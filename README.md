# Nova 3i Server

Spare Huawei Nova 3i (Android 9, unrooted) used as an always-on public web/API
server and Linux learning sandbox.

- Design: `docs/superpowers/specs/2026-09-17-nova3i-server-design.md`
- Plan: `docs/superpowers/plans/2026-09-17-nova3i-server.md`
- Runbook: `docs/runbook.md`

Public exposure is via Tailscale Funnel (`https://<node>.ts.net`). No custom
domain, no inbound ports, no credentials for other services stored on the phone.