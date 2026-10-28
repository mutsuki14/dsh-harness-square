/**
 * Executors: how one rollout runs under a candidate harness.
 *
 * | executor            | fidelity | where it runs                                                          |
 * |---------------------|----------|------------------------------------------------------------------------|
 * | `LlmExecutor`       | low      | one `ctx.llm` completion with the harness as system prompt (no tools)  |
 * | `WorkflowExecutor`  | high     | a fresh DSH subagent through `ctx.workflowEngine` (real tool loop)     |
 * | `HeadlessExecutor`  | highest  | a `dsh --profile headless --json` subprocess in an isolated workspace  |
 *
 * Every executor converts ordinary agent failure into a non-delivering rollout; only
 * infrastructure bugs throw (and the recursion still records them as dead rollouts).
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addUsage, costOf, ZERO_USAGE, type Executor, type Price, type Rollout, type TaskSpec, type TokenUsage } from '../core/spec.ts'
import { canonicalFrontmatter, DEFAULT_SURFACE, pluginNames, writeTree, type HarnessTree, type SurfaceSpec } from '../core/tree.ts'
import { streamText } from './improver.ts'
import { renderHarnessPrompt } from './render.ts'
import type { AgentLike, LlmService, WorkflowEngine } from './types.ts'

type ExecResult = Omit<Rollout, 'label' | 'runId'>

/** Raw tool-call markup a model emits when it wants a tool the runtime does not provide (DeepSeek DSML, generic forms). */
const TOOL_CALL_MARKUP = /<\uFF5C+DSML\uFF5C+|<\uFF5Ctool[\u2581_]calls?|<\|tool_calls?(?:_begin)?\|>|<tool_call>|<function_calls>/

/** Whether a completion is an unexecuted tool call rather than an answer. */
export function isUnexecutedToolCall(text: string): boolean {
  return TOOL_CALL_MARKUP.test(text)
}

/** Shape a toolless completion into a rollout, never counting dead tool-call markup as a deliverable. */
export function toollessRollout(text: string, trajectory: string, wallMs: number, usage?: TokenUsage, price?: Price): ExecResult {
  const metered: Partial<ExecResult> = {}
  if (usage) metered.usage = usage
  const cost = costOf(usage, price)
  if (cost !== undefined) metered.costUsd = cost
  if (isUnexecutedToolCall(text)) {
    return { ok: true, delivered: false, deliverable: '', trajectory: `${trajectory}\n[RUNTIME] the solver emitted a tool call, but this executor has no tool loop; nothing was delivered`, wallMs, error: 'unexecuted tool call (toolless executor)', ...metered }
  }
  return { ok: true, delivered: text.trim().length > 0, deliverable: text, trajectory, wallMs, ...metered }
}

function taskMessage(task: TaskSpec): string {
  const sources = Object.entries(task.sources ?? {})
  return [
    task.prompt.trim(),
    ...(sources.length ? ['\n# Source material\n', ...sources.map(([n, b]) => `<source name="${n}">\n${b}\n</source>`)] : []),
  ].join('\n')
}

// ---------------------------------------------------------------------------

export interface LlmExecutorOptions {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  surface?: SurfaceSpec
  /** USD per million tokens for the solver model, to turn usage into cost. */
  price?: Price
}

/** Single completion: the cheapest probe; it sees the harness but has no tool loop. */
export class LlmExecutor implements Executor {
  readonly name = 'dsh-llm'
  readonly toolless = true
  private readonly llm: LlmService
  private readonly opts: LlmExecutorOptions

  constructor(llm: LlmService, opts: LlmExecutorOptions) {
    this.llm = llm
    this.opts = opts
  }

  async execute(task: TaskSpec, harness: HarnessTree, _runId: string, signal?: AbortSignal): Promise<ExecResult> {
    const started = Date.now()
    const system = renderHarnessPrompt(harness, this.opts.surface ?? DEFAULT_SURFACE)
    try {
      const args: Parameters<typeof streamText>[1] = { provider: this.opts.provider, model: this.opts.model, system, prompt: taskMessage(task) }
      if (this.opts.temperature !== undefined) args.temperature = this.opts.temperature
      if (this.opts.maxTokens !== undefined) args.maxTokens = this.opts.maxTokens
      if (signal) args.signal = signal
      const r = await streamText(this.llm, args)
      return toollessRollout(r.text, `[SYSTEM] harness rendered (${system.length} chars)\n[USER] ${task.prompt.slice(0, 500)}\n[ASSISTANT]\n${r.text}`, Date.now() - started, { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens }, this.opts.price)
    } catch (e) {
      return { ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message, wallMs: Date.now() - started }
    }
  }
}

// ---------------------------------------------------------------------------

export interface WorkflowExecutorOptions {
  /** Subagent provider for the child (default `spawn`: a fresh agent with no parent context). */
  subagentProvider?: string
  surface?: SurfaceSpec
  /** The working directory children share (default `process.cwd()`); watched for writes outside each probe's scratch dir. */
  watchDir?: string
}

/**
 * Fixed, deployment-owned workflow script: one fresh child runs the task under the rendered
 * harness and returns a structured report. The model supplies data only (`args`).
 */
const ROLLOUT_SCRIPT = String.raw`
const schema = {
  type: 'object',
  properties: {
    deliverable: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'string' },
  },
  required: ['deliverable', 'steps', 'blockers'],
  additionalProperties: false,
}
phase('Rollout')
const prompt = [
  'You are executing one task under the operating harness below. Follow it.',
  'ISOLATION: you are one of several independent probe runs of the same task. Before doing anything else, create the directory ' + args.scratch + ' and copy into it only the input files the task names. From then on TREAT ' + args.scratch + ' AS THE CURRENT DIRECTORY: every relative path in the task -- inputs AND outputs, including any file the task says to write in "the current directory" -- resolves inside it. Never create, modify or copy files anywhere else; writes outside it are detected and void this run.',
  'The <harness> below is the ONLY harness that applies to this run. Ignore any other operating-harness text in your system prompt, and do not call the harness2_skill tool: every skill this harness defines is inlined below.',
  '<harness>\n' + args.harness + '\n</harness>',
  '<task>\n' + args.task + '\n</task>',
  'Do the work with your tools. When done, return: deliverable = the complete final artifact as text ' +
    '(or the path(s) and a faithful summary of the files you wrote); steps = the actions you took, in order, ' +
    'with what each observed; blockers = anything that stopped you (empty if none).',
].join('\n\n')
const report = await agent(prompt, { label: 'harness2 rollout', phase: 'Rollout', schema })
return report
`

/** Run the rollout as a real DSH child agent via the workflow engine. Requires a calling agent. */
export class WorkflowExecutor implements Executor {
  readonly name = 'dsh-workflow'
  private readonly engine: WorkflowEngine
  private readonly parent: AgentLike
  private readonly opts: WorkflowExecutorOptions

  constructor(engine: WorkflowEngine, parent: AgentLike, opts: WorkflowExecutorOptions = {}) {
    this.engine = engine
    this.parent = parent
    this.opts = opts
  }

  async execute(task: TaskSpec, harness: HarnessTree, runId: string, signal?: AbortSignal): Promise<ExecResult> {
    const started = Date.now()
    const req: Parameters<WorkflowEngine['start']>[0] = {
      script: ROLLOUT_SCRIPT,
      meta: { name: 'harness2-rollout', description: `Harness2 probe rollout ${runId}`, phases: [{ title: 'Rollout' }] },
      args: { harness: renderHarnessPrompt(harness, this.opts.surface ?? DEFAULT_SURFACE), task: taskMessage(task), scratch: `.harness2-probes/${runId.replace(/[^\w.\-]/g, '_')}` },
      subagentProvider: this.opts.subagentProvider ?? 'spawn',
      maxTotalAgents: 1,
      parent: this.parent,
    }
    if (signal) req.signal = signal
    const watchDir = this.opts.watchDir ?? process.cwd()
    const scratchAbs = join(watchDir, (req.args as { scratch: string }).scratch)
    /** Files the probe produced in its scratch dir, excluding verbatim copies of the shared inputs. */
    const scratchFiles = (): string[] => {
      if (!existsSync(scratchAbs)) return []
      const fresh = new Map<string, number>()
      for (const [rel] of snapshotFiles(scratchAbs)) {
        const shared = join(watchDir, rel)
        if (existsSync(shared) && readFileSync(shared).equals(readFileSync(join(scratchAbs, rel)))) fresh.set(rel, statSync(join(scratchAbs, rel)).mtimeMs)
      }
      return producedFiles(scratchAbs, fresh)
    }
    let before: Map<string, number> | undefined
    try {
      before = snapshotFiles(watchDir)
    } catch {
      before = undefined
    }
    /** Writes outside `.harness2-probes/` during this probe's window void the rollout. */
    const escaped = (): string[] => {
      if (!before) return []
      try {
        const after = snapshotFiles(watchDir)
        return [...after.entries()].filter(([rel, m]) => before!.get(rel) !== m).map(([rel]) => rel).sort()
      } catch {
        return []
      }
    }
    const voidIfEscaped = (r: ExecResult): ExecResult => {
      const out = escaped()
      if (!out.length) return r
      return { ...r, ok: false, error: `probe wrote outside its scratch directory (shared workspace ${watchDir}): ${out.slice(0, 8).join(', ')}${out.length > 8 ? ', ...' : ''}` }
    }
    const run = this.engine.start(req)
    const onAbort = () => run.cancel('harness2 aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await run.result
      if (res.stopReason !== 'completed') {
        return voidIfEscaped({ ok: false, delivered: false, deliverable: '', trajectory: '', error: `workflow ${res.stopReason}: ${res.error ?? ''}`, wallMs: Date.now() - started, ref: run.id })
      }
      const v = (res.value ?? null) as { deliverable?: string; steps?: string[]; blockers?: string } | null
      const files = scratchFiles()
      if (!v) {
        // The child's structured report failed, but the work it left on disk is still the deliverable.
        const deliverable = files.join('\n\n')
        return voidIfEscaped({ ok: true, delivered: deliverable.trim().length > 0, deliverable, trajectory: '(child produced no structured report; deliverable reconstructed from the files it wrote in its scratch directory)', wallMs: Date.now() - started, ref: run.id })
      }
      const deliverable = [String(v.deliverable ?? ''), ...files].filter(x => x.trim()).join('\n\n')
      return voidIfEscaped({
        ok: true,
        delivered: deliverable.trim().length > 0,
        deliverable,
        trajectory: [...(v.steps ?? []).map((s, i) => `[STEP ${i + 1}] ${s}`), v.blockers ? `[BLOCKERS] ${v.blockers}` : ''].filter(Boolean).join('\n'),
        wallMs: Date.now() - started,
        ref: run.id,
      })
    } catch (e) {
      return voidIfEscaped({ ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message, wallMs: Date.now() - started, ref: run.id })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await run.dispose().catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------

export interface HeadlessExecutorOptions {
  /** Command to launch dsh (default `dsh`; e.g. `npx @deepseek-ai/dsh`, `pnpm dsh`). */
  command?: string
  /** Root under which each rollout gets an isolated workspace. */
  workRoot: string
  /** Seed directory copied into every workspace (the task's files). */
  seedDir?: string
  permissionMode?: string
  timeoutMs?: number
  /** Files (relative to the workspace) collected as the deliverable when present. */
  deliverableFiles?: string[]
  env?: Record<string, string>
  surface?: SurfaceSpec
  /** Keep workspaces after the run (default true, for audit). */
  keep?: boolean
  /** USD per million tokens for the agent model, to turn usage into cost. */
  price?: Price
}

/** The probe plugin module next to this file (`.js` when built, `.ts` under tests). */
export function probeModulePath(): string {
  const self = fileURLToPath(import.meta.url)
  return join(self, '..', `probe${extname(self)}`)
}

/** Paths an install or seed places in a probe workspace; excluded from produced-file collection. */
const INSTALLED = ['.git', '.harness2', '.harness2-probes', '.agents', 'AGENTS.md', '.harness2-probe.patch.yml']

/** Relative path -> mtime for every file under `dir`, skipping installed paths. */
export function snapshotFiles(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name)
      const rel = relative(dir, abs).split(sep).join('/')
      if (INSTALLED.some(p => rel === p || rel.startsWith(`${p}/`)) || name === 'node_modules' || name === '__pycache__') continue
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (st.isFile()) out.set(rel, st.mtimeMs)
    }
  }
  walk(dir)
  return out
}

/**
 * Files the agent created or changed since `before`, rendered for the deliverable.
 * Text files only, at most `maxFiles` files and `maxChars` per file.
 */
export function producedFiles(dir: string, before: Map<string, number>, maxFiles = 8, maxChars = 12_000): string[] {
  const after = snapshotFiles(dir)
  const changed = [...after.entries()].filter(([rel, m]) => before.get(rel) !== m).map(([rel]) => rel).sort()
  const out: string[] = []
  for (const rel of changed.slice(0, maxFiles)) {
    const buf = readFileSync(join(dir, rel))
    if (buf.includes(0)) {
      out.push(`<file path="${rel}">(binary, ${buf.length} bytes)</file>`)
      continue
    }
    const text = buf.toString('utf8')
    out.push(`<file path="${rel}">\n${text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text}\n</file>`)
  }
  if (changed.length > maxFiles) out.push(`(+${changed.length - maxFiles} more changed files not shown)`)
  return out
}

export interface HeadlessEvent {
  type: string
  [k: string]: unknown
}

/** Convert `dsh headless --json` events into a trajectory and final text. */
export function foldHeadlessEvents(lines: string[]): { trajectory: string; final: string; sessionId?: string; error?: string; usage?: TokenUsage } {
  const out: string[] = []
  let final = ''
  let error: string | undefined
  let usage: TokenUsage | undefined
  let usageComplete = true
  let sessionId: string | undefined
  for (const line of lines) {
    let ev: HeadlessEvent
    try {
      ev = JSON.parse(line) as HeadlessEvent
    } catch {
      continue
    }
    switch (ev.type) {
      case 'session':
        sessionId = String(ev['sessionId'] ?? '')
        break
      case 'text':
        out.push(`[ASSISTANT] ${String(ev['text'] ?? '')}`)
        break
      case 'tool_call':
        out.push(`[ACTION] ${String(ev['tool'] ?? '?')} ${JSON.stringify(ev['input'] ?? {})}`)
        break
      case 'tool_result':
        out.push(`[OBSERVATION${ev['status'] === 'error' ? ' ERROR' : ''}] ${String(ev['result'] ?? ev['error'] ?? '')}`)
        break
      case 'final':
        final = String(ev['text'] ?? '')
        break
      case 'status':
        if (ev['phase'] === 'step_end') {
          const u = ev['usage'] as Partial<TokenUsage> | undefined
          // dsh omits usage for a step when any attempt failed to report it: the total is then unknowable.
          if (u && typeof u.inputTokens === 'number') usage = addUsage(usage ?? { ...ZERO_USAGE }, u)
          else usageComplete = false
        }
        break
      case 'error':
        error = String(ev['message'] ?? 'unknown error')
        out.push(`[ERROR] ${error}`)
        break
      default:
        break
    }
  }
  const r: { trajectory: string; final: string; sessionId?: string; error?: string; usage?: TokenUsage } = { trajectory: out.join('\n'), final }
  if (sessionId) r.sessionId = sessionId
  if (error) r.error = error
  if (usage && usageComplete) r.usage = usage
  return r
}

/**
 * Highest-fidelity probe: a real `dsh` headless run. The harness is installed as the
 * workspace's `AGENTS.md` (loaded by `dsh-agent-instructions`) plus `.agents/skills/<name>/SKILL.md`
 * (discovered by `dsh-skill-filesystem`) and `.harness2/` (scripts, raw tree).
 */
export class HeadlessExecutor implements Executor {
  readonly name = 'dsh-headless'
  private readonly opts: HeadlessExecutorOptions

  constructor(opts: HeadlessExecutorOptions) {
    this.opts = opts
  }

  /** Directories never copied from a seed workspace: VCS data, dependencies, earlier probe output. */
  static readonly SEED_SKIP = new Set(['.git', 'node_modules', '.harness2', '.harness2-probes', '.venv', '__pycache__', '.dsh'])

  /** Copy a seed directory into a probe workspace, skipping heavy/private dirs and capping size. */
  static seed(src: string, dest: string, maxFiles = 2000, maxBytes = 50 * 1024 * 1024): void {
    let files = 0
    let bytes = 0
    cpSync(src, dest, {
      recursive: true,
      filter: (from: string) => {
        const base = from.split(/[\\/]/).pop() ?? ''
        if (from !== src && HeadlessExecutor.SEED_SKIP.has(base)) return false
        const st = statSync(from)
        if (st.isFile()) {
          files++
          bytes += st.size
          if (files > maxFiles || bytes > maxBytes) throw new Error(`seed workspace ${src} exceeds ${maxFiles} files / ${maxBytes} bytes; pass a smaller directory`)
        }
        return true
      },
    })
  }

  /**
   * Make a workspace its own project root. dsh resolves the project root (for `.agents/skills`
   * and the AGENTS.md chain) as the nearest ancestor containing `.git`; a workspace nested in some
   * other checkout would otherwise read -- and let the agent touch -- that outer repository.
   */
  static isolate(workspace: string): void {
    if (existsSync(join(workspace, '.git'))) return
    const r = spawnSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' })
    if (r.status !== 0) mkdirSync(join(workspace, '.git'), { recursive: true })
  }

  /** Install a harness into a workspace using the DSH-native discovery paths. */
  static install(workspace: string, harness: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE): void {
    HeadlessExecutor.isolate(workspace)
    writeTree(surface, harness, join(workspace, '.harness2'))
    // Policies enforced in-loop by the probe plugin are not also described in prose: the live runtime does not describe them either.
    writeFileSync(join(workspace, 'AGENTS.md'), `${renderHarnessPrompt(harness, surface, { inlineSkills: false, policiesAsProse: pluginNames(surface, harness).length === 0 })}\n`, 'utf8')
    if (pluginNames(surface, harness).length) {
      // Enforce the candidate's loop policies inside the probe process, exactly as the live runtime would.
      const patch = [
        '- insert:',
        '    - id: harness2-probe',
        `      name: ${JSON.stringify(probeModulePath())}`,
        '      config:',
        `        treeDir: ${JSON.stringify(join(workspace, '.harness2'))}`,
        '',
      ].join('\n')
      writeFileSync(join(workspace, '.harness2-probe.patch.yml'), patch, 'utf8')
    }
    for (const [rel, text] of Object.entries(harness)) {
      const m = new RegExp(`^${surface.skillDir}/([^/]+)/(.+)$`).exec(rel)
      if (!m) continue
      const dest = join(workspace, '.agents', 'skills', m[1] as string, m[2] as string)
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(dest, m[2] === 'SKILL.md' ? canonicalFrontmatter(text) : text, 'utf8')
    }
  }

  async execute(task: TaskSpec, harness: HarnessTree, runId: string, signal?: AbortSignal): Promise<ExecResult> {
    const started = Date.now()
    const ws = join(this.opts.workRoot, runId)
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    if (this.opts.seedDir && existsSync(this.opts.seedDir)) HeadlessExecutor.seed(this.opts.seedDir, ws)
    for (const [name, text] of Object.entries(task.sources ?? {})) {
      if (/^[\w.\-]+$/.test(name)) writeFileSync(join(ws, name), text, 'utf8')
    }
    HeadlessExecutor.install(ws, harness, this.opts.surface ?? DEFAULT_SURFACE)
    const [cmd, ...pre] = (this.opts.command ?? 'dsh').split(/\s+/).filter(Boolean)
    // dsh 0.2.1-rc.4 headless has no --permission-mode flag; its bundle patch reads
    // DSH_PERMISSION_MODE for the sandbox policy instead, which newer releases also honour.
    const probePatch = join(ws, '.harness2-probe.patch.yml')
    const args = [...pre, '--profile', 'headless', ...(existsSync(probePatch) ? ['--patch', probePatch] : []), '--json', '-']
    const before = snapshotFiles(ws)
    const lines: string[] = []
    let stderr = ''
    const code = await new Promise<number | string>(resolve => {
      const child = spawn(cmd as string, args, { cwd: ws, env: { ...process.env, DSH_PERMISSION_MODE: this.opts.permissionMode ?? 'workspace-write', ...this.opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let buf = ''
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-8000)
      })
      const kill = () => child.kill('SIGTERM')
      const timer = setTimeout(kill, this.opts.timeoutMs ?? 30 * 60_000)
      signal?.addEventListener('abort', kill, { once: true })
      child.on('error', e => {
        clearTimeout(timer)
        resolve(e.message)
      })
      child.on('close', c => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', kill)
        if (buf.trim()) lines.push(buf)
        resolve(c ?? -1)
      })
      child.stdin.end(taskMessage(task))
    })
    const folded = foldHeadlessEvents(lines)
    const files: string[] = []
    for (const rel of this.opts.deliverableFiles ?? []) {
      const p = join(ws, rel)
      if (existsSync(p)) files.push(`<file path="${rel}">\n${readFileSync(p, 'utf8')}\n</file>`)
    }
    for (const f of producedFiles(ws, before)) if (!files.some(x => x.startsWith(f.slice(0, f.indexOf('>') + 1)))) files.push(f)
    const deliverable = [folded.final, ...files].filter(s => s.trim()).join('\n\n')
    if (this.opts.keep === false) rmSync(ws, { recursive: true, force: true })
    const res: ExecResult = {
      ok: code === 0,
      delivered: deliverable.trim().length > 0,
      deliverable,
      trajectory: folded.trajectory,
      wallMs: Date.now() - started,
      ref: folded.sessionId ?? ws,
    }
    if (folded.usage) {
      res.usage = folded.usage
      const cost = costOf(folded.usage, this.opts.price)
      if (cost !== undefined) res.costUsd = cost
    }
    if (code !== 0) res.error = `dsh exited ${code}: ${folded.error ?? stderr.trim().slice(-600)}`
    else if (existsSync(probePatch) && /harness2-probe[\s\S]{0,200}(?:did not activate|failed to import)|did not activate[\s\S]{0,400}harness2-probe/.test(stderr)) {
      // The run happened, but without the candidate's loop policies: it does not measure this harness.
      res.ok = false
      res.error = `harness2-probe did not activate, so candidate policies were not enforced: ${stderr.trim().slice(-400)}`
    }
    return res
  }
}
