/**
 * Deterministic local demo (port of harness2 `demo.py`): a real executor that runs the
 * harness's `scripts/summarize.js` on a ledger, and a scripted improver. No model needed.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Executor, Improver, ImproverReply, ImproverRequest, Rollout, TaskSpec } from './spec.ts'
import type { HarnessTree } from './tree.ts'

export const DEMO_SCRIPT = `const fs = require('fs')
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\\n').slice(1).map(Number)
const total = rows.filter(a => a > 0).reduce((s, a) => s + a, 0)
console.log('Total: ' + total.toFixed(2))
`

export const DEMO_BASE: HarnessTree = {
  'systemprompt.md': 'Reconcile the ledger using node scripts/summarize.js.\n',
  'guardrails.md': '',
  'memory.md': '',
  'tool_guidance.md': '',
  'scripts/summarize.js': DEMO_SCRIPT,
}

export const DEMO_TASKS: TaskSpec[] = [
  { id: 'ledger-1', domain: 'accounting', prompt: 'Sum every signed amount in ledger.csv. Return Total: with two decimals.', sources: { 'ledger.csv': 'amount\n100.25\n-20.10\n5.00\n' } },
  { id: 'ledger-2', domain: 'accounting', prompt: 'Sum every signed amount in ledger.csv. Return Total: with two decimals.', sources: { 'ledger.csv': 'amount\n35.50\n-10.25\n-5.00\n' } },
]

export class DemoExecutor implements Executor {
  readonly name = 'demo'
  count = 0
  async execute(task: TaskSpec, harness: HarnessTree): Promise<Omit<Rollout, 'label' | 'runId'>> {
    this.count++
    const dir = mkdtempSync(join(tmpdir(), 'h2demo-'))
    writeFileSync(join(dir, 'ledger.csv'), task.sources?.['ledger.csv'] ?? '')
    writeFileSync(join(dir, 's.cjs'), harness['scripts/summarize.js'] ?? '')
    const out = execFileSync(process.execPath, [join(dir, 's.cjs'), join(dir, 'ledger.csv')], { encoding: 'utf8' })
    return { ok: true, delivered: !!out.trim(), deliverable: out, trajectory: `[ACTION] node scripts/summarize.js ledger.csv\n[OBSERVATION]\n${out}` }
  }
}

export class DemoImprover implements Improver {
  readonly name = 'demo'
  readonly calls: string[] = []
  async call(req: ImproverRequest): Promise<ImproverReply> {
    this.calls.push(req.label)
    if (req.label.startsWith('select.')) {
      const ledger = /<source name="ledger.csv">\n([\s\S]*?)\n<\/source>/.exec(req.mission)?.[1] ?? ''
      const expected = ledger.trim().split('\n').slice(1).map(Number).reduce((s, a) => s + a, 0).toFixed(2)
      const ids = [...req.mission.matchAll(/<candidate id="([A-Z]+)">\n([\s\S]*?)\n<\/candidate>/g)]
      const hit = ids.find(m => (m[2] ?? '').includes(`Total: ${expected}`)) ?? ids[0]
      return { text: `<why>The signed total matches the source ledger.</why>\n\`\`\`choice\n${hit?.[1] ?? 'A'}\n\`\`\`` }
    }
    if (req.label.startsWith('experience.')) {
      return {
        text:
          '<edits>\ncomponent: scripts/summarize.js\ncandidates: inv1\nchange: dropped the positive-only filter\nobserved: probe total included credits the base omitted\nverdict: helped\n</edits>\n' +
          '<experience>\ncue: When a ledger includes credits and debits\nlesson: Include both signs when summing in scripts/summarize.js.\nevidence: the scripts/summarize.js row -- removing the filter changed the total to include credits.\nconfidence: high\n</experience>',
      }
    }
    if (req.label.startsWith('dom')) return { text: '<keep_base/>\n<notes>No practitioner knowledge is missing.</notes>' }
    const script = DEMO_SCRIPT.replace('.filter(a => a > 0)', '')
    return { text: `<file path="scripts/summarize.js">\n${script}</file>\n<notes>kept -> signed sum -> base total omitted credits in 1/1 base rollouts</notes>` }
  }
}
