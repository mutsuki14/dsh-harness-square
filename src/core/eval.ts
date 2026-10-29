/**
 * Held-out evaluation, kept OUTSIDE the method (harness2's separate judge step).
 *
 * The improvement loop never sees `expect`: `stripExpect` removes it before tasks reach
 * `Harness2`, and evidence/prompts only read `prompt` and `sources`. Here a deterministic
 * checker scores a harness's deliverables so base and adopted harnesses can be compared.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapLimit } from './recursion.ts'
import type { Executor, TaskSpec } from './spec.ts'
import type { HarnessTree } from './tree.ts'

/** Hidden unit tests for a code deliverable: the module is extracted from the reply and the tests import it. */
export interface CodeTests {
  lang: 'python'
  /** Module name the tests import, e.g. `amounts` for `amounts.py`. */
  module: string
  /** Test program; exits non-zero (e.g. a failing assert) when the module is wrong. */
  code: string
  timeoutMs?: number
}

export interface Expectation {
  /** Regular expression (multiline) that a correct deliverable must match, e.g. `^Total: 1724\\.50$`. */
  pattern?: string
  /** Run hidden tests against code extracted from the deliverable. */
  tests?: CodeTests
}

export type EvalTask = TaskSpec & { expect?: Expectation }

/** Remove grading data before a task enters the improvement loop. */
export function stripExpect(task: EvalTask): TaskSpec {
  const { expect: _expect, ...rest } = task
  return rest
}

export function passes(deliverable: string, expect: Expectation): boolean {
  return expect.pattern !== undefined && new RegExp(expect.pattern, 'm').test(deliverable)
}

/**
 * Pull the module source out of a reply: a `<file path=".../<module>.py">` block (headless/workflow
 * executors), else the longest fenced code block that defines something.
 */
export function extractCode(deliverable: string, module: string): string {
  const esc = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const file = new RegExp(`<file path="(?:[^"]*/)?${esc}\\.py">\\n([\\s\\S]*?)\\n</file>`).exec(deliverable)
  if (file?.[1]) return file[1]
  const blocks = [...deliverable.matchAll(/```[ \t]*(?:python3?|py)?[^\n]*\n([\s\S]*?)```/g)].map(m => m[1] ?? '')
  const defs = blocks.filter(b => /^\s*(?:def|class)\s/m.test(b))
  return defs.sort((a, b) => b.length - a.length)[0] ?? ''
}

/** Run hidden tests in a throwaway directory with a timeout. Never throws. */
export function runCodeTests(code: string, tests: CodeTests): Promise<{ ok: boolean; detail: string }> {
  if (!code.trim()) return Promise.resolve({ ok: false, detail: 'no code block found in the deliverable' })
  const dir = mkdtempSync(join(tmpdir(), 'h2code-'))
  writeFileSync(join(dir, `${tests.module}.py`), code, 'utf8')
  writeFileSync(join(dir, '_hidden_tests.py'), tests.code, 'utf8')
  return new Promise(resolve => {
    let out = ''
    const child = spawn('python3', ['-E', '-s', '-B', '_hidden_tests.py'], { cwd: dir, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', PYTHONHASHSEED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), tests.timeoutMs ?? 20_000)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    const done = (ok: boolean, detail: string) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      resolve({ ok, detail })
    }
    child.on('error', e => done(false, `could not run python3: ${e.message}`))
    child.on('close', (status, sig) => {
      if (status === 0) return done(true, 'all hidden tests passed')
      const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
      done(false, sig ? `killed (${sig}, timeout?)` : (lines.at(-1) ?? `exit ${status}`).slice(0, 240))
    })
  })
}

/** Score one deliverable against an expectation (regex or hidden tests). */
export async function check(deliverable: string, expect: Expectation): Promise<{ ok: boolean; detail: string }> {
  if (expect.tests) return runCodeTests(extractCode(deliverable, expect.tests.module), expect.tests)
  if (expect.pattern !== undefined) return { ok: passes(deliverable, expect), detail: '' }
  throw new Error('expectation needs `pattern` or `tests`')
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
    if (!t.expect || (t.expect.pattern === undefined && !t.expect.tests)) throw new Error(`eval task ${t.id} has no expect.pattern or expect.tests`)
    let r
    try {
      r = await executor.execute(stripExpect(t), tree, `${opts.runIdPrefix ?? 'eval'}.${opts.label}.${t.id.replace(/[^\w.\-]/g, '_')}.r${i + 1}`)
    } catch (e) {
      r = { ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message }
    }
    usage.inputTokens += r.usage?.inputTokens ?? 0
    usage.outputTokens += r.usage?.outputTokens ?? 0
    usage.cacheReadTokens += r.usage?.cacheReadTokens ?? 0
    const c = r.delivered ? await check(r.deliverable, t.expect) : { ok: false, detail: r.error ?? 'not delivered' }
    // Code tasks show WHY a run failed (the failing test); text tasks show the first line of the answer.
    const firstLine = t.expect.tests
      ? (c.ok ? 'PASS' : `FAIL ${c.detail}`).slice(0, 90)
      : (r.deliverable.split('\n').find(l => l.trim()) ?? r.error ?? '').slice(0, 60)
    return { id: t.id, ok: r.delivered && c.ok, delivered: r.delivered, firstLine }
  })
  const perTask = tasks.map(t => {
    const rs = results.filter(x => x.id === t.id)
    return { id: t.id, passed: rs.filter(x => x.ok).length, runs: rs.length, samples: rs.map(x => x.firstLine) }
  })
  const passed = results.filter(x => x.ok).length
  return { label: opts.label, runs: results.length, passed, delivered: results.filter(x => x.delivered).length, rate: results.length ? passed / results.length : 0, perTask, usage }
}
