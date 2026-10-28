/**
 * The seam between the method and the world. Port of harness2 `core/spec.py`.
 *
 * Three axes stay separate:
 * - method    -- recursion, prompts, selection, library (this package's core)
 * - executor  -- how one rollout runs under a harness (DSH workflow, DSH headless, plain LLM)
 * - improver  -- the model channel that proposes/composes/selects/reflects
 */

import type { HarnessTree } from './tree.ts'

/** Benchmark/domain-shaped text the shared prompts interpolate. Describes the WORK, never its measurement. */
export interface WorkPrompts {
  /** One paragraph: what kind of work the agent does. */
  work: string
  domainWord?: string
  deliverableWord?: string
  /** Extra levers for the INV (procedure) dimension. */
  invLevers?: string
  /** Extra levers for the DOM (practitioner knowledge) dimension. */
  domLevers?: string
  /** What good process looks like here. */
  yardstick?: string
  /** Task/domain lens. */
  domainGuidance?: string
  /** What correctness means for this artifact family (selection). */
  selectionChecks?: string
}

const MEASUREMENT_WORDS = ['benchmark', 'evaluation', 'grader', 'rubric', 'score']

/** Reject prompt slots that talk about measurement instead of work (harness2 invariant). */
export function checkWorkPrompts(wp: WorkPrompts): WorkPrompts {
  const visible: Record<string, string | undefined> = {
    work: wp.work,
    invLevers: wp.invLevers,
    domLevers: wp.domLevers,
    yardstick: wp.yardstick,
    domainGuidance: wp.domainGuidance,
    selectionChecks: wp.selectionChecks,
  }
  for (const [field, value] of Object.entries(visible)) {
    const low = (value ?? '').toLowerCase()
    for (const bad of MEASUREMENT_WORDS) {
      if (low.includes(bad)) {
        throw new Error(`WorkPrompts.${field} must describe the WORK, not its measurement (found ${JSON.stringify(bad)})`)
      }
    }
  }
  if (!wp.work?.trim()) throw new Error('WorkPrompts.work is required')
  return wp
}

/** Token usage of one model call or rollout. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** USD per million tokens. */
export interface Price {
  input: number
  output: number
}

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({ inputTokens: 0, outputTokens: 0 })

export function addUsage(a: TokenUsage, b?: Partial<TokenUsage>): TokenUsage {
  return { inputTokens: a.inputTokens + (b?.inputTokens ?? 0), outputTokens: a.outputTokens + (b?.outputTokens ?? 0) }
}

/** A usable price, or undefined for absent/partial/invalid input (config may supply `{}`). */
export function normalizePrice(p: unknown): Price | undefined {
  if (!p || typeof p !== 'object') return undefined
  const { input, output } = p as Partial<Price>
  return typeof input === 'number' && typeof output === 'number' && input >= 0 && output >= 0 ? { input, output } : undefined
}

/** Cost of a usage sample, or undefined when no price is configured. */
export function costOf(u: Partial<TokenUsage> | undefined, price: Price | undefined): number | undefined {
  const p = normalizePrice(price)
  if (!p || !u) return undefined
  return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output) / 1e6
}

/** One task the agent must perform. */
export interface TaskSpec {
  id: string
  /** Domain key: the experience library is partitioned by it. */
  domain: string
  /** The request, verbatim. */
  prompt: string
  /** Source material, by name (inlined into evidence, truncated). */
  sources?: Record<string, string>
  /** Optional per-task override of the work description. */
  work?: WorkPrompts
}

/** What the method knows about one finished rollout. Never carries a score. */
export interface Rollout {
  label: string
  runId: string
  /** The executor completed without an infrastructure error. */
  ok: boolean
  /** A non-empty deliverable was produced. */
  delivered: boolean
  /** The produced artifact, rendered as text. */
  deliverable: string
  /** Action/observation trace, rendered as text. */
  trajectory: string
  error?: string
  costUsd?: number
  /** Tokens the rollout consumed, when the executor can observe them. */
  usage?: TokenUsage
  wallMs?: number
  /** Executor-specific handle (session id, run dir). */
  ref?: string
}

/** Runs the task once under a harness. Must never throw for ordinary agent failure. */
export interface Executor {
  readonly name: string
  /**
   * True when the solver is a single completion with no tool loop. The improver is then told
   * not to prescribe tool calls, which such a solver can only emit as dead markup.
   */
  readonly toolless?: boolean
  execute(task: TaskSpec, harness: HarnessTree, runId: string, signal?: AbortSignal): Promise<Omit<Rollout, 'label' | 'runId'>>
}

export interface ImproverRequest {
  /** Stable label for audit/caching, e.g. `inv1.a1`, `agg2`, `select.agg2`. */
  label: string
  system: string
  mission: string
  signal?: AbortSignal
}

export interface ImproverReply {
  text: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

/** The model channel used for propose / compose / select / reflect. */
export interface Improver {
  readonly name: string
  call(req: ImproverRequest): Promise<ImproverReply>
}

export class ImproverError extends Error {
  readonly costUsd: number
  constructor(message: string, costUsd = 0) {
    super(message)
    this.name = 'ImproverError'
    this.costUsd = costUsd
  }
}

/** Optional observer hooks; the DSH service re-emits these as Cordis events. */
export interface ProgressSink {
  (event: ProgressEvent): void
}

export type ProgressEvent =
  | { type: 'rollout/start'; taskId: string; label: string }
  | { type: 'rollout/end'; taskId: string; label: string; ok: boolean; delivered: boolean }
  | { type: 'stage/start'; taskId: string; label: string; dim: string }
  | { type: 'stage/end'; taskId: string; label: string; dim: string; keptBase: boolean; fellBack: boolean; error?: string }
  | { type: 'selection'; taskId: string; chosen: string; why: string }
  | { type: 'library/add'; taskId: string; domain: string; cue: string }
  | { type: 'log'; taskId: string; message: string }
