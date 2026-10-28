/**
 * Improver channels.
 *
 * - `LlmImprover`      streams through DSH's provider-neutral `ctx.llm` service (any registered
 *                      adapter: `deepseek-official`, pi-ai routes, ...). This is the in-harness path.
 * - `DeepSeekApiImprover` calls the DeepSeek OpenAI-compatible HTTP API directly, for the
 *                      standalone CLI outside a DSH process.
 *
 * Both retry transport failures (harness2 `TRANSPORT_ATTEMPTS`) and never retry a model reply.
 */

import { costOf, ImproverError, type Improver, type ImproverReply, type ImproverRequest, type Price } from '../core/spec.ts'
import type { LlmService } from './types.ts'

export interface LlmImproverOptions {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  /** Transport attempts per call (default 3). */
  attempts?: number
  /** USD per million tokens, to turn usage into cost. */
  price?: Price
  /** Optional audit sink: every request/response pair. */
  audit?: (entry: { label: string; mission: string; text: string; error?: string }) => void
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const ms = Math.min(8000, 500 * 2 ** (attempt - 1))
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

/** Stream one completion through `ctx.llm` and return its text. */
export async function streamText(llm: LlmService, opts: { provider: string; model: string; system?: string; prompt: string; temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  const req: Parameters<LlmService['stream']>[0] = {
    provider: opts.provider,
    model: opts.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }],
  }
  if (opts.system) req.system = opts.system
  if (opts.temperature !== undefined) req.temperature = opts.temperature
  if (opts.maxTokens !== undefined) req.maxTokens = opts.maxTokens
  if (opts.signal) req.signal = opts.signal
  for await (const chunk of llm.stream(req)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      inputTokens = chunk.usage.inputTokens
      outputTokens = chunk.usage.outputTokens
    } else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        throw new ImproverError(`model call ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'unknown failure'}`)
      }
    }
  }
  return { text, inputTokens, outputTokens }
}

export class LlmImprover implements Improver {
  readonly name = 'dsh-llm'
  private readonly llm: LlmService
  private readonly opts: LlmImproverOptions

  constructor(llm: LlmService, opts: LlmImproverOptions) {
    this.llm = llm
    this.opts = opts
  }

  async call(req: ImproverRequest): Promise<ImproverReply> {
    const attempts = this.opts.attempts ?? 3
    let last: Error | undefined
    for (let i = 1; i <= attempts; i++) {
      try {
        const args: Parameters<typeof streamText>[1] = { provider: this.opts.provider, model: this.opts.model, system: req.system, prompt: req.mission }
        if (this.opts.temperature !== undefined) args.temperature = this.opts.temperature
        if (this.opts.maxTokens !== undefined) args.maxTokens = this.opts.maxTokens
        if (req.signal) args.signal = req.signal
        const r = await streamText(this.llm, args)
        if (!r.text.trim()) throw new ImproverError('empty reply')
        this.opts.audit?.({ label: req.label, mission: req.mission, text: r.text })
        const reply: ImproverReply = { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens }
        const cost = costOf(r, this.opts.price)
        if (cost !== undefined) reply.costUsd = cost
        return reply
      } catch (e) {
        last = e as Error
        if (req.signal?.aborted) break
        if (i < attempts) await backoff(i, req.signal).catch(() => undefined)
      }
    }
    this.opts.audit?.({ label: req.label, mission: req.mission, text: '', error: last?.message ?? 'unknown' })
    throw new ImproverError(`[${req.label}] ${last?.message ?? 'improver failed'}`)
  }
}

export interface DeepSeekApiOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  attempts?: number
  timeoutMs?: number
  price?: Price
}

/** Minimal chat-completions client for the DeepSeek API (OpenAI-compatible). */
export async function deepseekChat(opts: DeepSeekApiOptions, system: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const base = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), opts.timeoutMs ?? 600_000)
  const onAbort = () => ctl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const body: Record<string, unknown> = {
      model: opts.model ?? 'deepseek-flash',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      stream: false,
    }
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature
    if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) throw new ImproverError(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 400)}`)
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export class DeepSeekApiImprover implements Improver {
  readonly name = 'deepseek-api'
  private readonly opts: DeepSeekApiOptions

  constructor(opts: DeepSeekApiOptions) {
    if (!opts.apiKey) throw new Error('DeepSeekApiImprover needs an API key (DEEPSEEK_API_KEY)')
    this.opts = opts
  }

  async call(req: ImproverRequest): Promise<ImproverReply> {
    const attempts = this.opts.attempts ?? 3
    let last: Error | undefined
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await deepseekChat(this.opts, req.system, req.mission, req.signal)
        if (!r.text.trim()) throw new ImproverError('empty reply')
        const reply: ImproverReply = { ...r }
        const cost = costOf(r, this.opts.price)
        if (cost !== undefined) reply.costUsd = cost
        return reply
      } catch (e) {
        last = e as Error
        if (req.signal?.aborted) break
        if (i < attempts) await backoff(i, req.signal).catch(() => undefined)
      }
    }
    throw new ImproverError(`[${req.label}] ${last?.message ?? 'improver failed'}`)
  }
}
