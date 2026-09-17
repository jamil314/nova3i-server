# Nova 3i as a Public Web/API Server — Design

Date: 2026-09-17
Status: Approved (design), pending implementation plan

## Goal

Turn a spare Huawei Nova 3i into an always-on, publicly reachable web/API
server and Linux learning sandbox, using no root and no paid infrastructure.

## Constraints and facts

- Device: Huawei Nova 3i (model `INE-LX2r`), Kirin 710, arm64-v8a.
- Android 9 / API 28. Kernel is old; the Android 11+ netlink restriction
  does **not** apply, so userspace Tailscale is viable.
- 3.8 GB RAM, 109 GB `/data`, 28 GB free.
- Huawei stopped issuing bootloader unlock codes in 2018, and unlock is not
  required for this design. **No root, no custom ROM.**
- The internet connection is behind CGNAT (shared IP), so inbound port
  forwarding is impossible. Public exposure must be an outbound tunnel.
- Public exposure method chosen: **Tailscale Funnel** (free, stable
  `*.ts.net` hostname, works behind CGNAT, optional auth).
- The owner has the domain `jamilur.com` (Hostinger DNS; Vercel CNAMEs for
  `bhulbona.jamilur.com` and `me.jamilur.com`). It is **deliberately not
  used** for this server, to keep the phone isolated from existing domains.
  Cloudflare was considered and rejected: on the free plan a subdomain cannot
  be a separate zone (Enterprise-only), so isolation would require moving the
  entire `jamilur.com` zone, which co-mingles it with the phone.

## Non-goals

- No root, Magisk, custom ROM, or bootloader unlock.
- No Docker or true containers (not feasible without root here).
- Not production-grade; proot and a phone are for learning and light use.
- No public exposure of SSH (SSH stays on the tailnet).
- No custom domain and no DNS changes to any existing domain.
- No credentials for other services (Cloudflare/Vercel/Hostinger API tokens,
  SSH keys to other machines) are ever stored on the phone.

## Architecture (Approach A — split edge)

```
Internet
  |  https://<node>.ts.net   (TLS terminated at Tailscale edge)
  v
Tailscale Funnel  -->  tailscaled (userspace)  -->  127.0.0.1:8080
                                                      |
                                            Caddy reverse proxy (Termux native)
                                                |- /            landing page
                                                |- /api/*       Python API  -> :8000
                                                |- /node/*      Node API    -> :3000
                                                |- /admin/*     basic_auth  -> :9000
                                                      ^
                                     Debian proot sandbox (apps live here)
```

Rationale for splitting the edge (Termux native) from the sandbox (Debian
proot): the edge must come up reliably on every boot; native Termux is more
reliable than a proot container during early boot. The learning/deploy work
still happens inside a full Debian.

### Component responsibilities

- **tailscaled (Termux native)** — joins the tailnet, terminates TLS at the
  Tailscale edge, exposes the local Caddy port via Funnel. Runs in
  userspace-networking mode (no `/dev/net/tun`, no Android VPN slot).
- **Caddy (Termux native)** — one plain-HTTP reverse proxy bound to
  `127.0.0.1:8080`. Routes by path (Funnel provides a single hostname).
  Applies `basic_auth` (bcrypt) to private routes. Chosen over nginx at the
  edge for simpler config and reload.
- **Debian proot sandbox** — hosts code, toolchains, nginx (for learning),
  databases, and the sample apps. Shares Termux's network namespace, so its
  listening ports are reachable at `127.0.0.1` from Termux.
- **Sample apps** — `hello-py` FastAPI/uvicorn on `:8000`, `hello-node`
  Express on `:3000`, `admin-app` on `:9000` (behind auth).

### Data flow

1. Client hits `https://<node>.ts.net/<path>` over TLS.
2. Tailscale edge terminates TLS and forwards to `tailscaled` on the phone.
3. `tailscaled` (Funnel) proxies to `127.0.0.1:8080` (Caddy).
4. Caddy matches the path, optionally enforces basic auth, and proxies to the
   appropriate backend port.
5. Backend runs inside the Debian proot sandbox.

## Interfaces / contracts

- **Funnel ports**: only `443`, `8443`, `10000` are permitted by Tailscale.
  Primary service on `443` -> Caddy `:8080`. `8443`/`10000` are available for
  additional public endpoints later.
- **Caddy listen**: `127.0.0.1:8080` only. Never `0.0.0.0`; TLS is the edge's
  job.
- **Backends**: bind `0.0.0.0` (or `127.0.0.1`) on their assigned loopback
  ports; must be reachable from Termux's network namespace.
- **Auth**: bcrypt hash stored in the Caddyfile; private routes return `401`
  without valid credentials, `200` with.
- **Admin SSH**: Termux `sshd` on a nonstandard port, key-only, reachable only
  over the tailnet (never Funnel-exposed).

## Build / install outline

Host layer:
- Install **Termux** and **Termux:Boot** from F-Droid (not Play Store).
- `termux-wake-lock`; disable battery optimization for both apps.
- Install OpenSSH, configure key-only auth on a nonstandard port.
- Install `proot-distro`, then `proot-distro install debian`.

Network edge:
- Install `tailscale`/`tailscaled` (Termux package, or official static arm64
  binary if unavailable).
- Run `tailscaled --tun=userspace-networking` with socket under
  `$PREFIX/var/run/tailscale/` and state under `~/.config/tailscale/`.
- `tailscale up`; in the admin console enable MagicDNS, HTTPS, and Funnel for
  the node.
- `tailscale funnel --bg --https=443 http://127.0.0.1:8080`.

Edge proxy and sandbox:
- Install Caddy in Termux; deploy the Caddyfile with route map and auth.
- Inside Debian: install `python3`/`venv`, `nodejs`/`npm`, `nginx`, `sqlite3`,
  optional `postgresql`, `git`, `build-essential`.
- Create `hello-py`, `hello-node`, `admin-app` and their start scripts.

Boot and supervision:
- `~/.termux/boot/start-services.sh` (run by Termux:Boot):
  wake-lock -> start `tailscaled` -> wait for `tailscale up` -> start Caddy ->
  start proot sandbox apps.
- Use `termux-services` (runit) to supervise tailscaled and Caddy.
- Funnel `--bg` auto-resumes after reboot or `tailscale up`.

## Error handling

- Boot script must be idempotent: check for already-running daemons before
  starting, and retry `tailscale up` until the daemon is reachable.
- Service supervision via runit restarts crashed daemons.
- Caddy returns `502` when a backend is down; the landing page is a static
  index listing the available routes.
- Funnel fallback: if ACME/cert provisioning fails in non-root Termux, fall
  back to `tailscale serve` (tailnet-only) or a Cloudflare quick tunnel.

## Security

### Isolation from other domains and services

The phone is expected to eventually run an autonomous agent (e.g. Hermes /
OpenClaw) with broad local access. Treat the phone as a potentially hostile
host and constrain what a compromise can reach.

- **No privileged credentials on the device.** Only the Tailscale node identity
  is stored. No Cloudflare/Vercel/Hostinger API tokens, no SSH private keys to
  other machines, no cloud credentials. A Tailscale node identity can only
  serve its own Funnel, never DNS or other accounts.
- **Separate domain namespace.** The server is reachable only at
  `<node>.ts.net`; it has no relationship to `jamilur.com`. This removes the
  DNS/hosting layer as a pivot path.
- **Network egress isolation at the router.** Place the phone on an isolated
  guest/IoT VLAN or SSID. Allow outbound only to what the server needs
  (Tailscale/DERP endpoints and general HTTPS if required); block access to
  other LAN devices, NAS, admin panels, and internal subnets. This prevents
  lateral movement from a compromised agent.
- **Unprivileged agent.** The agent runs as an ordinary user inside the Debian
  proot sandbox, never as root and never with Android storage permissions
  beyond what is required. Termux on an unrooted phone cannot escalate to
  system root.
- **Revocability.** The Tailscale node can be removed from the tailnet at any
  time, and Funnel disabled, without touching any other infrastructure.

### General hardening

- Public only on `443`; SSH never public.
- `basic_auth` (bcrypt) on `/admin/*` and any other private route.
- Key-only SSH, nonstandard port, tailnet-restricted.
- No secrets committed to the repo; credentials and Tailscale state live on
  the device.
- Funnel URL is discoverable by anyone who has it; treat it as public.

## Risks and mitigations

- **EMUI aggressive battery management** (top failure mode) -> wake-lock and
  battery whitelist for Termux and Termux:Boot; verify survival over days.
- **Background process kills on Android 9/Doze** -> wake-lock plus runit
  supervision.
- **Funnel cert provisioning in non-root Termux** can intermittently fail ->
  documented fallback above.
- **proot performance** -> acceptable for learning/light use; not for heavy
  databases or production traffic.
- **Always-plugged battery** -> no charge limiter on the Nova 3i; expect
  battery wear over time.
- **Agent with broad access reconfiguring the tunnel** -> without root the
  agent shares the Termux UID and can in principle change Funnel/serve. This is
  accepted; the isolation controls above limit the blast radius to the phone's
  own public endpoint, not other domains or the LAN.
- **Public Funnel endpoint abused** -> keep private routes behind auth; rotate
  or disable Funnel if abuse is observed.

## Verification / acceptance

1. `tailscale status` shows the node online with Funnel enabled.
2. `curl http://127.0.0.1:8080/` returns the landing page on-device.
3. `curl https://<node>.ts.net/` works from a **different network** (phone on
   mobile data), proving public reachability.
4. `/admin/*` returns `401` without credentials and `200` with them.
5. `/api/*` and `/node/*` return the sample apps' responses.
6. Full reboot test: after reboot with no manual action, all of the above
   still holds.
7. Isolation test: from inside the phone, confirm no credentials for other
   services exist, and confirm the phone cannot reach other LAN devices or
   internal services (egress/VLAN rules effective).
8. Confirm `jamilur.com` and its subdomains are unchanged and resolve as before.

## Open questions

- Final tailnet node name / hostname (assigned by Tailscale at build time).
- Whether to add a second public endpoint on `8443`/`10000` later.
- Exact router/VLAN mechanism for egress isolation (depends on the network
  hardware available).
