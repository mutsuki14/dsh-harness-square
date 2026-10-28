import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEMO_BASE, DEMO_TASKS, DemoExecutor, DemoImprover } from '../src/core/demo.ts'
import { Harness2 } from '../src/core/pipeline.ts'
import { applyEdits, parseChoice, parseEdits, parseExperience } from '../src/core/protocol.ts'
import { assignIds } from '../src/core/selection.ts'
import { DEFAULT_SURFACE, isAllowed, validate } from '../src/core/tree.ts'
import { validatePolicyPlugin } from '../src/core/policy.ts'
import { checkWorkPrompts } from '../src/core/spec.ts'

test('surface admits only editable paths', () => {
  assert.ok(isAllowed(DEFAULT_SURFACE, 'skills/doc_review/SKILL.md'))
  assert.ok(isAllowed(DEFAULT_SURFACE, 'plugins/verify.json'))
  assert.ok(!isAllowed(DEFAULT_SURFACE, '../etc/passwd'))
  assert.ok(!isAllowed(DEFAULT_SURFACE, 'plugins/x.ts'))
})

test('validate catches untriggered skill and bad plugin', () => {
  const tree = { 'systemprompt.md': 'hi', 'skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\nbody', 'plugins/p.json': '{"description":"x","rules":[{"on":"pre","tool":"*","action":"deny","message":"no"}]}' }
  assert.throws(() => validate(DEFAULT_SURFACE, tree), /never named[\s\S]*unconditional deny/)
})

test('edit protocol: omitted is inherited, keep_base, escapes rejected', () => {
  const e = parseEdits('<file path="memory.md">\nfact\n</file>\n<delete path="guardrails.md"/>\n<notes>n</notes>')
  assert.deepEqual(applyEdits({ 'memory.md': '', 'guardrails.md': 'g', 'systemprompt.md': 's' }, e), { 'memory.md': 'fact\n', 'systemprompt.md': 's' })
  assert.equal(parseEdits('<keep_base/><notes>nothing</notes>').keepBase, true)
  assert.deepEqual(parseEdits('<file path="../x">y</file>').invalid, ['../x'])
  assert.equal(parseChoice('<why>w</why>\n```choice\nB\n```').choice, 'B')
  assert.equal(parseExperience('NO_ENTRY').experience, undefined)
})

test('policy and work-prompt invariants', () => {
  assert.throws(() => validatePolicyPlugin({ description: 'x', rules: [{ on: 'stop', action: 'deny', message: 'm' }] }))
  assert.throws(() => checkWorkPrompts({ work: 'maximise the benchmark score' }), /measurement/)
  assert.deepEqual(assignIds(['agg2', 'agg1'], 's'), assignIds(['agg1', 'agg2'], 's'))
})

for (const mode of ['parallel', 'sequential'] as const) {
  for (const k of [1, 2]) {
    test(`end-to-end ${mode} k=${k}: budget identity, adoption, library warm start`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'h2t-'))
      const exec = new DemoExecutor()
      const h2 = new Harness2({ executor: exec, improver: new DemoImprover(), work: { work: 'reconcile signed ledgers' }, baseTree: DEMO_BASE, k, mode, runsDir: join(dir, 'runs'), libraryDir: join(dir, 'lib') })
      const [a, b] = await h2.runStream(DEMO_TASKS)
      assert.equal(a!.modeResult.ledger.R, 4 * k)
      assert.equal(a!.modeResult.ledger.P, 3 * k)
      assert.equal(exec.count, 8 * k)
      assert.equal(a!.adoptedRollout?.deliverable.trim(), 'Total: 85.15')
      assert.ok(a!.libraryUpdated)
      assert.match(b!.startedFrom, /^library:/)
      assert.equal(b!.modeResult.rollouts['base1']?.deliverable.trim(), 'Total: 20.25')
    })
  }
}

test('toolless executor puts the runtime-limits note in every improvement mission', async () => {
  const { TOOLLESS_NOTE } = await import('../src/core/recursion.ts')
  const seen: string[] = []
  const imp = new DemoImprover()
  const spy = { name: 'spy', call: async (req: any) => { seen.push(req.mission); return imp.call(req) } }
  const exec = Object.assign(new DemoExecutor(), { toolless: true })
  const h2 = new Harness2({ executor: exec, improver: spy, work: { work: 'reconcile signed ledgers' }, baseTree: DEMO_BASE, k: 1, reflect: false })
  await h2.runTask(DEMO_TASKS[0]!)
  const stageMissions = seen.filter(m => m.includes('# HOW TO REPLY'))
  assert.equal(stageMissions.length, 3)
  assert.ok(stageMissions.every(m => m.includes(TOOLLESS_NOTE)))
})
