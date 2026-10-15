#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

tmp=$(mktemp -d)
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT
export CAM_GATE_ENV="$tmp/cam-gate.env"
python3 - <<'EOF'
import hashlib, os
salt = b"0123456789abcdef"
h = hashlib.scrypt(b"right-pw", salt=salt, n=2**14, r=8, p=1).hex()
with open(os.environ["CAM_GATE_ENV"], "w") as f:
    f.write(f"CAM_GATE_PASSWORD_HASH=scrypt${salt.hex()}${h}\nCAM_GATE_SECRET={'ab' * 32}\n")
EOF

python3 -m uvicorn app:app --host 127.0.0.1 --port 9100 >/tmp/cam-gate.test.log 2>&1 &
pid=$!
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:9100/health >/dev/null 2>&1 && break; sleep 0.5; done

B=http://127.0.0.1:9100
fail=0
expect() { # <desc> <want> <got>
  if [[ "$3" == *"$2"* ]]; then echo "PASS: $1"; else echo "FAIL: $1 (want '$2', got '$3')"; fail=1; fi
}
status() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$@"; }

expect "no cookie redirects to login" "302 $B/cam-login?next=/cam/video" \
  "$(status -H 'X-Forwarded-Uri: /cam/video' $B/auth)"
expect "foreign next is ignored" "next=/cam/" \
  "$(status -H 'X-Forwarded-Uri: //evil.example/x' $B/auth)"
expect "login page renders" "200" "$(status $B/cam-login)"
expect "wrong password rejected" "Wrong password" \
  "$(curl -s -d 'password=nope&next=/cam/' $B/cam-login)"

jar="$tmp/jar"
headers=$(curl -s -D - -o /dev/null -c "$jar" -d 'password=right-pw&next=/cam/video' $B/cam-login)
expect "right password redirects back" "location: /cam/video" "${headers,,}"
expect "cookie is locked down" "httponly; max-age=43200; path=/cam; samesite=strict; secure" "${headers,,}"

cookie=$(awk '$6 == "cam_gate" {print $7}' "$jar")
expect "valid cookie passes" "200" "$(status -b "cam_gate=$cookie" $B/auth)"
expect "viewer needs cookie" "302 $B/cam-login?next=/cam/view" "$(status $B/cam/view)"
expect "viewer renders with cookie" "Switch camera" "$(curl -s -b "cam_gate=$cookie" $B/cam/view)"
expect "tampered cookie fails" "302" "$(status -b "cam_gate=9999999999.${cookie#*.}" $B/auth)"
expect "expired cookie fails" "302" "$(status -b "cam_gate=1.${cookie#*.}" $B/auth)"

exit "$fail"
