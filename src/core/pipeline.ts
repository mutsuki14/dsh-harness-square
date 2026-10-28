/**
 * One full Harness2 step for one task, plus a domain stream (harness2 `core/schedule.py`):
 *
 *   1. read the domain's experience library (harnessing-level recursion, input side)
 *   2. roll the starting harness k times (shared base evidence)
 *   3. task-level recursion: ProposeProbeCompose, parallel or sequential, budget k
 *   4. blind selection over the k finals
 *   5. reflect on the round and append the adopted harness + lesson to the library (output side)
 *
 * Every artefact is written under `<runsDir>/<task>/<mode>-k<k>/` so a run can be audited.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvidenceLimits } from './evidence.ts'
import { ExperienceLibrary, slug } from './library.ts'
import { mapLimit, roll, runMode, summarizeMode, type Mode, type ModeResult, type RecursionContext } from './recursion.ts'
import { reflectAdoption, runSelection, type Selection } from './selection.ts'
import { addUsage, checkWorkPrompts, type TokenUsage, type Executor, type Improver, type ProgressSink, type Rollout, type TaskSpec, type WorkPrompts } from './spec.ts'
import { DEFAULT_SURFACE, writeTree, type HarnessTree, type SurfaceSpec } from './tree.ts'

export interface Harness2Options {
  executor: Executor
  improver: Improver
  /** Default work description; a task may override it. */
  work: WorkPrompts
  /** Starting harness when the domain library is empty. */
  baseTree: HarnessTree
  k?: number
  mode?: Mode
  surface?: SurfaceSpec
  /** Root for run artefacts; omit to keep everything in memory. */
  runsDir?: string
  /** Root for the persistent experience library; omit to disable harnessing-level recursion. */
  libraryDir?: string
  /** Start each task from the domain's latest adopted harness instead of `baseTree`. */
  warmStart?: boolean
  /** Skip reflection/library update (task-level recursion only). */
  reflect?: boolean
  allowSubagents?: boolean
  width?: number
  limits?: Partial<EvidenceLimits>
  onProgress?: ProgressSink
  validateTree?: (tree: HarnessTree) => void
}

export interface TaskResult {
  taskId: string
  domain: string
  mode: Mode
  k: number
  startedFrom: string
  modeResult: ModeResult
  selection: Selection
  adoptedTree: HarnessTree
  adoptedRollout?: Rollout
  libraryUpdated: boolean
  usd: number
  /** All tokens observed: rollouts + improvement stages + selection/reflection. */
  usage: TokenUsage
  /** Ledger labels whose usage the executor could not observe. */
  usageUnknown: string[]
}

export class Harness2 {
  readonly opts: Required<Pick<Harness2Options, 'k' | 'mode' | 'surface' | 'warmStart' | 'reflect' | 'width'>> & Harness2Options
  readonly library?: ExperienceLibrary

  constructor(opts: Harness2Options) {
    checkWorkPrompts(opts.work)
    const k = opts.k ?? 1
    if (!Number.isInteger(k) || k < 1 || k > 8) throw new Error(`k must be an integer in 1..8, got ${k}`)
    this.opts = {
      ...opts,
      k,
      mode: opts.mode ?? 'parallel',
      surface: opts.surface ?? DEFAULT_SURFACE,
      warmStart: opts.warmStart ?? true,
      reflect: opts.reflect ?? true,
      width: opts.width ?? 4,
    }
    if (opts.libraryDir) this.library = new ExperienceLibrary(opts.libraryDir, this.opts.surface)
  }

  /** The harness a task in `domain` starts from, and where it came from. */
  startingHarness(domain: string): { tree: HarnessTree; from: string } {
    if (this.opts.warmStart && this.library) {
      const latest = this.library.latest(domain)
      if (latest && Object.keys(latest.tree).length) return { tree: latest.tree, from: `library:${latest.taskSlug}` }
    }
    return { tree: { ...this.opts.baseTree }, from: 'base' }
  }

  private persist(dir: string | undefined, name: string, data: unknown): void {
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }

  async runTask(task: TaskSpec, signal?: AbortSignal): Promise<TaskResult> {
    const { k, mode, surface, executor, improver } = this.opts
    const work = checkWorkPrompts(task.work ?? this.opts.work)
    const workDir = this.opts.runsDir ? join(this.opts.runsDir, slug(task.id), `${mode}-k${k}`) : undefined
    const { tree: baseTree, from } = this.startingHarness(task.domain)
    const library = this.library?.render(task.domain) ?? ''
    const runIdOf = (label: string) => `${slug(task.id)}.${mode}-k${k}.${label}`

    const ctx: RecursionContext = {
      task,
      work,
      k,
      base: [],
      baseTree,
      surface,
      executor,
      improver,
      library,
      width: this.opts.width,
      runIdOf,
    }
    if (this.opts.allowSubagents !== undefined) ctx.allowSubagents = this.opts.allowSubagents
    if (this.opts.limits) ctx.limits = this.opts.limits
    if (this.opts.onProgress) ctx.onProgress = this.opts.onProgress
    if (this.opts.validateTree) ctx.validateTree = this.opts.validateTree
    if (signal) ctx.signal = signal

    // Shared base evidence: k rollouts of the starting harness.
    const baseLabels = Array.from({ length: k }, (_, i) => `base${i + 1}`)
    ctx.base = await mapLimit(baseLabels, this.opts.width, label => roll(ctx, label, baseTree))

    const modeResult = await runMode(mode, ctx)
    const selection = await runSelection({ task, work, result: modeResult, improver, ...(signal ? { signal } : {}) })
    if (selection.ok) this.opts.onProgress?.({ type: 'selection', taskId: task.id, chosen: selection.chosenLabel, why: selection.why })

    const adoptedTree = selection.ok ? modeResult.trees[selection.chosenLabel] ?? baseTree : baseTree
    let libraryUpdated = false
    if (this.opts.reflect && selection.ok) {
      const exp = await reflectAdoption({ task, work, result: modeResult, selection, baseTree, improver, ...(signal ? { signal } : {}) })
      if (exp && this.library) {
        libraryUpdated = this.library.add(task.domain, task.id, adoptedTree, { label: selection.chosenLabel, why: selection.why, experience: exp })
        if (libraryUpdated) this.opts.onProgress?.({ type: 'library/add', taskId: task.id, domain: task.domain, cue: exp.cue })
      }
    }

    const usd = Math.round((modeResult.ledger.usd + selection.usd) * 1e6) / 1e6
    const usage = addUsage(modeResult.ledger.tokens, selection.usage)
    const usageUnknown = modeResult.ledger.usageUnknown
    const out: TaskResult = {
      taskId: task.id,
      domain: task.domain,
      mode,
      k,
      startedFrom: from,
      modeResult,
      selection,
      adoptedTree,
      libraryUpdated,
      usd,
      usage,
      usageUnknown,
    }
    const adoptedRollout = selection.ok ? modeResult.rollouts[selection.chosenLabel] : undefined
    if (adoptedRollout) out.adoptedRollout = adoptedRollout

    if (workDir) {
      for (const [label, tree] of Object.entries({ base: baseTree, ...modeResult.trees })) writeTree(surface, tree, join(workDir, 'harnesses', label))
      writeTree(surface, adoptedTree, join(workDir, 'adopted'))
      for (const r of Object.values(modeResult.rollouts)) {
        this.persist(join(workDir, 'rollouts', r.label), 'trajectory.md', r.trajectory || '')
        this.persist(join(workDir, 'rollouts', r.label), 'deliverable.md', r.deliverable || '')
        this.persist(join(workDir, 'rollouts', r.label), 'rollout.json', { ...r, trajectory: undefined, deliverable: undefined })
      }
      this.persist(workDir, 'mode.json', summarizeMode(modeResult))
      this.persist(workDir, 'selection.json', selection)
      this.persist(workDir, 'summary.json', {
        taskId: task.id,
        domain: task.domain,
        mode,
        k,
        startedFrom: from,
        adopted: selection.chosenLabel || null,
        selectionOk: selection.ok,
        libraryUpdated,
        usd,
        usage,
        usageUnknown,
        R: modeResult.ledger.R,
        P: modeResult.ledger.P,
      })
    }
    return out
  }

  /** Run tasks in stream order; each task in a domain reads what earlier ones wrote. */
  async runStream(tasks: TaskSpec[], signal?: AbortSignal): Promise<TaskResult[]> {
    const out: TaskResult[] = []
    for (const t of tasks) {
      if (signal?.aborted) break
      out.push(await this.runTask(t, signal))
    }
    return out
  }
}
