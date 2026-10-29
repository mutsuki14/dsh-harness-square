#!/usr/bin/env bash
# Reproduce the helpdesk-triage held-out experiment with deepseek-flash only.
# Needs DEEPSEEK_API_KEY. Writes everything under ${OUT:-runs/helpdesk}.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-runs/helpdesk}
M=(--executor llm --model deepseek-flash --solver-model deepseek-flash)
D=examples/helpdesk-triage
# 1. Base vs. ceiling (all three policy documents attached to every task).
node bin/harness2-dsh.js eval --tasks $D/held.json --harness base --repeats 3 "${M[@]}" --out $OUT/eval-base
node bin/harness2-dsh.js eval --tasks $D/oracle.json --harness base --repeats 3 "${M[@]}" --out $OUT/eval-oracle
# 2. Three training tasks in order: policy, output standard, policy AMENDMENT. Each warm-starts from the last.
node bin/harness2-dsh.js run --tasks $D/train.json --k 1 --mode parallel "${M[@]}" --out $OUT/run
# 3. Held-out tasks attach nothing and are graded on the amended rules.
R=$OUT/run/runs
node bin/harness2-dsh.js eval --tasks $D/held.json --repeats 3 "${M[@]}" --out $OUT/eval-held \
  --harness $R/helpdesk__train-policy/parallel-k1/adopted \
  --harness $R/helpdesk__train-format/parallel-k1/adopted \
  --harness $R/helpdesk__train-update/parallel-k1/adopted
