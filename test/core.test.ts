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
  assert.ok(isAllowed(DEFAULT_SURFACE, 'skills/doc-review/SKILL.md'))
  assert.ok(!isAllowed(DEFAULT_SURFACE, 'skills/doc_review/SKILL.md'), 'dsh rejects non-kebab skill names')
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
      assert.match(b!.startedFrom, /^current:/)
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
  assert.ok(stageMissions.length >= 3, `expected >=3 stage missions, got ${stageMissions.length}`)
  assert.ok(stageMissions.every(m => m.includes(TOOLLESS_NOTE)))
})

test('toolless probe guard: rejects probe-limitation leaks and script edits, keeps prose edits', async () => {
  const { checkToollessProbe } = await import('../src/core/recursion.ts')
  const base = { 'systemprompt.md': 'Work it.', 'scripts/a.py': 'print(1)\n' }
  assert.match(checkToollessProbe(DEFAULT_SURFACE, { ...base, 'systemprompt.md': 'No tools are available: compute in your reply.' }, base).join(), /limitation of this evaluation probe/)
  assert.match(checkToollessProbe(DEFAULT_SURFACE, { ...base, 'scripts/a.py': 'print(2)\n' }, base).join(), /no tool loop/)
  assert.deepEqual(checkToollessProbe(DEFAULT_SURFACE, { ...base, 'memory.md': 'Amounts in parentheses are negative.' }, base), [])
})

test('ledger and task result account tokens; cost only when priced', async () => {
  const { costOf } = await import('../src/core/spec.ts')
  assert.equal(costOf({ inputTokens: 1_000_000, outputTokens: 500_000 }, { input: 0.2, output: 0.8 }), 0.6)
  assert.equal(costOf({ inputTokens: 10, outputTokens: 10 }, undefined), undefined)
  assert.equal(costOf({ inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 0 }, { input: 1, output: 2, cacheRead: 0.1 }), 1.1)
  assert.equal(costOf({ inputTokens: 0, cacheReadTokens: 1e6, outputTokens: 0 }, { input: 1, output: 2 }), 1, 'cache reads default to the input price')
  const imp = new DemoImprover()
  const metered = { name: 'm', call: async (req: any) => ({ ...(await imp.call(req)), inputTokens: 100, outputTokens: 10 }) }
  const exec = new DemoExecutor()
  const metExec = { name: 'me', execute: async (t: any, h: any) => ({ ...(await exec.execute(t, h)), usage: { inputTokens: 50, outputTokens: 5 } }) }
  const r = await new Harness2({ executor: metExec, improver: metered, work: { work: 'reconcile signed ledgers' }, baseTree: DEMO_BASE, k: 1 }).runTask(DEMO_TASKS[0]!)
  // 4 rollouts x (50,5) + 3 stages x (100,10) + selection(trivial, 0) + reflection (100,10)
  assert.deepEqual(r.usage, { inputTokens: 4 * 50 + 3 * 100 + 100, outputTokens: 4 * 5 + 3 * 10 + 10, cacheReadTokens: 0 })
  assert.deepEqual(r.usageUnknown, [])
})

test('a rejected attempt records its reason even when the retry succeeds', async () => {
  const { runStage } = await import('../src/core/recursion.ts')
  let n = 0
  const improver = { name: 'r', call: async () => ({ text: ++n === 1
    ? '<file path="systemprompt.md">\nNo tools are available.\n</file><notes>a</notes>'
    : '<file path="systemprompt.md">\nCompute row by row in your reply.\n</file><notes>b</notes>' }) }
  const ctx: any = { task: DEMO_TASKS[0], work: { work: 'reconcile signed ledgers' }, k: 1, base: [], baseTree: DEMO_BASE, surface: DEFAULT_SURFACE,
    executor: { name: 'x', toolless: true, execute: async () => ({}) }, improver, runIdOf: (l: string) => l }
  const s = await runStage(ctx, { label: 'inv1', dim: 'INV', job: 'job', fallback: DEMO_BASE, fallbackLabel: 'base' })
  assert.equal(s.fellBack, false); assert.equal(s.attempts, 2)
  assert.match(s.rejections?.[0] ?? '', /limitation of this evaluation probe/)
})

test('autotrigger lines never name a specific skill-loading tool', async () => {
  const { autotrigger } = await import('../src/core/tree.ts')
  const t: Record<string, string> = { 'systemprompt.md': 'x', 'skills/ledger-total/SKILL.md': '---\nname: ledger-total\ndescription: total a ledger\n---\nbody' }
  autotrigger(DEFAULT_SURFACE, t)
  assert.match(t['tool_guidance.md'] ?? '', /Use skill `ledger-total` when: total a ledger/)
  assert.ok(!/harness2_skill/.test(t['tool_guidance.md'] ?? ''))
})

test('frontmatter is canonicalised to YAML-safe quoted values (dsh rejects plain scalars with ": ")', async () => {
  const { canonicalFrontmatter, frontmatter } = await import('../src/core/tree.ts')
  const bad = '---\nname: payout-answer\ndescription: Use when the task states a required "Total: <value>" first line.\n---\nbody\n'
  const good = canonicalFrontmatter(bad)
  assert.equal(good, '---\nname: "payout-answer"\ndescription: "Use when the task states a required \\"Total: <value>\\" first line."\n---\nbody\n')
  assert.deepEqual(frontmatter(good), frontmatter(bad))
  assert.equal(canonicalFrontmatter(good), good, 'idempotent')
  assert.equal(canonicalFrontmatter('no frontmatter'), 'no frontmatter')
})

test('eval scores deliverables against expect, and stripExpect keeps grading data out of the loop', async () => {
  const { evaluateHarness, stripExpect } = await import('../src/core/eval.ts')
  const t = { ...DEMO_TASKS[0]!, expect: { pattern: '^Total: 85\\.15$' } }
  assert.equal('expect' in stripExpect(t), false)
  const fixed = DEMO_BASE['scripts/summarize.js']!.replace('.filter(a => a > 0)', '')
  const base = await evaluateHarness(new DemoExecutor(), [t], DEMO_BASE, { label: 'base', repeats: 2 })
  const good = await evaluateHarness(new DemoExecutor(), [t], { ...DEMO_BASE, 'scripts/summarize.js': fixed }, { label: 'fixed', repeats: 2 })
  assert.equal(base.passed, 0); assert.equal(good.passed, 2); assert.equal(good.rate, 1)
  // the improver never sees the expected answer
  const seen: string[] = []
  const imp = new DemoImprover()
  const spy = { name: 's', call: async (req: any) => { seen.push(req.mission); return imp.call(req) } }
  await new Harness2({ executor: new DemoExecutor(), improver: spy, work: { work: 'reconcile signed ledgers' }, baseTree: DEMO_BASE, k: 1 }).runTask(stripExpect(t))
  assert.ok(seen.length > 0 && seen.every(m => !m.includes('85\\.15$') && !m.includes('"pattern"')))
})

test('evidence reports output tokens per rollout and the toolless note names the output budget', async () => {
  const { buildEvidence } = await import('../src/core/evidence.ts')
  const { TOOLLESS_NOTE } = await import('../src/core/recursion.ts')
  const ev = buildEvidence({ task: { id: 't', domain: 'd', prompt: 'p' }, harness: {}, harnessLabel: 'base', base: [{ label: 'base1', ok: true, delivered: true, deliverable: 'x', trajectory: 'y', wallMs: 61000, usage: { inputTokens: 1, outputTokens: 64344, cacheReadTokens: 0 } }] } as never)
  assert.match(ev, /output tokens: 64344, wall: 61s/)
  assert.match(TOOLLESS_NOTE, /OUTPUT is also finite/)
})

test('an adoption without a library lesson still becomes the next task\'s warm start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h2cur-'))
  const imp = new DemoImprover()
  // Reflection answers NO_ENTRY: the library stays lesson-gated, but the adopted tree must carry over.
  const noLesson = { name: 'no-lesson', call: async (req: any) => (String(req.label).startsWith('experience.') ? { text: '<edits>\ncomponent: memory.md\n</edits>\nNO_ENTRY' } : imp.call(req)) }
  const h2 = new Harness2({ executor: new DemoExecutor(), improver: noLesson, work: { work: 'reconcile signed ledgers' }, baseTree: DEMO_BASE, k: 1, runsDir: join(dir, 'runs'), libraryDir: join(dir, 'lib') })
  const a = await h2.runTask(DEMO_TASKS[0]!)
  assert.ok(a.selection.ok)
  assert.equal(a.libraryUpdated, false)
  assert.notDeepEqual(a.adoptedTree, DEMO_BASE)
  const start = h2.startingHarness(DEMO_TASKS[1]!.domain)
  assert.match(start.from, /^current:/)
  assert.deepEqual(start.tree, a.adoptedTree)
})

test('evidence shrinks per-rollout budgets instead of clipping away the pool or library', async () => {
  const { buildEvidence, READING_GUIDE } = await import('../src/core/evidence.ts')
  const big = 'x'.repeat(40_000)
  const rollout = (label: string) => ({ label, ok: true, delivered: true, deliverable: big, trajectory: big })
  const ev = buildEvidence({
    task: { id: 't', domain: 'd', prompt: 'p' },
    harness: { 'systemprompt.md': 'base' },
    harnessLabel: 'base',
    base: [rollout('base1'), rollout('base2')],
    pool: ['inv1', 'dom1', 'inv2', 'dom2'].map(l => ({ label: l, harness: { 'systemprompt.md': l }, rollout: rollout(l) })),
    library: 'LIBRARY-SENTINEL',
    limits: { totalChars: 80_000 },
  } as never)
  assert.ok(ev.length <= 80_000, `length ${ev.length}`)
  assert.ok(ev.includes(READING_GUIDE))
  for (const l of ['inv1', 'dom1', 'inv2', 'dom2']) assert.ok(ev.includes(`candidate \`${l}\``), l)
  assert.ok(ev.includes('LIBRARY-SENTINEL'))
  assert.match(ev, /chars elided/)
})

test('restored reference prompt rules are present', async () => {
  const P = await import('../src/core/prompts.ts')
  const wp = { work: 'w' }
  const inv = P.propose(wp, 'INV')
  assert.match(inv, /THE LIBRARY HOLDS FINISHED HARNESSES/)
  assert.match(inv, /the mapping itself\nremoves it/)
  assert.match(P.propose(wp, 'DOM'), /if you add some, cut some/)
  const agg = P.aggregate(wp, { k: 2 })
  assert.match(agg, /draws from ONE distribution/)
  assert.match(agg, /Open what each side PRODUCED/)
  assert.match(P.select(wp, 2, ['A', 'B']), /CHECK THE CLAIMS AGAINST THE SOURCE MATERIAL/)
  assert.match(P.experience(wp), /An edit that appeared only in a rejected candidate/)
})

test('validate rejects scripts that do not compile and accepts ones that do', async () => {
  const { validate, scriptSyntaxError, DEFAULT_SURFACE } = await import('../src/core/tree.ts')
  assert.equal(scriptSyntaxError('scripts/a.py', 'print(1)\n'), '')
  assert.match(scriptSyntaxError('scripts/a.py', 'x = (1,\n'), /never closed|SyntaxError/)
  assert.notEqual(scriptSyntaxError('scripts/a.sh', 'if then fi\n'), '')
  assert.notEqual(scriptSyntaxError('scripts/a.js', 'const x = ;\n'), '')
  assert.equal(scriptSyntaxError('scripts/a.mjs', 'import fs from "node:fs"\nawait 1\n'), '')
  const base = { 'systemprompt.md': 'Run `scripts/sum.py` to total rows.' }
  assert.doesNotThrow(() => validate(DEFAULT_SURFACE, { ...base, 'scripts/sum.py': 'print(sum([1, 2]))\n' }))
  assert.throws(() => validate(DEFAULT_SURFACE, { ...base, 'scripts/sum.py': 'print(sum([1, 2]\n' }), /scripts\/sum\.py does not compile/)
  assert.doesNotThrow(() => validate(DEFAULT_SURFACE, { ...base, 'scripts/sum.py': 'print(sum([1, 2]\n' }, { compileScripts: false }))
})
