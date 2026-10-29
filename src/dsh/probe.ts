/**
 * `harness2-probe` -- enforces a CANDIDATE harness's loop policies inside a headless probe.
 *
 * The headless executor launches `dsh --patch <probe.patch.yml> --profile headless`, inserting
 * this plugin with the probe workspace's `.harness2/` tree. Without it, a candidate's
 * `plugins/*.json` would only reach the probe as prose in AGENTS.md, so the probe would not
 * measure what the adopted harness actually does once activated in-process.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_SURFACE, readTree } from '../core/tree.ts'
import { compilePolicies, installPolicyHooks } from './runtime.ts'

export const name = 'harness2-probe'

export interface Config {
  /** Absolute path of the candidate harness tree (the probe workspace's `.harness2/`). */
  treeDir: string
}

export const Config: Schema<Config> = Schema.object({
  treeDir: Schema.string().required(),
}) as Schema<Config>

export function apply(ctx: Context, config: Config): void {
  const policies = compilePolicies(readTree(DEFAULT_SURFACE, config.treeDir), DEFAULT_SURFACE)
  installPolicyHooks(ctx, () => policies)
}
