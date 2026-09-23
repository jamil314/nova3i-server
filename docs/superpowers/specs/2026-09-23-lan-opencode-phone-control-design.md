# LAN OpenCode Web Server for Phone Control — Design

**Date:** 2026-09-23
**Status:** Approved (user selected Approach A: LAN web server)

## Problem

The user wants to control this opencode session from a separate Android phone on the same home Wi-Fi. The phone is not connected to the PC via USB and must not touch the `nova3i` server. OpenCode runs on the PC as a TUI (`opencode` 1.18.31 at `~/.opencode/bin/opencode`).

## Goal

From the phone browser (or the optional OpenCode Mobile app), the user can open the opencode web UI at `http://192.168.0.111:4096`, log in with basic auth, browse projects, see session history (including the current conversation), and continue or start sessions.

## Constraints

- **Home Wi-Fi only.** No router port-forwarding, no public exposure, no Tailscale/tunnel.
- Sessions/password live only in the user's home dir — never in git.
- The current TUI keeps working untouched; no restart of the live session.
- Control is LAN-only by design; plain HTTP is acceptable on trusted home Wi-Fi.

## Architecture

```
Phone (Android, same Wi-Fi)                      PC (192.168.0.111)
─────────────────────────────                    ────────────────────
Browser / OpenCode Mobile   ──HTTP──▶  opencode web --hostname 0.0.0.0 --port 4096
 (basic auth user/pass)              │   (systemd user service, restart on failure)
                                     │
                                     ▼
                             ~/.config/opencode/opencode.jsonc  (server block)
                             ~/.config/opencode/server.env      (creds, 0600)
                             ~/.local/share/opencode/...        (shared session store)
```

The web server instance reads the same on-disk session store as the TUI, so this conversation appears in the phone's session list.

## Components

### 1. opencode server config (`opencode.jsonc`)
Add a `server` block so the web server binds consistently:
```jsonc
{
  "server": { "port": 4096, "hostname": "0.0.0.0" }
}
```
CLI flags would take precedence; use `opencode web` explicitly when starting the service so behavior is unambiguous.

### 2. Credentials (`server.env`)
File `~/.config/opencode/server.env`, mode `0600`, containing:
```
OPENCODE_SERVER_USERNAME=<chosen username>
OPENCODE_SERVER_PASSWORD=<strong password>
```
- Default username `opencode` is acceptable if preferred.
- `Reference only` — concrete values are not committed; setup will prompt/mint a random strong password.

### 3. systemd user service (`opencode-web.service`)
Unit installed at `~/.config/systemd/user/opencode-web.service`:
- `ExecStart=/home/jamil/.opencode/bin/opencode web --hostname 0.0.0.0 --port 4096`
- `EnvironmentFile=%h/.config/opencode/server.env`
- `Restart=on-failure`, `RestartSec=3`
- `WantedBy=default.target`
- `loginctl enable-linger` so it survives logout and starts on boot/login.
- System of type `simple` (the web server runs in the foreground).

### 4. Phone access (no PC-side work)
- Phone browser → `http://192.168.0.111:4096` → basic-auth prompt → opencode web UI.
- Optional: install OpenCode Mobile app, point it at the same URL + creds (it uses the standard opencode server API; verify via the server's health endpoint before publishing it as supported).

## Behavior Notes

- **Shared, not mirrored.** The web server is a separate server instance; with the TUI and web on different instances, the phone does not receive live keystroke-level mirror of the currently-open TUI screen. Session history is shared via disk storage.
- **One driver.** For any given session, drive it from the phone *or* the TUI, not both simultaneously, to avoid two clients steering one session.
- Port `4096` is currently free on the PC (confirmed via `ss`).

## Error Handling & Verification

1. After enabling the service, verify it is running:
   `systemctl --user status opencode-web`
2. Health check from the PC:
   `curl -u user:pass -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4096/`  (expect 200/401 correctly authed)
3. Confirm the server listens on the LAN interface:
   `ss -tlnp | grep 4096` → `0.0.0.0:4096`
4. From the phone: open the URL, confirm the login prompt appears, confirm session history includes a recent opencode conversation.
5. If the phone cannot reach the address: check phone is on the same Wi-Fi, check client isolation is off on the router/AP, and confirm `192.168.0.111` is the PC's primary LAN IP.

## Security Notes & Limitations

- Plain HTTP on trusted LAN; credentials transit in the clear within the home network. Acceptable per `home Wi-Fi only` constraint.
- If the user later wants access from anywhere, the upgrade path is HTTPS via Tailscale or a tunnel — out of scope here.
- The web server must NOT be exposed through the router; verify no port-forward rule exists.

## Out of Scope

- Live pixel-mirror of the running TUI (Approach B).
- Tailscale/remote access.
- SSH-from-phone terminal (Approach C).
- Any change to the `nova3i` phone server.