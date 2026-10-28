/**
 * Defaults: the starting harness and the generic work description used when a caller
 * does not supply domain-specific ones.
 */

import type { WorkPrompts } from '../core/spec.ts'
import type { HarnessTree } from '../core/tree.ts'

/** A deliberately small starting harness: refinement adds only what evidence argues for. */
export const DEFAULT_BASE_TREE: HarnessTree = Object.freeze({
  'systemprompt.md':
    'Work the request end to end. Read the supplied material before acting, do the work with your tools, ' +
    'and finish by checking that every requested deliverable exists and says what was asked.\n',
  'guardrails.md': 'Never invent facts, figures, citations or file contents. When the material is silent, say so.\n',
  'memory.md': '',
  'tool_guidance.md': '',
}) as HarnessTree

export const DEFAULT_WORK: WorkPrompts = Object.freeze({
  work:
    'An autonomous agent receives a professional request with supporting material and must produce the ' +
    'requested artifact (a document, an analysis, a file, code or a direct answer) that the requester can use as-is.',
  domainWord: 'domain',
  deliverableWord: 'deliverable',
}) as WorkPrompts
