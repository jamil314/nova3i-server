#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

NOVA="$HOME/nova3i"
ENV_FILE="$NOVA/config/auth.env"

if [[ -f "$ENV_FILE" ]]; then
  echo "auth.env already exists; leaving it unchanged."
  exit 0
fi

if [[ -t 0 ]]; then
  read -r -s -p "Set admin password: " PW; echo
  read -r -s -p "Confirm: " PW2; echo
else
  PW="${ADMIN_PASSWORD:-}"
  PW2="$PW"
fi

if [[ -z "${PW:-}" || "$PW" != "$PW2" ]]; then
  echo "Passwords empty or do not match." >&2
  exit 1
fi

HASH="$(caddy hash-password --plaintext "$PW")"
umask 077
printf "ADMIN_PASSWORD_HASH='%s'\n" "$HASH" > "$ENV_FILE"
echo "Wrote $ENV_FILE (mode 600)."