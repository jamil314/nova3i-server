#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000 >/tmp/hello-py.test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 0.5; done
body=$(curl -sf http://127.0.0.1:8000/hello)
echo "$body"
echo "$body" | grep -q '"message":"hello from python"'
