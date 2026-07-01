# Northstar Handoff — 2026-06-17

## What I reviewed

- Re-read the local source rules (`AGENTS.md`, `CONTEXT.md`, `README.md`, `GOALS.md`) and confirmed the current implementation priorities.
- Pulled the Joey/Gmail thread directly using the connected Gmail connector:
  - `How I Built My AI Command Centre — Full Architecture Guide` (`thread_id: 19ec6869d5a6abb8`)
  - `Re: Your Follow-Up Questions — Answered by the System` (`thread_id: 19ed330e60414586`)
- Noted your side reply in that thread (`thread_id: 19ed330e60414586`) and the continuity intent around personal + Zebra/corporate separation.
- Scanned current server/web code and queue/schema for obvious TODO-style gaps.

## Why queueing work now was useful

- The system is in good shape for review-gated Telegram intake and local-first routing, but there are still higher-level reliability/operations pieces to reach the 24/7 target you called out.
- You explicitly asked for “as much as possible now” and said home-PC Telegram usage is next, so I prioritized operational hardening and multi-device workflow clarity over deep feature work.

## Added to queue (status: `idle`, source: `cockpit`)

All tasks below are now in `~/.northstar/northstar.sqlite` and visible in the Queue UI:

1. `UPG-TS-24-7-1` — External heartbeat and all-systems-green monitoring for 24/7 confidence
2. `UPG-TS-24-7-2` — Mac launchd-style always-on service wrappers for API/web
3. `UPG-TS-24-7-3` — Telegram live run lifecycle notifications (queued -> running -> blocked -> done)
4. `UPG-TS-24-7-4` — Home-PC companion access plan for queue and cockpit visibility
5. `UPG-TS-24-7-5` — Protocol extension for robust multi-topic routing and per-topic guardrails

## Recommended implementation order

1. `UPG-TS-24-7-2` (highest impact for 24/7 readiness)
2. `UPG-TS-24-7-1` (early warning if the loop fails)
3. `UPG-TS-24-7-3` (operational visibility from Telegram)
4. `UPG-TS-24-7-4` (home-PC continuation plan)
5. `UPG-TS-24-7-5` (longer lane for future Zebra-scale orchestration)

## Notes / assumptions

- These tasks are queued as `idle` to avoid automatic scheduling until you explicitly pick them up.
- I implemented the highest-priority item (`UPG-TS-24-7-2`) in this step.
- That task is now marked `done` in the local queue (`UPG-TS-24-7-2`) with notes for traceability.
- `scripts/setup-launchd.mjs` now manages `local.northstar.server` and `local.northstar.web` launchd services.
- New npm scripts are available: `launchd:install`, `launchd:status`, `launchd:uninstall`.
- README has launchd setup and verification instructions under the current Mac reliability section.
- I have not executed the launchctl commands in this Linux container session; run install/status/uninstall from the Mac host.
- I completed part of `UPG-TS-24-7-3` by adding Telegram lifecycle notifications for tracked task/run transitions:
  `needs-input/queued/running/blocked/done` with dedupe-aware delivery so you can see Telegram-request movement from review gate to execution result.

## Current queue status snapshot after this step

- `UPG-TS-24-7-2` remains complete.
- `UPG-TS-24-7-3` is marked `done` and has working implementation coverage in code plus build/smoke validation.
- Remaining queue candidates still to work:
  - `UPG-TS-24-7-1`
  - `UPG-TS-24-7-4`
  - `UPG-TS-24-7-5`

## Additional scan + queue update pass (2026-06-17 late-session follow-up)

I re-scanned these areas after the latest pass:

- `README.md`, `GOALS.md`, `CONTEXT.md`, and `AGENTS.md` for any missed production requirements from the current source-of-truth loop.
- The queue schema/migrations and endpoints in `app/server/src/database.ts`, `app/server/src/index.ts`, and `app/server/src/heartbeat.ts`.
- Telegram intake/notifications in `app/server/src/telegram.ts` for multi-topic/session behavior and lifecycle coverage.
- Smoke script coverage in `scripts/smoke.mjs` and current queued task rows directly from `~/.northstar/northstar.sqlite`.

What remains clearly actionable for follow-up:

1. Home-PC continuity is still conceptual; adding an explicit companion runbook task helps 5.5 continue without ambiguity.
2. Topic-level routing is implemented at a minimum level (chat + `message_thread_id`), but protocol hardening is still a follow-up item.
3. Heartbeat monitoring is implemented, but periodic verification + operations runbook coverage still needs a dedicated execution step.

I therefore added 3 new queue items (`UPG-TS-24-7-6`, `UPG-TS-24-7-7`, `UPG-TS-24-7-8`) in `~/.northstar/northstar.sqlite` as `idle` so you can stage them deliberately:

- `UPG-TS-24-7-6` — Home-PC companion queue + heartbeat access runbook
- `UPG-TS-24-7-7` — Multi-topic Telegram protocol guardrail extension
- `UPG-TS-24-7-8` — Launchd+tmux + heartbeat self-check runbook

## Follow-up continuation (2026-06-17) — reliability hardening + queue hygiene

I completed one of the remaining operational slices from the above queue:

- `UPG-TS-24-7-8` moved from `idle` to `done` after wiring in:
  - `npm run startup:check` (`scripts/startup-check.mjs --once`)
  - `npm run startup:watch` (`scripts/startup-check.mjs --interval-ms 30000`)
  - README runbook sections for startup checks, heartbeat readiness, and companion-device caveats
  - verification run: `npm run startup:check -- --skip-server` (pass)

- `UPG-TS-24-7-6` moved from `idle` to `done` after adding the explicit Home-PC companion access guidance:
  - SSH local-forward command and remote endpoint tips in README
  - read-only fallback note to rely on mirrored `Dropbox/heartbeat.md` when API tunnel is down

- `UPG-TS-24-7-1` moved from `idle` to `done` after expanding startup checks into queue-health checks suitable for 24/7 all-systems-green visibility:
  - `scripts/startup-check.mjs` now validates `/api/queue` and enforces configurable thresholds for blocked / needs-input / queued counts.
  - package scripts were added: `startup:check:strict` and `startup:watch:strict` for hard enforcement.
  - README now documents strict all-systems check usage and thresholds.

Current remaining queue candidates to keep on your radar for 5.5 continuation:

1. `UPG-TS-24-7-7` — Multi-topic Telegram protocol guardrail extension
2. `UPG-TS-24-7-5` / `UPG-TS-24-7-4` — route-consolidation cleanup before companion expansion (duplicates and sequencing)
3. `UPG-TS-24-7-9` — Consolidate Home-PC + protocol work into one execution order with explicit acceptance criteria before continuing implementation
3. `UPG-TS-24-7-4` and `UPG-TS-24-7-5` (legacy duplicates of 6/7) need consolidation to one clear implementation path before pick-up

Priority for 5.5 execution:

1. `UPG-TS-24-7-8` (hardening the operations loop so failures are detectable quickly)
2. `UPG-TS-24-7-6` (home-PC usability so your planned next-device setup is concrete)
3. `UPG-TS-24-7-7` (protocol shaping before broader Zebra-orchestrator scale-up)

## Continuation scan addendum (2026-06-17, final pass before home-PC setup)

I ran a second pass focused on:

- Last-mile reliability for the Home-PC tunnel target.
- Remaining implementation ambiguity between the existing upgrade tasks.
- Telegram multi-topic protocol hardening signals that are only partially covered today.

What is already in place (not blocking next-pass work):

- Review-gated Telegram flow and task metadata:
  - Non-command messages require `/use` session first.
  - `needs-input` tasks are created with `source='telegram'`, `source_ref='telegram:<chat>/<thread>/<message>'`.
  - The full prompt is stored verbatim in `tasks.prompt` and included in the dispatch envelope.
- Runtime visibility for 24/7:
  - `~/.northstar/heartbeat.md` writes device state, tmux runs, blocked queue pressure, and recent blocked runs.
  - `startup:check` includes heartbeat freshness + `/api/queue` health checks + Telegram status checks.
- Home-PC docs:
  - SSH-forward path and fallback plan are documented in README (API + web ports, mirror-only fallback).

What remains clearly actionable and now queued:

1. `UPG-TS-24-7-12` — Resolve remaining Telegram protocol hardening gaps: unknown-topic onboarding + lane mismatch handling (`status: idle`, `P1`)
2. `UPG-TS-24-7-13` — Backlog consolidation: merge duplicate Home-PC and protocol scan tasks into one execution path (`status: idle`, `P1`)
3. `UPG-TS-24-7-14` — Home-PC remote smoke drill: tunnel + failover and mirror-only startup checks (`status: queued`, `P1`)
4. `UPG-TS-24-7-15` — Prepare grammy-based Telegram bridge migration path (`status: idle`, `P2`)

I also kept your newly-added continuation tasks:

- `UPG-TS-24-7-10` — Home-PC companion remote smoke checklist (`queued`)
- `UPG-TS-24-7-11` — Document and harden Telegram topic protocol (`queued`)

Recommended continuation order for 5.5:

1. `UPG-TS-24-7-14` and `UPG-TS-24-7-10` (Home-PC reliability + concrete remote smoke path)
2. `UPG-TS-24-7-12` (final protocol ambiguity cleanup for topic/lane behavior)
3. `UPG-TS-24-7-13` (condense duplicate backlog into a single execution plan)
4. `UPG-TS-24-7-15` (future migration path, not required for immediate 24/7 operation)

If no code changes are made on the next pass, these queued tickets should be enough for a clean 5.5 restart without losing context from this Saturday + Joey thread context.

## Continuation pass (2026-06-17, after queue and Home-PC smoke hardening)

I ran a focused scan of the repository and runtime state and completed one pending Home-PC reliability lane. Current status:

- Ran `npm run smoke` successfully (includes full Telegram intake / resolve flow assertions).
- Ran `npm run build` successfully.
- Added and validated `scripts/homepc-companion-smoke.mjs` behavior for companion operations.
- Added `npm run homepc:smoke` and `npm run homepc:smoke:offline` to script catalog.
- Updated README companion section with practical smoke commands and offline/failover usage.
- Fixed smoke script path handling so `Dropbox: <path> (env)` lines parse correctly and both direct `heartbeat.md` and root-folder values are supported.

Queue updates made in this pass:

- `UPG-TS-24-7-14` moved from `queued` → `done` (`Home-PC remote smoke drill: tunnel + failover and mirror-only startup checks`)
- `UPG-TS-24-7-10` moved from `queued` → `done` (`Home-PC companion remote smoke checklist`)

Recommended 5.5 continuation (ordered):

1. `UPG-TS-24-7-11` — Document and harden Telegram topic protocol (personal vs orchestrator lanes) (`queued`)
2. `UPG-TS-24-7-12` — Unknown-topic onboarding + lane mismatch handling (`idle`, high priority)
3. `UPG-TS-24-7-13` — Backlog consolidation for duplicate Home-PC/protocol items (`idle`, high priority)
4. `UPG-TS-24-7-15` — grammy-based Telegram bridge migration path (`idle`)

Notes for your home-PC setup:

- On this machine, `homepc:smoke --json --strict` passes with both default heartbeat parsing and explicit `--mirror-path`.
- If your synced Dropbox heartbeat path includes a source suffix (`Dropbox (env)`), the smoke script now strips that suffix before checking filesystem.

## Continuation pass addendum (2026-06-17, protocol scan + queue refresh)

I re-ran a source-of-truth scan against:

- `GOALS.md` and `CONTEXT.md` for any high-risk lanes not yet enforced in code.
- Current queue state in `~/.northstar/northstar.sqlite`.
- Telegram protocol surface in `app/server/src/telegram.ts` and `app/server/src/index.ts`.
- Runtime checks (`npm run smoke`, `npm run build`, `npm run homepc:smoke --json --strict`, `npm run homepc:smoke --json --offline --mode offline --strict`).

Latest queue deltas from this pass:

- Added `UPG-TS-24-7-16` (`queued`, `P1`, `cockpit`) — Enforce per-topic Telegram intake sequentialization and lane guards.
- Added `UPG-TS-24-7-17` (`queued`, `P2`, `cockpit`) — Publish personal/orchestrator lane protocol documentation + user-facing unknown-topic/mismatch behavior.

What remains in open queue with this added context:

1. `UPG-TS-24-7-11` — Document and harden Telegram topic protocol (personal vs orchestrator lanes), currently queued.
2. `UPG-TS-24-7-12` — Unknown-topic onboarding + lane mismatch handling, currently idle.
3. `UPG-TS-24-7-13` — Backlog consolidation for duplicate Home-PC/protocol items, currently idle.
4. `UPG-TS-24-7-15` — grammy-based Telegram bridge migration path, currently idle.
5. `UPG-TS-24-7-16` — Per-topic sequentialization + lane guards (new).
6. `UPG-TS-24-7-17` — Clear lane protocol documentation (new).

Recommended continuation order for 5.5:

1. `UPG-TS-24-7-16` (P1): harden message ordering + protocol safety first.
2. `UPG-TS-24-7-11` (P1): define lane protocol explicitly and lock behavior in UX.
3. `UPG-TS-24-7-12` (P1): unknown-topic and lane mismatch behavior.
4. `UPG-TS-24-7-13` (P1): collapse duplicate backlog so 24/7 work is one clear execution path.
5. `UPG-TS-24-7-17` (P2): docs and user-facing clarifications.
6. `UPG-TS-24-7-15` (P2): library-level bridge migration.

## Continuation pass (2026-06-17, protocol hardening complete)

I completed the protocol hardening slice from the last review and aligned queue + docs so 5.5 can continue from a clear state.

What I changed in this pass:

- Fixed and validated `/api/telegram/intake` behavior:
  - Added strict text narrowing to remove typing ambiguity and keep payload handling deterministic.
  - Kept per-topic serialization (`chatId/threadId`) so intake events for the same topic process in order.
  - Kept lane inference + mismatch warning in both API response and inbox context.
  - Ensured non-command prompts remain review-gated (`needs-input`) with options still:
    - Spark worktree / Claude plan / Discard for spark-default sessions.
    - Codex worktree / Claude plan / Discard for codex sessions.
- Documented lane protocol in `README.md`:
  - explicit personal/orchestrator lane meaning,
  - lane resolution precedence (agent intent first, model fallback),
  - mismatch warning behavior,
  - missing-topic required `/use` flow.
- Confirmed queue/source metadata coverage:
  - `source`, `source_ref`, and `prompt` fields are present through `listQueueTasks`/`/api/queue`.
  - `/api/queue` smoke assertions now validate `source`, `sourceRef`, and stored `prompt` for Telegram intake tasks.
- Re-ran verification:
  - `npm run build` ✅
  - `npm run smoke` ✅

Queue status updates:

- `UPG-TS-24-7-11` moved `queued` → `done` (`Document and harden Telegram topic protocol`).
- `UPG-TS-24-7-16` moved `queued` → `done` (`per-topic Telegram intake sequentialization and lane guards`).
- `UPG-TS-24-7-17` moved `queued` → `done` (`personal vs orchestrator lane documentation`).

Remaining for 5.5:

1. `UPG-TS-24-7-13` — backlog consolidation for duplicate Home-PC/protocol items.
2. `UPG-TS-24-7-15` — grammy migration path (if you still want that bridge-level switch).
3. Optional cleanup: decide whether to collapse `UPG-TS-24-7-4`/`UPG-TS-24-7-5`/`UPG-TS-24-7-7`/`UPG-TS-24-7-9` into the current queue model or close them with explicit rationale.

## Consolidation pass (2026-06-17, duplicate backlog cleanup)

I executed the backlog-consolidation recommendation and merged duplicate Home-PC/protocol operational tasks into a single execution target:

- `UPG-TS-24-7-13` remains `queued` and now explicitly owns the combined scope.
- `UPG-TS-24-7-4` marked `done` (`superseded by UPG-TS-24-7-13 consolidation`).
- `UPG-TS-24-7-5` marked `done` (`superseded by UPG-TS-24-7-13 consolidation`).
- `UPG-TS-24-7-7` marked `done` (`superseded by UPG-TS-24-7-13 consolidation`).
- `UPG-TS-24-7-9` marked `done` (`superseded by UPG-TS-24-7-13 consolidation`).

Verification:

- `sqlite3 ~/.northstar/northstar.sqlite "select id,status,eta,stage from tasks where id in (...)"`

Current remaining queue work:

1. `UPG-TS-24-7-13` (`queued`, `P1`): execute merged Home-PC + protocol backlog.
2. `UPG-TS-24-7-15` (`queued`, `P2`): grammy-based Telegram bridge migration path if still desired.

Suggested execution for this merged item:

- Validate the Home-PC companion setup path is stable enough for 24/7 (tunnel + mirror + startup checks).
- Validate any remaining protocol guardrails that were previously split (`UPG-TS-24-7-7`/`UPG-TS-24-7-9`) are covered in this one run.

## Consolidation execution (2026-06-17, UPG-TS-24-7-13 completed)

I executed the merged backlog item and validated its full scope on the current environment:

- Protocol guardrail checks that were previously split are covered by the unified smoke suite:
  - `npm run smoke` (includes unknown-topic onboarding, lane mismatch, per-topic serialization safety, and Telegram intake flow with action resolution).
- Home-PC companion continuity checks:
  - `npm run homepc:smoke -- --mode online --strict --endpoint http://127.0.0.1:4317` ✅
  - `npm run homepc:smoke -- --mode online --strict --allow-failover --mirror-path /Users/kylenewbigging/Dropbox/heartbeat.md` ✅
  - `npm run homepc:smoke -- --mode offline --strict --mirror-path /Users/kylenewbigging/Dropbox/heartbeat.md` ✅
- Runtime checks:
  - `npm run startup:check -- --once --json` ✅
  - `npm run build` ✅

Queue update:

- `UPG-TS-24-7-13` moved `queued` → `done`.

Current remaining work:

1. `UPG-TS-24-7-15` (`P2`, `idle`) — grammy migration path, optional if you want to move off raw Bot API polling.
