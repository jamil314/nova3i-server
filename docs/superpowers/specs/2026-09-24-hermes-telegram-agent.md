# Hermes Agent as a Telegram-Locked AI Assistant on Nova 3i

**Date:** 2026-09-24
**Status:** Approved

## Goal

Run Hermes Agent (Nous Research's self-improving AI agent) on the Nova 3i in
the existing proot-Debian sandbox, reachable only via a Telegram bot locked to
the owner's account. The model comes from a cloud API provider (Groq); no
on-device model. This is the production deployment of the `agent` user created
by `sandbox/setup-debian.sh`.

## Constraints

- Phone is unrooted Android 9; the sandbox runs as `u0_a32` uid + `untrusted_app`
  SELinux domain. Hermes can read everything under Termux home (same uid) but
  cannot read other apps' private storage.
- No root, no netns, no Docker. Hermes's "local" execution backend is used.
- Total RAM ~3.6 GB (~1.6 GB free at idle); Hermes runtime footprint ~512 MB is
  acceptable; a local model is NOT acceptable.
- Sandbox prerequisites verified on device: Python 3.13.5, SQLite 3.46.1 with
  FTS5, pip 25.1.1, aarch64.

## Security Posture (non-negotiable)

1. **Run Hermes as the unprivileged `agent` user**, never root. Its home and
   workspace are `/home/agent`. It is never granted Android storage access.
2. **Telegram is the only remote surface.** Nothing new is exposed on the public
   funnel. The bot is pinned to the owner's Telegram ID via Hermes's
   DM-pairing/allowlist; messages from anyone else are ignored.
3. **Command approvals ON.** Hermes cannot run a shell command or take a
   security-relevant action without explicit confirmation in Telegram.
4. **Credential filtering / context scanning ON** (Hermes defaults) to blunt
   prompt injection.
5. **No secrets in git.** Bot token and Groq API key live only on the device in
   an env file owned by `agent`, mode `600`, referenced by the service.
6. **No port listening on the host for Hermes**; no adb reverse tunnel while it
   runs. All tool execution is local inside the sandbox.
7. **Separate API key with low spend caps** so a compromised agent cannot run up
   cost. (User should also rotate the bot token and Groq key after setup, since
   they were shared in chat.)

## Components

1. **Hermes install (inside proot-Debian, as `agent`):**
   - Official installer: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
   - Hermes manages its own venv (via uv) under `~/.hermes`.
   - Installed with the curated `.[termux]` extra set (full `.[all]` pulls
     Android-incompatible voice deps).

2. **Model provider: Groq (OpenAI-compatible).**
   - `hermes model` / config points at Groq's OpenAI-compatible endpoint with the
     owner's Groq API key.
   - Model: a fast Groq-hosted chat model (e.g. llama-3.x 8b-class). Exact model
     chosen at setup; key stored in `agent`'s env file.

3. **Telegram gateway (single gateway process, 24/7):**
   - `hermes gateway setup` then `hermes gateway start` supervised by runit in
     the Termux host (`bootstrap/services/hermes/run`), mirroring the
     caddy/sandbox pattern:
     `proot-distro login debian -u 0 -- su - agent -c 'cd ~/workspace && hermes gateway'`
   - Conversation continuity across platforms from the same gateway process.

4. **Jailed workspace:** `/home/agent/workspace` is Hermes's working directory.
   It is NOT pointed at `/root/.ssh` or any host app files.

## Data Flow

```
Telegram msg (owner only)
  -> hermes gateway (proot-Debian, as agent)
  -> agent loop (tools local in sandbox; command approval prompts via Telegram)
  -> Groq API (outbound HTTPS, api.groq.com)
  -> reply to owner in Telegram
```

## Service Wiring

- New runit service dir `bootstrap/services/hermes/run` in the repo.
- Deployed on device under `$PREFIX/var/service/hermes/`, `sv enable` at boot.
- Env file: `/home/agent/.hermes-env` (mode 600, owns token + Groq key), sourced
  by the run script or Hermes config. Secrets never stored in the repo.
- Hermes state (memory, FTS5 session DB, skills, logs) persists under
  `/home/agent/.hermes` across setup/deploy.

## Error Handling

- Gateway crash → runit restarts it (same supervision model as the other apps).
- Telegram/network down → Hermes queues/reconnects on its own; runit keeps the
  process alive.
- Provider API fail/rate-limit → Hermes surfaces the error to the owner on the
  next message; no silent retry loop.
- Admission-time check via `hermes doctor` for broken installs.

## Testing

- Owner sends a message to the bot → receives a reply (functional proof).
- Message from a non-owner Telegram account → ignored/denied.
- Command approval gate responds to a request before any shell command runs.
- `sv status hermes` shows running; survives an `sv restart hermes`.
- `hermes doctor` reports healthy inside the sandbox.

## Deploy

1. Add `bootstrap/services/hermes/run` to the repo; commit (no secrets).
2. Preseed `/home/agent/.hermes-env` on the device (secrets, not in git).
3. Install Hermes as `agent` in the sandbox; run `hermes setup` non-interactively
   (portal/OpenAI-compatible provider config with the given key).
4. Configure Telegram gateway (bot token, owner DM pairing).
5. Link runit service on device, `sv start hermes`, verify via Telegram.
6. Log feature in `healthcheck/progress.json`.

## Out of Scope

- Local on-device LLM (Hermes 3 via llama.cpp/Ollama).
- Exposing Hermes or any HTTP interface for it on the public funnel.
- Migrating data from an existing OpenClaw setup.
- Multi-user / multi-bot operation.
- Scheduled automations config beyond defaults.