# Nova 3i Server

Spare Huawei Nova 3i (Android 9, unrooted) used as an always-on public web/API
server and Linux learning sandbox — running Termux + proot-Debian + Caddy +
Tailscale Funnel.

- Design: `docs/superpowers/specs/2026-09-17-nova3i-server-design.md`
- Plan: `docs/superpowers/plans/2026-09-17-nova3i-server.md`

## Public URLs

The permanent public base is `https://nova3i.taila5f58b.ts.net`
(tied to the `nova3i` tailnet identity — survives reboots and NAT changes).

| Endpoint           | What it is                                              |
|--------------------|---------------------------------------------------------|
| `/`                | Landing page (served from `webroot/index.html`)         |
| `/health`          | JSON: status + uptime + available urls + progress       |
| `/health/progress` | Human-readable progress page (HTML; add `?format=json`) |
| `/health/urls`     | JSON list of available endpoints                        |
| `/api/hello`       | Python app (sandbox :8000)                              |
| `/node/hello`      | Node app (sandbox :3000)                                |
| `/admin`           | Admin app (sandbox :9000, basic auth via `config/auth.env`) |

A CNAME `nova3i.jamilur.com` exists, but the Tailscale Funnel routes **only by
tailnet-name SNI**, so browser TLS to the custom domain is dropped at the edge —
the ts.net URL is therefore the supported way in. A Let's Encrypt cert for
`nova3i.jamilur.com` is still issued/deployed (`config/site.{crt,key}`) for any
future reverse-proxy use.

## Architecture

```
Internet --443--> Tailscale funnel edge
                 |  (only forwards TLS whose SNI == nova3i.taila5f58b.ts.net)
                 v
        tailscaled  (userspace networking, patched binary in tailscale-old/)
                 v  tcp://127.0.0.1:8443
        Caddy :8443  (TLS: ts.crt; sites: ts.net + jamilur.com)
        Caddy :8080  (plain HTTP, local only)
                 v
        Debian sandbox (proot-distro, runit service)   -- 127.0.0.1 --
            :3100 healthcheck   :8000 python api
            :3000 node api      :9000 admin app
```

## Layout on the device

- Project copy: `$HOME/nova3i` — `config/` (Caddyfile, certs, auth.env),
  `bootstrap/`, `tailscale-old/` (patched binaries), `webroot/`, `logs/`
- Debian sandbox source: `sandbox/` (repo) deployed to
  `/root/apps/` inside the proot rootfs
  `$PREFIX/var/lib/proot-distro/containers/debian/rootfs`
- runit services (termux-services): `$PREFIX/var/service/{tailscaled,caddy,sandbox,watchdog}`
- Boot hook (Termux:Boot): `~/.termux/boot/start-services.sh`
- Progress store (keep me posted): `sandbox/apps/healthcheck/progress.json` —
  edits go live immediately, no restart

## Ops

```sh
# ssh to the device (via adb on the PC)
adb forward tcp:2222 tcp:2222
ssh -i ~/.ssh/nova3i_ed25519 -o StrictHostKeyChecking=no -p 2222 -T 127.0.0.1 '<cmd>'

# service control
export SVDIR=$PREFIX/var/service
sv status tailscaled caddy sandbox watchdog
sv restart caddy          # after Caddyfile changes
sv restart sandbox        # after sandbox app changes

# logs
tail -f $HOME/nova3i/logs/watchdog.log    # funnel/ingress/cert health
tail -f $HOME/nova3i/logs/tailscaled.log  # daemon lifecycle
tail -f $HOME/nova3i/logs/boot.log        # boot hook output
# sandbox app logs: /tmp/*.log inside the proot (healthcheck.log, etc.)

# update progress (live, no restart)
<edit> $PREFIX/var/lib/proot-distro/containers/debian/rootfs/root/apps/healthcheck/progress.json

# tests (repo)
./tests/acceptance.sh http://127.0.0.1:8080                     # local
./tests/acceptance.sh https://nova3i.taila5f58b.ts.net          # public
```

## Reboot & resilience

On device boot, Termux:Boot runs `~/.termux/boot/start-services.sh`, which
takes a wake lock, starts `runsvdir`, brings up all services, and re-arms the
Funnel. The `watchdog` service then loops every 5 minutes and:

1. reapplies the Funnel TCP forward if it vanished (`--tcp=443 tcp://127.0.0.1:8443`);
2. restarts Caddy (then the sandbox) if `/health` drops locally;
3. tests full ingress through each funnel edge and reapplies Funnel on failure;
4. auto-renews the tailscale cert (into `config/ts.crt|key`, restarts Caddy)
   when fewer than 25 days remain.

## Gotchas

- **Funnel SNI filter**: Funnel only forwards TLS whose SNI is a tailnet name.
  Any other SNI (e.g. `nova3i.jamilur.com`) is silently dropped — connections
  hang/EOF after connect. Hence no custom-domain HTTPS without a TLS-terminating
  proxy in front (e.g. Cloudflare).
- **Patched tailscaled**: `tailscale-old/tailscaled` fixes the auto-update
  SIGSYS crash and DNS issues on this device. Do not replace it with the stock
  binary from `tailscale/`.
- **Funnel ingress can go stale**: an `off`/`on` cycle of the TCP forward
  restores it; the watchdog does this automatically.
- **No `pkill` patterns**: this shell self-kills on SIGSYS if a `pkill -f`
  pattern matches its own command line; kill by explicit PID.
- **Caddy env**: `config/auth.env` must be sourced for `/admin` basic auth;
  the runit run script does this.