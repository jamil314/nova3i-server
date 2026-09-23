#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
FAIL=0

check() { # <desc> <path> <expected_code> [expected_substring]
  local desc="$1" path="$2" want_code="$3" want_sub="${4:-}"
  local code body
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' "$BASE$path")
  local actual
  actual=$(cat "$body")
  rm -f "$body"
  if [[ "$code" != "$want_code" ]]; then
    echo "FAIL: $desc (want $want_code, got $code)"; FAIL=1; return
  fi
  if [[ -n "$want_sub" && "$actual" != *"$want_sub"* ]]; then
    echo "FAIL: $desc (body missing '$want_sub': $actual)"; FAIL=1; return
  fi
  echo "PASS: $desc"
}

check "landing page"      "/"          200 "Nova 3i Server"
check "python api"        "/api/hello" 200 "hello from python"
check "node api"          "/node/hello" 200 "hello from node"
check "admin unauth"      "/admin/"    401 ""
check "health json"       "/health"    200 "healthcheck"
check "progress page"     "/health/progress" 200 "mission control"
check "progress json"     "/health/progress?format=json" 200 "mission"
check "health spec json"  "/health" 200 "\"spec\""
check "resources live"    "/health/resources" 200 "memoryAvailableKB"
check "urls json"         "/health/urls" 200 "base"

exit "$FAIL"