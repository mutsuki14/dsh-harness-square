#!/usr/bin/env bash
# Reproduce the "team conventions" held-out experiment with deepseek-flash only.
# Needs DEEPSEEK_API_KEY. Writes everything under ${OUT:-runs/acme}.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-runs/acme}
M=(--executor llm --model deepseek-flash --solver-model deepseek-flash)
D=examples/acme-conventions
# 1. Ceiling: base harness WITH the handbooks in every task.
node bin/harness2-dsh.js eval --tasks $D/oracle.json --harness base --repeats 3 "${M[@]}" --out $OUT/eval-oracle
# 2. Improve on the two training tasks (each shows one handbook once; task 2 warm-starts from task 1).
node bin/harness2-dsh.js run --tasks $D/train.json --k 1 --mode parallel "${M[@]}" --out $OUT/run
# 3. Held-out tasks have NO handbook: base vs. the harness after task 1 vs. after task 2.
R=$OUT/run/runs
node bin/harness2-dsh.js eval --tasks $D/held.json --repeats 3 "${M[@]}" --out $OUT/eval-held \
  --harness base --harness $R/acme__train-data/parallel-k1/adopted --harness $R/acme__train-dash/parallel-k1/adopted
