/**
 * Render a harness tree into the text an agent actually runs under.
 *
 * Used by every executor that cannot mount the harness as live DSH registrations (one-shot
 * LLM rollouts, workflow children, headless subprocesses). The in-process runtime
 * (`runtime.ts`) instead registers the same components as system-prompt sections, a skill
 * tool and loop policies.
 */

import { frontmatter, pluginNames, scriptPaths, skillNames, subagentNames, DEFAULT_SURFACE, type HarnessTree, type SurfaceSpec } from '../core/tree.ts'
import { validatePolicyPlugin } from '../core/policy.ts'

const TITLES: Record<string, string> = {
  'systemprompt.md': 'Role and procedure',
  'guardrails.md': 'Guardrails',
  'memory.md': 'Durable domain memory',
  'tool_guidance.md': 'Tool guidance',
}

/** The always-on block: what a DSH system-prompt section would contain. */
export function renderAlwaysOn(tree: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE): string {
  return surface.alwaysOn
    .filter(a => (tree[a] ?? '').trim())
    .map(a => `## ${TITLES[a] ?? a}\n\n${(tree[a] ?? '').trim()}`)
    .join('\n\n')
}

/** A catalog line per skill/subagent/script/plugin. */
export function renderCatalog(tree: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE): string {
  const lines: string[] = []
  for (const name of skillNames(surface, tree)) {
    const fm = frontmatter(tree[`${surface.skillDir}/${name}/SKILL.md`] ?? '') ?? {}
    lines.push(`- skill \`${name}\`: ${fm['description'] ?? ''}`)
  }
  for (const name of subagentNames(surface, tree)) {
    const fm = frontmatter(tree[`${surface.subagentDir}/${name}/AGENT.md`] ?? '') ?? {}
    lines.push(`- sub-agent \`${name}\`: ${fm['description'] ?? ''}`)
  }
  for (const rel of scriptPaths(surface, tree)) lines.push(`- script \`${rel}\``)
  return lines.join('\n')
}

/** Strip frontmatter from a component body. */
export function body(text: string): string {
  return text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

/** Loop-policy rules, rendered as prose for executors that cannot enforce them in the loop. */
export function renderPoliciesAsProse(tree: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE): string {
  const out: string[] = []
  for (const name of pluginNames(surface, tree)) {
    try {
      const p = validatePolicyPlugin(JSON.parse(tree[`${surface.pluginDir}/${name}.json`] ?? ''))
      for (const r of p.rules) {
        if (r.on === 'pre') out.push(`- ${r.action === 'deny' ? 'Never' : 'Ask before you'} call \`${r.tool}\`${r.match ? ` with arguments matching /${r.match}/` : ''}: ${r.message}`)
        else if (r.on === 'post') out.push(`- After each \`${r.tool}\` call: ${r.message}`)
        else out.push(`- Before you finish: ${r.message}`)
      }
    } catch {
      /* invalid plugins never pass validation; ignore defensively */
    }
  }
  return out.join('\n')
}

/**
 * Render the full harness as one system prompt (for one-shot / subprocess executors).
 * Skills are inlined because the executor cannot offer the on-demand tool; the prompt says so.
 */
export function renderHarnessPrompt(tree: HarnessTree, surface: SurfaceSpec = DEFAULT_SURFACE, opts: { inlineSkills?: boolean } = {}): string {
  const parts: string[] = []
  const always = renderAlwaysOn(tree, surface)
  if (always) parts.push(always)
  const policies = renderPoliciesAsProse(tree, surface)
  if (policies) parts.push(`## Loop policies\n\n${policies}`)
  const skills = skillNames(surface, tree)
  if (skills.length && opts.inlineSkills !== false) {
    parts.push(
      '## Skills\n\nUse a skill only when its trigger applies.\n\n' +
        skills.map(n => `### skill \`${n}\`\n\n${body(tree[`${surface.skillDir}/${n}/SKILL.md`] ?? '')}`).join('\n\n'),
    )
  }
  const agents = subagentNames(surface, tree)
  if (agents.length) {
    parts.push('## Sub-agent briefs\n\n' + agents.map(n => `### \`${n}\`\n\n${body(tree[`${surface.subagentDir}/${n}/AGENT.md`] ?? '')}`).join('\n\n'))
  }
  const scripts = scriptPaths(surface, tree)
  if (scripts.length) {
    parts.push('## Helper scripts\n\nThese files are available in the workspace under `.harness2/`:\n\n' + scripts.map(s => `- \`.harness2/${s}\``).join('\n'))
  }
  return parts.join('\n\n')
}
