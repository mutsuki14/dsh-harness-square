/**
 * `harness2-tools` -- model-facing control of Harness2.
 *
 * - `harness2_improve`  run one recursive-harnessing step (ProposeProbeCompose + selection +
 *                       reflection) for a task, and activate the adopted harness for its domain.
 * - `harness2_status`   inspect the active harness, the domain's experience library and runs.
 * - `harness2_reset`    restore a domain's default starting harness.
 *
 * The workflow executor runs each probe as a fresh child of the CALLING agent
 * (`exec.agent`), so probes inherit its sandbox and approval policy.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { renderTreeDiff } from '../core/protocol.ts'
import type { Mode } from '../core/recursion.ts'
import { inventory } from '../core/tree.ts'
import { DEFAULT_BASE_TREE } from './defaults.ts'
import type { ExecutorKind } from './service.ts'
import type { SystemPromptService, ToolRunContext, ToolsService } from './types.ts'

export const name = 'harness2-tools'
export const inject = ['harness2', 'tools']

export interface Config {
  /** Register the improvement tool (it can spend 4k rollouts + 3k improver calls + selection/reflection). */
  enableImprove: boolean
  /** Add a usage-policy system-prompt section when `ctx.systemPrompt` is available. */
  policySection: boolean
  /** Cooperative deadline for one improvement run, in ms (0 = none). */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  enableImprove: Schema.boolean().default(true),
  policySection: Schema.boolean().default(true),
  timeoutMs: Schema.number().min(0).default(0),
}) as Schema<Config>

const text = (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export function apply(ctx: Context, config: Config): void {
  const svc = ctx.harness2
  const tools = (ctx as unknown as { tools: ToolsService }).tools
  const systemPrompt = (ctx as unknown as { get(n: string): SystemPromptService | undefined }).get('systemPrompt')

  if (config.policySection && systemPrompt) {
    systemPrompt.section({
      name: 'tool:harness2',
      order: (systemPrompt.getSectionOrder?.('TOOL_WORKFLOW') ?? 2600) + 50,
      interpolate: false,
      text:
        'Use harness2_improve ONLY when the human explicitly asks to improve, tune or "harness" how the agent works on a task. ' +
        'It runs the task several times under candidate harnesses (prompts, skills, scripts, sub-agent briefs, loop policies), ' +
        'composes a refined harness from the behavioural contrasts, and activates it for the domain. It is expensive: say so before ' +
        'using a budget k above 1. Use harness2_status to explain what the active harness contains.',
    })
  }

  if (config.enableImprove) {
    tools.register({
      name: 'harness2_improve',
      description:
        'Recursively improve the operating harness for one task (Harness2 ProposeProbeCompose). Rolls the task under the current ' +
        'harness k times, proposes k procedure (INV) and k domain-knowledge (DOM) edits, probes each, composes refined harnesses, ' +
        'blind-selects the best output, records an evidence-backed lesson in the domain library, and activates the adopted harness. ' +
        'Spends 4k rollouts and 3k improver calls plus selection and reflection.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The complete request the agent should get better at, verbatim.' },
          domain: { type: 'string', description: 'Domain key for the experience library and active harness (e.g. "legal-contracts").' },
          work: { type: 'string', description: 'One paragraph describing the kind of work (not how it is measured). Optional.' },
          sources: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional source material: name -> text.' },
          k: { type: 'integer', minimum: 1, maximum: 8, description: 'Task-level recursion budget (default from config; capped by maxK).' },
          mode: { type: 'string', enum: ['parallel', 'sequential'], description: 'parallel explores wider; sequential refines deeper.' },
          executor: { type: 'string', enum: ['workflow', 'llm', 'headless'], description: 'How probes run (default from config).' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          const v = value as Record<string, unknown>
          return [{ type: 'text', text: String(v['report'] ?? JSON.stringify(v, null, 2)) }]
        },
      },
      async execute(args, exec: ToolRunContext) {
        const a = args as { task: string; domain?: string; work?: string; sources?: Record<string, string>; k?: number; mode?: Mode; executor?: ExecutorKind }
        const task = String(a.task ?? '').trim()
        if (!task) throw new Error('harness2_improve: task must be a non-empty string')
        const domain = (a.domain ?? svc.config.defaultDomain).trim() || svc.config.defaultDomain
        let signal = exec.signal
        if (config.timeoutMs > 0) signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
        const before = svc.activeHarness(domain)
        const req: Parameters<typeof svc.improve>[0] = {
          task: { id: `${domain}/${Date.now().toString(36)}`, domain, prompt: task, ...(a.sources ? { sources: a.sources } : {}) },
          signal,
        }
        if (a.work?.trim()) req.work = { work: a.work.trim() }
        if (a.k !== undefined) req.k = a.k
        if (a.mode) req.mode = a.mode
        if (a.executor) req.executor = a.executor
        if (exec.agent) req.parent = exec.agent
        const r = await svc.improve(req)
        const diff = renderTreeDiff(before, r.adoptedTree, 200)
        const report = [
          `Harness2 ${r.mode} k=${r.k} on domain \`${domain}\`: adopted \`${r.selection.chosenLabel || '(none)'}\`${r.selection.fellBack ? ' (selector fallback)' : ''}.`,
          r.selection.why && `Why: ${r.selection.why}`,
          `Budget: R=${r.modeResult.ledger.R} rollouts, P=${r.modeResult.ledger.P} improver stages.`,
          `Stages fell back: ${r.modeResult.stages.filter(s => s.fellBack).map(s => s.label).join(', ') || 'none'}; kept base: ${r.modeResult.stages.filter(s => s.keptBase).map(s => s.label).join(', ') || 'none'}.`,
          r.selection.experience ? `Lesson recorded -- cue: ${r.selection.experience.cue}\nlesson: ${r.selection.experience.lesson}` : 'No transferable lesson was supported by the evidence (NO_ENTRY).',
          `Active harness for \`${domain}\`: ${inventory(svc.surface, svc.activeHarness(domain))}`,
          `Change vs. previous active harness:\n${diff}`,
        ]
          .filter(Boolean)
          .join('\n\n')
        return {
          adopted: r.selection.chosenLabel,
          domain,
          k: r.k,
          mode: r.mode,
          libraryUpdated: r.libraryUpdated,
          report,
        }
      },
    })
  }

  tools.register({
    name: 'harness2_status',
    description: 'Show the active Harness2 harness for a domain, the lessons in its experience library, and recent improvement runs.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain key (default: the configured default domain).' },
        full: { type: 'boolean', description: 'Include the full content of every harness file.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: text },
    isConcurrencySafe: () => true,
    async execute(args) {
      const a = (args ?? {}) as { domain?: string; full?: boolean }
      const domain = a.domain?.trim() || svc.config.defaultDomain
      const tree = svc.activeHarness(domain)
      const files = Object.keys(tree).sort()
      const lessons = svc.library
        .entries(domain)
        .map(s => svc.library.entry(domain, s))
        .filter(Boolean)
        .map(e => `- \`${e!.taskId}\` (${e!.label}): cue: ${e!.experience.cue} | lesson: ${e!.experience.lesson}`)
      const runs = svc
        .listRuns()
        .slice(-10)
        .map(r => `- ${r.id} ${r.status} task=${r.taskId}${r.adopted ? ` adopted=${r.adopted}` : ''}${r.error ? ` error=${r.error}` : ''}`)
      return [
        `# Harness2 -- domain \`${domain}\``,
        `Active harness (source: ${svc.activeSource(domain)}): ${inventory(svc.surface, tree)}`,
        a.full ? Object.entries(tree).map(([rel, t]) => `<file path="${rel}">\n${t.trimEnd()}\n</file>`).join('\n') : `Files: ${files.join(', ')}`,
        `## Library (${lessons.length})\n${lessons.join('\n') || '_(empty)_'}`,
        `## Runs this session\n${runs.join('\n') || '_(none)_'}`,
      ].join('\n\n')
    },
  })

  tools.register({
    name: 'harness2_reset',
    description: 'Restore the default starting harness for a domain (the experience library is kept). Use only when the human asks.',
    parameters: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Domain key.' } },
      required: ['domain'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: text },
    async execute(args) {
      const domain = String((args as { domain?: string }).domain ?? '').trim()
      if (!domain) throw new Error('harness2_reset: domain is required')
      svc.reset(domain)
      return `Reset \`${domain}\` to the default harness: ${inventory(svc.surface, DEFAULT_BASE_TREE)}`
    },
  })
}
