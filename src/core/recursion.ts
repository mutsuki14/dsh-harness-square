/**
 * Task-level recursion: parallel (width) and sequential (depth) ProposeProbeCompose.
 * Port of harness2 `core/recursion.py`.
 *
 * Both modes spend R = 4k rollouts and P = 3k improvement stages:
 * - parallel  : k base -> 2k iid candidates (k INV + k DOM) -> k independent compositions agg1..aggk
 * - sequential: k base -> for t in 1..k { inv_t, dom_t -> compose c_t from the whole history }
 *
 * An invalid proposal gets one retry with the validator's error, then inherits the current harness.
 */

import { buildEvidence, type EvidenceLimits, type PoolEntry } from './evidence.ts'
import { Ledger } from './ledger.ts'
import { applyEdits, parseEdits } from './protocol.ts'
import * as P from './prompts.ts'
import { addUsage, ZERO_USAGE, type Executor, type Improver, type ProgressSink, type Rollout, type TaskSpec, type TokenUsage, type WorkPrompts } from './spec.ts'
import { autotrigger, diversity, isUnchanged, scriptPaths, validate, type HarnessTree, type SurfaceSpec } from './tree.ts'

export const STAGE_ATTEMPTS = 2

/** Appended to improvement missions when the executor has no tool loop. */
export const TOOLLESS_NOTE = `# RUNTIME LIMITS OF THIS SOLVER

The solver for this task runs as ONE model completion with NO tools: it cannot run scripts, read
files, call \`harness2_skill\`, or delegate to a sub-agent. Skills and sub-agent briefs are inlined
into its prompt as text, and the source material is inlined into the request. Do not add any
instruction that requires a tool call before answering -- a run that emits a tool call delivers
nothing. Encode procedure as prose the solver can follow in-context, and do not add scripts.

This limit belongs to the PROBE, not to the harness: an adopted harness is later activated for
agents that DO have tools. Never write "no tools are available" or similar into any component.`

export type Mode = 'parallel' | 'sequential'

export interface Stage {
  label: string
  dim: 'INV' | 'DOM' | 'AGG' | 'COMPOSE'
  tree: HarnessTree
  keptBase: boolean
  fellBack: boolean
  error: string
  usd: number
  attempts: number
  notes: string
  usage?: TokenUsage
  /** Why each rejected attempt was rejected (validator / guard / protocol), in order. */
  rejections?: string[]
}

export interface ModeResult {
  mode: Mode
  taskId: string
  k: number
  stages: Stage[]
  trees: Record<string, HarnessTree>
  rollouts: Record<string, Rollout>
  finals: string[]
  ledger: Ledger
  similarity?: ReturnType<typeof diversity>
  errors: string[]
}

export interface RecursionContext {
  task: TaskSpec
  work: WorkPrompts
  k: number
  base: Rollout[]
  baseTree: HarnessTree
  surface: SurfaceSpec
  executor: Executor
  improver: Improver
  /** Rendered experience library for this domain (harnessing-level recursion input). */
  library?: string
  allowSubagents?: boolean
  /** Max concurrent improver calls / rollouts. */
  width?: number
  runIdOf: (label: string) => string
  limits?: Partial<EvidenceLimits>
  onProgress?: ProgressSink
  signal?: AbortSignal
  /** Extra validation hook (e.g. deployment-specific required files). */
  validateTree?: (tree: HarnessTree) => void
}

/** Phrases that state the PROBE's limitation as if it were a property of every future run. */
const PROBE_LEAK = /\bno tools? (?:are|is) (?:available|provided)\b|\bwithout (?:any )?(?:tools|tool access)\b|\b(?:never|do not|don't) (?:answer|reply|respond) with a tool call\b|\b(?:cannot|can't|can not) (?:use|call|run) (?:any )?tools\b|\btools? (?:are|is) (?:not|un)available\b/i

/**
 * Deterministic checks for a toolless probe: such a probe can only produce evidence about prose.
 * 1. No component may state the probe's limitation -- the adopted harness later runs for agents WITH tools.
 * 2. No script may be added or changed -- no rollout of this probe can execute it, so no evidence can support it.
 */
export function checkToollessProbe(surface: SurfaceSpec, next: HarnessTree, fallback: HarnessTree): string[] {
  const errs: string[] = []
  for (const [rel, text] of Object.entries(next)) {
    const m = PROBE_LEAK.exec(text)
    if (m && !PROBE_LEAK.test(fallback[rel] ?? '')) {
      errs.push(`${rel}: says "${m[0]}" -- that is a limitation of this evaluation probe, not of the agents this harness will run for (they have tools). Remove it; keep any in-reply procedure without claiming tools are absent.`)
    }
  }
  for (const rel of scriptPaths(surface, next)) {
    if (next[rel] !== fallback[rel]) {
      errs.push(`${rel}: this probe has no tool loop, so no rollout can execute or support a script edit. Drop the script and encode the procedure as prose or a skill.`)
    }
  }
  return errs
}

/** Run `fn` over items with at most `width` in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], width: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const n = Math.max(1, Math.min(width, items.length))
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i] as T, i)
      }
    }),
  )
  return out
}

function acceptTree(ctx: RecursionContext, next: HarnessTree, fallback: HarnessTree, label: string): { kept: boolean; error: string } {
  const triggered = autotrigger(ctx.surface, next)
  if (triggered.length) ctx.onProgress?.({ type: 'log', taskId: ctx.task.id, message: `[${label}] auto-triggered skill(s): ${triggered.join(', ')}` })
  const kept = isUnchanged(fallback, next)
  try {
    const opts: { allowSubagents?: boolean } = {}
    if (ctx.allowSubagents !== undefined) opts.allowSubagents = ctx.allowSubagents
    validate(ctx.surface, next, opts)
    if (ctx.executor.toolless) {
      const probeErrs = checkToollessProbe(ctx.surface, next, fallback)
      if (probeErrs.length) throw new Error(probeErrs.join('\n'))
    }
    ctx.validateTree?.(next)
  } catch (e) {
    return { kept, error: (e as Error).message }
  }
  return { kept, error: '' }
}

interface StageSpec {
  label: string
  dim: Stage['dim']
  job: string
  fallback: HarnessTree
  fallbackLabel: string
  pool?: PoolEntry[]
  decisions?: Record<string, string>
}

/** Build evidence, propose an edit, and retry an invalid proposal once. */
export async function runStage(ctx: RecursionContext, spec: StageSpec): Promise<Stage> {
  ctx.onProgress?.({ type: 'stage/start', taskId: ctx.task.id, label: spec.label, dim: spec.dim })
  let usage: TokenUsage = { ...ZERO_USAGE }
  const rejections: string[] = []
  const finish = (s: Stage): Stage => {
    s.usage = usage
    if (rejections.length) s.rejections = rejections
    const ev: Parameters<ProgressSink>[0] = { type: 'stage/end', taskId: ctx.task.id, label: s.label, dim: s.dim, keptBase: s.keptBase, fellBack: s.fellBack }
    if (s.error) (ev as { error?: string }).error = s.error
    ctx.onProgress?.(ev)
    return s
  }
  let evidence: string
  try {
    const input: Parameters<typeof buildEvidence>[0] = {
      task: ctx.task,
      harness: spec.fallback,
      harnessLabel: spec.fallbackLabel,
      base: ctx.base,
    }
    if (spec.pool) input.pool = spec.pool
    if (spec.decisions) input.decisions = spec.decisions
    if (ctx.library) input.library = ctx.library
    if (ctx.limits) input.limits = ctx.limits
    evidence = buildEvidence(input)
  } catch (e) {
    return finish({ label: spec.label, dim: spec.dim, tree: { ...spec.fallback }, keptBase: false, fellBack: true, error: `could not build evidence: ${(e as Error).message}`.slice(0, 400), usd: 0, attempts: 0, notes: '' })
  }
  let err = ''
  let usd = 0
  let attempts = 0
  let working: HarnessTree = spec.fallback
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    if (err) rejections.push(err.slice(0, 600))
    if (ctx.signal?.aborted) {
      err = 'aborted'
      break
    }
    const retry = err
      ? `\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${err}\n\nThe harness as you left it (after your previous edits) is the starting point now:\n\n${Object.keys(working).sort().join(', ')}\n\nFix it and reply again with the corrected files.`
      : ''
    attempts++
    let text: string
    try {
      const req: Parameters<Improver['call']>[0] = {
        label: `${spec.label}.a${attempt}`,
        system: P.SYSTEM_IMPROVER,
        mission: `${spec.job}${ctx.executor.toolless ? `\n\n${TOOLLESS_NOTE}` : ''}\n\n${evidence}${retry}`,
      }
      if (ctx.signal) req.signal = ctx.signal
      const reply = await ctx.improver.call(req)
      usd += reply.costUsd ?? 0
      usage = addUsage(usage, reply)
      text = reply.text
    } catch (e) {
      err = `improver call failed: ${(e as Error).message}`
      usd += (e as { costUsd?: number }).costUsd ?? 0
      break
    }
    const edits = parseEdits(text)
    if (edits.invalid.length) {
      err = `these paths escape the harness and were not applied: ${edits.invalid.slice(0, 6).join(', ')}`
      continue
    }
    if (edits.keepBase) {
      return finish({ label: spec.label, dim: spec.dim, tree: { ...spec.fallback }, keptBase: true, fellBack: false, error: '', usd, attempts, notes: edits.notes || 'KEEP_BASE' })
    }
    if (!Object.keys(edits.writes).length && !edits.deletes.length) {
      err = 'no <file>, <delete> or <keep_base/> found in the reply -- use the reply protocol exactly'
      continue
    }
    // On a retry the model edits the tree it produced last time, not the original fallback.
    const next = applyEdits(attempt === 1 ? spec.fallback : working, edits)
    const verdict = acceptTree(ctx, next, spec.fallback, spec.label)
    if (verdict.error) {
      working = next
      err = verdict.error
      continue
    }
    return finish({ label: spec.label, dim: spec.dim, tree: next, keptBase: verdict.kept, fellBack: false, error: '', usd, attempts, notes: edits.notes || text.trim().slice(0, 2000) })
  }
  return finish({ label: spec.label, dim: spec.dim, tree: { ...spec.fallback }, keptBase: false, fellBack: true, error: err.slice(0, 400), usd, attempts, notes: '' })
}

/** Materialise a harness and roll it once. A dead rollout is recorded, never thrown. */
export async function roll(ctx: RecursionContext, label: string, tree: HarnessTree): Promise<Rollout> {
  const runId = ctx.runIdOf(label)
  ctx.onProgress?.({ type: 'rollout/start', taskId: ctx.task.id, label })
  const started = Date.now()
  let rv: Rollout
  try {
    const r = await ctx.executor.execute(ctx.task, tree, runId, ctx.signal)
    rv = { ...r, label, runId, wallMs: r.wallMs ?? Date.now() - started }
  } catch (e) {
    rv = { label, runId, ok: false, delivered: false, deliverable: '', trajectory: '', error: `${(e as Error).name}: ${(e as Error).message}`, wallMs: Date.now() - started }
  }
  ctx.onProgress?.({ type: 'rollout/end', taskId: ctx.task.id, label, ok: rv.ok, delivered: rv.delivered })
  return rv
}

async function rollMany(ctx: RecursionContext, ledger: Ledger, items: [string, HarnessTree][]): Promise<Record<string, Rollout>> {
  const got = await mapLimit(items, ctx.width ?? 4, ([label, tree]) => roll(ctx, label, tree))
  const out: Record<string, Rollout> = {}
  // Record after the pool drains so a concurrent run records the same sequence as a serial one.
  items.forEach(([label], i) => {
    ledger.rollout(label, got[i]?.costUsd ?? 0, got[i]?.usage)
    out[label] = got[i] as Rollout
  })
  return out
}

function newResult(mode: Mode, ctx: RecursionContext): ModeResult {
  const ledger = new Ledger(mode, ctx.task.id, ctx.k)
  for (const r of ctx.base) ledger.rollout(r.label, r.costUsd ?? 0, r.usage)
  const rollouts: Record<string, Rollout> = {}
  for (const r of ctx.base) rollouts[r.label] = r
  return { mode, taskId: ctx.task.id, k: ctx.k, stages: [], trees: {}, rollouts, finals: [], ledger, errors: [] }
}

function record(result: ModeResult, stages: Stage[]): void {
  for (const s of stages) {
    result.ledger.session(s.label, s.usd, s.attempts, s.usage)
    result.stages.push(s)
    result.trees[s.label] = s.tree
  }
}

const notesOf = (stages: Stage[]): Record<string, string> => Object.fromEntries(stages.map(s => [s.label, s.notes || s.error]))

/** WIDTH: 2k iid candidates from shared evidence, then k INDEPENDENT compositions. */
export async function runParallel(ctx: RecursionContext): Promise<ModeResult> {
  const result = newResult('parallel', ctx)
  const { k } = ctx
  const specs: StageSpec[] = []
  for (let i = 1; i <= k; i++) {
    for (const dim of ['INV', 'DOM'] as const) {
      specs.push({ label: `${dim.toLowerCase()}${i}`, dim, job: P.propose(ctx.work, dim, { k, index: i }), fallback: ctx.baseTree, fallbackLabel: 'base' })
    }
  }
  const stages = await mapLimit(specs, ctx.width ?? 4, s => runStage(ctx, s))
  record(result, stages)
  Object.assign(result.rollouts, await rollMany(ctx, result.ledger, stages.map(s => [s.label, s.tree])))

  const pool: PoolEntry[] = stages.map(s => {
    const e: PoolEntry = { label: s.label, harness: s.tree }
    const r = result.rollouts[s.label]
    if (r) e.rollout = r
    return e
  })
  const decisions = notesOf(stages)
  const aggSpecs: StageSpec[] = Array.from({ length: k }, (_, j) => ({
    label: `agg${j + 1}`,
    dim: 'AGG' as const,
    job: P.aggregate(ctx.work, { k, index: j + 1 }),
    fallback: ctx.baseTree,
    fallbackLabel: 'base',
    pool,
    decisions,
  }))
  const aggs = await mapLimit(aggSpecs, ctx.width ?? 4, s => runStage(ctx, s))
  record(result, aggs)
  result.finals = aggs.map(s => s.label)
  Object.assign(result.rollouts, await rollMany(ctx, result.ledger, aggs.map(s => [s.label, s.tree])))
  result.similarity = diversity(Object.fromEntries(aggs.map(s => [s.label, s.tree])))
  result.ledger.assertIdentity()
  return result
}

/** DEPTH: k nested passes over the same shared base evidence. */
export async function runSequential(ctx: RecursionContext): Promise<ModeResult> {
  const result = newResult('sequential', ctx)
  const { k } = ctx
  let current: HarnessTree = { ...ctx.baseTree }
  let history: PoolEntry[] = []
  for (let t = 1; t <= k; t++) {
    const currentLabel = t > 1 ? `c${t - 1}` : 'base'
    const specs: StageSpec[] = (['INV', 'DOM'] as const).map(dim => ({
      label: `${dim.toLowerCase()}${t}`,
      dim,
      job: P.propose(ctx.work, dim, k > 1 ? { k, index: t, roundT: t } : { k, index: t }),
      fallback: current,
      fallbackLabel: currentLabel,
      pool: [...history],
      decisions: notesOf(result.stages),
    }))
    const stages = await mapLimit(specs, 2, s => runStage(ctx, s))
    record(result, stages)
    Object.assign(result.rollouts, await rollMany(ctx, result.ledger, stages.map(s => [s.label, s.tree])))

    const roundPool: PoolEntry[] = [
      ...history,
      ...stages.map(s => {
        const e: PoolEntry = { label: s.label, harness: s.tree }
        const r = result.rollouts[s.label]
        if (r) e.rollout = r
        return e
      }),
    ]
    const ck = `c${t}`
    const comp = await runStage(ctx, {
      label: ck,
      dim: 'COMPOSE',
      job: k === 1 ? P.aggregate(ctx.work, { k: 1, index: 1 }) : P.composeRound(ctx.work, t, k),
      fallback: current,
      fallbackLabel: currentLabel,
      pool: roundPool,
      decisions: notesOf(result.stages),
    })
    record(result, [comp])
    const r = await roll(ctx, ck, comp.tree)
    result.ledger.rollout(ck, r.costUsd ?? 0, r.usage)
    result.rollouts[ck] = r
    history = [...roundPool, { label: ck, harness: comp.tree, rollout: r }]
    current = comp.tree
  }
  result.finals = Array.from({ length: k }, (_, i) => `c${i + 1}`)
  result.ledger.assertIdentity()
  return result
}

export function runMode(mode: Mode, ctx: RecursionContext): Promise<ModeResult> {
  if (mode === 'parallel') return runParallel(ctx)
  if (mode === 'sequential') return runSequential(ctx)
  throw new Error(`unknown mode ${JSON.stringify(mode)}; expected 'parallel' or 'sequential'`)
}

/** Serialisable summary of a mode result. */
export function summarizeMode(r: ModeResult): object {
  return {
    mode: r.mode,
    taskId: r.taskId,
    k: r.k,
    finals: r.finals,
    fellBack: r.stages.filter(s => s.fellBack).map(s => s.label),
    keptBase: r.stages.filter(s => s.keptBase).map(s => s.label),
    stages: r.stages.map(s => ({ label: s.label, dim: s.dim, fellBack: s.fellBack, keptBase: s.keptBase, attempts: s.attempts, usd: s.usd, usage: s.usage, rejections: s.rejections, notes: s.notes.slice(0, 1200), error: s.error })),
    rollouts: Object.values(r.rollouts).map(x => ({ label: x.label, ok: x.ok, delivered: x.delivered, error: x.error, wallMs: x.wallMs })),
    similarity: r.similarity,
    ledger: r.ledger.toJSON(),
    errors: r.errors,
  }
}
