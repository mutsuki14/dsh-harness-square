/**
 * The improver's reply protocol.
 *
 * harness2 hands a CLI agent a directory and harvests the edited `context/harness/` tree.
 * A DSH improver is a single model call, so edits travel as text instead:
 *
 *     <file path="skills/doc-review/SKILL.md">
 *     ...full new content...
 *     </file>
 *     <delete path="memory.md"/>
 *     <keep_base/>                       (explicitly change nothing)
 *     <notes>kept|revised|dropped -> ... -> evidence</notes>
 *
 * Omitted files are inherited unchanged (omitted-is-inherited). Selection replies carry a
 * ```choice block; reflection replies carry <edits> and <experience> (or NO_ENTRY).
 */

import { normalizeRel, type HarnessTree } from './tree.ts'

export interface ParsedEdits {
  writes: Record<string, string>
  deletes: string[]
  keepBase: boolean
  notes: string
  /** Paths the reply tried to touch that escape the harness. */
  invalid: string[]
}

const FILE_RE = /<file\s+path\s*=\s*"([^"]+)"\s*>\r?\n?([\s\S]*?)<\/file>/g
const DELETE_RE = /<delete\s+path\s*=\s*"([^"]+)"\s*\/?>(?:\s*<\/delete>)?/g
const NOTES_RE = /<notes>([\s\S]*?)<\/notes>/
const KEEP_RE = /<keep_base\s*\/?>|\bKEEP_BASE\b/

/** Strip one level of ``` fencing a model may wrap around file content. */
function unfence(body: string): string {
  const m = /^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(body)
  return m?.[1] !== undefined ? `${m[1]}\n` : body
}

export function parseEdits(text: string): ParsedEdits {
  const out: ParsedEdits = { writes: {}, deletes: [], keepBase: false, notes: '', invalid: [] }
  for (const m of text.matchAll(FILE_RE)) {
    const raw = m[1] ?? ''
    try {
      out.writes[normalizeRel(raw)] = unfence(m[2] ?? '')
    } catch {
      out.invalid.push(raw)
    }
  }
  for (const m of text.matchAll(DELETE_RE)) {
    const raw = m[1] ?? ''
    try {
      out.deletes.push(normalizeRel(raw))
    } catch {
      out.invalid.push(raw)
    }
  }
  const notes = NOTES_RE.exec(text)
  out.notes = (notes?.[1] ?? '').trim()
  out.keepBase = !Object.keys(out.writes).length && !out.deletes.length && KEEP_RE.test(text.replace(NOTES_RE, ''))
  return out
}

/** Apply parsed edits to a base tree (omitted-is-inherited). */
export function applyEdits(base: HarnessTree, edits: ParsedEdits): HarnessTree {
  const next: HarnessTree = { ...base }
  for (const rel of edits.deletes) delete next[rel]
  for (const [rel, content] of Object.entries(edits.writes)) next[rel] = content
  return next
}

/** Render a tree for a prompt, one fenced block per file. */
export function renderTree(tree: HarnessTree, maxCharsPerFile = 8_000): string {
  const rels = Object.keys(tree).sort()
  if (!rels.length) return '_(empty harness)_'
  return rels
    .map(rel => {
      const body = tree[rel] ?? ''
      const shown = body.length > maxCharsPerFile ? `${body.slice(0, maxCharsPerFile)}\n…[truncated ${body.length - maxCharsPerFile} chars]` : body
      return `<file path="${rel}">\n${shown.trim() ? shown.trimEnd() : '(empty)'}\n</file>`
    })
    .join('\n\n')
}

/** Unified-ish line diff of two trees, for evidence and audit. */
export function renderTreeDiff(before: HarnessTree, after: HarnessTree, maxLines = 400): string {
  const rels = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const out: string[] = []
  for (const rel of rels) {
    const a = before[rel] ?? ''
    const b = after[rel] ?? ''
    if (a === b) continue
    if (!a.trim() && b.trim()) {
      out.push(`+++ ${rel} (added)`)
      out.push(...b.trimEnd().split('\n').map(l => `+ ${l}`))
      continue
    }
    if (a.trim() && !b.trim()) {
      out.push(`--- ${rel} (removed)`)
      continue
    }
    out.push(`*** ${rel} (modified)`)
    const al = new Set(a.split('\n'))
    const bl = new Set(b.split('\n'))
    for (const l of a.split('\n')) if (!bl.has(l) && l.trim()) out.push(`- ${l}`)
    for (const l of b.split('\n')) if (!al.has(l) && l.trim()) out.push(`+ ${l}`)
  }
  if (!out.length) return '(no change)'
  return out.length > maxLines ? [...out.slice(0, maxLines), `…[${out.length - maxLines} more diff lines]`].join('\n') : out.join('\n')
}

const CHOICE_RE = /```choice\s*\n\s*([A-Za-z]+)\s*\n\s*```/
const WHY_RE = /<why>([\s\S]*?)<\/why>/

export function parseChoice(text: string): { choice?: string; why: string } {
  const c = CHOICE_RE.exec(text)
  const w = WHY_RE.exec(text)
  const out: { choice?: string; why: string } = { why: (w?.[1] ?? '').trim().slice(0, 2000) }
  if (c?.[1]) out.choice = c[1].trim().toUpperCase()
  return out
}

export interface Experience {
  cue: string
  lesson: string
  evidence: string
  confidence?: string
  edits?: string
}

const EDITS_RE = /<edits>([\s\S]*?)<\/edits>/
const EXP_RE = /<experience>([\s\S]*?)<\/experience>/

export function parseExperience(text: string): { experience?: Experience; edits: string } {
  const edits = (EDITS_RE.exec(text)?.[1] ?? '').trim()
  const m = EXP_RE.exec(text)
  if (!m?.[1]) return { edits }
  const fields: Record<string, string> = {}
  for (const line of m[1].trim().split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    if (['cue', 'lesson', 'evidence', 'confidence'].includes(key)) fields[key] = line.slice(idx + 1).trim()
  }
  if (!fields['cue'] || !fields['lesson'] || !fields['evidence']) return { edits }
  const experience: Experience = { cue: fields['cue'], lesson: fields['lesson'], evidence: fields['evidence'] }
  if (fields['confidence']) experience.confidence = fields['confidence']
  if (edits) experience.edits = edits
  return { experience, edits }
}
