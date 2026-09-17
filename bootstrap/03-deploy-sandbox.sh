#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

NOVA="$HOME/nova3i"
STAGE="$HOME/nova3i-stage"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$NOVA/sandbox" "$STAGE/sandbox"

echo "Deploying sandbox into Debian..."
proot-distro login debian --root --bind "$STAGE:/root/nova3i-src" -- bash /root/nova3i-src/sandbox/setup-debian.sh /root/nova3i-src/sandbox

echo "== Sandbox deployed =="