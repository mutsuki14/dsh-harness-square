import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { DEMO_BASE, DemoExecutor, DemoImprover, DEMO_TASKS } from '../src/core/demo.ts'
import Harness2Service from '../src/dsh/service.ts'
import * as runtime from '../src/dsh/runtime.ts'
import * as tools from '../src/dsh/tools.ts'
import { foldHeadlessEvents } from '../src/dsh/executors.ts'

class FakeTools extends Service { defs = new Map<string, any>(); constructor(ctx: Context) { super(ctx, 'tools') } register(d: any) { this.defs.set(d.name, d); return () => this.defs.delete(d.name) } }
class FakePrompt extends Service { sections = new Map<string, any>(); constructor(ctx: Context) { super(ctx, 'systemPrompt') } section(s: any) { this.sections.set(s.name, s); return () => this.sections.delete(s.name) } }
const tick = () => new Promise(r => setTimeout(r, 30))

test('bundle mounts on Cordis: section, tools, policies, improvement + activation', async () => {
  const root = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'h2c-'))
  root.plugin(FakeTools); root.plugin(FakePrompt)
  root.plugin(Harness2Service, { root: dir, k: 1, maxK: 3, mode: 'parallel', width: 2, alwaysOnMax: 12000, autoActivate: true, warmStart: true, allowSubagents: true, defaultDomain: 'accounting', executor: 'llm' } as any)
  root.plugin(runtime, { sectionOrder: 50, enforcePolicies: true, skillToolName: 'harness2_skill' })
  root.plugin(tools, { enableImprove: true, policySection: true, timeoutMs: 0 })
  await tick()
  const ctx = root as any
  assert.ok(ctx.tools.defs.has('harness2_skill') && ctx.tools.defs.has('harness2_improve') && ctx.tools.defs.has('harness2_status'))
  assert.match(ctx.systemPrompt.sections.get('harness2:active').text(), /Operating harness/)

  const r = await ctx.harness2.improve({ task: DEMO_TASKS[0], executorImpl: new DemoExecutor(), improverImpl: new DemoImprover() })
  assert.equal(r.adoptedRollout.deliverable.trim(), 'Total: 85.15')
  assert.ok(!ctx.harness2.activeHarness('accounting')['scripts/summarize.js'].includes('a > 0'))

  // Activate a harness with a skill + loop policy and exercise the runtime hooks.
  ctx.harness2.activate('accounting', { ...DEMO_BASE, 'tool_guidance.md': 'Use skill recon for ledgers.',
    'skills/recon/SKILL.md': '---\nname: recon\ndescription: ledger reconciliation\n---\nSum both signs.',
    'plugins/safety.json': JSON.stringify({ description: 'no deletes', rules: [{ on: 'pre', tool: 'bash', match: 'rm -rf', action: 'deny', message: 'never delete' }, { on: 'post', tool: 'write', action: 'remind', message: 're-open the file' }] }) })
  assert.match(ctx.systemPrompt.sections.get('harness2:active').text(), /skill `recon`/)
  assert.match(await ctx.tools.defs.get('harness2_skill').execute({ name: 'recon' }), /Sum both signs/)
  const deny = await root.waterfall('tools/pre-execute' as any, { name: 'bash', arguments: { command: 'rm -rf /' } } as any, async () => ({ kind: 'allow' }) as any)
  assert.equal((deny as any).kind, 'deny')
  const post = await root.waterfall('tools/post-execute' as any, { name: 'write', arguments: {} } as any, { isError: false, content: [{ type: 'text', text: 'ok' }] } as any, async () => ({ kind: 'accept' }) as any)
  assert.match(JSON.stringify(post), /re-open the file/)
  assert.match(await ctx.tools.defs.get('harness2_status').execute({}), /When a ledger includes credits/)
})

test('headless --json events fold into a trajectory', () => {
  const f = foldHeadlessEvents(['{"type":"session","sessionId":"s1"}', '{"type":"tool_call","tool":"bash","input":{"command":"ls"}}', '{"type":"tool_result","status":"completed","result":"a.txt"}', '{"type":"final","text":"done"}'])
  assert.equal(f.final, 'done'); assert.equal(f.sessionId, 's1'); assert.match(f.trajectory, /\[ACTION\] bash/)
})

test('toolless executors never count unexecuted tool-call markup as delivered', async () => {
  const { isUnexecutedToolCall, toollessRollout } = await import('../src/dsh/executors.ts')
  assert.ok(isUnexecutedToolCall('<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<invoke name="bash">'))
  assert.ok(!isUnexecutedToolCall('Total: 85.15'))
  const r = toollessRollout('I will read the file.\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>', '', 1)
  assert.equal(r.delivered, false)
  assert.equal(toollessRollout('Total: 1.00', '', 1).delivered, true)
})

test('headless step usage is summed, and dropped when any step lacked it', () => {
  const ok = foldHeadlessEvents(['{"type":"status","phase":"step_end","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":100}}', '{"type":"status","phase":"step_end","usage":{"inputTokens":5,"outputTokens":1}}'])
  assert.deepEqual(ok.usage, { inputTokens: 15, outputTokens: 3, cacheReadTokens: 100 })
  const partial = foldHeadlessEvents(['{"type":"status","phase":"step_end","usage":{"inputTokens":10,"outputTokens":2}}', '{"type":"status","phase":"step_end"}'])
  assert.equal(partial.usage, undefined)
})

test('service config: loads with no price (regression) and normalises a partial price away', async () => {
  for (const extra of [{}, { solverPrice: {} }, { solverPrice: { input: 0.1, output: 0.4 } }]) {
    const root = new Context()
    root.plugin(Harness2Service, { root: mkdtempSync(join(tmpdir(), 'h2p-')), ...extra } as any)
    await tick()
    const svc = (root as any).get('harness2')
    assert.ok(svc, `service failed to load with ${JSON.stringify(extra)}`)
    assert.deepEqual(svc.config.solverPrice, (extra as any).solverPrice?.input !== undefined ? { input: 0.1, output: 0.4 } : undefined)
  }
})

test('headless install makes the workspace its own project root with dsh-discoverable skills', async () => {
  const { HeadlessExecutor } = await import('../src/dsh/executors.ts')
  const { existsSync, readFileSync } = await import('node:fs')
  const ws = mkdtempSync(join(tmpdir(), 'h2ws-'))
  HeadlessExecutor.install(ws, { 'systemprompt.md': 'Role.', 'tool_guidance.md': 'Use skill ledger-total.', 'skills/ledger-total/SKILL.md': '---\nname: ledger-total\ndescription: d\n---\nx' })
  assert.ok(existsSync(join(ws, '.git')))
  assert.ok(existsSync(join(ws, '.agents/skills/ledger-total/SKILL.md')))
  assert.match(readFileSync(join(ws, 'AGENTS.md'), 'utf8'), /Role\./)
})

test('headless seed copy skips .git/node_modules/probe output and enforces a size cap', async () => {
  const { HeadlessExecutor } = await import('../src/dsh/executors.ts')
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
  const src = mkdtempSync(join(tmpdir(), 'h2seed-'))
  for (const d of ['.git', 'node_modules/x', '.harness2-probes/old', 'data']) mkdirSync(join(src, d), { recursive: true })
  writeFileSync(join(src, 'export.csv'), 'a'); writeFileSync(join(src, 'data/b.txt'), 'b'); writeFileSync(join(src, 'node_modules/x/i.js'), 'i')
  const dest = mkdtempSync(join(tmpdir(), 'h2dest-'))
  HeadlessExecutor.seed(src, dest)
  assert.ok(existsSync(join(dest, 'export.csv')) && existsSync(join(dest, 'data/b.txt')))
  assert.ok(!existsSync(join(dest, 'node_modules')) && !existsSync(join(dest, '.git')) && !existsSync(join(dest, '.harness2-probes')))
  assert.throws(() => HeadlessExecutor.seed(src, mkdtempSync(join(tmpdir(), 'h2d2-')), 1), /exceeds/)
})

test('headless install writes a probe patch only for harnesses with plugins; produced files are collected', async () => {
  const { HeadlessExecutor, probeModulePath, snapshotFiles, producedFiles } = await import('../src/dsh/executors.ts')
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const plain = mkdtempSync(join(tmpdir(), 'h2p1-'))
  HeadlessExecutor.install(plain, { 'systemprompt.md': 'x' })
  assert.ok(!existsSync(join(plain, '.harness2-probe.patch.yml')))
  const withPolicy = mkdtempSync(join(tmpdir(), 'h2p2-'))
  HeadlessExecutor.install(withPolicy, { 'systemprompt.md': 'x', 'plugins/safe.json': JSON.stringify({ description: 'd', rules: [{ on: 'pre', tool: 'bash', match: 'rm ', action: 'deny', message: 'no' }] }) })
  const patch = readFileSync(join(withPolicy, '.harness2-probe.patch.yml'), 'utf8')
  assert.ok(patch.includes(probeModulePath()) && patch.includes(join(withPolicy, '.harness2')))
  assert.ok(existsSync(probeModulePath()))
  assert.ok(!readFileSync(join(withPolicy, 'AGENTS.md'), 'utf8').includes('Loop policies'), 'enforced policies are not duplicated as prose')
  assert.ok(readFileSync(join(plain, 'AGENTS.md'), 'utf8') !== undefined)
  const before = snapshotFiles(withPolicy)
  writeFileSync(join(withPolicy, 'report.txt'), 'Total: 1.00')
  const files = producedFiles(withPolicy, before)
  assert.equal(files.length, 1); assert.match(files[0]!, /report\.txt[\s\S]*Total: 1\.00/)
})

test('probe plugin enforces a candidate deny rule on the real Cordis event pipeline', async () => {
  const { HeadlessExecutor } = await import('../src/dsh/executors.ts')
  const probe = await import('../src/dsh/probe.ts')
  const ws = mkdtempSync(join(tmpdir(), 'h2p3-'))
  HeadlessExecutor.install(ws, { 'systemprompt.md': 'x', 'plugins/safe.json': JSON.stringify({ description: 'd', rules: [{ on: 'pre', tool: 'bash', match: 'rm ', action: 'deny', message: 'never delete' }] }) })
  const root = new Context()
  root.plugin(probe, { treeDir: join(ws, '.harness2') })
  await tick()
  const d = await root.waterfall('tools/pre-execute' as any, { name: 'bash', arguments: { command: 'rm junk.txt' } } as any, async () => ({ kind: 'allow' }) as any)
  assert.deepEqual(d, { kind: 'deny', reason: '[harness2 policy] never delete' })
})

test('steer message is built even when @deepseek-ai/dsh-llm cannot be resolved', async () => {
  const { createSteerMessage } = await import('../src/dsh/types.ts')
  const m = (await createSteerMessage('check it', 'x'.repeat(200))) as any
  assert.equal(m.role, 'user'); assert.equal(m.content[0].text, 'check it'); assert.ok(m.id); assert.ok(m.source.summary.length <= 120)
})

test('workflow probe that writes outside its scratch dir is voided; scratch writes are fine', async () => {
  const { WorkflowExecutor } = await import('../src/dsh/executors.ts')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const shared = mkdtempSync(join(tmpdir(), 'h2wf-'))
  writeFileSync(join(shared, 'export.csv'), 'a')
  const engine = (write: string) => ({ start: (req: any) => ({ id: 'r', cancel() {}, async dispose() {}, result: (async () => {
    const p = join(shared, write); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, String(Math.random()))
    return { stopReason: 'completed', value: { deliverable: 'Total: 1.00', steps: ['s'], blockers: '' } }
  })() }) })
  const ok = await new WorkflowExecutor(engine(`.harness2-probes/${'t.base1'}/result.txt`) as any, {}, { watchDir: shared }).execute({ id: 't', domain: 'd', prompt: 'p' }, {}, 't.base1')
  assert.equal(ok.ok, true)
  const bad = await new WorkflowExecutor(engine('result.txt') as any, {}, { watchDir: shared }).execute({ id: 't', domain: 'd', prompt: 'p' }, {}, 't.agg1')
  assert.equal(bad.ok, false); assert.match(bad.error ?? '', /outside its scratch directory.*result\.txt/)
})

test('workflow probe without a structured report is judged on the files it wrote in scratch', async () => {
  const { WorkflowExecutor } = await import('../src/dsh/executors.ts')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const shared = mkdtempSync(join(tmpdir(), 'h2wf2-'))
  writeFileSync(join(shared, 'export.csv'), 'csv')
  const engine = { start: (req: any) => ({ id: 'r', cancel() {}, async dispose() {}, result: (async () => {
    const d = join(shared, req.args.scratch); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'export.csv'), 'csv'); writeFileSync(join(d, 'result.txt'), 'Total: 975.35\n')
    return { stopReason: 'completed', value: null }
  })() }) }
  const r = await new WorkflowExecutor(engine as any, {}, { watchDir: shared }).execute({ id: 't', domain: 'd', prompt: 'p' }, {}, 't.inv1')
  assert.equal(r.ok, true); assert.equal(r.delivered, true)
  assert.match(r.deliverable, /result\.txt[\s\S]*Total: 975\.35/)
  assert.ok(!r.deliverable.includes('export.csv'), 'verbatim input copies are not deliverables')
})
