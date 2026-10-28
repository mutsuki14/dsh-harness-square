/**
 * dsh-harness2 -- recursive agent harnessing for DeepSeek Harness.
 *
 * Bundle entry. Mounting the default export composes all three plugins:
 *
 *   harness2          (service)  library + active harness + improvement runs   -> ctx.harness2
 *   harness2-runtime  (consumer) applies the active harness to live agents
 *   harness2-tools    (consumer) harness2_improve / harness2_status / harness2_reset
 *
 * `cordis.patch.yml` mounts them as separate rows so each can be configured or disabled.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import Harness2Service, { Config as ServiceConfig } from './service.ts'
import * as runtime from './runtime.ts'
import * as tools from './tools.ts'

export { Harness2Service, ServiceConfig }
export * as runtime from './runtime.ts'
export * as tools from './tools.ts'
export * from './executors.ts'
export * from './improver.ts'
export * from './render.ts'
export * from './defaults.ts'
export type { ImproveRequest, RunRecord, ExecutorKind } from './service.ts'
export * as core from '../core/index.ts'

export const name = 'harness2-bundle'

export interface Config {
  service?: Partial<ServiceConfig>
  runtime?: Partial<runtime.Config> | false
  tools?: Partial<tools.Config> | false
}

export const Config: Schema<Config> = Schema.object({
  service: Schema.any().default({}),
  runtime: Schema.any().default({}),
  tools: Schema.any().default({}),
}) as Schema<Config>

/** One-row composition: service + runtime + tools. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(Harness2Service, (config.service ?? {}) as ServiceConfig)
  if (config.runtime !== false) ctx.plugin(runtime, (config.runtime ?? {}) as runtime.Config)
  if (config.tools !== false) ctx.plugin(tools, (config.tools ?? {}) as tools.Config)
}
