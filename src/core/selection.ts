/**
 * Blind selection over the k finals, and post-adoption reflection.
 * Port of harness2 `core/selection.py`.
 *
 * - The pool is exactly the k finals (agg1..aggk or c1..ck); base runs are excluded by construction.
 * - Non-answers are dropped before anonymisation; ids are a seeded shuffle (stable across reruns).
 * - k=1 is delivered without a selector session (trivial selection).
 * - A selector failure falls back to the first delivered final and never throws.
 */

import { createHash } from 'node:crypto'
import { clip } from './evidence.ts'
import { parseChoice, parseExperience, renderTreeDiff, type Experience } from './protocol.ts'
import * as P from './prompts.ts'
import type { ModeResult } from './recursion.ts'
import type { Improver, Rollout, TaskSpec, WorkPrompts } from './spec.ts'
import type { HarnessTree } from './tree.ts'

export interface Selection {
  taskId: string
  mode: string
  k: number
  ok: boolean
  trivial: boolean
  fellBack: boolean
  chosenId: string
  chosenLabel: string
  idMap: Record<string, string>
  why: string
  dropped: string[]
  error: string
  usd: number
  experience?: Experience
  edits?: string
}

/** A..Z, AA..AZ, BA... */
export function anonId(index: number): string {
  let out = ''
  let n = index + 1
  while (n) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** mulberry32 PRNG seeded from a string hash: deterministic shuffles. */
function rng(seedText: string): () => number {
  let a = parseInt(createHash('sha1').update(seedText).digest('hex').slice(0, 8), 16) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** anon id -> label, canonical sort then a seeded shuffle. */
export function assignIds(labels: string[], seed: string): Record<string, string> {
  const ordered = [...labels].sort()
  const r = rng(seed)
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[ordered[i], ordered[j]] = [ordered[j] as string, ordered[i] as string]
  }
  return Object.fromEntries(ordered.map((l, i) => [anonId(i), l]))
}

function emptySelection(task: TaskSpec, mode: string, k: number): Selection {
  return { taskId: task.id, mode, k, ok: false, trivial: false, fellBack: false, chosenId: '', chosenLabel: '', idMap: {}, why: '', dropped: [], error: '', usd: 0 }
}

function deliverablePool(result: ModeResult, sel: Selection): Record<string, Rollout> {
  const pool: Record<string, Rollout> = {}
  for (const label of result.finals) {
    const r = result.rollouts[label]
    if (!r || !r.ok || !r.delivered || !r.deliverable.trim()) {
      sel.dropped.push(label)
      continue
    }
    pool[label] = r
  }
  return pool
}

export interface SelectOptions {
  task: TaskSpec
  work: WorkPrompts
  result: ModeResult
  improver: Improver
  seed?: string
  maxArtifactChars?: number
  signal?: AbortSignal
}

export async function runSelection(opts: SelectOptions): Promise<Selection> {
  const { task, result } = opts
  const sel = emptySelection(task, result.mode, result.k)
  const pool = deliverablePool(result, sel)
  const labels = Object.keys(pool)
  if (!labels.length) {
    sel.error = 'no final produced an artifact'
    return sel
  }
  if (labels.length === 1) {
    const label = labels[0] as string
    Object.assign(sel, { ok: true, trivial: true, chosenId: 'A', chosenLabel: label, idMap: { A: label }, why: 'single delivered final; delivered without a selector session' })
    return sel
  }
  sel.idMap = assignIds(labels, opts.seed ?? `${task.id}|${result.k}|${result.mode}`)
  const ids = Object.keys(sel.idMap).sort()
  const maxChars = opts.maxArtifactChars ?? 20_000
  const sources = Object.entries(task.sources ?? {})
    .map(([n, b]) => `<source name="${n}">\n${clip(b, 8000)}\n</source>`)
    .join('\n\n')
  const candidates = ids
    .map(id => `<candidate id="${id}">\n${clip(pool[sel.idMap[id] as string]?.deliverable ?? '', maxChars)}\n</candidate>`)
    .join('\n\n')
  const mission = [
    P.select(opts.work, labels.length, ids),
    `# YOUR EVIDENCE\n\n<task>\n${task.prompt.trim()}\n</task>`,
    sources && `<sources>\n${sources}\n</sources>`,
    `<candidates>\n${candidates}\n</candidates>`,
    `Read every candidate before choosing. Choose exactly one of: ${ids.join(', ')}.`,
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const req: Parameters<Improver['call']>[0] = { label: `select.${result.mode}${result.k}`, system: P.SYSTEM_SELECTOR, mission }
    if (opts.signal) req.signal = opts.signal
    const reply = await opts.improver.call(req)
    sel.usd += reply.costUsd ?? 0
    const { choice, why } = parseChoice(reply.text)
    if (!choice) throw new Error('no ```choice block in the reply')
    if (!(choice in sel.idMap)) throw new Error(`chose ${JSON.stringify(choice)}, which is not one of ${ids.join(', ')}`)
    Object.assign(sel, { ok: true, chosenId: choice, chosenLabel: sel.idMap[choice], why })
  } catch (e) {
    sel.usd += (e as { costUsd?: number }).costUsd ?? 0
    // Fallback: the first delivered final in canonical order.
    const label = [...labels].sort()[0] as string
    const id = Object.entries(sel.idMap).find(([, l]) => l === label)?.[0] ?? 'A'
    Object.assign(sel, { ok: true, fellBack: true, chosenId: id, chosenLabel: label, why: `selector failed (${(e as Error).message}); fell back to ${label}` })
  }
  return sel
}

export interface ReflectOptions {
  task: TaskSpec
  work: WorkPrompts
  result: ModeResult
  selection: Selection
  baseTree: HarnessTree
  improver: Improver
  signal?: AbortSignal
}

/** Learn from harness edits, decisions, trajectories and deliverables after adoption. */
export async function reflectAdoption(opts: ReflectOptions): Promise<Experience | undefined> {
  const { result, selection: sel } = opts
  if (!sel.ok || !sel.chosenLabel) return undefined
  const rows = result.stages.map(s => {
    const r = result.rollouts[s.label]
    const status = !r ? 'not rolled out' : !r.ok ? `failed: ${r.error ?? ''}` : r.delivered ? 'delivered' : 'produced nothing'
    return [
      `### candidate \`${s.label}\` (${s.dim})${s.label === sel.chosenLabel ? ' -- ADOPTED' : ''}${s.fellBack ? ' -- fell back to its input harness' : ''}${s.keptBase ? ' -- KEEP_BASE' : ''}`,
      `<diff_vs_base>\n${renderTreeDiff(opts.baseTree, s.tree, 120)}\n</diff_vs_base>`,
      s.notes ? `<decision_notes>\n${clip(s.notes, 1500)}\n</decision_notes>` : '',
      `rollout: ${status}`,
      r ? `<trajectory>\n${clip(r.trajectory, 4000)}\n</trajectory>\n<deliverable>\n${clip(r.deliverable, 2500)}\n</deliverable>` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  const base = Object.values(result.rollouts).filter(r => r.label.startsWith('base'))
  const mission = [
    P.experience(opts.work),
    `# WHAT HAPPENED\n\nHarness \`${sel.chosenLabel}\` was adopted. The selection reasoning was:\n\n${sel.why || '(none)'}\n\nAnonymous ids map to labels as: ${JSON.stringify(sel.idMap)}`,
    `<task>\n${opts.task.prompt.trim()}\n</task>`,
    `## Base rollouts\n\n${base.map(r => `### \`${r.label}\` -- ${r.delivered ? 'delivered' : 'produced nothing'}\n<trajectory>\n${clip(r.trajectory, 4000)}\n</trajectory>`).join('\n\n')}`,
    `## Candidates\n\n${rows.join('\n\n')}`,
  ].join('\n\n')
  try {
    const req: Parameters<Improver['call']>[0] = { label: `experience.${result.mode}${result.k}`, system: P.SYSTEM_REFLECTOR, mission }
    if (opts.signal) req.signal = opts.signal
    const reply = await opts.improver.call(req)
    sel.usd += reply.costUsd ?? 0
    const { experience, edits } = parseExperience(reply.text)
    if (edits) sel.edits = edits
    if (experience) sel.experience = experience
    return experience
  } catch (e) {
    sel.usd += (e as { costUsd?: number }).costUsd ?? 0
    return undefined
  }
}
