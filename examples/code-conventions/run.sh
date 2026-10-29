#!/usr/bin/env bash
# Reproduce the code-conventions held-out experiment with deepseek-flash only. Needs DEEPSEEK_API_KEY and python3.
# Held-out tasks are graded by running hidden unit tests against the module extracted from each reply.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-runs/code}
M=(--executor llm --model deepseek-flash --solver-model deepseek-flash)
D=examples/code-conventions
node bin/harness2-dsh.js eval --tasks $D/held.json --harness base --repeats 3 "${M[@]}" --out $OUT/eval-base
node bin/harness2-dsh.js eval --tasks $D/oracle.json --harness base --repeats 3 "${M[@]}" --out $OUT/eval-oracle
node bin/harness2-dsh.js run --tasks $D/train.json --k 1 --mode parallel "${M[@]}" --out $OUT/run
R=$OUT/run/runs
node bin/harness2-dsh.js eval --tasks $D/held.json --repeats 3 "${M[@]}" --out $OUT/eval-held \
  --harness $R/code__train-standards/parallel-k1/adopted --harness $R/code__train-calendar/parallel-k1/adopted
