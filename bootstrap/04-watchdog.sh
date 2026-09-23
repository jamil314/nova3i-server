#!/data/data/com.termux/files/usr/bin/bash
set -uo pipefail

NOVA="$HOME/nova3i"
if [[ -x "$NOVA/tailscale-old/tailscaled" ]]; then
  TSBIN="$NOVA/tailscale-old"
else
  TSBIN="$NOVA/tailscale"
fi
SOCK="$PREFIX/var/run/tailscale/tailscaled.sock"
LOG="$NOVA/logs/watchdog.log"
LOCK="$NOVA/logs/watchdog.lock"
CERT="$NOVA/config/ts.crt"
CKEY="$NOVA/config/ts.key"
DNS="nova3i.taila5f58b.ts.net"
EDGE_IPS="103.84.155.153 103.84.155.217"
RENEW_DAYS=25
LOOP_SECS=300

mkdir -p "$NOVA/logs"

# single instance guard
if [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi
echo $$ >"$LOCK"
trap 'rm -f "$LOCK"' EXIT

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

is_up() { "$TSBIN/tailscale" --socket="$SOCK" status >/dev/null 2>&1; }

apply_funnel() {
  "$TSBIN/tailscale" --socket="$SOCK" serve reset </dev/null >>"$LOG" 2>&1
  "$TSBIN/tailscale" --socket="$SOCK" funnel --bg --tcp=443 tcp://127.0.0.1:8443 >>"$LOG" 2>&1
}

funnel_present() {
  "$TSBIN/tailscale" --socket="$SOCK" funnel status 2>/dev/null |
    grep -q "tcp://${DNS}:443 .*Funnel on"
}

# local Caddy -> sandbox healthcheck path
local_ok() {
  curl -sk --max-time 10 \
    --resolve "$DNS:8443:127.0.0.1" \
    "https://$DNS:8443/health" -o /dev/null -w "%{http_code}" 2>/dev/null | grep -q 200
}

# full ingress check: curl the public funnel edge and back to this node
ingress_ok() {
  local ip code
  for ip in $EDGE_IPS; do
    code=$(curl -sk --max-time 20 --resolve "$DNS:443:$ip" \
      "https://$DNS/health" -o /dev/null -w "%{http_code}" 2>/dev/null)
    if [[ "$code" == "200" ]]; then return 0; fi
  done
  return 1
}

cert_days_left() {
  local end endepoch
  end=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/notAfter=//')
  [[ -z "$end" ]] && { echo 0; return; }
  endepoch=$(date -d "$end" +%s 2>/dev/null) || { echo 0; return; }
  echo $(( (endepoch - $(date +%s)) / 86400 ))
}

renew_cert() {
  local tmpc="$NOVA/config/.ts.crt.tmp" tmpk="$NOVA/config/.ts.key.tmp"
  "$TSBIN/tailscale" --socket="$SOCK" cert \
    --cert-file="$tmpc" --key-file="$tmpk" "$DNS" >>"$LOG" 2>&1 || return 1
  mv "$tmpc" "$CERT"
  mv "$tmpk" "$CKEY"
  chmod 600 "$CKEY"
  export SVDIR="$PREFIX/var/service"
  sv restart caddy >>"$LOG" 2>&1
  log "ts cert renewed -> $CERT"
}

restart_svc() {
  export SVDIR="$PREFIX/var/service"
  sv restart "$1" >>"$LOG" 2>&1
}

log "watchdog starting (loop ${LOOP_SECS}s)"

while true; do
  if ! is_up; then
    log "tailscaled not reachable; waiting"
    sleep 60
    continue
  fi

  if ! funnel_present; then
    log "funnel missing; reapplying"
    apply_funnel
    sleep 5
  fi

  if ! local_ok; then
    log "local stack unhealthy; restarting caddy"
    restart_svc caddy
    sleep 3
    if ! local_ok; then
      log "caddy still unhealthy; restarting sandbox"
      restart_svc sandbox
      sleep 5
    fi
  fi

  if ! ingress_ok; then
    log "ingress check failed; reapplying funnel"
    apply_funnel
    sleep 30
    if ! ingress_ok; then
      log "ingress still failing after reapply"
    fi
  fi

  if [[ ! -f "$CERT" ]]; then
    log "ts cert missing; issuing"
    renew_cert || log "cert issuance failed"
  else
    d=$(cert_days_left)
    if [[ "$d" -lt "$RENEW_DAYS" ]]; then
      log "ts cert expires in ${d}d; renewing"
      renew_cert || log "cert renewal failed"
    fi
  fi

  sleep "$LOOP_SECS"
done