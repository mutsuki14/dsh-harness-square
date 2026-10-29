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

执行器有三种：
- `headless`（默认）：每次试跑起一个独立的 `dsh --profile headless --json` 进程，有独立工作区和独立的 `.git` 项目根，互不干扰。可以用 `workspace` 参数把任务文件复制进去。
- `workflow`：调用方的子 Agent，和调用方共用工作目录，只靠提示要求它在 `.harness2-probes/<runId>/` 里工作。
- `llm`：单次模型调用，没有工具，成本最低。

skill 目录名必须是短横线命名（如 `ledger-total`），dsh 会静默忽略其他命名。

每次运行都会报告 token 用量；配置 `improverPrice` / `solverPrice`（或命令行 `--price`）后还会报告金额。

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

留出集评测（评分数据不会进入优化循环）：

```sh
node bin/harness2-dsh.js eval --tasks heldout.json --harness base --harness <adopted 目录> --repeats 3
```

实测（仅 deepseek-flash，toolless 执行器）：

- 200 行多币种账本：base 两次均 11/12，采纳的 harness 也是 11/12。改进内容正确且可迁移，但没有提分，剩下的错误是偶发的几分钱误差。
- 30 行、120 行账本以及"规则只写在 POLICY.md 里"的任务族：base 全对。
- 400 行账本：base 2/8、3/8；同一次改进产生的候选 `inv1` 4/8、`agg1` 4/8、`dom1` 1/8。几乎所有失败都是模型撞上 65,536 的输出 token 上限，而不是规则理解错。按这个样本量，4/8 对 2–3/8 还在噪声范围内。
- 这一族真正有效的手段是写脚本计算，只有带工具的 headless 探针才能验证；toolless 探针测不出来。

**能测出提升的任务族：团队约定**（`examples/acme-conventions/`，用 `run.sh` 复现，只用 flash）

两个训练任务各附一份团队手册，每份只出现一次：一份是数据约定（金额单位是美分、剔除 `QA-` 测试账户、退款要减、取消的销售不算），另一份是看板首行格式（`KPI <代码> <期间> = <值>`）。6 道留出题换了月份和数据，而且**不附手册**。

| harness | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| base（无手册） | 1/18 | 1/18 | 0/18 |
| 训练任务 1 之后（学到数据手册） | 6/18 | 6/18 | — |
| 训练任务 2 之后（从任务 1 的结果接着改） | **15/18** | **18/18** | **14/18** |
| 上限：base 且每题都附两份手册 | 18/18 | | |

三次合计从 2/54 提到 47/54（87%），上限是 100%。采纳的 harness 里没有任何留出题的答案或月份。这一族测的是"把前面任务学到的约定带到后面的任务"，这正是 harness 的作用；它不说明模型的算术能力变强了。

详细配置见 [README.md](README.md)。许可证：Apache-2.0。
