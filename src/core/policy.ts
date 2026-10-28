/**
 * The plugin component (harness2 "c8"), made safe for DeepSeek Harness.
 *
 * In harness2 a plugin is a TypeScript file that acts inside the OpenCode tool loop. Loading
 * model-written code into a Cordis process would hand the proposer arbitrary in-process
 * authority, so here a plugin is a declarative JSON policy that the runtime compiles onto
 * DSH's documented interception points:
 *
 * - `pre`  -> `tools/pre-execute` waterfall: `deny` or `ask` a matching call.
 * - `post` -> `tools/post-execute` waterfall: append a reminder to a matching result.
 * - `stop` -> `agent/turn-stopping` serial: steer the agent once more before it stops.
 *
 * It keeps the property that matters (it acts in the loop, so the model cannot skip it)
 * while staying auditable and bounded.
 */

export type PolicyHook = 'pre' | 'post' | 'stop'

export interface PolicyRule {
  /** Interception point. */
  on: PolicyHook
  /** Tool name (exact) or `*`. Ignored for `stop`. */
  tool?: string
  /** Case-insensitive regular expression tested against the JSON-serialised arguments (pre/post) or result text (post). */
  match?: string
  /** pre: `deny` | `ask`; post: `remind`; stop: `steer`. */
  action: 'deny' | 'ask' | 'remind' | 'steer'
  /** Reason (deny/ask) or message (remind/steer) shown to the model. */
  message: string
  /** stop only: steer at most this many times per agent (default 1, max 3). */
  maxTimes?: number
  /** post only: test `match` against the result text instead of the arguments. */
  matchResult?: boolean
}

export interface PolicyPlugin {
  description: string
  rules: PolicyRule[]
}

const ACTIONS: Record<PolicyHook, readonly PolicyRule['action'][]> = {
  pre: ['deny', 'ask'],
  post: ['remind'],
  stop: ['steer'],
}

const MAX_RULES = 16
const MAX_MESSAGE = 600

/** Validate an untrusted policy document; throws a readable error. */
export function validatePolicyPlugin(doc: unknown): PolicyPlugin {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('plugin must be a JSON object')
  const d = doc as Record<string, unknown>
  if (typeof d['description'] !== 'string' || !d['description'].trim()) throw new Error('plugin needs a non-empty "description"')
  if (!Array.isArray(d['rules']) || d['rules'].length === 0) throw new Error('plugin needs a non-empty "rules" array')
  if (d['rules'].length > MAX_RULES) throw new Error(`plugin has ${d['rules'].length} rules; at most ${MAX_RULES}`)
  const rules: PolicyRule[] = d['rules'].map((raw, i) => {
    const where = `rules[${i}]`
    if (typeof raw !== 'object' || raw === null) throw new Error(`${where} must be an object`)
    const r = raw as Record<string, unknown>
    const on = r['on']
    if (on !== 'pre' && on !== 'post' && on !== 'stop') throw new Error(`${where}.on must be "pre", "post" or "stop"`)
    const action = r['action'] as PolicyRule['action']
    if (!ACTIONS[on].includes(action)) throw new Error(`${where}.action for "${on}" must be one of ${ACTIONS[on].join(', ')}`)
    const message = r['message']
    if (typeof message !== 'string' || !message.trim()) throw new Error(`${where}.message must be a non-empty string`)
    if (message.length > MAX_MESSAGE) throw new Error(`${where}.message is over ${MAX_MESSAGE} chars`)
    if (on !== 'stop' && (typeof r['tool'] !== 'string' || !r['tool'])) throw new Error(`${where}.tool is required for "${on}" (use "*" for every tool)`)
    if (r['match'] !== undefined) {
      if (typeof r['match'] !== 'string') throw new Error(`${where}.match must be a string`)
      try {
        new RegExp(r['match'], 'i')
      } catch (e) {
        throw new Error(`${where}.match is not a valid regular expression: ${(e as Error).message}`)
      }
    }
    if (on === 'pre' && action === 'deny' && r['tool'] === '*' && r['match'] === undefined) {
      throw new Error(`${where}: an unconditional deny of every tool would block all valid work`)
    }
    let maxTimes: number | undefined
    if (r['maxTimes'] !== undefined) {
      if (!Number.isInteger(r['maxTimes']) || (r['maxTimes'] as number) < 1 || (r['maxTimes'] as number) > 3) {
        throw new Error(`${where}.maxTimes must be an integer in 1..3`)
      }
      maxTimes = r['maxTimes'] as number
    }
    const rule: PolicyRule = { on, action, message: message.trim() }
    if (typeof r['tool'] === 'string') rule.tool = r['tool']
    if (typeof r['match'] === 'string') rule.match = r['match']
    if (maxTimes !== undefined) rule.maxTimes = maxTimes
    if (r['matchResult'] === true) rule.matchResult = true
    return rule
  })
  return { description: d['description'].trim(), rules }
}

/** Whether a pre/post rule applies to one call. */
export function ruleMatches(rule: PolicyRule, toolName: string, haystack: string): boolean {
  if (rule.tool !== undefined && rule.tool !== '*' && rule.tool !== toolName) return false
  if (rule.match === undefined) return true
  return new RegExp(rule.match, 'i').test(haystack)
}

/** Stringify tool arguments for matching, never throwing. */
export function argsText(args: unknown): string {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args) ?? ''
  } catch {
    return String(args)
  }
}
