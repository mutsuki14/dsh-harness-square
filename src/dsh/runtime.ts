/**
 * `harness2-runtime` -- applies the ACTIVE harness to live DeepSeek Harness agents.
 *
 * | harness component                                     | DSH mechanism                                   |
 * |-------------------------------------------------------|-------------------------------------------------|
 * | systemprompt / guardrails / memory / tool_guidance    | `ctx.systemPrompt.section()` (dynamic text)     |
 * | skills + sub-agent briefs                             | `harness2_skill` tool (on-demand load)          |
 * | plugins/*.json  `pre` rules                           | `tools/pre-execute` waterfall (deny / ask)      |
 * | plugins/*.json  `post` rules                          | `tools/post-execute` waterfall (append reminder)|
 * | plugins/*.json  `stop` rules                          | `agent/turn-stopping` serial (`agent.steer`)    |
 *
 * The section text and policies are re-read from the service on every step, so activating a
 * new harness (e.g. after a Harness2 run) takes effect on the next model step with no restart.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { argsText, ruleMatches, validatePolicyPlugin, type PolicyRule } from '../core/policy.ts'
import { DEFAULT_SURFACE, frontmatter, pluginNames, skillNames, subagentNames, type HarnessTree, type SurfaceSpec } from '../core/tree.ts'
import { body, renderAlwaysOn, renderCatalog } from './render.ts'
import type { Harness2Service } from './service.ts'
import {
  createSteerMessage,
  onEvent,
  type AgentLike,
  type ContentBlock,
  type PostToolDecision,
  type PreToolDecision,
  type SystemPromptService,
  type ToolExecution,
  type ToolExecutionResult,
  type ToolsService,
} from './types.ts'

export const name = 'harness2-runtime'
export const inject = ['harness2', 'systemPrompt', 'tools']

export interface Config {
  /** Domain whose active harness this runtime applies. */
  domain?: string
  /** System-prompt section order (default: just after the deployment persona prefix). */
  sectionOrder: number
  /** Enforce plugin policies in the tool loop. */
  enforcePolicies: boolean
  /** Name of the on-demand skill tool. */
  skillToolName: string
}

export const Config: Schema<Config> = Schema.object({
  domain: Schema.string().description('Domain to apply; defaults to the service defaultDomain.'),
  sectionOrder: Schema.number().default(50),
  enforcePolicies: Schema.boolean().default(true),
  skillToolName: Schema.string().default('harness2_skill'),
}) as Schema<Config>

interface CompiledPolicies {
  pre: PolicyRule[]
  post: PolicyRule[]
  stop: PolicyRule[]
}

/** Compile every valid plugin in a harness into hook-indexed rules. */
export function compilePolicies(tree: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE): CompiledPolicies {
  const out: CompiledPolicies = { pre: [], post: [], stop: [] }
  for (const n of pluginNames(surface, tree)) {
    try {
      for (const r of validatePolicyPlugin(JSON.parse(tree[`${surface.pluginDir}/${n}.json`] ?? '')).rules) out[r.on].push(r)
    } catch {
      /* invalid plugins never reach activation; skip defensively */
    }
  }
  return out
}

/** The text of the always-on system-prompt section for a harness. */
export function sectionText(tree: HarnessTree, svc: Pick<Harness2Service, 'surface'>, skillTool: string): string {
  const always = renderAlwaysOn(tree, svc.surface)
  const catalog = renderCatalog(tree, svc.surface)
  if (!always && !catalog) return ''
  return [
    '# Operating harness',
    always,
    catalog && `## On-demand components\n\nLoad a skill or sub-agent brief with the \`${skillTool}\` tool when its trigger applies; do not load them speculatively.\n\n${catalog}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function apply(ctx: Context, config: Config): void {
  const svc = ctx.harness2
  const systemPrompt = (ctx as unknown as { systemPrompt: SystemPromptService }).systemPrompt
  const tools = (ctx as unknown as { tools: ToolsService }).tools
  const domain = () => config.domain || svc.config.defaultDomain

  // Cache the active harness; refresh when the service activates a new one.
  let tree: HarnessTree = svc.activeHarness(domain())
  let policies = compilePolicies(tree, svc.surface)
  onEvent(ctx, 'harness2/activated', (d: string, next: HarnessTree) => {
    if (d !== domain()) return
    tree = next
    policies = compilePolicies(tree, svc.surface)
  })

  // ---- always-on components -> one dynamic system-prompt section -------------
  systemPrompt.section({
    name: 'harness2:active',
    order: config.sectionOrder,
    interpolate: false,
    text: () => sectionText(tree, svc, config.skillToolName),
  })

  // ---- skills / sub-agent briefs -> on-demand tool ---------------------------
  tools.register({
    name: config.skillToolName,
    description:
      'Load one on-demand component of the operating harness: a skill (a reusable workflow) or a sub-agent brief ' +
      '(instructions to hand to a delegated agent). Call it only when the component trigger listed in the system prompt applies.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill or sub-agent name from the harness catalog.' },
        kind: { type: 'string', enum: ['skill', 'subagent'], description: 'Component kind (default skill).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const a = (args ?? {}) as { name?: string; kind?: string }
      const n = String(a.name ?? '').trim()
      const kind = a.kind === 'subagent' ? 'subagent' : 'skill'
      const s = svc.surface
      const rel = kind === 'skill' ? `${s.skillDir}/${n}/SKILL.md` : `${s.subagentDir}/${n}/AGENT.md`
      const text = tree[rel]
      if (!text) {
        const known = kind === 'skill' ? skillNames(s, tree) : subagentNames(s, tree)
        throw new Error(`no ${kind} named ${JSON.stringify(n)}; available: ${known.join(', ') || '(none)'}`)
      }
      const fm = frontmatter(text) ?? {}
      const helpers = Object.keys(tree).filter(r => r.startsWith(`${s.skillDir}/${n}/scripts/`))
      return [
        `# ${kind} \`${n}\`${fm['description'] ? ` -- ${fm['description']}` : ''}`,
        body(text),
        helpers.length ? `Helper files (in the harness tree):\n${helpers.map(h => `<file path="${h}">\n${tree[h]}\n</file>`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    },
  })

  if (!config.enforcePolicies) return

  // ---- plugins: pre rules -> tools/pre-execute -------------------------------
  onEvent(ctx, 'tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const hay = argsText(exec.arguments)
    for (const r of policies.pre) {
      if (!ruleMatches(r, exec.name, hay)) continue
      if (r.action === 'deny') return { kind: 'deny', reason: `[harness2 policy] ${r.message}` }
      if (r.action === 'ask') return { kind: 'ask', reason: `[harness2 policy] ${r.message}` }
    }
    return next()
  })

  // ---- plugins: post rules -> tools/post-execute -----------------------------
  onEvent(
    ctx,
    'tools/post-execute',
    async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
      const downstream = await next()
      if (downstream.kind !== 'accept' || downstream.value !== undefined) return downstream
      const args = argsText(exec.arguments)
      const resultText = result.content.map(b => (b.type === 'text' ? String((b as { text?: string }).text ?? '') : '')).join('\n')
      const reminders = policies.post.filter(r => ruleMatches(r, exec.name, r.matchResult ? resultText : args)).map(r => r.message)
      if (!reminders.length) return downstream
      const base: ContentBlock[] = downstream.content ?? [...result.content]
      const decision: PostToolDecision = { kind: 'accept', content: [...base, { type: 'text', text: `\n[harness2 policy] ${reminders.join(' ')}` }] }
      if (downstream.additionalContexts) decision.additionalContexts = downstream.additionalContexts
      return decision
    },
  )

  // ---- plugins: stop rules -> agent/turn-stopping ----------------------------
  const steered = new Map<string, number>()
  onEvent(ctx, 'agent/turn-stopping', async (payload: { agent: AgentLike; turn: number }) => {
    if (!policies.stop.length || typeof payload.agent?.steer !== 'function') return
    const key = `${payload.agent.id ?? payload.agent.sessionId ?? '?'}#${payload.turn}`
    const used = steered.get(key) ?? 0
    const budget = Math.max(...policies.stop.map(r => r.maxTimes ?? 1))
    if (used >= budget) return
    const rules = policies.stop.filter(r => (r.maxTimes ?? 1) > used)
    if (!rules.length) return
    const msg = await createSteerMessage(`[harness2 policy] ${rules.map(r => r.message).join(' ')}`, 'harness2 stop check')
    if (msg === undefined) return
    steered.set(key, used + 1)
    if (steered.size > 1000) steered.delete(steered.keys().next().value as string)
    payload.agent.steer(msg)
  })
}
