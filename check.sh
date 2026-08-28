#!/usr/bin/env bash
# check.sh — confirms the two version strings match. Run before every push.
set -euo pipefail
cd "$(dirname "$0")"

SITE=public
HTML=$(grep -o 'APP_VERSION *= *"[^"]*"' $SITE/index.html | head -1 | sed 's/.*"\(.*\)"/\1/')
JSON=$(python3 -c 'import json;print(json.load(open("public/version.json"))["version"])')

echo "index.html   APP_VERSION : $HTML"
echo "version.json version     : $JSON"

if [ "$HTML" = "$JSON" ]; then
  echo "MATCH — safe to push."
else
  echo "MISMATCH — do not push. The update banner would nag every user forever."
  exit 1
fi
