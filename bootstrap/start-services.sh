#!/data/data/com.termux/files/usr/bin/bash
set -uo pipefail

NOVA="$HOME/nova3i"
LOG="$NOVA/logs/boot.log"
mkdir -p "$NOVA/logs"
exec >>"$LOG" 2>&1

echo "=== boot $(date -u +%FT%TZ) ==="
termux-wake-lock

# Ensure the runit supervision tree is up
if ! pgrep -f runsvdir >/dev/null 2>&1; then
  SVDIR="$PREFIX/var/service" runsvdir "$PREFIX/var/service" &
  sleep 2
fi

for svc in tailscaled caddy sandbox; do
  sv up "$svc" || echo "failed to start $svc"
done

echo "=== boot done ==="