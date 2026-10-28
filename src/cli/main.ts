/**
 * harness2-dsh CLI.
 *   harness2-dsh demo [--k 2] [--mode parallel|sequential] [--out runs/demo]
 *   harness2-dsh run --tasks tasks.json [--k 1] [--mode parallel] [--out runs] [--executor llm|headless]
 *   harness2-dsh eval --tasks heldout.json --harness <dir>|base [--repeats 3] [--executor llm|headless]
 * `run` uses the DeepSeek API directly (DEEPSEEK_API_KEY) for the improver and the llm executor,
 * or `dsh --profile headless` subprocesses for --executor headless.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DEMO_BASE, DEMO_TASKS, DemoExecutor, DemoImprover } from '../core/demo.ts'
import { Harness2 } from '../core/pipeline.ts'
import type { Mode } from '../core/recursion.ts'
import { evaluateHarness, stripExpect, type EvalTask } from '../core/eval.ts'
import { DEFAULT_SURFACE, readTree } from '../core/tree.ts'
import type { Executor, TaskSpec, WorkPrompts } from '../core/spec.ts'
import { DEFAULT_BASE_TREE, DEFAULT_WORK } from '../dsh/defaults.ts'
import { HeadlessExecutor, toollessRollout } from '../dsh/executors.ts'
import { DeepSeekApiImprover, deepseekChat } from '../dsh/improver.ts'
import { renderHarnessPrompt } from '../dsh/render.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    k: { type: 'string', default: '1' },
    mode: { type: 'string', default: 'parallel' },
    out: { type: 'string' },
    tasks: { type: 'string' },
    executor: { type: 'string', default: 'llm' },
    model: { type: 'string', default: process.env['HARNESS2_IMPROVER_MODEL'] ?? 'deepseek-v4-pro' },
    'solver-model': { type: 'string', default: process.env['HARNESS2_SOLVER_MODEL'] ?? 'deepseek-flash' },
    price: { type: 'string', default: process.env['HARNESS2_PRICE'] ?? '' },
    harness: { type: 'string', multiple: true },
    repeats: { type: 'string', default: '1' },
    width: { type: 'string', default: '4' },
    help: { type: 'boolean', short: 'h' },
  },
})

const cmd = positionals[0]
const k = Number(values.k)
const mode = values.mode as Mode
/** `--price in,out` (USD per 1M tokens) applies to every model call; omit to report tokens only. */
const price = (() => {
  if (!values.price) return undefined
  const [i, o, c] = values.price.split(',').map(Number)
  if (!Number.isFinite(i) || !Number.isFinite(o) || (c !== undefined && !Number.isFinite(c))) throw new Error('--price expects "<input>,<output>[,<cacheRead>]" USD per 1M tokens')
  return c === undefined ? { input: i as number, output: o as number } : { input: i as number, output: o as number, cacheRead: c }
})()
const log = (e: { type: string; label?: string; message?: string }) => console.error(`  ${e.type}${e.label ? ` ${e.label}` : ''}${e.message ? ` ${e.message}` : ''}`)

if (!cmd || values.help) {
  console.log('usage: harness2-dsh demo [--k N] [--mode parallel|sequential] [--out DIR]\n       harness2-dsh run --tasks tasks.json [--k N] [--mode M] [--out DIR] [--executor llm|headless]')
  process.exit(cmd ? 0 : 1)
}

if (cmd === 'demo') {
  const out = resolve(values.out ?? 'runs/demo')
  for (const m of ['parallel', 'sequential'] as Mode[]) {
    const exec = new DemoExecutor()
    const h2 = new Harness2({ executor: exec, improver: new DemoImprover(), work: { work: 'reconcile signed amounts in a transaction ledger' }, baseTree: DEMO_BASE, k, mode: m, runsDir: join(out, m, 'runs'), libraryDir: join(out, m, 'library'), onProgress: log })
    for (const r of await h2.runStream(DEMO_TASKS)) {
      console.log(`[${m} k=${k}] ${r.taskId}: start=${r.startedFrom} adopted=${r.selection.chosenLabel} -> ${r.adoptedRollout?.deliverable.trim()} R=${r.modeResult.ledger.R} P=${r.modeResult.ledger.P} library=${r.libraryUpdated}`)
    }
  }
  console.log(`artefacts: ${out}`)
} else if (cmd === 'run' || cmd === 'eval') {
  if (!values.tasks) throw new Error('--tasks is required')
  const spec = JSON.parse(readFileSync(values.tasks, 'utf8')) as { work?: WorkPrompts; tasks: EvalTask[] }
  const apiKey = process.env['DEEPSEEK_API_KEY'] ?? ''
  const baseUrl = process.env['DEEPSEEK_BASE_URL']
  const out = resolve(values.out ?? 'runs')
  const executor: Executor =
    values.executor === 'headless'
      ? new HeadlessExecutor({ workRoot: join(out, 'workspaces'), command: process.env['DSH_COMMAND'] ?? 'dsh', ...(price ? { price } : {}) })
      : {
          name: 'deepseek-api',
          toolless: true,
          async execute(task, harness) {
            const started = Date.now()
            try {
              const r = await deepseekChat({ apiKey, model: values['solver-model'], ...(baseUrl ? { baseUrl } : {}) }, renderHarnessPrompt(harness), task.prompt + Object.entries(task.sources ?? {}).map(([n, b]) => `\n<source name="${n}">\n${b}\n</source>`).join(''))
              return toollessRollout(r.text, `[ASSISTANT]\n${r.text}`, Date.now() - started, { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens }, price)
            } catch (e) {
              return { ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message }
            }
          },
        }
  if (cmd === 'eval') {
    const harnesses = values.harness?.length ? values.harness : ['base']
    const report: object[] = []
    for (const h of harnesses) {
      const tree = h === 'base' ? DEFAULT_BASE_TREE : readTree(DEFAULT_SURFACE, resolve(h))
      if (h !== 'base' && !Object.keys(tree).length) throw new Error(`no harness files under ${h}`)
      const r = await evaluateHarness(executor, spec.tasks, tree, { label: h === 'base' ? 'base' : `h${report.length}`, repeats: Number(values.repeats), width: Number(values.width) })
      console.log(`${h}: ${r.passed}/${r.runs} passed (${(r.rate * 100).toFixed(1)}%), delivered ${r.delivered}/${r.runs}, tokens in/cached/out ${r.usage.inputTokens}/${r.usage.cacheReadTokens}/${r.usage.outputTokens}`)
      for (const t of r.perTask) console.log(`  ${t.id}: ${t.passed}/${t.runs}  ${t.samples.map(s => JSON.stringify(s)).join(' ')}`)
      report.push({ harness: h, ...r })
    }
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'eval.json'), `${JSON.stringify(report, null, 2)}\n`)
  } else {
    const improver = new DeepSeekApiImprover({ apiKey, model: values.model, ...(baseUrl ? { baseUrl } : {}), ...(price ? { price } : {}) })
    const h2 = new Harness2({ executor, improver, work: spec.work ?? DEFAULT_WORK, baseTree: DEFAULT_BASE_TREE, k, mode, runsDir: join(out, 'runs'), libraryDir: join(out, 'library'), onProgress: log })
    // Grading data never enters the improvement loop.
    for (const r of await h2.runStream(spec.tasks.map(stripExpect))) {
      const cost = price ? ` usd=${r.usd.toFixed(4)}` : ''
      console.log(`${r.taskId}: adopted=${r.selection.chosenLabel} library=${r.libraryUpdated} tokens_in=${r.usage.inputTokens} tokens_cached=${r.usage.cacheReadTokens ?? 0} tokens_out=${r.usage.outputTokens}${cost}${r.usageUnknown.length ? ` usage_unknown=${r.usageUnknown.join(',')}` : ''}`)
    }
  }
} else {
  console.error(`unknown command ${cmd}`)
  process.exit(1)
}
