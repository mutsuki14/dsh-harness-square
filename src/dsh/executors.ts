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

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Executor, Rollout, TaskSpec } from '../core/spec.ts'
import { DEFAULT_SURFACE, writeTree, type HarnessTree, type SurfaceSpec } from '../core/tree.ts'
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
export function toollessRollout(text: string, trajectory: string, wallMs: number): ExecResult {
  if (isUnexecutedToolCall(text)) {
    return { ok: true, delivered: false, deliverable: '', trajectory: `${trajectory}\n[RUNTIME] the solver emitted a tool call, but this executor has no tool loop; nothing was delivered`, wallMs, error: 'unexecuted tool call (toolless executor)' }
  }
  return { ok: true, delivered: text.trim().length > 0, deliverable: text, trajectory, wallMs }
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
      return toollessRollout(r.text, `[SYSTEM] harness rendered (${system.length} chars)\n[USER] ${task.prompt.slice(0, 500)}\n[ASSISTANT]\n${r.text}`, Date.now() - started)
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
      args: { harness: renderHarnessPrompt(harness, this.opts.surface ?? DEFAULT_SURFACE), task: taskMessage(task) },
      subagentProvider: this.opts.subagentProvider ?? 'spawn',
      maxTotalAgents: 1,
      parent: this.parent,
    }
    if (signal) req.signal = signal
    const run = this.engine.start(req)
    const onAbort = () => run.cancel('harness2 aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await run.result
      if (res.stopReason !== 'completed') {
        return { ok: false, delivered: false, deliverable: '', trajectory: '', error: `workflow ${res.stopReason}: ${res.error ?? ''}`, wallMs: Date.now() - started, ref: run.id }
      }
      const v = (res.value ?? null) as { deliverable?: string; steps?: string[]; blockers?: string } | null
      if (!v) return { ok: true, delivered: false, deliverable: '', trajectory: '(child failed before producing a report)', wallMs: Date.now() - started, ref: run.id }
      const deliverable = String(v.deliverable ?? '')
      return {
        ok: true,
        delivered: deliverable.trim().length > 0,
        deliverable,
        trajectory: [...(v.steps ?? []).map((s, i) => `[STEP ${i + 1}] ${s}`), v.blockers ? `[BLOCKERS] ${v.blockers}` : ''].filter(Boolean).join('\n'),
        wallMs: Date.now() - started,
        ref: run.id,
      }
    } catch (e) {
      return { ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message, wallMs: Date.now() - started, ref: run.id }
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
}

export interface HeadlessEvent {
  type: string
  [k: string]: unknown
}

/** Convert `dsh headless --json` events into a trajectory and final text. */
export function foldHeadlessEvents(lines: string[]): { trajectory: string; final: string; sessionId?: string; error?: string } {
  const out: string[] = []
  let final = ''
  let error: string | undefined
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
      case 'error':
        error = String(ev['message'] ?? 'unknown error')
        out.push(`[ERROR] ${error}`)
        break
      default:
        break
    }
  }
  const r: { trajectory: string; final: string; sessionId?: string; error?: string } = { trajectory: out.join('\n'), final }
  if (sessionId) r.sessionId = sessionId
  if (error) r.error = error
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

  /** Install a harness into a workspace using the DSH-native discovery paths. */
  static install(workspace: string, harness: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE): void {
    writeTree(surface, harness, join(workspace, '.harness2'))
    writeFileSync(join(workspace, 'AGENTS.md'), `${renderHarnessPrompt(harness, surface, { inlineSkills: false })}\n`, 'utf8')
    for (const [rel, text] of Object.entries(harness)) {
      const m = new RegExp(`^${surface.skillDir}/([^/]+)/(.+)$`).exec(rel)
      if (!m) continue
      const dest = join(workspace, '.agents', 'skills', m[1] as string, m[2] as string)
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(dest, text, 'utf8')
    }
  }

  async execute(task: TaskSpec, harness: HarnessTree, runId: string, signal?: AbortSignal): Promise<ExecResult> {
    const started = Date.now()
    const ws = join(this.opts.workRoot, runId)
    rmSync(ws, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
    if (this.opts.seedDir && existsSync(this.opts.seedDir)) cpSync(this.opts.seedDir, ws, { recursive: true })
    for (const [name, text] of Object.entries(task.sources ?? {})) {
      if (/^[\w.\-]+$/.test(name)) writeFileSync(join(ws, name), text, 'utf8')
    }
    HeadlessExecutor.install(ws, harness, this.opts.surface ?? DEFAULT_SURFACE)
    const [cmd, ...pre] = (this.opts.command ?? 'dsh').split(/\s+/).filter(Boolean)
    // dsh 0.2.1-rc.4 headless has no --permission-mode flag; its bundle patch reads
    // DSH_PERMISSION_MODE for the sandbox policy instead, which newer releases also honour.
    const args = [...pre, '--profile', 'headless', '--json', '-']
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
    if (code !== 0) res.error = `dsh exited ${code}: ${folded.error ?? stderr.trim().slice(-600)}`
    return res
  }
}
