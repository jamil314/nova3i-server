#!/data/data/com.termux/files/usr/bin/bash
set -uo pipefail

NOVA="$HOME/nova3i"
LOG="$NOVA/logs/boot.log"
if [[ -x "$NOVA/tailscale-old/tailscaled" ]]; then
  TSBIN="$NOVA/tailscale-old"
else
  TSBIN="$NOVA/tailscale"
fi
SOCK="$PREFIX/var/run/tailscale/tailscaled.sock"

mkdir -p "$NOVA/logs"
exec >>"$LOG" 2>&1

echo "=== boot $(date -u +%FT%TZ) ==="
termux-wake-lock

# runit env: service log/run scripts require LOGDIR (svlogd) + SVDIR
export SVDIR="$PREFIX/var/service"
export LOGDIR="$PREFIX/var/log"

# Ensure the runit supervision tree is up
if ! pgrep -f runsvdir >/dev/null 2>&1; then
  runsvdir "$SVDIR" &
  sleep 2
fi
for svc in tailscaled caddy sandbox watchdog hermes whatsapp-bot sshd ssh-agent; do
  sv up "$svc" || echo "failed to start $svc"
done

# Wait for tailscale and ensure the funnel is applied early (watchdog also heals)
for _ in $(seq 1 30); do
  "$TSBIN/tailscale" --socket="$SOCK" status >/dev/null 2>&1 && break
  sleep 1
done
"$TSBIN/tailscale" --socket="$SOCK" serve reset </dev/null >>"$LOG" 2>&1 || true
"$TSBIN/tailscale" --socket="$SOCK" funnel --bg --tcp=443 tcp://127.0.0.1:8443 >>"$LOG" 2>&1 || true

echo "=== boot done ==="