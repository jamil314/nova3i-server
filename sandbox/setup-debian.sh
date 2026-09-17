#!/usr/bin/env bash
set -euo pipefail

SRC="${1:-/root/nova3i-src}"
APPS="/root/apps"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip nodejs npm nginx sqlite3 git curl build-essential

mkdir -p "$APPS"
cp -r "$SRC/apps/." "$APPS/"

# Python venv shared by both FastAPI apps
python3 -m venv /root/venv
/root/venv/bin/pip install --upgrade pip
/root/venv/bin/pip install -r "$APPS/hello-py/requirements.txt"

# Node deps
( cd "$APPS/hello-node" && npm install --silent )

cat > /root/apps/start-all.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /root/apps
nohup /root/venv/bin/python3 -m uvicorn app:app --app-dir /root/apps/hello-py  --host 127.0.0.1 --port 8000 >/tmp/hello-py.log  2>&1 &
nohup /root/venv/bin/python3 -m uvicorn app:app --app-dir /root/apps/admin-app --host 127.0.0.1 --port 9000 >/tmp/admin-app.log 2>&1 &
nohup node /root/apps/hello-node/server.js >/tmp/hello-node.log 2>&1 &
wait
EOF
chmod +x /root/apps/start-all.sh

# Unprivileged user for future autonomous agents (Hermes/OpenClaw), per spec.
if ! id agent >/dev/null 2>&1; then
  useradd -m -s /bin/bash agent
fi
mkdir -p /home/agent/workspace
chown -R agent:agent /home/agent/workspace

chmod -R a+rX /root/venv

# Agent launching contract: install/run any future agent as the `agent` user,
# never as root, and never grant it Android storage permissions:
#   proot-distro login debian --root -- su - agent -c 'cd ~/workspace && <agent command>'

echo "== Debian sandbox ready =="