#!/usr/bin/env bash
# Serve public/ for the test suite. Picks a free port and prints it.
#
#   ./tools/serve.sh          # serves on 8111, or the next free port
#   BASE_URL=http://127.0.0.1:8111 node tools/test_boot.js
#
# Always check the served bytes, not the file on disk — a stale server left
# running on the same port will happily answer with an older build and every
# test will pass against the wrong artifact.
set -euo pipefail
cd "$(dirname "$0")/../public"
PORT="${PORT:-8111}"
while lsof -i ":$PORT" >/dev/null 2>&1 || nc -z 127.0.0.1 "$PORT" 2>/dev/null; do
  echo "port $PORT is busy — trying $((PORT+1))" >&2
  PORT=$((PORT+1))
done
echo "serving $(pwd) on http://127.0.0.1:$PORT"
echo "export BASE_URL=http://127.0.0.1:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
