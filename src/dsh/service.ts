/**
 * `ctx.harness2` -- the Harness2 Cordis service.
 *
 * Owns: the experience library (harnessing-level recursion), the ACTIVE harness each domain
 * currently runs under, and improvement runs (task-level recursion). Other plugins in this
 * bundle consume it: `harness2-runtime` applies the active harness to live agents, and
 * `harness2-tools` exposes it to the model.
 *
 * Events (emit):
 *   harness2/progress (event)            every recursion progress event
 *   harness2/activated (domain, tree)    the active harness of a domain changed
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ExperienceLibrary, domainDir } from '../core/library.ts'
import { Harness2, type TaskResult } from '../core/pipeline.ts'
import type { Mode } from '../core/recursion.ts'
import { normalizePrice, type Executor, type Improver, type Price, type ProgressEvent, type TaskSpec, type WorkPrompts } from '../core/spec.ts'
import { DEFAULT_SURFACE, readTree, surfaceWith, validate, writeTree, type HarnessTree, type SurfaceSpec } from '../core/tree.ts'
import { DEFAULT_BASE_TREE, DEFAULT_WORK } from './defaults.ts'
import { LlmExecutor, WorkflowExecutor, HeadlessExecutor } from './executors.ts'
import { LlmImprover } from './improver.ts'
import { optionalService, type AgentLike, type LlmService, type WorkflowEngine } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    harness2: Harness2Service
  }
  interface Events {
    'harness2/progress'(event: ProgressEvent): void
    'harness2/activated'(domain: string, tree: HarnessTree): void
  }
}

export type ExecutorKind = 'llm' | 'workflow' | 'headless'

export interface Config {
  /** Root directory for library, active harnesses and run artefacts (default `$DSH_HOME/harness2` or `~/.dsh/harness2`). */
  root?: string
  /** Model route for the improver (propose / compose / select / reflect). */
  improverProvider: string
  improverModel: string
  /** Model route for `llm` executor rollouts. */
  solverProvider: string
  solverModel: string
  /**
   * Default executor. `headless` (default): an isolated \`dsh --profile headless\` process per probe, with its
   * own workspace and project root. `workflow`: a child agent of the caller -- shares the caller's
   * working directory and process (isolation is instruction-level only). `llm`: one completion, no tools.
   */
  executor: ExecutorKind
  /** Subagent provider used by the workflow executor. */
  subagentProvider: string
  /** `dsh` launch command for the headless executor. */
  headlessCommand: string
  /** Default task-level recursion budget k. */
  k: number
  /** Ceiling the model may request through the tool. */
  maxK: number
  mode: Mode
  /** Max concurrent improver calls / rollouts. */
  width: number
  /** Always-on character cap for the active harness. */
  alwaysOnMax: number
  /** Activate the adopted harness for its domain after every successful run. */
  autoActivate: boolean
  /** Start each run from the domain's latest adopted harness. */
  warmStart: boolean
  allowSubagents: boolean
  /** Default domain for agents that never selected one. */
  defaultDomain: string
  /** Optional USD-per-million-token prices; without them runs report tokens only. */
  improverPrice?: Price
  solverPrice?: Price
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().description('Harness2 data root; defaults to $DSH_HOME/harness2.'),
  improverProvider: Schema.string().default('deepseek-official'),
  improverModel: Schema.string().default('deepseek-v4-pro'),
  solverProvider: Schema.string().default('deepseek-official'),
  solverModel: Schema.string().default('deepseek-flash'),
  executor: Schema.union(['headless', 'workflow', 'llm'] as const).default('headless'),
  subagentProvider: Schema.string().default('spawn'),
  headlessCommand: Schema.string().default('dsh'),
  k: Schema.number().step(1).min(1).max(8).default(1),
  maxK: Schema.number().step(1).min(1).max(8).default(3),
  mode: Schema.union(['parallel', 'sequential'] as const).default('parallel'),
  width: Schema.number().step(1).min(1).max(16).default(4),
  alwaysOnMax: Schema.number().step(1).min(1000).max(100_000).default(12_000),
  autoActivate: Schema.boolean().default(true),
  warmStart: Schema.boolean().default(true),
  allowSubagents: Schema.boolean().default(true),
  defaultDomain: Schema.string().default('general'),
  improverPrice: Schema.object({ input: Schema.number().min(0), output: Schema.number().min(0) }).description('USD per 1M tokens for the improver model.'),
  solverPrice: Schema.object({ input: Schema.number().min(0), output: Schema.number().min(0) }).description('USD per 1M tokens for the solver model.'),
}) as Schema<Config>

export interface ImproveRequest {
  task: TaskSpec
  work?: WorkPrompts
  k?: number
  mode?: Mode
  executor?: ExecutorKind
  /** Calling agent; required by the `workflow` executor. */
  parent?: AgentLike
  signal?: AbortSignal
  /** Override the executor/improver entirely (tests, custom substrates). */
  executorImpl?: Executor
  improverImpl?: Improver
  /** Headless executor: seed workspace directory. */
  seedDir?: string
}

export interface RunRecord {
  id: string
  taskId: string
  domain: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  adopted?: string
  error?: string
  summary?: object
}

export class Harness2Service extends Service {
  // llm / workflowEngine are optional: resolved lazily through ctx.get(), never load dependencies.
  static readonly Config = Config

  readonly config: Config
  readonly surface: SurfaceSpec
  readonly root: string
  readonly library: ExperienceLibrary
  private readonly runs = new Map<string, RunRecord & { ctl: AbortController }>()
  private seq = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'harness2')
    const improverPrice = normalizePrice(config.improverPrice)
    const solverPrice = normalizePrice(config.solverPrice)
    this.config = { ...config }
    delete this.config.improverPrice
    delete this.config.solverPrice
    if (improverPrice) this.config.improverPrice = improverPrice
    if (solverPrice) this.config.solverPrice = solverPrice
    this.surface = surfaceWith({ alwaysOnMax: config.alwaysOnMax })
    this.root = config.root || join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'harness2')
    mkdirSync(this.root, { recursive: true })
    this.library = new ExperienceLibrary(join(this.root, 'library'), this.surface)
    // Cancel in-flight runs when the plugin unloads (HMR, profile change, shutdown).
    ctx.effect(() => () => {
      for (const r of this.runs.values()) r.ctl.abort(new Error('harness2 service disposed'))
    }, 'harness2 runs')
  }

  // ---- active harness ----------------------------------------------------

  /** Directory holding the domain's activated harness files, or undefined while the default is in effect. */
  activeHarnessDir(domain = this.config.defaultDomain): string | undefined {
    const dir = this.activeDir(domain)
    return existsSync(join(dir, 'ACTIVE')) ? dir : undefined
  }

  private activeDir(domain: string): string {
    return join(this.root, 'active', domainDir(domain))
  }

  /** The harness a domain currently runs under (falls back to the default base tree). */
  activeHarness(domain = this.config.defaultDomain): HarnessTree {
    const dir = this.activeDir(domain)
    if (existsSync(join(dir, 'ACTIVE'))) {
      const tree = readTree(this.surface, dir)
      if (Object.keys(tree).length) return tree
    }
    return { ...DEFAULT_BASE_TREE }
  }

  /** Validate and activate a harness for a domain; live agents pick it up on their next step. */
  activate(domain: string, tree: HarnessTree, source = 'manual'): void {
    validate(this.surface, tree, { allowSubagents: this.config.allowSubagents })
    const dir = this.activeDir(domain)
    writeTree(this.surface, tree, dir)
    writeFileSync(join(dir, 'ACTIVE'), `${JSON.stringify({ source, at: new Date().toISOString() })}\n`, 'utf8')
    this.ctx.emit('harness2/activated', domain, tree)
  }

  /** Restore the default base harness for a domain. */
  reset(domain: string): void {
    this.activate(domain, { ...DEFAULT_BASE_TREE }, 'reset')
  }

  activeSource(domain: string): string {
    const p = join(this.activeDir(domain), 'ACTIVE')
    try {
      return (JSON.parse(readFileSync(p, 'utf8')) as { source?: string }).source ?? 'unknown'
    } catch {
      return 'default'
    }
  }

  // ---- improvement runs ----------------------------------------------------

  /** Build the executor for a request from configuration and available services. */
  resolveExecutor(req: ImproveRequest): Executor {
    if (req.executorImpl) return req.executorImpl
    const kind = req.executor ?? this.config.executor
    if (kind === 'workflow') {
      const engine = optionalService<WorkflowEngine>(this.ctx, 'workflowEngine')
      if (engine && req.parent) return new WorkflowExecutor(engine, req.parent, { subagentProvider: this.config.subagentProvider, surface: this.surface })
      // Fall through to the LLM executor when no workflow engine/caller is available.
    }
    if (kind === 'headless') {
      const opts: ConstructorParameters<typeof HeadlessExecutor>[0] = { command: this.config.headlessCommand, workRoot: join(this.root, 'workspaces'), surface: this.surface }
      if (this.config.solverPrice) opts.price = this.config.solverPrice
      if (req.seedDir) opts.seedDir = req.seedDir
      return new HeadlessExecutor(opts)
    }
    const llm = optionalService<LlmService>(this.ctx, 'llm')
    if (!llm) throw new Error('harness2: no executor available -- mount @deepseek-ai/dsh-llm (and a provider adapter) or pass executorImpl')
    const opts: ConstructorParameters<typeof LlmExecutor>[1] = { provider: this.config.solverProvider, model: this.config.solverModel, surface: this.surface }
    if (this.config.solverPrice) opts.price = this.config.solverPrice
    return new LlmExecutor(llm, opts)
  }

  resolveImprover(req: ImproveRequest): Improver {
    if (req.improverImpl) return req.improverImpl
    const llm = optionalService<LlmService>(this.ctx, 'llm')
    if (!llm) throw new Error('harness2: the improver needs ctx.llm -- mount @deepseek-ai/dsh-llm and a provider adapter')
    const auditDir = join(this.root, 'audit')
    return new LlmImprover(llm, {
      provider: this.config.improverProvider,
      model: this.config.improverModel,
      ...(this.config.improverPrice ? { price: this.config.improverPrice } : {}),
      audit: entry => {
        try {
          mkdirSync(auditDir, { recursive: true })
          writeFileSync(join(auditDir, `${Date.now()}-${entry.label.replace(/[^\w.\-]/g, '_')}.json`), JSON.stringify(entry), 'utf8')
        } catch {
          /* audit is best effort */
        }
      },
    })
  }

  /** Run one full Harness2 step for a task; resolves with the adopted harness. */
  async improve(req: ImproveRequest): Promise<TaskResult> {
    const k = Math.min(req.k ?? this.config.k, this.config.maxK)
    const id = `h2-${Date.now().toString(36)}-${(++this.seq).toString(36)}`
    const ctl = new AbortController()
    const onAbort = () => ctl.abort(req.signal?.reason)
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const record: RunRecord & { ctl: AbortController } = { id, taskId: req.task.id, domain: req.task.domain, status: 'running', startedAt: new Date().toISOString(), ctl }
    this.runs.set(id, record)
    try {
      const engine = new Harness2({
        executor: this.resolveExecutor(req),
        improver: this.resolveImprover(req),
        work: req.work ?? DEFAULT_WORK,
        baseTree: this.activeHarness(req.task.domain),
        k,
        mode: req.mode ?? this.config.mode,
        surface: this.surface,
        runsDir: join(this.root, 'runs'),
        libraryDir: join(this.root, 'library'),
        warmStart: false, // the active harness already is the warm start in-harness
        allowSubagents: this.config.allowSubagents,
        width: this.config.width,
        onProgress: ev => this.ctx.emit('harness2/progress', ev),
      })
      const result = await engine.runTask(req.task, ctl.signal)
      if (this.config.autoActivate && result.selection.ok) {
        this.activate(req.task.domain, result.adoptedTree, `run:${id}:${result.selection.chosenLabel}`)
      }
      Object.assign(record, {
        status: 'done',
        endedAt: new Date().toISOString(),
        adopted: result.selection.chosenLabel,
        summary: { k, mode: result.mode, adopted: result.selection.chosenLabel, why: result.selection.why, libraryUpdated: result.libraryUpdated, R: result.modeResult.ledger.R, P: result.modeResult.ledger.P, usage: result.usage, usd: result.usd, usageUnknown: result.usageUnknown },
      })
      return result
    } catch (e) {
      Object.assign(record, { status: ctl.signal.aborted ? 'cancelled' : 'failed', endedAt: new Date().toISOString(), error: (e as Error).message })
      throw e
    } finally {
      req.signal?.removeEventListener('abort', onAbort)
    }
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].map(({ ctl: _ctl, ...r }) => r)
  }

  cancel(id: string): boolean {
    const r = this.runs.get(id)
    if (!r || r.status !== 'running') return false
    r.ctl.abort(new Error('cancelled'))
    return true
  }

  defaultSurface(): SurfaceSpec {
    return this.surface ?? DEFAULT_SURFACE
  }
}

export default Harness2Service
