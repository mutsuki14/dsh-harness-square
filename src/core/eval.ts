/**
 * Held-out evaluation, kept OUTSIDE the method (harness2's separate judge step).
 *
 * The improvement loop never sees `expect`: `stripExpect` removes it before tasks reach
 * `Harness2`, and evidence/prompts only read `prompt` and `sources`. Here a deterministic
 * checker scores a harness's deliverables so base and adopted harnesses can be compared.
 */

import { mapLimit } from './recursion.ts'
import type { Executor, TaskSpec } from './spec.ts'
import type { HarnessTree } from './tree.ts'

export interface Expectation {
  /** Regular expression (multiline) that a correct deliverable must match, e.g. `^Total: 1724\\.50$`. */
  pattern: string
}

export type EvalTask = TaskSpec & { expect?: Expectation }

/** Remove grading data before a task enters the improvement loop. */
export function stripExpect(task: EvalTask): TaskSpec {
  const { expect: _expect, ...rest } = task
  return rest
}

export function passes(deliverable: string, expect: Expectation): boolean {
  return new RegExp(expect.pattern, 'm').test(deliverable)
}

export interface EvalResult {
  label: string
  runs: number
  passed: number
  delivered: number
  rate: number
  perTask: { id: string; passed: number; runs: number; samples: string[] }[]
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

/** Run every task `repeats` times under `tree` and score each deliverable. */
export async function evaluateHarness(executor: Executor, tasks: EvalTask[], tree: HarnessTree, opts: { label: string; repeats?: number; width?: number; runIdPrefix?: string }): Promise<EvalResult> {
  const repeats = opts.repeats ?? 1
  const jobs = tasks.flatMap(t => Array.from({ length: repeats }, (_, i) => ({ t, i })))
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  const results = await mapLimit(jobs, opts.width ?? 4, async ({ t, i }) => {
    if (!t.expect) throw new Error(`eval task ${t.id} has no expect.pattern`)
    let r
    try {
      r = await executor.execute(stripExpect(t), tree, `${opts.runIdPrefix ?? 'eval'}.${opts.label}.${t.id.replace(/[^\w.\-]/g, '_')}.r${i + 1}`)
    } catch (e) {
      r = { ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message }
    }
    usage.inputTokens += r.usage?.inputTokens ?? 0
    usage.outputTokens += r.usage?.outputTokens ?? 0
    usage.cacheReadTokens += r.usage?.cacheReadTokens ?? 0
    const firstLine = (r.deliverable.split('\n').find(l => l.trim()) ?? r.error ?? '').slice(0, 60)
    return { id: t.id, ok: r.delivered && passes(r.deliverable, t.expect), delivered: r.delivered, firstLine }
  })
  const perTask = tasks.map(t => {
    const rs = results.filter(x => x.id === t.id)
    return { id: t.id, passed: rs.filter(x => x.ok).length, runs: rs.length, samples: rs.map(x => x.firstLine) }
  })
  const passed = results.filter(x => x.ok).length
  return { label: opts.label, runs: results.length, passed, delivered: results.filter(x => x.delivered).length, rate: results.length ? passed / results.length : 0, perTask, usage }
}
