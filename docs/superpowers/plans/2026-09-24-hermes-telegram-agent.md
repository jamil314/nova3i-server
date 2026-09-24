# Hermes Telegram Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Hermes Agent (Nous Research's self-improving AI agent) on the Nova 3i's proot-Debian sandbox as the unprivileged `agent` user, reachable 24/7 only via a Telegram bot locked to the owner, powered by a Groq OpenAI-compatible endpoint.

**Architecture:** Hermes is installed inside the existing proot-Debian sandbox via the documented Termux-tested manual path (`pip install -e '.[termux]' -c constraints-termux.txt`). It runs as the `agent` user under a new runit service on the Termux host (`bootstrap/services/hermes/run`) so it auto-starts with the phone and gets restarted on crash. The gateway process talks to Telegram by outbound polling (no inbound port), calls Groq over HTTPS, and stores memory/skills in `~/.hermes` (SQLite FTS5), all inside the jailed `/home/agent/workspace`. Secrets live only in `~/.hermes/.env` (mode 600, owned by `agent`), never in git.

**Tech Stack:** Python 3.13.5 (sandbox), pip + stdlib venv, Hermes Agent `.[termux]` extra, Groq OpenAI-compatible API, Telegram Bot API, runit (Termux host), adb-forward ssh for deploy, proot-distro.

**Spec:** `docs/superpowers/specs/2026-09-24-hermes-telegram-agent.md`

**Device facts already verified (do not re-verify):**
- Sandbox: Debian 13.6, aarch64, Python 3.13.5, pip 25.1.1, sqlite 3.46.1 + FTS5, venv works, `git`/`curl`/`build-essential` installed, internet OK.
- `getprop` available inside proot (returns `28` for API level) — used for `ANDROID_API_LEVEL`.
- `agent` user exists (uid 10033) BUT `/home/agent` is root-owned mode 700 → MUST be chowned to `agent` before install.
- `su` and `runuser` exist in sandbox; `$PREFIX/var/service` supervises `caddy sandbox tailscaled watchdog sshd ssh-agent`.
- Groq key works; `openai/gpt-oss-20b` returns chat completions.
- grocconsole key and bot token were supplied by the owner and must NOT be committed.

---

### Task 1: Add runit service + boot wiring in the repo

**Files:**
- Create: `bootstrap/services/hermes/run`
- Modify: `bootstrap/start-services.sh:23-26` (service list)

- [ ] **Step 1: Write `bootstrap/services/hermes/run`**

```bash
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
exec proot-distro login debian -u 0 -- /usr/bin/su - agent -c 'cd /home/agent/workspace && /usr/local/bin/hermes gateway'
```

- [ ] **Step 2: Add `hermes` to the boot service list**

In `bootstrap/start-services.sh`, change the loop line:

```bash
for svc in tailscaled caddy sandbox watchdog sshd ssh-agent; do
```

to:

```bash
for svc in tailscaled caddy sandbox watchdog hermes sshd ssh-agent; do
```

- [ ] **Step 3: Syntax-check and commit**

Run: `bash -n bootstrap/services/hermes/run bootstrap/start-services.sh && echo CHECKED`
Expected: `CHECKED`

```bash
git add bootstrap/services/hermes/run bootstrap/start-services.sh
git commit -m "feat(hermes): add runit service definition + boot wiring"
```

---

### Task 2: Fix agent home ownership on device

**Files:**
- None (device operation via adb-forward ssh)

- [ ] **Step 1: Establish the tunnel and fix ownership**

Run (from `/home/jamil/nova3i-server`):

```bash
adb forward tcp:12222 tcp:2222
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- chown -R agent:agent /home/agent; proot-distro login debian -u 0 -- chmod 700 /home/agent'
```

- [ ] **Step 2: Verify ownership + agent can write home**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- bash -c "ls -ld /home/agent; su - agent -c \"touch /home/agent/write-test && rm /home/agent/write-test && echo AGENT_WRITE_OK\""'
```

Expected: `drwx------ … agent agent /home/agent` and `AGENT_WRITE_OK`.

---

### Task 3: Install Hermes as the agent user inside the sandbox

**Files:**
- None (device operation)

- [ ] **Step 1: apt deps (Rust toolchain for maturin builds if no aarch64 wheel)**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq rustc cargo pkg-config python3-dev libffi-dev ripgrep >/dev/null 2>&1; echo APT_DONE"'
```

Expected: `APT_DONE`

- [ ] **Step 2: Clone Hermes as agent**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- su - agent -c "git clone --depth 1 https://github.com/NousResearch/hermes-agent.git /home/agent/hermes-agent 2>&1 | tail -1"'
```

Expected: `Resolving deltas: 100% … done.`

- [ ] **Step 3: Create venv + install the Termux-tested extra**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  "proot-distro login debian -u 0 -- su - agent -c 'cd /home/agent/hermes-agent && export ANDROID_API_LEVEL=28 && python3 -m venv venv && . venv/bin/activate && pip -q install --upgrade pip setuptools wheel && pip -q install -e \".[termux]\" -c constraints-termux.txt 2>&1 | tail -3'"
```

Expected: last lines end with success (no `error:` / `Command errored out`). This step may take several minutes.

- [ ] **Step 4: Symlink hermes onto PATH and verify**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- bash -c "ln -sf /home/agent/hermes-agent/venv/bin/hermes /usr/local/bin/hermes; chmod +x /home/agent/hermes-agent/venv/bin/hermes; su - agent -c \"hermes --version\""'
```

Expected: prints a version like `hermes …` (no `command not found`).

- [ ] **Step 5: Run `hermes doctor`**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- su - agent -c "hermes doctor 2>&1 | tail -15"'
```

Expected: no fatal errors; HTTP/network + sqlite checks OK.

---

### Task 4: Write Hermes config + secrets (device only, never in git)

**Files:**
- Create on device: `/home/agent/.hermes/config.yaml`
- Create on device: `/home/agent/.hermes/.env` (mode 600, owner `agent`)

- [ ] **Step 1: Write `config.yaml`**

Run (writes via heredoc inside the sandbox, as agent):

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- su - agent -c "mkdir -p /home/agent/.hermes && cat > /home/agent/.hermes/config.yaml <<'"'"'EOF'"'"'
model:
  provider: custom
  base_url: https://api.groq.com/openai/v1
  name: openai/gpt-oss-20b
approvals:
  mode: manual
  timeout: 300
  cron_mode: deny
  single_query_mode: deny
  unattended_mode: deny
gateway:
  platforms:
    telegram:
      enabled: true
EOF'"'"'"
```

- [ ] **Step 2: Write `.env` (secrets — use the values supplied by the owner; NEVER commit them)**

Run (substitute the token from the owner's BotFather bot and their Groq key; do NOT commit these): the values are available in the session but must stay device-only:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- su - agent -c "cat > /home/agent/.hermes/.env <<'"'"'EOF'"'"'
TELEGRAM_BOT_TOKEN=<bot-token-from-owner>
OPENAI_API_KEY=<groq-key-from-owner>
EOF'"'"'; proot-distro login debian -u 0 -- chown -R agent:agent /home/agent/.hermes; proot-distro login debian -u 0 -- chmod 600 /home/agent/.hermes/.env; proot-distro login debian -u 0 -- chmod 700 /home/agent/.hermes'
```

- [ ] **Step 3: Verify permissions and that no secret leaked into the repo**

Run: `git status --short`
Expected: clean tree (no `.env` or token anywhere in the repo). Then:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- bash -c "ls -l /home/agent/.hermes/.env /home/agent/.hermes/config.yaml"'
```

Expected: `.env` mode `-rw-------` owner `agent`, `config.yaml` owner `agent`.

---

### Task 5: Prove the model works end-to-end (CLI one-shot) before the gateway

**Files:**
- None (device verification)

- [ ] **Step 1: Run a one-shot CLI turn through Groq**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- su - agent -c "cd /home/agent/workspace && hermes chat -q \"Reply with exactly the word PONG\" 2>&1 | tail -15"'
```

Expected: the reply contains `PONG` — proves model credentials, provider routing, and sandbox outbound HTTPS all work. If it errs on the model name, list Groq models with `curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.groq.com/openai/v1/models` and update `config.yaml` model name, then re-run.

---

### Task 6: Install + start the runit service on device

**Files:**
- None (device deployment of `bootstrap/services/hermes/run`)

- [ ] **Step 1: Copy service dir, enable, up**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'SVDIR=$PREFIX/var/service; mkdir -p "$SVDIR/hermes"; cat > "$SVDIR/hermes/run" <<'"'"'EOF'"'"'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
exec proot-distro login debian -u 0 -- /usr/bin/su - agent -c '"'"'cd /home/agent/workspace && /usr/local/bin/hermes gateway'"'"'
EOF
chmod +x "$SVDIR/hermes/run"; export SVDIR; $PREFIX/bin/sv enable hermes; sleep 3; $PREFIX/bin/sv up hermes; sleep 8; $PREFIX/bin/sv status hermes'
```

Expected: `run: hermes: (pid …)…` (green, running).

- [ ] **Step 2: Confirm the gateway process and no inbound port**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- bash -c "ps -ef | grep hermes | grep -v grep | head; echo ---; cat /home/agent/workspace/logs 2>/dev/null | tail -5; echo; ls /home/agent/.hermes/logs 2>/dev/null && tail -5 /home/agent/.hermes/logs/*.log 2>/dev/null | tail -20"'
```

Expected: `hermes gateway` process visible; log tail shows the gateway connecting to Telegram (e.g. poller start / bot username). If the log shows an auth error, re-check `TELEGRAM_BOT_TOKEN`/`OPENAI_API_KEY` in `/home/agent/.hermes/.env`.

---

### Task 7: Functional test — Telegram pairing, ownership lock, approvals

**Files:**
- None (manual verification with the owner)

- [ ] **Step 1: Owner DMs the bot and shares the pairing code**

Ask the owner to message the bot from their personal Telegram. Hermes's gateway replies to DM from an unknown user with a one-time pairing code (e.g. `XKGH5N7P`). Get that code from the owner.

- [ ] **Step 2: Approve the pairing (locks bot to owner)**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'proot-distro login debian -u 0 -- su - agent -c "hermes pairing approve telegram <CODE> 2>&1 | tail -3"'
```

Expected: approval confirmed.

- [ ] **Step 3: Owner conversation round-trip**

Ask the owner to send a normal message to the bot.
Expected: the bot replies within ~30s (first reply may be slower as the gateway warms up / downloads skill metadata).

- [ ] **Step 4: Non-owner is denied**

From a different Telegram account (or a second bot in a shared group), send a message.
Expected: no reply / pairing-denied behavior — the bot is locked to the paired owner.

- [ ] **Step 5: Dangerous-command approval gate**

Ask the owner to ask the bot to run a dangerous command (e.g. `run rm -rf /`).
Expected: Hermes surfaces an approval prompt in Telegram; the command executes only after the owner explicitly approves. (YOLO mode is NOT enabled anywhere.)

---

### Task 8: Restart resilience + repo housekeeping

**Files:**
- Modify: `tests/acceptance.sh` (optional smoke note — Hermes has no HTTP surface, so no new HTTP check is possible)
- Modify: `sandbox/apps/healthcheck/progress.json`

- [ ] **Step 1: `sv restart hermes` survives**

Run:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'export SVDIR=$PREFIX/var/service; $PREFIX/bin/sv restart hermes; sleep 10; $PREFIX/bin/sv status hermes; proot-distro login debian -u 0 -- bash -c "ps -ef | grep hermes | grep -v grep | head -1"'
```

Expected: service back up, new pid, `hermes gateway` running. Ask the owner to send another message to reconfirm a reply after restart.

- [ ] **Step 2: Log the feature in progress.json**

Add a history entry to `sandbox/apps/healthcheck/progress.json`:

```json
{ "when": "2026-09-24", "what": "Hermes Agent live in sandbox as agent user: Telegram-locked bot (owner pairing), Groq openai/gpt-oss-20b brain, runit service auto-starts with phone" }
```

- [ ] **Step 3: Commit repo changes**

```bash
git add sandbox/apps/healthcheck/progress.json
git commit -m "docs(healthcheck): log Hermes Telegram agent deployment"
```

- [ ] **Step 4: Deploy progress.json to device + restart healthcheck**

Run (uses the same scp path proven in the device-specs plan — a direct write into the proot rootfs):

```bash
scp -P 12222 -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no \
  sandbox/apps/healthcheck/progress.json \
  nova3i@127.0.0.1:/data/data/com.termux/files/usr/var/lib/proot-distro/containers/debian/rootfs/root/apps/healthcheck/progress.json
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'export SVDIR=$PREFIX/var/service; sv restart $SVDIR/sandbox; sleep 12; sv status $SVDIR/sandbox'
```

Expected: transfer succeeds; sandbox restarts. If a hung proot blocks restart, kill the sandbox proot tree first:

```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'PROOT_PID=$(ps -ef | grep "proot.*-c /root/apps/start-all.sh" | grep -v grep | awk "{print $2; exit}"); [ -n "$PROOT_PID" ] && kill -9 "$PROOT_PID"; export SVDIR=$PREFIX/var/service; sv restart $SVDIR/sandbox; sleep 14; sv status $SVDIR/sandbox'
```

- [ ] **Step 5: Final verification sweep**

Run: `bash tests/acceptance.sh http://127.0.0.1:8080`
Expected: all existing checks PASS (Hermes adds no HTTP endpoint, so the suite is unchanged).

---

## Out of Scope (per spec)

- Local on-device LLM / llama.cpp / Ollama.
- Any HTTP surface for Hermes on the public funnel.
- OpenClaw migration.
- Multi-user / multi-bot.
- Scheduled automations beyond defaults.