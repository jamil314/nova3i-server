#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

SRC="${1:-/sdcard/nova3i}"
NOVA="$HOME/nova3i"
TS_VERSION="1.102.4"

echo "== Termux bootstrap: installing packages =="
pkg update -y
pkg install -y openssh termux-services proot-distro caddy curl git python jq

echo "== Copying project files into $NOVA =="
mkdir -p "$NOVA"
for d in bootstrap config sandbox webroot; do
  rm -rf "$NOVA/$d"
  cp -r "$SRC/$d" "$NOVA/$d"
done
mkdir -p "$NOVA/logs"

echo "== Installing Tailscale $TS_VERSION (arm64 static) =="
mkdir -p "$NOVA/tailscale"
if [[ ! -x "$NOVA/tailscale/tailscaled" ]]; then
  curl -fL -o "$NOVA/ts.tgz" "https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_arm64.tgz"
  tar -xzf "$NOVA/ts.tgz" -C "$NOVA/tailscale" --strip-components=1
  rm -f "$NOVA/ts.tgz"
fi
"$NOVA/tailscale/tailscale" version

echo "== Installing Debian (proot-distro) if missing =="
if [[ ! -d "$PREFIX/var/lib/proot-distro/installed-rootfs/debian" ]]; then
  proot-distro install debian
fi
proot-distro list --installed

echo "== Bootstrap complete =="