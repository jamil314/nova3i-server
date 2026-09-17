#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m uvicorn app:app --host 127.0.0.1 --port 9000 >/tmp/admin-app.test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:9000/health >/dev/null 2>&1 && break; sleep 0.5; done
body=$(curl -sf http://127.0.0.1:9000/)
echo "$body"
echo "$body" | grep -q '"app":"admin-app"'