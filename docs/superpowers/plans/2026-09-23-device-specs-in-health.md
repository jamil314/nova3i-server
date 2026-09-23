# Device Specs in Health Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a device hardware spec + available-resources section to the `/health` endpoint, with a `GET /health/resources` refresh endpoint and an in-place Refresh button on the progress page.

**Architecture:** Extend the existing healthcheck Node app (`sandbox/apps/healthcheck/server.js`). Static hardware and the startup snapshot are captured once at process start; live MemAvailable/disk values are read per request; `/health/resources` returns current values; the progress-page Specs section fetches it via inline JS and updates in place.

**Tech Stack:** Node 20 (healthcheck app), `os` module, `child_process.execFileSync` (getprop/df), inline vanilla JS, deploy via adb-forward ssh + runit `sv restart`.

**Spec:** `docs/superpowers/specs/2026-09-23-device-specs-in-health.md`

---

### Task 1: Add read helpers + startup snapshot to server.js

**Files:**
- Modify: `sandbox/apps/healthcheck/server.js:1-10` (requires + module state)

- [ ] **Step 1: Add requires and module-level spec state**

Replace the top block of `sandbox/apps/healthcheck/server.js`:

```js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = 3100;
const BASE = 'https://nova3i.taila5f58b.ts.net';
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const START_TS = Date.now();

function readProp(name) {
  try {
    const out = execFileSync('getprop', [name], { encoding: 'utf8' }).trim();
    return out || 'n/a';
  } catch (err) {
    return 'n/a';
  }
}

function readMemAvailableKB() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const hit = mem.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return hit ? parseInt(hit[1], 10) : null;
  } catch (err) {
    return null;
  }
}

function readDf() {
  try {
    const out = execFileSync('df', ['-k', '/'], { encoding: 'utf8' });
    const line = out.trim().split('\n')[1].split(/\s+/);
    return { totalKB: parseInt(line[1], 10), freeKB: parseInt(line[3], 10) };
  } catch (err) {
    return { totalKB: null, freeKB: null };
  }
}

const STATIC_SPEC = {
  model: readProp('ro.product.model'),
  os: readProp('ro.build.version.release'),
  cores: os.cpus().length,
  totalMemoryKB: Math.round(os.totalmem() / 1024),
  totalDiskKB: readDf().totalKB,
};

const STARTUP_SPEC = {
  memoryAvailableKB: readMemAvailableKB(),
  diskFreeKB: readDf().freeKB,
  at: new Date().toISOString(),
};

function readLiveSpec() {
  return {
    memoryAvailableKB: readMemAvailableKB(),
    diskFreeKB: readDf().freeKB,
    at: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check sandbox/apps/healthcheck/server.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add sandbox/apps/healthcheck/server.js
git commit -m "feat(healthcheck): device spec read helpers + startup snapshot"
```

### Task 2: Add spec to buildIndex JSON and /health/resources endpoint

**Files:**
- Modify: `sandbox/apps/healthcheck/server.js:40-57` (buildIndex) and `:146-150` (router)

- [ ] **Step 1: Add spec to buildIndex**

Add a `spec` key to the returned object in `buildIndex` (right after `progress`):

```js
function buildIndex(p) {
  const history = (p && Array.isArray(p.history) ? p.history : []).slice(-6).reverse();
  return {
    status: 'ok',
    service: 'healthcheck',
    time: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - START_TS) / 1000),
    urls: p && p.urls ? p.urls : null,
    progress: {
      mission: p ? p.mission : null,
      base: p && p.base ? p.base : BASE,
      current: p && p.status ? p.status.current : null,
      next: p && p.status ? p.status.next : null,
      updated: p ? p.updated : null,
      history,
    },
    spec: {
      model: STATIC_SPEC.model,
      os: STATIC_SPEC.os,
      cores: STATIC_SPEC.cores,
      totalMemoryKB: STATIC_SPEC.totalMemoryKB,
      totalDiskKB: STATIC_SPEC.totalDiskKB,
      startup: STARTUP_SPEC,
      live: readLiveSpec(),
    },
  };
}
```

- [ ] **Step 2: Add the /health/resources route**

Add this branch to the router, immediately before the final `json(res, 404, ...)` line:

```js
  if (pathname === '/health/resources') {
    json(res, 200, readLiveSpec());
    return;
  }
```

- [ ] **Step 3: Verify parse + smoke-test locally**

Run:
```bash
node --check sandbox/apps/healthcheck/server.js
( cd sandbox/apps/healthcheck && node server.js >/tmp/hc.log 2>&1 & echo $! >/tmp/hc.pid )
sleep 1
curl -s http://127.0.0.1:3100/health/resources
kill "$(cat /tmp/hc.pid)" 2>/dev/null; rm -f /tmp/hc.pid
```
Expected: JSON containing `memoryAvailableKB`, `diskFreeKB`, `at`. (On this dev PC `model`/`os` may be `n/a` since `getprop` is Android-only — acceptable.)

- [ ] **Step 4: Commit**

```bash
git add sandbox/apps/healthcheck/server.js
git commit -m "feat(healthcheck): expose device spec + /health/resources endpoint"
```

### Task 3: Add Specs section + Refresh button to the progress page

**Files:**
- Modify: `sandbox/apps/healthcheck/server.js:63-115` (renderHtml) and `:76-95` (page CSS)

- [ ] **Step 1: Add CSS for the spec table and button**

Inside the existing `<style>` block in `renderHtml`, after the `.muted` rule, add:

```css
  table.spec { border-collapse: collapse; margin: 6px 0; }
  table.spec td { padding: 3px 14px 3px 0; border: 0; }
  button { background: #238636; color: #fff; border: 0; border-radius: 6px;
           padding: 3px 10px; cursor: pointer; font: inherit; }
  button:hover { background: #2ea043; }
```

- [ ] **Step 2: Add the Specs HTML section**

Insert this block between the "Next" box and the "Recent progress" heading in the template literal (i.e. after the `<div class="box">${escapeHtml(pr.next || 'n/a')}</div>` line). It needs a shared `spec` variable and a `fmtKB` helper — add both: define `const spec = idx.spec || {};` next to the existing `const pr = idx.progress || {};` at the top of `renderHtml`, and append a `fmtKB` helper function above `renderHtml`:

```js
function fmtKB(kb, total) {
  if (kb == null || isNaN(kb)) return 'n/a';
  if (total) return `${(kb / 1048576).toFixed(1)} GiB`;
  return kb >= 1048576 ? `${(kb / 1048576).toFixed(2)} GiB` : `${(kb / 1024).toFixed(0)} MiB`;
}
```

Template block:

```html
<h2>Specs</h2>
<div class="box">
<table class="spec">
  <tr><td class="t">Model</td><td>${escapeHtml(spec.model || 'n/a')}</td></tr>
  <tr><td class="t">OS</td><td>Android ${escapeHtml(spec.os || 'n/a')}</td></tr>
  <tr><td class="t">Cores</td><td>${spec.cores != null ? spec.cores : 'n/a'}</td></tr>
  <tr><td class="t">Total RAM</td><td>${fmtKB(spec.totalMemoryKB, true)}</td></tr>
  <tr><td class="t">Total storage</td><td>${fmtKB(spec.totalDiskKB, true)}</td></tr>
</table>
<p class="muted">Available resources</p>
<table class="spec">
  <tr><td class="t">At startup</td>
      <td>mem ${fmtKB(spec.startup && spec.startup.memoryAvailableKB)} · disk ${fmtKB(spec.startup && spec.startup.diskFreeKB)}</td></tr>
  <tr><td class="t">Now</td>
      <td>mem <span id="live-mem">${fmtKB(spec.live && spec.live.memoryAvailableKB)}</span> · disk <span id="live-disk">${fmtKB(spec.live && spec.live.diskFreeKB)}</span>
          <button id="spec-refresh" type="button">refresh</button></td></tr>
</table>
<p class="muted" id="spec-msg"></p>
</div>
```

- [ ] **Step 3: Add the refresh script**

Insert this `<script>` immediately before `</body>` in the template literal:

```html
<script>
document.getElementById('spec-refresh').addEventListener('click', async () => {
  const msg = document.getElementById('spec-msg');
  msg.textContent = 'refreshing…';
  try {
    const r = await fetch('/health/resources');
    const d = await r.json();
    const fmt = (kb) => kb == null ? 'n/a' : (kb >= 1048576 ? (kb / 1048576).toFixed(2) + ' GiB' : Math.round(kb / 1024) + ' MiB');
    document.getElementById('live-mem').textContent = fmt(d.memoryAvailableKB);
    document.getElementById('live-disk').textContent = fmt(d.diskFreeKB);
    msg.textContent = 'updated ' + new Date(d.at).toISOString();
  } catch (err) {
    msg.textContent = 'refresh failed';
  }
});
</script>
```

- [ ] **Step 4: Smoke-test locally**

Run:
```bash
node --check sandbox/apps/healthcheck/server.js
( cd sandbox/apps/healthcheck && node server.js >/tmp/hc.log 2>&1 & echo $! >/tmp/hc.pid )
sleep 1
curl -s http://127.0.0.1:3100/health/progress | grep -E "Specs|spec-refresh|live-mem" | head
kill "$(cat /tmp/hc.pid)" 2>/dev/null; rm -f /tmp/hc.pid
```
Expected: the grep shows `Specs`, `spec-refresh`, and `live-mem`.

- [ ] **Step 5: Commit**

```bash
git add sandbox/apps/healthcheck/server.js
git commit -m "feat(healthcheck): Specs section + refresh button on progress page"
```

### Task 4: Extend acceptance tests

**Files:**
- Modify: `tests/acceptance.sh:28-31` (checks block)

- [ ] **Step 1: Add the new checks**

Add after the `check "progress json"` line:

```bash
check "health spec json"  "/health" 200 "\"spec\""
check "resources live"    "/health/resources" 200 "memoryAvailableKB"
```

Note: the query string `?format=json` also works against `/health/resources` (harmless).

- [ ] **Step 2: Run acceptance locally**

Run: `bash tests/acceptance.sh http://127.0.0.1:8080`
Expected: any failures only involve the new spec checks IF the local stack lacks them; the existing 8 checks must all PASS. If a local Caddy stack is not running, note that the full suite runs against the funnel after deploy.

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance.sh
git commit -m "test: accept spec fields in /health and /health/resources"
```

### Task 5: Deploy to phone and verify through the funnel

**Files:**
- Modify (on device): `/root/apps/healthcheck/server.js` (in the Debian proot, via Termux sshd)

- [ ] **Step 1: Copy server.js to the device sandbox**

Run (uses the adb-forward ssh channel):
```bash
adb forward tcp:12222 tcp:2222
scp -P 12222 -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no \
  sandbox/apps/healthcheck/server.js \
  nova3i@127.0.0.1:/data/data/com.termux/files/usr/var/lib/proot-distro/containers/debian/rootfs/root/apps/healthcheck/server.js
```
Expected: transfer succeeds, no host-key prompt.

- [ ] **Step 2: Restart the sandbox service**

Run:
```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'export SVDIR=$PREFIX/var/service; sv restart $SVDIR/sandbox; sleep 12; sv status $SVDIR/sandbox'
```
Expected: `run: .../sandbox: (pid <new>) ...s`. If a hung proot blocks restart, kill the sandbox proot tree first:
```bash
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 12222 nova3i@127.0.0.1 \
  'PROOT_PID=$(ps -ef | grep "proot.*-c /root/apps/start-all.sh" | grep -v grep | awk "{print \$2; exit}"); [ -n "$PROOT_PID" ] && kill -9 "$PROOT_PID"; export SVDIR=$PREFIX/var/service; sv restart $SVDIR/sandbox; sleep 14; sv status $SVDIR/sandbox'
```

- [ ] **Step 3: Verify through the funnel**

```bash
for u in "/health" "/health/progress" "/health/resources"; do
  curl -s -o /dev/null -w "%{http_code} $u\n" --max-time 15 "https://nova3i.taila5f58b.ts.net$u"
done
curl -s https://nova3i.taila5f58b.ts.net/health/resources
```
Expected: all `200`; the resources body shows real device values with `memoryAvailableKB`.

- [ ] **Step 4: Run acceptance against the funnel**

Run: `bash tests/acceptance.sh https://nova3i.taila5f58b.ts.net`
Expected: all checks PASS (existing 8 + 2 new).

- [ ] **Step 5: Update progress.json history**

Append to `sandbox/apps/healthcheck/progress.json` `history`:

```json
{ "when": "2026-09-23", "what": "Device specs live: /health shows Nova 3i hardware + available resources; /health/resources + progress-page refresh button" }
```

Also add after the `node/hello` fix note in `status.current` (optional): append ` Device specs endpoint live.`

- [ ] **Step 6: Deploy progress.json + verify**

Run:
```bash
scp -P 12222 -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no \
  sandbox/apps/healthcheck/progress.json \
  nova3i@127.0.0.1:/data/data/com.termux/files/usr/var/lib/proot-distro/containers/debian/rootfs/root/apps/healthcheck/progress.json
curl -s https://nova3i.taila5f58b.ts.net/health/progress | grep -E "Device specs|Specs"
```
Expected: progress page shows the new history entry and the Specs section.

- [ ] **Step 7: Commit**

```bash
git add sandbox/apps/healthcheck/progress.json
git commit -m "docs(healthcheck): log device-specs feature in progress history"
```