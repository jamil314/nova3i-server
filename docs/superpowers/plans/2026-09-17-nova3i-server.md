# Nova 3i Public Web/API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a spare Huawei Nova 3i (Android 9, no root) into an always-on, publicly reachable web/API server via Tailscale Funnel, with a Debian proot sandbox, and isolated from the owner's other domains and LAN.

**Architecture:** Split edge. `tailscaled` (userspace mode) and Caddy run natively in Termux for boot reliability; Caddy reverse-proxies by path to sample apps running in a Debian proot sandbox that shares Termux's network namespace. Tailscale Funnel terminates TLS at the Tailscale edge and exposes only `https://<node>.ts.net`. The phone holds no credentials for any other service or domain.

**Tech Stack:** Termux (F-Droid), Termux:Boot, Termux services (runit), proot-distro (Debian), Tailscale static arm64 `1.102.4` (userspace-networking), Caddy `2.11.4`, Python/FastAPI/uvicorn, Node/Express, OpenSSH.

**Reference spec:** `docs/superpowers/specs/2026-09-17-nova3i-server-design.md`

---

## Conventions used in this plan

- `[AGENT]` — run on the development laptop (this repo, `adb`, `curl`).
- `[DEVICE]` — run inside Termux on the phone (the plan tells the user to paste it, unless noted).
- `[USER]` — requires the human (tapping the phone UI, admin console, router).
- Termux `$HOME` is `/data/data/com.termux/files/home`; `$PREFIX` is `/data/data/com.termux/files/usr`.
- Secrets are never committed. `config/auth.env` is gitignored.

## File structure

```
nova3i-server/
├── README.md                              # overview + manual prerequisites + runbook pointer
├── .gitignore
├── webroot/
│   └── index.html                         # landing page served by Caddy
├── config/
│   ├── Caddyfile                          # edge reverse proxy (loopback :8080)
│   └── auth.env.example                   # template; real auth.env is gitignored
├── bootstrap/
│   ├── 01-termux-bootstrap.sh             # [DEVICE] pkg installs, tailscale, debian
│   ├── 02-start-tailscaled.sh             # [DEVICE] start daemon + funnel
│   ├── 03-deploy-sandbox.sh               # [DEVICE] copy sandbox into Debian + run setup
│   ├── 04-setup-caddy-auth.sh             # [DEVICE] generate bcrypt hash -> auth.env
│   ├── start-services.sh                  # [DEVICE] Termux:Boot entrypoint
│   └── services/                          # runit run scripts copied to $PREFIX/var/service
│       ├── tailscaled/run
│       ├── caddy/run
│       └── sandbox/run
├── sandbox/
│   ├── setup-debian.sh                    # [DEVICE, inside Debian] apt installs + app wiring
│   └── apps/
│       ├── hello-py/{app.py,requirements.txt,start.sh,test.sh}
│       ├── hello-node/{server.js,package.json,start.sh,test.sh}
│       └── admin-app/{app.py,requirements.txt,start.sh,test.sh}
├── tests/
│   └── acceptance.sh                      # [AGENT] curl checks against a base URL
├── docs/
│   ├── runbook.md
│   └── superpowers/{specs,plans}/...
```

---

### Task 1: Repository scaffolding and landing page

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `webroot/index.html`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# secrets
config/auth.env
*.env.local

# runtime
*.log
logs/
```

- [ ] **Step 2: Create the landing page** `webroot/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nova 3i Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
    code { background: #f0f0f0; padding: .1rem .3rem; border-radius: 4px; }
    li { margin: .4rem 0; }
  </style>
</head>
<body>
  <h1>Nova 3i Server</h1>
  <p>This phone is running a Debian sandbox behind a Caddy reverse proxy, exposed publicly through Tailscale Funnel.</p>
  <ul>
    <li><a href="/api/hello">/api/hello</a> &mdash; Python (FastAPI)</li>
    <li><a href="/node/hello">/node/hello</a> &mdash; Node (Express)</li>
    <li><code>/admin/*</code> &mdash; requires authentication</li>
  </ul>
</body>
</html>
```

- [ ] **Step 3: Create a minimal `README.md`**

```markdown
# Nova 3i Server

Spare Huawei Nova 3i (Android 9, unrooted) used as an always-on public web/API
server and Linux learning sandbox.

- Design: `docs/superpowers/specs/2026-09-17-nova3i-server-design.md`
- Plan: `docs/superpowers/plans/2026-09-17-nova3i-server.md`
- Runbook: `docs/runbook.md`

Public exposure is via Tailscale Funnel (`https://<node>.ts.net`). No custom
domain, no inbound ports, no credentials for other services stored on the phone.
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore README.md webroot/index.html
git commit -m "chore: scaffold repo with landing page"
```

---

### Task 2: Edge reverse proxy configuration (Caddy)

**Files:**
- Create: `config/Caddyfile`
- Create: `config/auth.env.example`

- [ ] **Step 1: Create `config/Caddyfile`**

Path routing matches the Funnel single-host model. `basic_auth` is Caddy `2.11.4` syntax. The hash comes from the `ADMIN_PASSWORD_HASH` env var so no secret is committed.

```caddyfile
{
	admin off
	auto_https off
}

http://127.0.0.1:8080 {
	encode gzip

	handle /api/* {
		uri strip_prefix /api
		reverse_proxy 127.0.0.1:8000
	}

	handle /node/* {
		uri strip_prefix /node
		reverse_proxy 127.0.0.1:3000
	}

	handle /admin/* {
		basic_auth {
			admin {$ADMIN_PASSWORD_HASH}
		}
		uri strip_prefix /admin
		reverse_proxy 127.0.0.1:9000
	}

	handle {
		root * /data/data/com.termux/files/home/nova3i/webroot
		file_server
	}
}
```

- [ ] **Step 2: Create `config/auth.env.example`**

```bash
# Copy to auth.env and fill in. Generate the hash with:
#   caddy hash-password --plaintext 'your-password-here'
ADMIN_PASSWORD_HASH='$2a$14$REPLACE_WITH_BCRYPT_HASH'
```

- [ ] **Step 3: Validate syntax on the host (Caddy must be installed; if not, skip and rely on Task 14 device validation)**

Run: `caddy validate --config config/Caddyfile --adapter caddyfile`
Expected: `Valid configuration` (an "ADMIN_PASSWORD_HASH not set" warning is acceptable).

- [ ] **Step 4: Commit**

```bash
git add config/Caddyfile config/auth.env.example
git commit -m "feat: add Caddy edge reverse proxy config"
```

---

### Task 3: Python API app (hello-py)

**Files:**
- Create: `sandbox/apps/hello-py/app.py`
- Create: `sandbox/apps/hello-py/requirements.txt`
- Create: `sandbox/apps/hello-py/start.sh`
- Create: `sandbox/apps/hello-py/test.sh`

- [ ] **Step 1: Write the failing test** `sandbox/apps/hello-py/test.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000 >/tmp/hello-py.test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 0.5; done
body=$(curl -sf http://127.0.0.1:8000/hello)
echo "$body"
echo "$body" | grep -q '"message":"hello from python"'
```

- [ ] **Step 2: Run test to verify it fails**

Run (inside Debian after deps exist, or on a host with uvicorn): `bash sandbox/apps/hello-py/test.sh`
Expected: FAIL — `app.py` does not exist yet (`ModuleNotFoundError`).

- [ ] **Step 3: Implement `app.py`**

```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"app": "hello-py", "status": "ok"}


@app.get("/hello")
def hello():
    return {"message": "hello from python"}


@app.get("/health")
def health():
    return {"ok": True}
```

- [ ] **Step 4: Add `requirements.txt`**

```
fastapi>=0.110,<1
uvicorn[standard]>=0.29,<1
```

- [ ] **Step 5: Add `start.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bash sandbox/apps/hello-py/test.sh`
Expected: prints `{"message":"hello from python"}` and exits 0.

- [ ] **Step 7: Commit**

```bash
git add sandbox/apps/hello-py
git commit -m "feat: add hello-py FastAPI app with smoke test"
```

---

### Task 4: Node API app (hello-node)

**Files:**
- Create: `sandbox/apps/hello-node/server.js`
- Create: `sandbox/apps/hello-node/package.json`
- Create: `sandbox/apps/hello-node/start.sh`
- Create: `sandbox/apps/hello-node/test.sh`

- [ ] **Step 1: Write the failing test** `sandbox/apps/hello-node/test.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ -d node_modules ]] || npm install --silent
node server.js >/tmp/hello-node.test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1 && break; sleep 0.5; done
body=$(curl -sf http://127.0.0.1:3000/hello)
echo "$body"
echo "$body" | grep -q 'hello from node'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash sandbox/apps/hello-node/test.sh`
Expected: FAIL — `Cannot find module .../server.js`.

- [ ] **Step 3: Implement `server.js`**

```js
const express = require('express');

const app = express();
const PORT = 3000;

app.get('/', (req, res) => res.json({ app: 'hello-node', status: 'ok' }));
app.get('/hello', (req, res) => res.json({ message: 'hello from node' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '127.0.0.1', () => console.log(`hello-node listening on ${PORT}`));
```

- [ ] **Step 4: Add `package.json`**

```json
{
  "name": "hello-node",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "express": "^4.19.0" }
}
```

- [ ] **Step 5: Add `start.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ -d node_modules ]] || npm install --silent
exec node server.js
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bash sandbox/apps/hello-node/test.sh`
Expected: prints `{"message":"hello from node"}` and exits 0.

- [ ] **Step 7: Commit**

```bash
git add sandbox/apps/hello-node
git commit -m "feat: add hello-node Express app with smoke test"
```

---

### Task 5: Admin app behind auth (admin-app)

**Files:**
- Create: `sandbox/apps/admin-app/app.py`
- Create: `sandbox/apps/admin-app/requirements.txt`
- Create: `sandbox/apps/admin-app/start.sh`
- Create: `sandbox/apps/admin-app/test.sh`

- [ ] **Step 1: Write the failing test** `sandbox/apps/admin-app/test.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m uvicorn app:app --host 127.0.0.1 --port 9000 >/tmp/admin-app.test.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:9000/health >/dev/null 2>&1 && break; sleep 0.5; done
body=$(curl -sf http://127.0.0.1:9000/)
echo "$body"
echo "$body" | grep -q '"app":"admin-app"'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash sandbox/apps/admin-app/test.sh`
Expected: FAIL — `app.py` does not exist yet.

- [ ] **Step 3: Implement `app.py`**

```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"app": "admin-app", "status": "ok"}


@app.get("/health")
def health():
    return {"ok": True}
```

- [ ] **Step 4: Add `requirements.txt`**

```
fastapi>=0.110,<1
uvicorn[standard]>=0.29,<1
```

- [ ] **Step 5: Add `start.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m uvicorn app:app --host 127.0.0.1 --port 9000
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bash sandbox/apps/admin-app/test.sh`
Expected: prints `{"app":"admin-app","status":"ok"}` and exits 0.

- [ ] **Step 7: Commit**

```bash
git add sandbox/apps/admin-app
git commit -m "feat: add admin-app behind Caddy basic auth"
```

---

### Task 6: End-to-end acceptance test

**Files:**
- Create: `tests/acceptance.sh`

- [ ] **Step 1: Write `tests/acceptance.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
FAIL=0

check() { # <desc> <path> <expected_code> [expected_substring]
  local desc="$1" path="$2" want_code="$3" want_sub="${4:-}"
  local code body
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' "$BASE$path")
  local actual
  actual=$(cat "$body")
  rm -f "$body"
  if [[ "$code" != "$want_code" ]]; then
    echo "FAIL: $desc (want $want_code, got $code)"; FAIL=1; return
  fi
  if [[ -n "$want_sub" && "$actual" != *"$want_sub"* ]]; then
    echo "FAIL: $desc (body missing '$want_sub': $actual)"; FAIL=1; return
  fi
  echo "PASS: $desc"
}

check "landing page"      "/"          200 "Nova 3i Server"
check "python api"        "/api/hello" 200 "hello from python"
check "node api"          "/node/hello" 200 "hello from node"
check "admin unauth"      "/admin/"    401 ""

exit "$FAIL"
```

- [ ] **Step 2: Verify the test fails locally (nothing is serving yet)**

Run: `bash tests/acceptance.sh http://127.0.0.1:8080`
Expected: FAIL lines / non-zero exit (`curl` connection refused).

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance.sh
git commit -m "test: add end-to-end acceptance script"
```

---

### Task 7: Android device prep via adb

**Files:** none (device state only)

- [ ] **Step 1: Download the Termux and Termux:Boot APKs**

```bash
mkdir -p /tmp/opencode/apks
curl -fL -o /tmp/opencode/apks/termux.apk       https://f-droid.org/repo/com.termux_1002.apk
curl -fL -o /tmp/opencode/apks/termux-boot.apk  https://f-droid.org/repo/com.termux.boot_1000.apk
ls -l /tmp/opencode/apks
```
Expected: two APK files, each > 1 MB.

- [ ] **Step 2: Confirm the device is connected**

Run: `adb devices -l`
Expected: one line with `model:INE_LX2r` and state `device`.

- [ ] **Step 3: Install both APKs**

```bash
adb install -r /tmp/opencode/apks/termux.apk
adb install -r /tmp/opencode/apks/termux-boot.apk
```
Expected: `Success` twice.

- [ ] **Step 4: Grant storage permission to Termux (needed to read pushed files)**

```bash
adb shell pm grant com.termux android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.termux android.permission.WRITE_EXTERNAL_STORAGE
```
Expected: no output (success).

- [ ] **Step 5: Whitelist Termux and Termux:Boot from Doze/battery optimization**

```bash
adb shell dumpsys deviceidle whitelist +com.termux
adb shell dumpsys deviceidle whitelist +com.termux.boot
adb shell cmd appops set com.termux RUN_IN_BACKGROUND allow
adb shell cmd appops set com.termux RUN_ANY_IN_BACKGROUND allow
```
Expected: `Added: com.termux` / `Added: com.termux.boot`, then no output.

- [ ] **Step 6: [USER] Launch Termux once and disable Huawei battery optimization**

On the phone: open **Termux** (let it finish installing its bootstrap — wait for the prompt), then open **Termux:Boot** once (this activates boot scripts). Then Settings → Battery → App launch, set **Termux** and **Termux:Boot** to **Manage manually** with all three toggles ON, and turn off "Power-intensive prompt".

- [ ] **Step 7: Verify boot activation marker exists after opening Termux:Boot**

Run: `adb shell ls /data/data/com.termux.boot 2>/dev/null || echo "run-as blocked, verify visually"`
Expected: either a listing or the fallback message. Visual confirmation in the app is acceptable.

---

### Task 8: Termux bootstrap script

**Files:**
- Create: `bootstrap/01-termux-bootstrap.sh`

- [ ] **Step 1: Write `bootstrap/01-termux-bootstrap.sh`**

```bash
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
```

- [ ] **Step 2: Sanity-check the script syntax on the host**

Run: `bash -n bootstrap/01-termux-bootstrap.sh && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add bootstrap/01-termux-bootstrap.sh
git commit -m "feat: add Termux bootstrap script"
```

---

### Task 9: Debian sandbox setup script

**Files:**
- Create: `sandbox/setup-debian.sh`

- [ ] **Step 1: Write `sandbox/setup-debian.sh`** (runs *inside* Debian as root)

```bash
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

echo "== Debian sandbox ready =="
```

- [ ] **Step 2: Grant the agent user access to the shared Python venv (read-only use)**

Add to the end of `sandbox/setup-debian.sh` before the final echo:
```bash
chmod -R a+rX /root/venv
```

- [ ] **Step 3: Document the agent launching contract**

When installing an agent later, run it as `agent`:
```bash
proot-distro login debian -u 0 -- su - agent -c 'cd ~/workspace && <agent command>'
```
Never run the agent as root, and never give it Android storage permissions.

- [ ] **Step 4: Sanity-check syntax on the host**

Run: `bash -n sandbox/setup-debian.sh && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add sandbox/setup-debian.sh
git commit -m "feat: add Debian sandbox setup script and agent user"
```

---

### Task 10: Tailscale edge script

**Files:**
- Create: `bootstrap/02-start-tailscaled.sh`

- [ ] **Step 1: Write `bootstrap/02-start-tailscaled.sh`**

```bash
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
```

- [ ] **Step 2: Sanity-check syntax on the host**

Run: `bash -n bootstrap/02-start-tailscaled.sh && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add bootstrap/02-start-tailscaled.sh
git commit -m "feat: add tailscaled + funnel start script"
```

---

### Task 11: Caddy auth setup and runit supervision

**Files:**
- Create: `bootstrap/03-deploy-sandbox.sh`
- Create: `bootstrap/04-setup-caddy-auth.sh`
- Create: `bootstrap/start-services.sh`
- Create: `bootstrap/services/tailscaled/run`
- Create: `bootstrap/services/caddy/run`
- Create: `bootstrap/services/sandbox/run`

- [ ] **Step 1: Write `bootstrap/03-deploy-sandbox.sh`**

```bash
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

NOVA="$HOME/nova3i"
STAGE="$HOME/nova3i-stage"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$NOVA/sandbox" "$STAGE/sandbox"

echo "Deploying sandbox into Debian..."
proot-distro login debian -u 0 --bind "$STAGE:/root/nova3i-src" -- bash /root/nova3i-src/sandbox/setup-debian.sh /root/nova3i-src/sandbox

echo "== Sandbox deployed =="
```

- [ ] **Step 2: Write `bootstrap/04-setup-caddy-auth.sh`**

```bash
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
```

- [ ] **Step 3: Write `bootstrap/services/tailscaled/run`**

```bash
#!/data/data/com.termux/files/usr/bin/bash
exec "$HOME/nova3i/bootstrap/02-start-tailscaled.sh"
```

- [ ] **Step 4: Write `bootstrap/services/caddy/run`**

```bash
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
NOVA="$HOME/nova3i"
[[ -f "$NOVA/config/auth.env" ]] && { set -a; . "$NOVA/config/auth.env"; set +a; }
exec caddy run --config "$NOVA/config/Caddyfile" --adapter caddyfile
```

- [ ] **Step 5: Write `bootstrap/services/sandbox/run`**

```bash
#!/data/data/com.termux/files/usr/bin/bash
exec proot-distro login debian -u 0 -- /root/apps/start-all.sh
```

- [ ] **Step 6: Write `bootstrap/start-services.sh` (Termux:Boot entrypoint)**

```bash
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
```

- [ ] **Step 7: Sanity-check all script syntax on the host**

Run: `for f in bootstrap/03-deploy-sandbox.sh bootstrap/04-setup-caddy-auth.sh bootstrap/start-services.sh bootstrap/services/*/run; do bash -n "$f" || echo "SYNTAX FAIL: $f"; done; echo CHECKED`
Expected: `CHECKED` with no `SYNTAX FAIL` lines.

- [ ] **Step 8: Commit**

```bash
git add bootstrap/03-deploy-sandbox.sh bootstrap/04-setup-caddy-auth.sh bootstrap/start-services.sh bootstrap/services
git commit -m "feat: add sandbox deploy, auth setup, and runit supervision"
```

---

### Task 12: Deploy everything to the device

**Files:** none (device state)

- [ ] **Step 1: [AGENT] Push the project tree to the phone's shared storage**

```bash
adb shell rm -rf /sdcard/nova3i
adb push bootstrap config sandbox webroot /sdcard/nova3i/
adb shell ls /sdcard/nova3i
```
Expected: the four directories are listed.

- [ ] **Step 2: [DEVICE] Run the bootstrap script in Termux**

Paste into Termux:
```bash
bash /sdcard/nova3i/bootstrap/01-termux-bootstrap.sh /sdcard/nova3i
```
Expected: ends with `== Bootstrap complete ==`, Tailscale version printed, and Debian listed as installed. This can take several minutes.

- [ ] **Step 3: [DEVICE] Set the admin password**

```bash
bash ~/nova3i/bootstrap/04-setup-caddy-auth.sh
```
Expected: `Wrote .../nova3i/config/auth.env (mode 600).`

- [ ] **Step 4: [DEVICE] Deploy the Debian sandbox**

```bash
bash ~/nova3i/bootstrap/03-deploy-sandbox.sh
```
Expected: ends with `== Debian sandbox ready ==` and `== Sandbox deployed ==`.

---

### Task 13: Bring up the public endpoint

**Files:** none (device state, plus admin console)

- [ ] **Step 1: [DEVICE] Verify apps respond inside Debian**

```bash
proot-distro login debian -u 0 -- bash -lc '
  (nohup /root/venv/bin/python3 -m uvicorn app:app --app-dir /root/apps/hello-py  --host 127.0.0.1 --port 8000 >/tmp/hp.log 2>&1 &)
  (nohup /root/venv/bin/python3 -m uvicorn app:app --app-dir /root/apps/admin-app --host 127.0.0.1 --port 9000 >/tmp/ad.log 2>&1 &)
  (nohup node /root/apps/hello-node/server.js >/tmp/hn.log 2>&1 &)
  sleep 4
  echo "py:   $(curl -s http://127.0.0.1:8000/hello)"
  echo "node: $(curl -s http://127.0.0.1:3000/hello)"
  echo "adm:  $(curl -s http://127.0.0.1:9000/)"
'
```
Expected: three JSON bodies with `hello from python`, `hello from node`, and `admin-app`.

- [ ] **Step 2: [DEVICE] Start Caddy via runit and check loopback routing**

```bash
mkdir -p "$PREFIX/var/service"
for svc in tailscaled caddy sandbox; do
  rm -rf "$PREFIX/var/service/$svc"
  cp -r ~/nova3i/bootstrap/services/$svc "$PREFIX/var/service/$svc"
  chmod +x "$PREFIX/var/service/$svc/run"
done
pgrep -f runsvdir >/dev/null || (SVDIR="$PREFIX/var/service" runsvdir "$PREFIX/var/service" &)
sleep 2
sv up sandbox; sv up caddy
sleep 5
bash ~/nova3i/tests/acceptance.sh http://127.0.0.1:8080
```
Expected: four `PASS:` lines (landing, python api, node api, admin unauth) and exit 0.

- [ ] **Step 3: [DEVICE] Start Tailscale and authenticate**

```bash
bash ~/nova3i/bootstrap/02-start-tailscaled.sh
```
First run prints a login URL. [USER] opens it and authenticates the node. Re-run the script after authenticating; expected: `funnel status` shows a `https://<node>.ts.net` URL proxying `http://127.0.0.1:8080`.

- [ ] **Step 4: [USER] Enable HTTPS and Funnel for the node in the Tailscale admin console**

Admin console → DNS: enable **MagicDNS** and **HTTPS Certificates**. Then ACLs: add a `nodeAttrs` entry granting `funnel` to this node:
```json
{
  "nodeAttrs": [
    { "target": ["<node-name>"], "attr": ["funnel"] }
  ]
}
```
Re-run Task 13 Step 3 so Funnel applies.

- [ ] **Step 5: [AGENT] Verify public reachability from a different network**

On the laptop, with the phone on mobile data (Wi-Fi off):
```bash
NODE_URL="https://<node>.ts.net"
curl -s "$NODE_URL/" | grep -q "Nova 3i Server" && echo "PUBLIC OK"
curl -s -o /dev/null -w '%{http_code}\n' "$NODE_URL/api/hello"   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' "$NODE_URL/admin/"      # expect 401
```
Expected: `PUBLIC OK`, `200`, `401`.

- [ ] **Step 6: [AGENT] Re-run the full acceptance suite against the public URL**

Run: `bash tests/acceptance.sh "$NODE_URL"`
Expected: four `PASS:` lines.

---

### Task 14: SSH admin access over the tailnet

**Files:** none (device state)

- [ ] **Step 1: [AGENT] Generate a dedicated keypair (if you do not have one)**

```bash
[[ -f ~/.ssh/nova3i_ed25519 ]] || ssh-keygen -t ed25519 -f ~/.ssh/nova3i_ed25519 -N '' -C nova3i-admin
cat ~/.ssh/nova3i_ed25519.pub
```

- [ ] **Step 2: [DEVICE] Install the public key and set a nonstandard port**

In Termux, paste the public key, then configure the port:
```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'KEY'
<PASTE PUBLIC KEY HERE>
KEY
chmod 600 ~/.ssh/authorized_keys
mkdir -p "$PREFIX/etc/ssh"
printf '\nPort 2222\nPasswordAuthentication no\nPermitRootLogin no\n' >> "$PREFIX/etc/ssh/sshd_config"
sshd
```
Expected: no errors; `sshd` starts.

- [ ] **Step 3: [AGENT] Connect over the tailnet (never via Funnel)**

```bash
ssh -i ~/.ssh/nova3i_ed25519 -p 2222 "$(tailscale status --json | jq -r '.Self.DNSName' | cut -d. -f1)@<node-ts-ip>"
```
Expected: a Termux shell. Confirm the Funnel URL does **not** expose port 2222.

- [ ] **Step 4: [DEVICE] Make sshd start at boot**

Add `sshd` to `bootstrap/start-services.sh` before the `for svc` loop:
```bash
pgrep -x sshd >/dev/null 2>&1 || sshd
```
Then re-run Task 11 Step 8's commit and re-push the updated `bootstrap/` (Task 12 Step 1).

---

### Task 15: Isolation and credential audit

**Files:** none (network + audit)

- [ ] **Step 1: [USER] Put the phone on an isolated SSID/VLAN**

Configure the router: place the phone on a guest/IoT network with (a) client isolation / no access to the main LAN, and (b) outbound allowed only to: `*.tailscale.com`, `*.tailscale.io`, `controlplane.tailscale.com`, `*.ts.net` (DERP), plus general HTTPS as needed. Block RFC1918 LAN ranges and router admin.

- [ ] **Step 2: [DEVICE] Audit on-device credentials — expect none for other services**

```bash
echo "== env tokens =="; env | grep -iE 'cloudflare|vercel|hostinger|aws_|gcp|do_|api[_-]?token' || echo "none"
echo "== ssh keys =="; ls -l ~/.ssh 2>/dev/null || echo "none"
echo "== cloudflared =="; command -v cloudflared || echo "not installed"
echo "== tailscale identity only =="; ls -l ~/.config/tailscale 2>/dev/null
```
Expected: `none` for tokens; no private keys beyond the phone's own; no `cloudflared`; only Tailscale state present.

- [ ] **Step 3: [AGENT] Verify the phone cannot reach other LAN services**

From the phone's shell (SSH from Task 14):
```bash
# replace with a real LAN host you want to prove is unreachable
curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://192.168.1.1 || echo "BLOCKED (expected)"
```
Expected: `BLOCKED (expected)` or a timeout.

- [ ] **Step 4: [AGENT] Confirm `jamilur.com` is untouched**

```bash
dig +short NS jamilur.com
dig +short bhulbona.jamilur.com
```
Expected: still `atlas.dns-parking.com` / `hyperion.dns-parking.com`, and the Vercel CNAME — unchanged.

---

### Task 16: Reboot resilience test

**Files:** none (device state)

- [ ] **Step 1: [DEVICE] Install the boot entrypoint**

```bash
mkdir -p ~/.termux/boot
cp ~/nova3i/bootstrap/start-services.sh ~/.termux/boot/90-nova3i.sh
chmod +x ~/.termux/boot/90-nova3i.sh
```

- [ ] **Step 2: Reboot the phone with no manual intervention**

Run: `adb reboot`
Wait ~90 seconds for boot + services.

- [ ] **Step 3: [AGENT] Verify the full system came back automatically**

```bash
bash tests/acceptance.sh "$NODE_URL"
```
Expected: four `PASS:` lines without any manual step.

- [ ] **Step 4: [DEVICE] Inspect boot log if anything failed**

```bash
cat ~/nova3i/logs/boot.log; sv status tailscaled caddy sandbox
```

---

### Task 17: Runbook and final documentation

**Files:**
- Create: `docs/runbook.md`

- [ ] **Step 1: Write `docs/runbook.md`**

```markdown
# Runbook

## URLs
- Public: `https://<node>.ts.net` (Funnel -> Caddy `127.0.0.1:8080`)
- Admin: `https://<node>.ts.net/admin/` (basic auth; password in `~/nova3i/config/auth.env`)
- SSH: `<tailnet-ip>:2222` key-only, tailnet only

## Service management (Termux)
    sv status tailscaled caddy sandbox
    sv restart caddy
    sv down sandbox && sv up sandbox
    tail -f ~/nova3i/logs/boot.log
    tail -f ~/nova3i/logs/tailscaled.log

## Tailscale
    TS=~/nova3i/tailscale/tailscale
    SOCK=$PREFIX/var/run/tailscale/tailscaled.sock
    $TS --socket=$SOCK status
    $TS --socket=$SOCK funnel status
    $TS --socket=$SOCK funnel --https=443 off   # kill switch

## Deploy an app update
    # from laptop
    adb push sandbox /sdcard/nova3i/
    # on device
    cp -r /sdcard/nova3i/sandbox ~/nova3i/sandbox
    bash ~/nova3i/bootstrap/03-deploy-sandbox.sh
    proot-distro login debian -u 0 -- pkill -f 'uvicorn|node' ; sv restart sandbox

## Troubleshooting
- **Funnel fails to get a cert**: verify MagicDNS + HTTPS + the `funnel` nodeAttr.
- **Public URL 502**: backends down. `sv status sandbox`; check `/tmp/*.log` inside Debian.
- **Everything dies after a while**: EMUI killed Termux. Confirm battery whitelist and `termux-wake-lock`.
- **No internet from device**: Tailscale needs outbound to `controlplane.tailscale.com`; check VLAN egress rules.

## Revocation
Remove the node from the Tailscale admin console; the phone loses all public reachability immediately.
```

- [ ] **Step 2: Update `README.md`** to link the runbook and record the final node URL.

- [ ] **Step 3: Final commit**

```bash
git add docs/runbook.md README.md
git commit -m "docs: add runbook and finalize README"
```

---

## Self-review

**Spec coverage**
- Split edge, tailscaled userspace, Caddy loopback, Debian sandbox, sample apps: Tasks 2, 9, 10, 11, 13.
- Funnel ports / single hostname / path routing: Task 2, 10, 13.
- Boot, wake-lock, runit supervision: Tasks 11, 16.
- Android battery/background hardening: Task 7.
- SSH tailnet-only, key-only, nonstandard port: Task 14.
- Isolation (no creds, separate namespace, VLAN egress, unprivileged agent): Tasks 15, plus agent runs as root inside proot by design (note below).
- Risks (EMUI kill, cert provisioning, proot perf, battery wear) documented in spec; runbook covers operations.
- Verification/acceptance (local, public, auth 401/200, reboot, isolation, jamilur.com unchanged): Tasks 6, 13, 15, 16.

**Note on "unprivileged agent":** the sample apps run as root *inside* the proot (scoped to the Debian filesystem, which is a file inside Termux's app-private storage). Task 9 creates a dedicated unprivileged `agent` user and documents the launch contract so a future Hermes/OpenClaw agent never runs as root.

**Placeholder scan:** No `TBD`/`TODO`. `<node>.ts.net`, `<tailnet-ip>`, and `<PASTE PUBLIC KEY HERE>` are runtime values produced by Tasks 13 and 14, not missing content.

**Type/name consistency:** Funnel target `127.0.0.1:8080` matches the Caddyfile listen address; app ports `8000/3000/9000` match Caddy's `reverse_proxy` targets and the start scripts; service names `tailscaled`/`caddy`/`sandbox` match across Task 11 and the runbook.
