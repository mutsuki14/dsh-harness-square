/**
 * Evidence assembly (harness2 `core/context.py`). harness2 materialises a `context/` directory
 * for a CLI agent; a DSH improver is a single model call, so the same evidence is rendered as
 * one bounded document: the task, sources, the harness being edited, base rollouts, the
 * candidate pool (harness diff + rollout per candidate), earlier decisions and the library.
 */

import { renderTree, renderTreeDiff } from './protocol.ts'
import type { Rollout, TaskSpec } from './spec.ts'
import type { HarnessTree } from './tree.ts'

export interface EvidenceLimits {
  /** Max chars of one trajectory. harness2 warns that < 10k fabricates defects. */
  trajectoryChars: number
  deliverableChars: number
  sourceChars: number
  /** Hard cap on the whole document. */
  totalChars: number
}

export const DEFAULT_LIMITS: EvidenceLimits = {
  trajectoryChars: 12_000,
  deliverableChars: 6_000,
  sourceChars: 8_000,
  totalChars: 180_000,
}

export interface PoolEntry {
  label: string
  harness: HarnessTree
  rollout?: Rollout
}

export interface EvidenceInput {
  task: TaskSpec
  /** The harness this stage edits (base, or the current checkpoint). */
  harness: HarnessTree
  harnessLabel: string
  base: Rollout[]
  pool?: PoolEntry[]
  decisions?: Record<string, string>
  library?: string
  limits?: Partial<EvidenceLimits>
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n…[${text.length - max} chars elided]…\n${text.slice(text.length - tail)}`
}

function rolloutBlock(r: Rollout, lim: EvidenceLimits): string {
  const status = !r.ok ? `FAILED TO RUN${r.error ? `: ${r.error}` : ''}` : r.delivered ? 'delivered' : `PRODUCED NOTHING${r.error ? `: ${r.error}` : ''}`
  // Output volume is evidence too: a rollout near its output budget will break if a harness asks for more steps.
  const meter = r.usage ? `output tokens: ${r.usage.outputTokens}${r.wallMs !== undefined ? `, wall: ${Math.round(r.wallMs / 1000)}s` : ''}` : ''
  return [
    `### rollout \`${r.label}\` -- ${status}`,
    ...(meter ? [meter] : []),
    '',
    '<trajectory>',
    clip(r.trajectory || '(no trajectory recorded)', lim.trajectoryChars),
    '</trajectory>',
    '',
    `<deliverable>`,
    r.delivered ? clip(r.deliverable, lim.deliverableChars) : '(none)',
    '</deliverable>',
  ].join('\n')
}

/** How to read the evidence (harness2 `context.mission`), adapted to an inline document. */
export const READING_GUIDE = [
  'Read the request and the harness you are editing first. Inventory every rollout and candidate below and inspect each ' +
    'at least once before deciding. For a candidate, compare what changed from its editing baseline, what behavior changed ' +
    'in its rollout, what improved, and what regressed or remained unresolved. Then deep-read the evidence relevant to any ' +
    'edit. Cite the specific trajectory moment behind every change; one you cannot trace to a moment is speculation.',
  'Long trajectories may carry an explicit `…[N chars elided]…` marker. That marker is ours, inserted to fit this ' +
    'document; it is not behavior by the solver. Do not diagnose it as a solver failure.',
].join('\n\n')

/** Render the evidence document for one improvement stage. */
export function buildEvidence(input: EvidenceInput): string {
  const lim = { ...DEFAULT_LIMITS, ...input.limits }
  // Never clip the document as a whole: that silently drops the pool or library, the sections a
  // composer needs most. Instead shrink the per-rollout budgets until everything fits.
  for (let i = 0; i < 6; i++) {
    const doc = renderEvidence(input, lim)
    if (doc.length <= lim.totalChars) return doc
    lim.trajectoryChars = Math.max(2_000, Math.floor(lim.trajectoryChars * 0.6))
    lim.deliverableChars = Math.max(1_500, Math.floor(lim.deliverableChars * 0.7))
    lim.sourceChars = Math.max(2_000, Math.floor(lim.sourceChars * 0.7))
  }
  const doc = renderEvidence(input, lim)
  return doc.length <= lim.totalChars ? doc : clip(doc, lim.totalChars)
}

function renderEvidence(input: EvidenceInput, lim: EvidenceLimits): string {
  const parts: string[] = ['# EVIDENCE', READING_GUIDE]
  parts.push(`## The request (verbatim)\n\n<task id="${input.task.id}" domain="${input.task.domain}">\n${input.task.prompt.trim()}\n</task>`)
  const sources = Object.entries(input.task.sources ?? {})
  if (sources.length) {
    parts.push(
      '## Source material\n\n' +
        sources.map(([name, body]) => `<source name="${name}">\n${clip(body, lim.sourceChars)}\n</source>`).join('\n\n'),
    )
  }
  parts.push(`## The harness you are editing (\`${input.harnessLabel}\`)\n\n${renderTree(input.harness)}`)
  parts.push(
    `## Rollouts under the unmodified harness (${input.base.length})\n\n` +
      (input.base.length ? input.base.map(r => rolloutBlock(r, lim)).join('\n\n') : '_(none)_'),
  )
  if (input.pool?.length) {
    parts.push(
      `## Candidate pool (${input.pool.length})\n\nEach candidate: its harness DIFF against \`${input.harnessLabel}\`, its decision notes, and its single rollout.\n\n` +
        input.pool
          .map(p =>
            [
              `### candidate \`${p.label}\``,
              '',
              '<diff>',
              renderTreeDiff(input.harness, p.harness),
              '</diff>',
              input.decisions?.[p.label] ? `\n<decision_notes>\n${clip(input.decisions[p.label] ?? '', 3000)}\n</decision_notes>` : '',
              '',
              p.rollout ? rolloutBlock(p.rollout, lim) : '_(not rolled out)_',
            ].join('\n'),
          )
          .join('\n\n'),
    )
  }
  if (input.library?.trim()) {
    parts.push(`## Experience library for the \`${input.task.domain}\` domain\n\nEarlier tasks in this domain, their adopted harness and what was learned. Use it as guidance, not as fact about this matter.\n\n${input.library.trim()}`)
  }
  return parts.join('\n\n')
}
