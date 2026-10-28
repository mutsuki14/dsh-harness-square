/**
 * Structural views of the DeepSeek Harness services this bundle consumes.
 *
 * DSH public APIs are pre-stable ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES"), so the
 * bundle does not compile against `@deepseek-ai/dsh-*` types. It declares only the members
 * it calls -- each mirrors the upstream contract cited beside it -- and resolves services
 * at runtime through Cordis `inject` / `ctx.get()`.
 */

import type { Context } from '@deepseek-ai/cordis'

/** `@deepseek-ai/dsh-llm` ContentBlock subset. */
export type TextBlock = { type: 'text'; text: string }
export type ContentBlock = TextBlock | { type: string; [k: string]: unknown }

/** `@deepseek-ai/dsh-llm` StreamChunk (types.ts). */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; totalTokens?: number } }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'; failure?: { message?: string } & Record<string, unknown> } }

/** `@deepseek-ai/dsh-llm` GenerateOptions subset (one-shot caller form). */
export interface GenerateOptions {
  provider: string
  model: string
  system?: string
  messages: { role: 'user'; content: TextBlock[] }[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** `ctx.llm` (LlmRuntime). */
export interface LlmService {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  listProviders?(): string[]
}

/** `@deepseek-ai/dsh-system-prompt` PromptSection. */
export interface PromptSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

/** `ctx.systemPrompt`. */
export interface SystemPromptService {
  section(section: PromptSection): () => void
  getSectionOrder?(name: string): number
}

/** `@deepseek-ai/dsh-tools` ToolDefinition (raw JSON-Schema form accepted by `ctx.tools.register`). */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

/** `@deepseek-ai/dsh-tools` ToolExecution subset. */
export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: AgentLike
  readonly signal: AbortSignal
}

export interface ToolRunContext extends ToolExecution {
  deferContext?(context: unknown): void
  concludeTurn?(): void
}

/** `@deepseek-ai/dsh-tools` ToolExecutionResult subset. */
export interface ToolExecutionResult {
  readonly isError: boolean
  readonly content: ContentBlock[]
  readonly value?: unknown
}

/** `@deepseek-ai/dsh-tools` PreToolDecision. */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string }

/** `@deepseek-ai/dsh-tools` PostToolDecision subset. */
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: unknown[] }
  | { kind: 'accept'; value: unknown; content?: never; additionalContexts?: unknown[] }
  | { kind: 'block'; feedback: string; additionalContexts?: unknown[] }

/** `ctx.tools`. */
export interface ToolsService {
  register(tool: ToolDefinition): () => void
}

/** `@deepseek-ai/dsh-agent` Agent subset. */
export interface AgentLike {
  readonly id?: string
  readonly sessionId?: string
  steer?(message: unknown): void
}

/** `@deepseek-ai/dsh-workflow` WorkflowStartRequest / WorkflowRun / WorkflowResult. */
export interface WorkflowStartRequest {
  script: string
  meta: { name: string; description: string; phases?: { title: string; detail?: string }[] }
  args?: unknown
  subagentProvider?: string
  maxTotalAgents?: number
  parent: AgentLike
  signal?: AbortSignal
}

export interface WorkflowResult {
  stopReason: 'completed' | 'cancelled' | 'error'
  value?: unknown
  error?: string
  agentsStarted?: number
}

export interface WorkflowRun {
  readonly id: string
  readonly result: Promise<WorkflowResult>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

/** `ctx.workflowEngine`. */
export interface WorkflowEngine {
  start(request: WorkflowStartRequest): WorkflowRun
}

/** Typed-loose event registration for DSH events this package does not declare. */
export function onEvent(ctx: Context, name: string, listener: (...args: any[]) => unknown): () => boolean {
  return (ctx.on as unknown as (n: string, l: (...a: any[]) => unknown) => () => boolean).call(ctx, name, listener)
}

/** Resolve an optional service without making it a load dependency. */
export function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get(name: string): T | undefined }).get(name)
  } catch {
    return undefined
  }
}

/**
 * Build a durable user message for `agent.steer()` through `@deepseek-ai/dsh-llm` when the
 * host provides it (it always does inside DSH). Returns undefined elsewhere.
 */
export async function createSteerMessage(text: string, summary: string): Promise<unknown | undefined> {
  try {
    const mod = (await import('@deepseek-ai/dsh-llm' as string)) as {
      createUserMessage?: (input: unknown) => unknown
      boundContextSummary?: (s: string) => string
    }
    if (!mod.createUserMessage) return undefined
    const bounded = mod.boundContextSummary ? mod.boundContextSummary(summary) : summary.slice(0, 120)
    return mod.createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'harness2-policy', form: 'notice', summary: bounded },
    })
  } catch {
    return undefined
  }
}
