/**
 * The editable harness tree: eight components around the model, stored as a flat
 * `relative path -> content` map. Port of harness2 `core/tree.py`, re-shaped for the
 * DeepSeek Harness runtime.
 *
 * | path                         | component      | runtime reach                         |
 * |------------------------------|----------------|---------------------------------------|
 * | `systemprompt.md`            | system prompt  | always on (system-prompt section)     |
 * | `guardrails.md`              | guardrails     | always on                             |
 * | `memory.md`                  | memory         | always on                             |
 * | `tool_guidance.md`           | tool guidance  | always on                             |
 * | `skills/<name>/SKILL.md`     | skill          | on demand (`harness2_skill` tool)     |
 * | `sub_agents/<name>/AGENT.md` | subagent       | delegated, own context                |
 * | `scripts/<name>.{py,js,sh}`  | script         | run on demand through the shell       |
 * | `plugins/<name>.json`        | plugin         | declarative policy inside the tool loop |
 *
 * The edit contract is omitted-is-inherited: a proposal only emits what it changes.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { validatePolicyPlugin } from './policy.ts'

/** A harness: relative path -> file content. */
export type HarnessTree = Record<string, string>

const NAME = '[a-z0-9][a-z0-9_\\-]*'
/** Skill names follow DeepSeek Harness' skill grammar (kebab-case); dsh ignores any other name. */
const SKILL_NAME = '[a-z0-9]+(?:-[a-z0-9]+)*'

/** The editable surface: paths, caps and per-component rules. */
export interface SurfaceSpec {
  readonly alwaysOn: readonly string[]
  /** Character cap over the concatenated always-on text. */
  readonly alwaysOnMax: number
  readonly skillDir: string
  readonly subagentDir: string
  readonly scriptDir: string
  readonly pluginDir: string
  /** Script basenames the runtime reserves; proposals may not overwrite them. */
  readonly reservedScripts: ReadonlySet<string>
}

export const DEFAULT_SURFACE: SurfaceSpec = Object.freeze({
  alwaysOn: Object.freeze(['systemprompt.md', 'guardrails.md', 'memory.md', 'tool_guidance.md']),
  alwaysOnMax: 12_000,
  skillDir: 'skills',
  subagentDir: 'sub_agents',
  scriptDir: 'scripts',
  pluginDir: 'plugins',
  reservedScripts: new Set<string>(),
})

/** Build a surface with overrides (e.g. a deployment-specific always-on cap). */
export function surfaceWith(overrides: Partial<SurfaceSpec>): SurfaceSpec {
  return Object.freeze({ ...DEFAULT_SURFACE, ...overrides })
}

interface SurfaceRegexes {
  skill: RegExp
  skillScript: RegExp
  subagent: RegExp
  script: RegExp
  plugin: RegExp
  scriptRef: RegExp
}

const regexCache = new WeakMap<SurfaceSpec, SurfaceRegexes>()

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rx(surface: SurfaceSpec): SurfaceRegexes {
  let cached = regexCache.get(surface)
  if (cached) return cached
  const sd = esc(surface.skillDir)
  const sc = esc(surface.scriptDir)
  cached = {
    skill: new RegExp(`^${sd}/(${SKILL_NAME})/SKILL\\.md$`),
    skillScript: new RegExp(`^${sd}/${SKILL_NAME}/scripts/[A-Za-z0-9_.\\-]+$`),
    subagent: new RegExp(`^${esc(surface.subagentDir)}/(${NAME})/AGENT\\.md$`),
    script: new RegExp(`^${sc}/[a-z0-9_][a-z0-9_\\-]*\\.(?:py|js|mjs|sh)$`),
    plugin: new RegExp(`^${esc(surface.pluginDir)}/(${NAME})\\.json$`),
    scriptRef: new RegExp(`(?:python3?|node|bash|sh)\\s+((?:${sd}/[\\w\\-]+/)?${sc}/[\\w.\\-]+\\.(?:py|js|mjs|sh))`, 'g'),
  }
  regexCache.set(surface, cached)
  return cached
}

/** Normalise a relative path, rejecting escapes before it is joined to a directory. */
export function normalizeRel(rel: string): string {
  let r = String(rel).trim().replace(/\\/g, '/')
  if (r.startsWith('/') || r.split('/').includes('..')) {
    throw new Error(`path escapes the harness: ${JSON.stringify(rel)}`)
  }
  while (r.startsWith('./')) r = r.slice(2)
  return r.replace(/^\/+|\/+$/g, '')
}

/** Whether a path is on the editable surface. A predicate: never throws. */
export function isAllowed(surface: SurfaceSpec, rel: string): boolean {
  let r: string
  try {
    r = normalizeRel(rel)
  } catch {
    return false
  }
  if (surface.alwaysOn.includes(r)) return true
  const re = rx(surface)
  return re.skill.test(r) || re.skillScript.test(r) || re.subagent.test(r) || re.script.test(r) || re.plugin.test(r)
}

function namesOf(tree: HarnessTree, re: RegExp): string[] {
  const out = new Set<string>()
  for (const rel of Object.keys(tree)) {
    const m = re.exec(rel)
    if (m?.[1]) out.add(m[1])
  }
  return [...out].sort()
}

export const skillNames = (s: SurfaceSpec, t: HarnessTree): string[] => namesOf(t, rx(s).skill)
export const subagentNames = (s: SurfaceSpec, t: HarnessTree): string[] => namesOf(t, rx(s).subagent)
export const pluginNames = (s: SurfaceSpec, t: HarnessTree): string[] => namesOf(t, rx(s).plugin)
export const scriptPaths = (s: SurfaceSpec, t: HarnessTree): string[] =>
  Object.keys(t).filter(rel => rx(s).script.test(rel) || rx(s).skillScript.test(rel)).sort()

/** The concatenated always-on text, in surface order. */
export function alwaysOnText(surface: SurfaceSpec, tree: HarnessTree): string {
  return surface.alwaysOn.map(a => tree[a] ?? '').filter(Boolean).join('\n\n')
}

/** Parse a `---`-delimited YAML-ish frontmatter block into flat key/value pairs. */
export function frontmatter(text: string): Record<string, string> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.trimStart())
  if (!m?.[1]) return undefined
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv?.[1]) out[kv[1]] = (kv[2] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** Read every file on the editable surface below `dir`. Off-surface paths go to `rejected`. */
export function readTree(surface: SurfaceSpec, dir: string, rejected?: string[]): HarnessTree {
  const out: HarnessTree = {}
  let entries: string[]
  try {
    entries = walk(dir)
  } catch {
    return out
  }
  for (const abs of entries.sort()) {
    const rel = relative(dir, abs).split(sep).join('/')
    if (rel.split('/').some(part => part === '__pycache__' || part === 'node_modules')) continue
    if (!isAllowed(surface, rel)) {
      rejected?.push(rel)
      continue
    }
    out[rel] = readFileSync(abs, 'utf8')
  }
  return out
}

function walk(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) files.push(...walk(abs))
    else if (st.isFile()) files.push(abs)
  }
  return files
}

/**
 * Materialise an exact tree under `dest`. Editable files already there are replaced;
 * files off the surface are preserved. Always-on files exist even when empty.
 */
export function writeTree(surface: SurfaceSpec, tree: HarnessTree, dest: string): string {
  mkdirSync(dest, { recursive: true })
  let existing: string[] = []
  try {
    existing = walk(dest)
  } catch {
    existing = []
  }
  for (const abs of existing) {
    const rel = relative(dest, abs).split(sep).join('/')
    if (isAllowed(surface, rel)) rmSync(abs, { force: true })
  }
  for (const a of surface.alwaysOn) {
    if (!(a in tree)) writeFileSync(join(dest, a), '', 'utf8')
  }
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(dest, normalizeRel(rel))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return dest
}

/**
 * Give every skill a trigger line in always-on text so the agent knows when to load it.
 * Returns the names repaired. A line that would break the always-on cap is skipped.
 */
export function autotrigger(surface: SurfaceSpec, tree: HarnessTree): string[] {
  const fixed: string[] = []
  for (const name of skillNames(surface, tree)) {
    const body = alwaysOnText(surface, tree)
    if (body.includes(name)) continue
    const fm = frontmatter(tree[`${surface.skillDir}/${name}/SKILL.md`] ?? '') ?? {}
    // Tool-agnostic on purpose: the live runtime loads skills via harness2_skill, headless dsh via its own
    // `skill` tool, and a toolless probe has them inlined. Naming one tool breaks the others.
    const line = `- Use skill \`${name}\` when: ${fm['description'] || 'its situation arises'}`
    if (body.length + line.length + 2 > surface.alwaysOnMax) continue
    const target = 'tool_guidance.md'
    const prev = tree[target] ?? ''
    tree[target] = prev.trim() ? `${prev.trimEnd()}\n${line}\n` : `${line}\n`
    fixed.push(name)
  }
  return fixed
}

/** Phrases that would leak an evaluator's perspective into a harness. */
const GRADER_PATTERNS = [
  /\bthe grader (?:expects|wants|checks|rewards)\b/i,
  /\brubric (?:item|criteria|says|requires)\b/i,
  /\banswer key\b/i,
  /\breference solution\b/i,
  /\bto (?:maximi[sz]e|get) (?:a |the )?(?:higher |better )?score\b/i,
]

/** Throw when any file carries evaluator-facing language (harness2 `assert_tree_has_no_grader_verdicts`). */
export function assertNoGraderVerdicts(tree: HarnessTree): void {
  for (const [rel, text] of Object.entries(tree)) {
    for (const pat of GRADER_PATTERNS) {
      if (pat.test(text)) throw new Error(`${rel}: contains evaluator-facing language (${pat.source}); describe the work, not its measurement`)
    }
  }
}

export interface ValidateOptions {
  allowSubagents?: boolean
}

/** Validate a proposed tree. Throws one error listing every defect. */
export function validate(surface: SurfaceSpec, tree: HarnessTree, opts: ValidateOptions = {}): void {
  const errs: string[] = []
  const re = rx(surface)
  for (const rel of Object.keys(tree)) {
    if (!isAllowed(surface, rel)) errs.push(`${rel}: not on the editable surface`)
  }
  const body = alwaysOnText(surface, tree)
  if (body.length > surface.alwaysOnMax) {
    errs.push(`always-on text is ${body.length} chars, over the ${surface.alwaysOnMax} cap -- move procedure into skills`)
  }
  for (const name of skillNames(surface, tree)) {
    const rel = `${surface.skillDir}/${name}/SKILL.md`
    const fm = frontmatter(tree[rel] ?? '')
    if (!fm) errs.push(`${rel}: missing frontmatter (needs name: and description:)`)
    else {
      if (fm['name'] !== name) errs.push(`${rel}: frontmatter name ${JSON.stringify(fm['name'] ?? '')} must equal ${JSON.stringify(name)}`)
      if (!fm['description']) errs.push(`${rel}: frontmatter needs a description:`)
    }
    if (!body.includes(name)) errs.push(`${rel}: skill is never named in always-on text, so it would never be loaded`)
  }
  for (const rel of Object.keys(tree)) {
    if (re.skillScript.test(rel)) {
      const owner = rel.split('/')[1]
      if (!tree[`${surface.skillDir}/${owner}/SKILL.md`]) errs.push(`${rel}: helper script without its SKILL.md`)
    }
  }
  const agents = subagentNames(surface, tree)
  if (agents.length && opts.allowSubagents === false) errs.push('sub_agents are disabled for this deployment')
  for (const name of agents) {
    const rel = `${surface.subagentDir}/${name}/AGENT.md`
    const fm = frontmatter(tree[rel] ?? '')
    if (!fm?.['description']) errs.push(`${rel}: frontmatter needs a description:`)
  }
  for (const rel of scriptPaths(surface, tree)) {
    const base = rel.split('/').pop() ?? rel
    if (surface.reservedScripts.has(base)) errs.push(`${rel}: ${base} is reserved by the runtime`)
    if (!(tree[rel] ?? '').trim()) errs.push(`${rel}: empty script`)
  }
  for (const [rel, text] of Object.entries(tree)) {
    if (!rel.endsWith('.md')) continue
    for (const m of text.matchAll(re.scriptRef)) {
      const ref = m[1]
      if (ref && !(ref in tree)) errs.push(`${rel}: references ${ref}, which is not in the harness`)
    }
  }
  for (const name of pluginNames(surface, tree)) {
    const rel = `${surface.pluginDir}/${name}.json`
    try {
      validatePolicyPlugin(JSON.parse(tree[rel] ?? ''))
    } catch (e) {
      errs.push(`${rel}: ${(e as Error).message}`)
    }
  }
  try {
    assertNoGraderVerdicts(tree)
  } catch (e) {
    errs.push((e as Error).message)
  }
  if (errs.length) throw new Error(errs.join('\n'))
}

export interface TreeDiff {
  added: string[]
  removed: string[]
  modified: string[]
}

/** Path-level diff; empty always-on files count as absent. */
export function diffSummary(before: HarnessTree, after: HarnessTree): TreeDiff {
  const live = (t: HarnessTree) => new Set(Object.keys(t).filter(k => (t[k] ?? '').trim() !== ''))
  const a = live(before)
  const b = live(after)
  return {
    added: [...b].filter(k => !a.has(k)).sort(),
    removed: [...a].filter(k => !b.has(k)).sort(),
    modified: [...b].filter(k => a.has(k) && before[k] !== after[k]).sort(),
  }
}

export function isUnchanged(before: HarnessTree, after: HarnessTree): boolean {
  const d = diffSummary(before, after)
  return !d.added.length && !d.removed.length && !d.modified.length
}

/** Pairwise mean line-Jaccard over the final harnesses (harness2 `diversity`). */
export function diversity(trees: Record<string, HarnessTree>): { n: number; nDistinct: number; meanLineJaccard: number } {
  const names = Object.keys(trees)
  const lines = (t: HarnessTree) =>
    new Set(Object.entries(t).flatMap(([rel, text]) => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => `${rel}:${l}`)))
  const sets = names.map(n => lines(trees[n] ?? {}))
  const distinct = new Set(names.map(n => JSON.stringify(Object.entries(trees[n] ?? {}).sort())))
  let total = 0
  let pairs = 0
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!
      const b = sets[j]!
      const inter = [...a].filter(x => b.has(x)).length
      const union = new Set([...a, ...b]).size
      total += union ? inter / union : 1
      pairs++
    }
  }
  return { n: names.length, nDistinct: distinct.size, meanLineJaccard: pairs ? Number((total / pairs).toFixed(4)) : 1 }
}

/** A one-line census of the components in a harness. */
export function inventory(surface: SurfaceSpec, tree: HarnessTree): string {
  const bits: string[] = []
  const s = skillNames(surface, tree).length
  const a = subagentNames(surface, tree).length
  const sc = scriptPaths(surface, tree).length
  const p = pluginNames(surface, tree).length
  if (s) bits.push(`${s} skill${s > 1 ? 's' : ''}`)
  if (a) bits.push(`${a} sub-agent${a > 1 ? 's' : ''}`)
  if (sc) bits.push(`${sc} script${sc > 1 ? 's' : ''}`)
  if (p) bits.push(`${p} plugin${p > 1 ? 's' : ''}`)
  return `${bits.join(', ') || 'always-on only'}; ${alwaysOnText(surface, tree).length.toLocaleString('en-US')} always-on chars`
}
