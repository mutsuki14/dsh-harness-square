/**
 * harness2-dsh CLI.
 *   harness2-dsh demo [--k 2] [--mode parallel|sequential] [--out runs/demo]
 *   harness2-dsh run --tasks tasks.json [--k 1] [--mode parallel] [--out runs] [--executor llm|headless]
 * `run` uses the DeepSeek API directly (DEEPSEEK_API_KEY) for the improver and the llm executor,
 * or `dsh --profile headless` subprocesses for --executor headless.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DEMO_BASE, DEMO_TASKS, DemoExecutor, DemoImprover } from '../core/demo.ts'
import { Harness2 } from '../core/pipeline.ts'
import type { Mode } from '../core/recursion.ts'
import type { Executor, TaskSpec, WorkPrompts } from '../core/spec.ts'
import { DEFAULT_BASE_TREE, DEFAULT_WORK } from '../dsh/defaults.ts'
import { HeadlessExecutor } from '../dsh/executors.ts'
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
    model: { type: 'string', default: process.env['HARNESS2_IMPROVER_MODEL'] ?? 'deepseek-reasoner' },
    'solver-model': { type: 'string', default: process.env['HARNESS2_SOLVER_MODEL'] ?? 'deepseek-chat' },
    help: { type: 'boolean', short: 'h' },
  },
})

const cmd = positionals[0]
const k = Number(values.k)
const mode = values.mode as Mode
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
} else if (cmd === 'run') {
  if (!values.tasks) throw new Error('--tasks is required')
  const spec = JSON.parse(readFileSync(values.tasks, 'utf8')) as { work?: WorkPrompts; tasks: TaskSpec[] }
  const apiKey = process.env['DEEPSEEK_API_KEY'] ?? ''
  const baseUrl = process.env['DEEPSEEK_BASE_URL']
  const improver = new DeepSeekApiImprover({ apiKey, model: values.model, ...(baseUrl ? { baseUrl } : {}) })
  const out = resolve(values.out ?? 'runs')
  const executor: Executor =
    values.executor === 'headless'
      ? new HeadlessExecutor({ workRoot: join(out, 'workspaces'), command: process.env['DSH_COMMAND'] ?? 'dsh' })
      : {
          name: 'deepseek-api',
          async execute(task, harness) {
            try {
              const r = await deepseekChat({ apiKey, model: values['solver-model'], ...(baseUrl ? { baseUrl } : {}) }, renderHarnessPrompt(harness), task.prompt + Object.entries(task.sources ?? {}).map(([n, b]) => `\n<source name="${n}">\n${b}\n</source>`).join(''))
              return { ok: true, delivered: !!r.text.trim(), deliverable: r.text, trajectory: `[ASSISTANT]\n${r.text}` }
            } catch (e) {
              return { ok: false, delivered: false, deliverable: '', trajectory: '', error: (e as Error).message }
            }
          },
        }
  const h2 = new Harness2({ executor, improver, work: spec.work ?? DEFAULT_WORK, baseTree: DEFAULT_BASE_TREE, k, mode, runsDir: join(out, 'runs'), libraryDir: join(out, 'library'), onProgress: log })
  for (const r of await h2.runStream(spec.tasks)) console.log(`${r.taskId}: adopted=${r.selection.chosenLabel} library=${r.libraryUpdated} usd=${r.usd}`)
} else {
  console.error(`unknown command ${cmd}`)
  process.exit(1)
}
