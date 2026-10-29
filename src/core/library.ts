/**
 * The per-domain experience library R -- harnessing-level recursion (harness2
 * `core/library.py`). After each task the adopted harness and an evidence-supported lesson
 * are stored; the next task in the same domain reads them before refinement.
 *
 *     <root>/<domain>/INDEX.md
 *     <root>/<domain>/harnesses/<task>/harness/<rel>   the full adopted tree
 *     <root>/<domain>/harnesses/<task>/EXPERIENCE.md   why picked + lesson
 *     <root>/<domain>/harnesses/<task>/entry.json      machine-readable record
 *
 * Retrieval is by construction: a domain directory only ever holds same-domain entries.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Experience } from './protocol.ts'
import { assertNoGraderVerdicts, inventory, readTree, writeTree, type HarnessTree, type SurfaceSpec } from './tree.ts'

export function slug(id: string): string {
  return id.replace(/[/\\]/g, '__').replace(/[^\w.\-]/g, '_')
}

export function domainDir(domain: string): string {
  return domain.replace(/\s*[/\\]\s*/g, '__').trim() || 'unknown'
}

export interface LibraryEntry {
  taskId: string
  label: string
  why: string
  experience: Experience
  addedAt: string
}

export function hasExperience(e: Partial<Experience> | undefined): e is Experience {
  return !!e && ['cue', 'lesson', 'evidence'].every(k => typeof (e as Record<string, unknown>)[k] === 'string' && ((e as Record<string, string>)[k] ?? '').trim() !== '')
}

export class ExperienceLibrary {
  readonly root: string
  readonly surface: SurfaceSpec

  constructor(root: string, surface: SurfaceSpec) {
    this.root = root
    this.surface = surface
  }

  dir(domain: string): string {
    return join(this.root, domainDir(domain))
  }

  private entryDir(domain: string, taskId: string): string {
    return join(this.dir(domain), 'harnesses', slug(taskId))
  }

  entries(domain: string): string[] {
    const d = join(this.dir(domain), 'harnesses')
    return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []
  }

  entry(domain: string, taskSlug: string): LibraryEntry | undefined {
    const p = join(this.dir(domain), 'harnesses', taskSlug, 'entry.json')
    if (!existsSync(p)) return undefined
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as LibraryEntry
    } catch {
      return undefined
    }
  }

  treeOf(domain: string, taskSlug: string): HarnessTree {
    return readTree(this.surface, join(this.dir(domain), 'harnesses', taskSlug, 'harness'))
  }

  /**
   * Record the domain's CURRENT harness: the latest adopted tree, whether or not reflection found a
   * lesson worth a library entry. Entries stay lesson-gated (harness2); the warm start must not be,
   * or an adoption with no transferable lesson is silently lost for the next task.
   */
  setCurrent(domain: string, taskId: string, harness: HarnessTree, label: string): void {
    assertNoGraderVerdicts(harness)
    const d = join(this.dir(domain), 'current')
    rmSync(join(d, 'harness'), { recursive: true, force: true })
    writeTree(this.surface, harness, join(d, 'harness'))
    writeFileSync(join(d, 'current.json'), `${JSON.stringify({ taskId, label, adoptedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  }

  current(domain: string): { taskSlug: string; label: string; tree: HarnessTree } | undefined {
    const d = join(this.dir(domain), 'current')
    const p = join(d, 'current.json')
    if (!existsSync(p)) return undefined
    try {
      const meta = JSON.parse(readFileSync(p, 'utf8')) as { taskId: string; label: string }
      const tree = readTree(this.surface, join(d, 'harness'))
      return Object.keys(tree).length ? { taskSlug: slug(meta.taskId), label: meta.label, tree } : undefined
    } catch {
      return undefined
    }
  }

  /** The most recent library entry in a domain (fallback warm start for libraries written before `current`). */
  latest(domain: string): { taskSlug: string; entry: LibraryEntry; tree: HarnessTree } | undefined {
    const all = this.entries(domain)
      .map(s => ({ taskSlug: s, entry: this.entry(domain, s) }))
      .filter((x): x is { taskSlug: string; entry: LibraryEntry } => !!x.entry)
      .sort((a, b) => a.entry.addedAt.localeCompare(b.entry.addedAt))
    const last = all.at(-1)
    return last ? { ...last, tree: this.treeOf(domain, last.taskSlug) } : undefined
  }

  /** Store one adopted harness plus why it was adopted; returns false when there is no supported lesson. */
  add(domain: string, taskId: string, harness: HarnessTree, opts: { label: string; why: string; experience?: Experience }): boolean {
    if (!hasExperience(opts.experience)) return false
    assertNoGraderVerdicts(harness)
    assertNoGraderVerdicts({ 'EXPERIENCE.md': JSON.stringify(opts.experience) + opts.why })
    const d = this.entryDir(domain, taskId)
    rmSync(join(d, 'harness'), { recursive: true, force: true })
    writeTree(this.surface, harness, join(d, 'harness'))
    const exp = opts.experience
    const lines = [
      `# ${taskId}`,
      '',
      `- adopted: \`${opts.label}\``,
      `- components: ${inventory(this.surface, harness)}`,
      '',
    ]
    if (opts.why.trim()) lines.push('## Why this was chosen', opts.why.trim(), '')
    if (exp.edits) lines.push('## What each edit did', exp.edits.trim(), '')
    lines.push('## Transferable lesson')
    for (const f of ['cue', 'lesson', 'evidence', 'confidence'] as const) {
      if (exp[f]) lines.push(`- **${f}**: ${String(exp[f]).trim()}`)
    }
    lines.push('')
    writeFileSync(join(d, 'EXPERIENCE.md'), lines.join('\n'), 'utf8')
    const entry: LibraryEntry = { taskId, label: opts.label, why: opts.why, experience: exp, addedAt: new Date().toISOString() }
    writeFileSync(join(d, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    this.rebuildIndex(domain)
    return true
  }

  forget(domain: string, taskIds: string[]): void {
    for (const t of taskIds) rmSync(this.entryDir(domain, t), { recursive: true, force: true })
    this.rebuildIndex(domain)
  }

  rebuildIndex(domain: string): string {
    const rows = [
      `# Library -- ${domain}`,
      '',
      'Each entry is an earlier task in THIS domain whose harness was adopted, stored with its full component tree and why it was picked.',
      '',
    ]
    const names = this.entries(domain)
    if (!names.length) rows.push('_(empty -- this is the first task in this domain)_')
    for (const name of names) {
      const e = this.entry(domain, name)
      rows.push(`## \`harnesses/${name}/\``, `- harness: ${inventory(this.surface, this.treeOf(domain, name))}`)
      if (e?.experience.cue) rows.push(`- cue: ${e.experience.cue}`)
      rows.push('')
    }
    mkdirSync(this.dir(domain), { recursive: true })
    const p = join(this.dir(domain), 'INDEX.md')
    writeFileSync(p, rows.join('\n'), 'utf8')
    return p
  }

  /**
   * Render the library for an improver prompt: every lesson, plus the full tree of the most
   * recent `maxTrees` entries (harness2 carries whole trees, never summaries).
   */
  render(domain: string, maxTrees = 2, maxChars = 30_000): string {
    const names = this.entries(domain)
    if (!names.length) return ''
    const out: string[] = []
    const recent = new Set(names.slice(-maxTrees))
    for (const name of names) {
      const e = this.entry(domain, name)
      if (!e) continue
      out.push(
        `### \`${e.taskId}\` (adopted \`${e.label}\`)\n- cue: ${e.experience.cue}\n- lesson: ${e.experience.lesson}\n- evidence: ${e.experience.evidence}` +
          (e.experience.confidence ? `\n- confidence: ${e.experience.confidence}` : ''),
      )
      if (recent.has(name)) {
        const tree = this.treeOf(domain, name)
        const files = Object.entries(tree)
          .filter(([, v]) => v.trim())
          .map(([rel, v]) => `<file path="${rel}">\n${v.trimEnd()}\n</file>`)
        if (files.length) out.push(`<adopted_harness task="${e.taskId}">\n${files.join('\n')}\n</adopted_harness>`)
      }
    }
    const text = out.join('\n\n')
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[library truncated]` : text
  }
}
