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
  await root.registry.get(runtime as any)?.dispose?.()
})

test('headless --json events fold into a trajectory', () => {
  const f = foldHeadlessEvents(['{"type":"session","sessionId":"s1"}', '{"type":"tool_call","tool":"bash","input":{"command":"ls"}}', '{"type":"tool_result","status":"completed","result":"a.txt"}', '{"type":"final","text":"done"}'])
  assert.equal(f.final, 'done'); assert.equal(f.sessionId, 's1'); assert.match(f.trajectory, /\[ACTION\] bash/)
})
