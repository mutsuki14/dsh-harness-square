# dsh-harness2

**Recursive agent harnessing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**, ported from Google Research's [Harness²](https://github.com/google-research/harness2) (*Recursive Agent Harnessing for an Open World*). It ships as a DSH plugin bundle (`dsh.bundle`).

A **harness** is everything around the model: the system prompt, guardrails, memory, tool guidance, skills, sub-agents, scripts and plugins. This bundle lets a DSH agent **improve its own harness**, with the model weights left unchanged:

- **Task-level recursion (ProposeProbeCompose).** The task is rolled out k times under the current harness. The improver then proposes k procedure (INV) and k domain-knowledge (DOM) edits, *probes* each edit by running it, and *composes* refined harnesses from the behavioural contrasts. No ground-truth answers are needed. There are two modes:
  - `parallel`: 2k independent candidates, then k compositions;
  - `sequential`: k successive propose/probe/compose rounds.
  
  Either way the budget is exactly **R = 4k rollouts** and **P = 3k improver stages**, and the ledger asserts this.
- **Blind selection.** The k finals are anonymised (seeded shuffle) and the selector picks one by looking only at the artifacts.
- **Harnessing-level recursion.** A reflector writes per-edit verdicts plus at most one evidence-backed lesson. That lesson and the adopted harness go into a per-domain **experience library**, which the next task in the same domain reads (and warm-starts from).

[中文说明](README.zh.md)

## Architecture

```
src/core/            framework-agnostic method (no Cordis/DSH dependency)
  tree.ts            8-component harness tree, surface rules, validation, diversity
  policy.ts          declarative "plugin" component (JSON loop policies)
  protocol.ts        improver reply protocol (<file>/<delete>/<keep_base/>/<notes>, choice, experience)
  prompts.ts         INV / DOM / aggregate / compose / select / experience prompts (from harness2)
  evidence.ts        bounded evidence document (task, sources, rollouts, candidate diffs, library)
  recursion.ts       runParallel / runSequential, retry-once-then-inherit, ledger
  selection.ts       blind selection + post-adoption reflection
  library.ts         per-domain experience library (INDEX.md, adopted trees, EXPERIENCE.md)
  pipeline.ts        Harness2: base rollouts -> recursion -> selection -> reflection -> library
src/dsh/             DeepSeek Harness integration (Cordis plugins)
  service.ts         ctx.harness2: library, active harness per domain, improvement runs, events
  runtime.ts         applies the active harness to live agents
  tools.ts           harness2_improve / harness2_status / harness2_reset
  executors.ts       LlmExecutor (ctx.llm), WorkflowExecutor (ctx.workflowEngine child), HeadlessExecutor (dsh --profile headless --json)
  improver.ts        LlmImprover (ctx.llm) and DeepSeekApiImprover (standalone)
cordis.patch.yml     bundle layer mounting the three plugins
```

How each harness component maps onto DSH extension points (`harness2-runtime`):

| harness component | DSH mechanism |
|---|---|
| `systemprompt.md`, `guardrails.md`, `memory.md`, `tool_guidance.md` | one dynamic `ctx.systemPrompt.section()` (always on) |
| `skills/<n>/SKILL.md`, `sub_agents/<n>/AGENT.md` | the `harness2_skill` tool (loaded on demand) |
| `scripts/<n>.{py,js,sh}` | materialised for the shell / headless workspaces |
| `plugins/<n>.json` `pre` / `post` / `stop` rules | `tools/pre-execute` (deny/ask), `tools/post-execute` (reminder), `agent/turn-stopping` (`agent.steer`) |

In harness2, plugins are TypeScript files. Here they are **declarative JSON policies** instead, so that model-written code never runs inside the Cordis process. They still act in the tool loop and are validated before they are activated.

Probe executors:

| executor | isolation | notes |
|---|---|---|
| `headless` (**default**) | full: one `dsh --profile headless --json` process per probe, own workspace, own `.git` project root | harness installed as `AGENTS.md` + `.agents/skills/`; pass `workspace` to copy the task's files in (skips `.git`, `node_modules`; capped at 2000 files / 50 MB); token usage read from `step_end` events |
| `workflow` | instruction-level only: a child agent of the caller sharing its cwd | probes are told to work in `.harness2-probes/<runId>/`; token usage not observable |
| `llm` | n/a: one `ctx.llm` completion, no tools | cheapest; flagged `toolless`, so the improver may not add scripts or write "no tools available" into the harness, and raw tool-call markup counts as not delivered |

Skill directory names must be kebab-case (`ledger-total`, not `ledger_total`): dsh's skill registry silently ignores anything else, so the surface rejects it.

## Install into a DSH profile

```sh
git clone <this repo> dsh-harness2 && cd dsh-harness2 && npm install   # prepare builds lib/
dsh plugin --profile demo add ./dsh-harness2
dsh --profile demo --dump-config     # shows a "# == dsh-harness2" layer
dsh --profile demo web
```

The bundle needs a model provider. The defaults use `deepseek-official` with `deepseek-v4-pro` as the improver and `deepseek-flash` as the solver; override these by row id (see `examples/profile.cordis.patch.yml`). Then ask the agent, for example: *"Use harness2_improve on this task with k=2 in domain legal-contracts: …"*. The adopted harness is activated for that domain straight away and takes effect on the agent's next step.

### Service configuration (`harness2` row)

| key | default | meaning |
|---|---|---|
| `improverProvider` / `improverModel` | `deepseek-official` / `deepseek-v4-pro` | propose / compose / select / reflect |
| `solverProvider` / `solverModel` | `deepseek-official` / `deepseek-flash` | `llm` executor |
| `executor` | `headless` | `headless` \| `workflow` \| `llm` (`workflow` falls back to `llm` when there is no calling agent) |
| `k`, `maxK`, `mode` | `1`, `3`, `parallel` | recursion budget, ceiling, mode |
| `autoActivate`, `defaultDomain` | `true`, `general` | activate the adopted harness; default domain |
| `root` | `$DSH_HOME/harness2` | library, active harnesses, runs, audit |
| `headlessCommand` | `dsh` | how the headless executor launches dsh |
| `improverPrice` / `solverPrice` | unset | optional `{input, output}` USD per 1M tokens; without them runs report tokens only (no built-in price table) |

Events: `harness2/progress` and `harness2/activated`.

## Standalone use (no DSH process)

```sh
npm install
node bin/harness2-dsh.js demo --k 2                     # deterministic, no API key
DEEPSEEK_API_KEY=... node bin/harness2-dsh.js run --tasks examples/tasks.json --k 1 --mode parallel
node bin/harness2-dsh.js run --tasks examples/tasks.json --executor headless   # probes via `dsh` CLI
```

Add `--price <in>,<out>` (USD per 1M tokens) to also report cost; token counts are always reported.

### Held-out evaluation

`eval` scores harnesses on tasks the improvement loop never saw, with a deterministic checker kept outside the method:

```sh
node bin/harness2-dsh.js eval --tasks heldout.json --harness base --harness runs/runs/<task>/parallel-k1/adopted --repeats 3
```

Each task carries `"expect": {"pattern": "^Total: 1724\\.50$"}` (a multiline regex). `run` strips `expect` before tasks enter the loop, so grading data never reaches the improver. Results go to `<out>/eval.json`. In the toolless (`llm`) executor, transport failures are retried; empty or cut-off answers count as failures and record `finish_reason`.

Run artefacts are written to `runs/<task>/<mode>-k<k>/`: every harness tree, every rollout, `mode.json`, `selection.json` and `summary.json`. The library lives in `library/<domain>/`.

## Verified against real DeepSeek Harness

End-to-end in a sandbox with `@deepseek-ai/dsh@0.2.1-rc.4` and `deepseek-flash` (every row is a live run):

| path | result |
|---|---|
| bundle install / load | `dsh plugin add` + `--dump-config` show the layer; all plugins activate |
| activated harness in a live agent turn | the agent loaded the skill via `harness2_skill`; the `pre` rule denied `rm` (file kept); the `post` reminder was appended to the `write` result and the agent re-read the file; the `stop` rule steered one extra step |
| activated harness scripts | the agent ran `scripts/*.py` from the active harness dir by absolute path |
| headless probe of a candidate | dsh loaded the candidate skill with its own `skill` tool; the candidate's `pre` deny rule was enforced in the probe via the `harness2-probe` plugin; `bash` ran under bubblewrap |
| agent calls `harness2_improve` (headless) | 4 isolated probes, each with its own `.git` and seeded input; caller workspace untouched |
| agent calls `harness2_improve` (workflow) | probes stayed in `.harness2-probes/<runId>/`; caller workspace untouched |
| parallel k=2 and sequential k=2 (CLI) | R=4k / P=3k; non-trivial blind selection; a 2-task stream warm-started task 2 from task 1's adopted harness (identical tree) |
| agent calls `harness2_improve` k=2 (headless) | R=8 / P=6, 8 isolated probes, blind selection adopted `agg2`, library updated; usage recorded for every stage |
| token / cost | usage incl. cache reads observed from API and dsh `step_end`; cost recomputed independently and matched |
| held-out eval (toolless, flash) | 200-row multi-currency ledger family (duplicates by `seq`, reversals by `ref`, half-even rounding per line). Base harness 11/12 and 11/12 across two runs; the harness adopted from one training task also scored 11/12 (4 held-out tasks × 3 repeats) |
| held-out eval, 400 rows (toolless, flash) | base 2/8 and 3/8 (two runs); candidates from one improvement run: `inv1` 4/8, `agg1` 4/8, `dom1` 1/8. Almost every miss is the model hitting its 65,536-token output limit, not a wrong rule |

### A task family where improvement is measurable: team conventions

`examples/acme-conventions/` (reproduce with `examples/acme-conventions/run.sh`, flash only). Each of two
training tasks shows one team handbook once: data conventions (amounts are cents, `QA-` accounts excluded,
refunds subtract, cancelled sales never count) and the dashboard line (`KPI <CODE> <period> = <value>`).
The six held-out tasks are new months with new data and **no handbook**. They ask for net revenue (needs
the data handbook), the order-count KPI (needs the dashboard handbook) or the revenue KPI (needs both).
The checker grades only the value on the first line. Three independent improvement runs, 6 tasks × 3 repeats each:

| harness | run 1 | run 2 | run 3 |
|---|---|---|---|
| base (no handbook) | 1/18 | 1/18 | 0/18 |
| after training task 1 (data handbook) | 6/18 | 6/18 | — |
| after training task 2 (warm-started from task 1) | **15/18** | **18/18** | **14/18** |
| ceiling: base with both handbooks in every task | 18/18 | | |

Across those three runs that is 2/54 → 47/54 (87%). No held-out answer or held-out period appears in any
adopted harness or library; the only matching number, `= 12`, is the training task's own answer, used as
a formatting example.

**After the reference-alignment pass** (restored harness2 prompt rules, budgeted evidence, tool-agnostic
base prompt, plus two fixes below), three new independent runs, same tasks and checker:

| harness after training task 2 | run 4 | run 5 | run 6 |
|---|---|---|---|
| current version | **18/18** | **18/18** | **18/18** |

54/54 against 47/54 before. The intermediate runs that led there are recorded because each one exposed a
real defect:

| intermediate run | held-out | what went wrong | fix |
|---|---|---|---|
| warm start, before fix | 12/18 | task 2 rewrote task 1's skill to "apply only the exclusions this handbook states", so `QA-` and cancelled rules were dropped for revenue KPIs | prompts: inherited conventions stay in force; absence is not contradiction; add, never narrow |
| `--no-warm-start` (harness2 reference: library only) | 5/18 | task 2 starts from base and only reads task 1's harness in the library, so the data conventions did not carry over | none needed: warm start is this port's default for this reason |
| warm start, after fix 1 (one of two runs) | 6/18 | task 2's base run was already right (the handbook was attached), so the composer kept the base and the dashboard convention was never recorded | prompts: a standing convention declared in the material is domain knowledge, encoded even when the run succeeded |

Caveats. Both prompt fixes were motivated by failures on this same family; the held-out tasks were never
seen by the method, but the prompts were developed while watching it, so a fresh task family is needed to
confirm the fixes generalise. The ledger families below were not re-run after these changes.

- This family tests what a harness is for: carrying conventions learned on one task into later ones. It
  does not show that the method makes the model better at arithmetic. The ledger families below show it
  does not.

### Second family, fresh after the fixes: helpdesk triage with a policy amendment

`examples/helpdesk-triage/` (reproduce with `run.sh`, flash only). Written after the reference-alignment
pass, never used to develop prompts. It differs from the acme family on every axis that matters:

- **Domain and work**: classifying and routing IT tickets, not computing a revenue figure.
- **Three training tasks, one document each**: the triage policy (routing precedence, severity thresholds),
  the ops output standard (`TRIAGE <date> P1=n P2=n P3=n SEC=n`), and a **policy amendment** that changes
  three rules from task 1 (contractors → `desk` instead of `vendor`, VPN → `net`, P1 threshold 50 → 30).
- **Held-out tasks** attach nothing and are graded on the amended rules. Every batch contains a contractor
  ticket, a VPN ticket and a ticket with 30–49 users, so a harness that kept the old rules fails. The checker
  was verified offline: correct answers pass, pre-amendment answers fail.

This tests the open question from the acme fixes: "inherited rules stay in force" must not stop a later
task from legitimately REPLACING a rule.

| harness | run A | run B | run C |
|---|---|---|---|
| base (nothing attached) | 0/18 | | |
| ceiling: base with all three documents attached | 18/18 | | |
| after task 1 (policy) | 0/18 | | |
| after task 2 (+ output standard) | 6/18 | | |
| **after task 3 (+ amendment)** | **18/18** | **18/18** | **18/18** |

- 0/54 → 54/54 across three independent runs, matching the ceiling.
- Run A's intermediate harnesses show it built up step by step. After task 1 the triage lines followed
  the old policy, which is correct for that point in time but wrong for the held-out tasks. After task 2
  the summary tasks passed (6/18). After task 3 everything passed.
- All three final harnesses REPLACED the amended rules rather than keeping both: each skill names `desk`
  as current and `vendor` as retired, adds VPN to the `net` rule, and states P1 at 30 users. All three
  also kept the unchanged rules (`sec` precedence, the P2 rules) and task 2's output standard.
- No held-out date, ticket id or count appears in any adopted harness.
- No code or prompt changes were made for this family.

What the held-out runs show, honestly:

- **No measured gain on the ledger families.** On the 200-row family the adopted harness was correct and transferred (a domain
  skill with the rule order, per-line rounding and a removed-row audit) but tied the base at ~92%: the remaining
  misses are occasional slips of a few cents. A policy-driven family (rules only in a POLICY.md, 50 rows) and
  the 30- and 120-row families were solved 100% by the base harness.
- **At 400 rows the bottleneck is output budget, not rules.** A single toolless completion runs out of output
  tokens about half the time. The best candidates (`inv1`, `agg1`: "keep working compact, carry a running
  subtotal") reached 4/8 against 2–3/8 for base. That is within noise at this sample size, and `dom1` was worse
  (1/8). The lever that would fix this family is a script, which only exists when the probes have tools
  (the `headless` executor); toolless probes cannot test it.
- **Selection can legitimately adopt nothing.** In three improvement runs on the 400-row training task, every
  final rollout was cut off at least once, so blind selection had no artifact to choose from and kept the
  starting harness. This matches harness2 (the finals-only pool has no base fallback); the CLI now prints
  `adopted=none (selection failed: …; kept base)` instead of an empty label.

### Alignment with the harness2 reference

A module-by-module comparison with `google-research/harness2` (`core/{recursion,selection,context,tree,prompts,schedule}.py`)
found the recursion, selection pool, trivial selection, ledger and library gating already matched. What was
missing or weakened, and is now restored or adapted:

- **Prompts**: the full GENERALIZE block (write the fact itself, not the procedure for rediscovering it;
  labelled workspace facts; library harnesses must be copied and re-verified), the DOM encoding and
  hard rules, the aggregate's "read the base set as one distribution" and "open what each side produced",
  the selector's full CONFORMANCE / FIDELITY / CONSISTENCY / FITNESS criteria and artifact-only framing,
  and the reflector's calibration rules (rejected candidates are evidence, prefer `confounded`).
- **Evidence**: the reference serves full trajectories as files; a single DSH call cannot, so the document
  now shrinks per-rollout budgets until it fits instead of clipping the end (which used to drop the pool
  and library), carries the reference's reading guide, and marks elisions as ours. Reflection now sees
  each rollout's deliverable.
- **Validation**: scripts must compile (`python3` / `bash -n` / `node --check`), like harness2's `_py_compiles`.
- **Schedule**: domains run concurrently with tasks ordered inside each domain (`--domain-workers`, the
  reference's `--workers`); results report `adoptedIsBase` (`chosen_tree_is_base`); `--no-warm-start`
  reproduces the reference's library-only behaviour.

Bugs these runs found and fixed: tool-call markup counted as a deliverable; probe limitation written into the
harness; snake_case skills ignored by dsh; YAML-invalid skill frontmatter ignored by dsh; headless workspaces
reading the outer repo; shared-cwd contamination between workflow probes and writes into the caller's
workspace; skill triggers naming the wrong tool; candidate policies not enforced in headless probes; reports
lost when a workflow child's structured output failed; cache tokens missing from cost; the base system prompt
saying "with your tools", which one-shot probes answered with tool calls (one-shot executors now add a
runtime note instead, outside the harness); an adoption whose
reflection wrote `NO_ENTRY` lost as the next task's warm start (the domain now keeps a `current/` harness
separately from the lesson-gated library entries); long non-streaming
API calls cut mid-generation (`terminated`), which polluted eval results as wrong answers (the client now
streams); truncated answers (`finish_reason=length`) shown to the improver as an unexplained "PRODUCED
NOTHING" (evidence now states the cause and every rollout's output tokens, and the toolless note warns that
adding passes can push a near-limit rollout over its output budget).

## Development

```sh
npm run build && npm run typecheck && npm test
```

The tests cover the surface and validation rules, the reply protocol, the policy invariants, end-to-end runs in both modes at k=1 and k=2 (checking the budget identity, adoption and library warm start), and mounting the bundle on a real Cordis context (system-prompt section, skill tool, pre/post policy hooks, improvement and activation).

## Credits and license

The method, prompts and invariants are adapted from [google-research/harness2](https://github.com/google-research/harness2) (Apache-2.0). The integration targets [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT). This project is Apache-2.0. DSH's public APIs are still pre-stable, so this bundle types the services it uses structurally (`src/dsh/types.ts`).
