# Northstar Scan + Queue Handoff (2026-06-17)

## What I scanned

- Reviewed prior state from:
  - `/Users/kylenewbigging/dev/northstar/CONTEXT.md`
  - `/Users/kylenewbigging/dev/northstar/GOALS.md`
  - `/Users/kylenewbigging/dev/northstar/AGENTS.md`
  - `/Users/kylenewbigging/dev/northstar/README.md`
  - `/Users/kylenewbigging/dev/northstar/NORTHSTAR_HANDOFF_2026-06-17.md`
  - Current SQLite queue state in `~/.northstar/northstar.sqlite`
  - Runtime checks: `npm run build`, `npm run smoke`, `npm run startup:check -- --once --json`, and both `npm run homepc:smoke` variants.

## What remains to do

- All high-priority Telegram hardening from the Joey source of truth is complete:
  - Review-gated Telegram flow (`needs-input`)
  - Source metadata (`source`, `sourceRef`, `prompt`) on task rows and `/api/queue`
  - Per-topic session sequencing and lane mismatch controls
  - Home-PC tunnel/mirror smoke and startup checks
  - Launchd/tmux/heartbeat readiness loop

- The remaining open implementation is one item, still intentionally optional versus immediate 24/7 needs:
  - `UPG-TS-24-7-15` — migrate the Telegram bridge from raw Bot API polling to a `grammy`/`@grammyjs/runner`-based implementation path.

## Queue update made in this pass

- Updated:
  - `UPG-TS-24-7-15` from `idle` → `queued`
  - stage set to `queued from latest scan`

## Recommended approach for 5.5 handoff

1. Keep current queue-gate behavior unchanged while migrating transport.
2. Add a thin bridge adapter with two implementations:
   - `telegram-polling` (current behavior) for immediate stability.
   - `telegram-grammy` (new implementation) behind an env toggle.
3. Use `@grammyjs/runner` `run(sequentialize)` + `bot.on('message')` / `bot.on('callback_query')` to preserve:
   - chat/topic serialization keying
   - allowlist checks
   - non-command prompt capture workflow
   - existing bridge `queuePrompt` / `resolveInboxAction` contract
4. Preserve one source of truth for command handlers and message parsing in shared helpers.
5. Add smoke assertions for both transports and add migration test that flips transport mode.

## Home-PC continuity context (for Tuesday setup)

- Companion checks are already wired and clean:
  - `npm run homepc:smoke` (online)
  - `npm run homepc:smoke:offline`
  - queue pressure + heartbeat freshness are part of startup checks.
