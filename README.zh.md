# dsh-harness2

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**递归 Agent 框架优化（Recursive Agent Harnessing）**插件包。思路与代码移植自 Google Research 的 [Harness²](https://github.com/google-research/harness2)。

- **任务级递归（ProposeProbeCompose）**：先在当前 harness 下执行任务 k 次。随后提出 k 个流程类（INV）编辑和 k 个领域知识类（DOM）编辑，逐一实际运行（probe），再根据各次执行之间的行为差异组合出更好的 harness。整个过程不需要标准答案。
  - `parallel`（并行，探索更宽）
  - `sequential`（串行，打磨更深）
  
  两种模式的预算都严格等于 R=4k 次执行、P=3k 次改进调用。
- **盲选**：k 个最终候选匿名化后，只根据产出物挑选其一。
- **框架级递归**：反思阶段为每个编辑给出判定，并最多沉淀一条有证据支撑的经验。经验连同被采纳的 harness 一起写入按领域划分的**经验库**，同领域的下一个任务会读取它，并以它为起点继续优化。

## 组件到 DSH 的映射

| harness 组件 | DSH 机制 |
|---|---|
| systemprompt / guardrails / memory / tool_guidance | `ctx.systemPrompt.section()` 动态段落 |
| skills / sub_agents | `harness2_skill` 按需加载工具 |
| plugins/*.json | `tools/pre-execute`（拒绝/询问）、`tools/post-execute`（提醒）、`agent/turn-stopping`（steer） |

在 harness2 中插件是 TS 代码；本插件改为声明式 JSON 策略，以免模型生成的代码在 Cordis 进程内执行。

执行器有三种，保真度依次升高：
- `llm`：单次 `ctx.llm` 调用；
- `workflow`：通过 `ctx.workflowEngine` 启动一个全新的子 Agent；
- `headless`：以 `dsh --profile headless --json` 子进程运行。

## 使用

```sh
npm install
dsh plugin --profile demo add ./dsh-harness2
dsh --profile demo web
# 对 Agent 说："用 harness2_improve 在 legal-contracts 领域以 k=2 优化这个任务：……"
```

脱离 DSH 单独运行：

```sh
node bin/harness2-dsh.js demo --k 2
DEEPSEEK_API_KEY=... node bin/harness2-dsh.js run --tasks examples/tasks.json
```

详细配置见 [README.md](README.md)。许可证：Apache-2.0。
