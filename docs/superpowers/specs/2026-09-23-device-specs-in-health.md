# Device Specs in Health Endpoint

**Date:** 2026-09-23
**Status:** Approved

## Goal

Surface the Nova 3i device hardware specs and resource availability on the
`/health` endpoint, with a refresh button on the progress page to recompute
current available resources in place.

## Scope

Read-only reporting. No config changes, no new services, no admin endpoints.
Implementation lives entirely in `sandbox/apps/healthcheck/server.js`, plus a
test addition in `tests/acceptance.sh` and a history note in
`sandbox/apps/healthcheck/progress.json`.

## Components

1. **Static hardware spec — captured once at server startup.**
   - Model: `getprop ro.product.model` → `INE-LX2r` (Huawei Nova 3i)
   - OS: `getprop ro.build.version.release` → `9` (Android 9)
   - Cores: `os.cpus().length` → 8
   - Total RAM: `os.totalmem()` → ~3.8 GB
   - Total storage: `df -k /` total → ~109 GB
   - Startup snapshot: `MemAvailable` (from `/proc/meminfo`) and free disk,
     captured once at boot.

2. **Live resource values — read per request, cheaply.**
   - Current `MemAvailable` from `/proc/meminfo`
   - Current free disk via `df -k /`
   - No child-process spawn for memory; disk uses one `df` call.

3. **New endpoint `GET /health/resources`.**
   - Returns `{ memoryAvailableKB, diskFreeKB, at }` (current values + ISO time).

4. **HTML progress page — new "Specs" section.**
   - Hardware table (static values).
   - "Available resources": startup vs current rows.
   - Refresh button that fetches `/health/resources` and updates the current
     rows in place via a small inline script (~30 lines). No full page reload.

## Data Flow

```
startup        readStaticSpec() → spec.startup snapshot (+ hardware)
request /health          → buildIndex() includes spec.live (fresh read)
request /health/resources → json(res, {memoryAvailableKB, diskFreeKB, at})
request /health/progress → renderHtml() includes Specs section + JS button
```

## JSON Shape (additions to /health and /health/progress?format=json)

```json
"spec": {
  "model": "INE-LX2r",
  "os": "9",
  "cores": 8,
  "totalMemoryKB": 3801360,
  "totalDiskKB": 114000000,
  "startup": { "memoryAvailableKB": 1306444, "diskFreeKB": 27300000, "at": "<iso>" },
  "live":    { "memoryAvailableKB": 1200000, "diskFreeKB": 27000000, "at": "<iso>" }
}
```

Numbers are examples; actual values read from the device.

## Error Handling

- `getprop` unavailable or empty → `"n/a"` for model/os; never crash.
- `/proc/meminfo` unreadable → memory fields `null`.
- `df` fails → disk fields `null`.
- Follows the existing `readProgress()` try/catch pattern; endpoint stays 200.

## Testing

Add to `tests/acceptance.sh`:

```bash
check "spec in health"   "/health" 200 "spec"
check "resources live"   "/health/resources" 200 "memoryAvailableKB"
```

## Deploy

1. Edit `sandbox/apps/healthcheck/server.js` locally.
2. Copy to the phone's sandbox at `/root/apps/healthcheck/server.js`
   (via adb-forward ssh to Termux sshd on :2222).
3. `sv restart sandbox` on the device (SVDIR=$PREFIX/var/service).
4. Verify through the funnel: `/health`, `/health/progress`,
   `/health/resources`.

## Out of Scope

- Persisting resource history or snapshots across restarts.
- Alerts/thresholds on low resources.
- Access control changes.