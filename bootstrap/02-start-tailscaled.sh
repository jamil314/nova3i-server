#!/data/data/com.termux/files/usr/bin/bash
set -uo pipefail

NOVA="$HOME/nova3i"
if [[ -x "$NOVA/tailscale-old/tailscaled" ]]; then
  TSBIN="$NOVA/tailscale-old"
else
  TSBIN="$NOVA/tailscale"
fi
SOCK="$PREFIX/var/run/tailscale/tailscaled.sock"
STATE="$HOME/.config/tailscale"
LOG="$NOVA/logs/tailscaled.log"

mkdir -p "$(dirname "$SOCK")" "$STATE" "$NOVA/logs"

is_up() { "$TSBIN/tailscale" --socket="$SOCK" status >/dev/null 2>&1; }

if [[ ! -S "$SOCK" ]] || ! is_up; then
  echo "$(date -u +%FT%TZ) starting tailscaled" >>"$LOG"
  nohup "$TSBIN/tailscaled" \
    --tun=userspace-networking \
    --socket="$SOCK" \
    --statedir="$STATE" \
    --port=41641 \
    >>"$LOG" 2>&1 &
fi

for _ in $(seq 1 30); do is_up && break; sleep 1; done

if ! is_up; then
  echo "$(date -u +%FT%TZ) tailscaled failed to come up" >>"$LOG"
  exit 1
fi

echo "$(date -u +%FT%TZ) tailscaled up; supervising" >>"$LOG"

# Keep this runit service alive as long as the daemon lives. If the daemon
# dies, this loop exits and runsv restarts this script, which restarts it.
while is_up; do sleep 5; done

echo "$(date -u +%FT%TZ) tailscaled went away" >>"$LOG"
exit 0