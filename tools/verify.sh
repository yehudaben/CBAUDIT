#!/usr/bin/env bash
# Full verification. Run this before every release — it is the whole reason
# the numbers in this tool can be trusted.
#
#   ./tools/serve.sh &                       # note the port it prints
#   BASE_URL=http://127.0.0.1:8111 ./tools/verify.sh
#
# Needs: fixtures/sample.csv (a real portal export, gitignored) and the
# fx_* fixtures from make_fixtures.py. Node needs `npm i playwright` once.
set -uo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE_URL:-http://127.0.0.1:8111}"
export BASE_URL="$BASE"

echo "target: $BASE"
echo -n "served build: "
curl -s "$BASE/index.html" | grep -o 'APP_VERSION *= *"[^"]*"' | head -1
echo -n "file build:   "
grep -o 'APP_VERSION *= *"[^"]*"' public/index.html | head -1
echo "^ these MUST match. If they differ, a stale server is answering."
echo

fail=0
step(){ echo "--- $1 ---"; shift; "$@" || fail=1; echo; }

step "version strings agree"        ./check.sh
step "dump app state"               node tools/audit_dump.js
step "A — field capture"            python3 tools/audit_A_fields.py
step "B — arithmetic"               python3 tools/audit_B_math.py
step "C — grading"                  python3 tools/audit_C_grading.py
step "boot + update banner"         node tools/test_boot.js
step "monthly reset behaviour"      node tools/test_months.js
step "tracker + outcomes"           node tools/test_tracker.js
step "drive backend"                node tools/test_drive.js
step "processor api pull"          node tools/test_apipull.js

echo "======================================================"
[ $fail -eq 0 ] && echo "all steps ran. Read the counts above — a step can" \
  && echo "exit 0 and still report mismatches. Zero is the only pass." \
  || echo "A STEP FAILED — do not release."
exit $fail
