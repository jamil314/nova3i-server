# LAN OpenCode Phone-Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this PC's opencode reachable from a phone browser on the same home Wi-Fi (`http://192.168.0.111:4096`) with username/password auth, served persistently by a systemd user service.

**Architecture:** Run `opencode web --hostname 0.0.0.0 --port 4096` as a dedicated foreground server under a systemd *user* unit, with credentials loaded from a 0600 env file. The web server reads the same on-disk session store as the existing TUI, so session history (including the current conversation) appears on the phone. **Deviation from spec:** the `server` block is NOT added to `opencode.jsonc` — CLI flags only. This keeps the normal TUI's internal server bound to loopback (unauth'd random port stays off the LAN); only the dedicated web process exposes LAN access, and it is password-protected.

**Tech Stack:** opencode 1.18.31 (`/home/jamil/.opencode/bin/opencode`), systemd user units, `loginctl enable-linger`, openssl (password minting).

---

### Task 1: Mint credentials into a private env file

**Files:**
- Create: `~/.config/opencode/server.env` (mode `0600`)

- [x] **Step 1: Create the directory and env file**

Run:
```bash
mkdir -p ~/.config/opencode
PW=$(openssl rand -base64 24 | tr -d '\n')
umask 177
printf 'OPENCODE_SERVER_USERNAME=jamil\nOPENCODE_SERVER_PASSWORD=%s\n' "$PW" > ~/.config/opencode/server.env
unset PW
```
Expected: no output; file created.

- [x] **Step 2: Verify permissions and contents**

Run: `ls -l ~/.config/opencode/server.env && sed 's/=.*/=<redacted>/' ~/.config/opencode/server.env`
Expected: `-rw------- 1 jamil jamil ... server.env` and exactly two lines, username `jamil`, password printed as `<redacted>`.

- [x] **Step 3: Commit (plan doc) — after all tasks**

Defer all commits to final task.

### Task 2: Install the systemd user service

**Files:**
- Create: `~/.config/systemd/user/opencode-web.service`

- [x] **Step 1: Write the unit file**

Run (heredoc writes the unit):
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/opencode-web.service <<'EOF'
[Unit]
Description=OpenCode web server (LAN phone control)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/jamil
EnvironmentFile=%h/.config/opencode/server.env
ExecStart=/home/jamil/.opencode/bin/opencode web --hostname 0.0.0.0 --port 4096
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
```
Expected: no output.

- [x] **Step 2: Verify the unit parses**

Run: `systemd-analyze --user verify ~/.config/systemd/user/opencode-web.service`
Expected: exit 0, no errors printed.

### Task 3: Enable linger and start the service

- [x] **Step 1: Reload user units and enable linger**

Run:
```bash
systemctl --user daemon-reload
loginctl enable-linger jamil
systemctl --user enable --now opencode-web.service
```
Expected: `Created symlink ... default.target` output; `enable-linger` silent.

- [x] **Step 2: Wait and confirm the service is active**

Run: `systemctl --user status opencode-web.service --no-pager -l | head -8`
Expected: `Active: active (running)`.

If `Active: failed`, inspect with `journalctl --user -u opencode-web --no-pager -n 30` and fix (common causes: missing `dbus` session, invalid unit line).

### Task 4: Verify from the PC

- [x] **Step 1: Confirm it binds on the LAN interface**

Run: `ss -tlnp | grep 4096`
Expected: a line showing `0.0.0.0:4096` (or `*:4096`) owned by an `opencode` / `node` process.

- [x] **Step 2: Unauthorized request → 401**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/`
Expected: `401`

- [x] **Step 3: Authorized request → 200**

Load creds and hit the web root:
```bash
set -a; . ~/.config/opencode/server.env; set +a
curl -s -o /dev/null -w '%{http_code}\n' -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/
```
Expected: `200`

- [x] **Step 4: Confirm the LAN IP answer**

Run: `curl -s -o /dev/null -w '%{http_code}\n' -u "jamil:$(grep OPENCODE_SERVER_PASSWORD ~/.config/opencode/server.env | cut -d= -f2)" http://192.168.0.111:4096/`
Expected: `200`

### Task 5: Phone-side check (user confirm)

- [x] **Step 1: Provide the URL and credentials to the user**

On the phone (same home Wi-Fi, not on the nova3i): open `http://192.168.0.111:4096`, log in as `jamil` with the generated password. They should see the opencode web UI, project list, and session history (including the current conversation).

- [ ] **Step 2: If the phone cannot connect**

Run from the PC: `ip route get 192.168.0.111` to confirm the PC's address; check the phone is on the same SSID; disable AP client isolation if present. Retry Task 4 Step 4 first to rule out PC-side issues.

### Task 6: Commit the plan (and any spec note)

- [x] **Step 1: Commit plan document**

Run:
```bash
cd /home/jamil/nova3i-server
git add docs/superpowers/plans/2026-09-23-lan-opencode-phone-control.md
git commit -m "docs: LAN opencode phone-control implementation plan"
```
Expected: commit succeeds.

- [x] **Step 2: Note the spec deviation**

Append one line to `docs/superpowers/specs/2026-09-23-lan-opencode-phone-control-design.md` under "Components → 1": "Implementation uses CLI flags only; the `server` config block is NOT added, so the TUI stays loopback-bound." Commit:
```bash
git add docs/superpowers/specs/2026-09-23-lan-opencode-phone-control-design.md
git commit -m "docs: note CLI-only server config in phone-control spec"
```

---

## Notes for the executor

- Do not run `opencode web` manually in a terminal as a test — the systemd service is the single managed instance. If debugging, prefer `systemctl --user restart opencode-web`.
- The credentials file must never be committed or echoed to screenshots.
- Config change reminder for the user: this setup does **not** require restarting the running opencode session; the web server is an independent process. The TUI's config is untouched.