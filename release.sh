#!/usr/bin/env bash
# release.sh — bump the build in both places at once, so they cannot drift.
#
#   ./release.sh 2026.09.02
#   ./release.sh 2026.09.02 "Adds the $ RDR deflection column."
#
# Then: git commit + push. Cloudflare deploys on its own.

set -euo pipefail
cd "$(dirname "$0")"

SITE=public
VER="${1:-}"
NOTES="${2:-}"

if [ -z "$VER" ]; then
  echo "usage: ./release.sh <version> [notes]"
  echo "current: $(grep -o 'APP_VERSION *= *"[^"]*"' $SITE/index.html | head -1 | sed 's/.*"\(.*\)"/\1/')"
  exit 1
fi

MODEL=$(grep -o 'MODEL_VERSION *= *"[^"]*"' $SITE/index.html | head -1 | sed 's/.*"\(.*\)"/\1/')

# 1. stamp index.html
perl -0pi -e "s/(APP_VERSION\s*=\s*)\"[^\"]*\"/\$1\"$VER\"/" $SITE/index.html

# 2. write version.json to match
python3 - "$VER" "$MODEL" "$NOTES" <<'PY'
import json, sys
ver, model, notes = sys.argv[1], sys.argv[2], sys.argv[3]
open("public/version.json", "w").write(json.dumps(
    {"version": ver, "model": model, "notes": notes}, indent=2) + "\n")
PY

# 3. prove they agree
./check.sh

echo
echo "Next:  git add -A && git commit -m \"release $VER\" && git push"
