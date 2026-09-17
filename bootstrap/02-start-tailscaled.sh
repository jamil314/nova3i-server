#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

NOVA="$HOME/nova3i"
TS="$NOVA/tailscale/tailscale"
SOCK="$PREFIX/var/run/tailscale/tailscaled.sock"
STATE="$HOME/.config/tailscale"

mkdir -p "$(dirname "$SOCK")" "$STATE" "$NOVA/logs"

if [[ ! -S "$SOCK" ]]; then
  echo "Starting tailscaled (userspace networking)..."
  nohup "$NOVA/tailscale/tailscaled" \
    --tun=userspace-networking \
    --socket="$SOCK" \
    --statedir="$STATE" \
    --port=41641 \
    >"$NOVA/logs/tailscaled.log" 2>&1 &
fi

for _ in $(seq 1 30); do
  "$TS" --socket="$SOCK" status >/dev/null 2>&1 && break
  sleep 1
done

if ! "$TS" --socket="$SOCK" status >/dev/null 2>&1; then
  echo "tailscaled not reachable; see $NOVA/logs/tailscaled.log" >&2
  exit 1
fi

echo "== tailscale status =="
"$TS" --socket="$SOCK" status || true

echo "== Applying Funnel -> Caddy (127.0.0.1:8080) =="
"$TS" --socket="$SOCK" funnel --bg --https=443 http://127.0.0.1:8080 || {
  echo "Funnel failed. Ensure HTTPS + Funnel are enabled for this node in the admin console." >&2
  exit 1
}

"$TS" --socket="$SOCK" funnel status || true