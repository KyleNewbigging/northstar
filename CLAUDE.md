# Northstar — Agent Entry Point

Northstar is a localhost-first AI command center: a Telegram-controllable cockpit
that lets a user dispatch and monitor local coding agents (Claude/Codex) against
git projects under `~/dev`, with SQLite as the source of truth and tmux-backed
durable agent runs. No hosted/billing/multi-user features — this is single-user,
loopback-only infrastructure.

Target end-state (GOALS.md): a Telegram-powered remote-control cockpit where a
message routes to a project/session, a local agent runs from the right working
directory, status streams back, and durable audit artifacts land in Dropbox.
Long-term it should support multi-device dispatch and a "Zebra" corporate-grade
orchestrator lane on top of today's personal-agent lane (see CONTEXT.md).

## Current State (verified 2026-07-06, per HANDOFF.md — the freshest source)

Working, per the 2026-07-02 survey (re-verify before relying on line numbers,
code has moved since):
- Fastify/SQLite API on `127.0.0.1:4317` + React/Vite cockpit on `127.0.0.1:5173`, both loopback-only, launchd-managed.
- Telegram bridge (grammY): per-chat/topic sequentialization, review-gated free-text intake, `/use` session binding, voice/doc/PDF intake.
- tmux-backed agent execution: isolated worktrees under `~/.northstar/worktrees`, persisted logs, reattach, startup reconciliation.
- Guardrails: no patch-apply/commit/push/delete from Telegram; reserved-model dispatch gated; strict no-API-key blocking before spawning real agents.
- Heartbeat, watchdog, Dropbox mirroring, home-PC companion smoke checks.

In progress / recently landed (all **uncommitted in the working tree** as of this
writing — `git status` shows modified files in `app/server/src` and `app/web/src`
plus `package.json`; do not assume these are on `main` until committed):
1. Queue lanes (`dev`/`personal`/`telegram-intent`) — done 2026-07-02.
2. Queue triage + inbox/blocked-run expiry policy (`expiry.ts`) — done 2026-07-06.
3. Split `telegram.ts` monolith into `app/server/src/telegram/` modules — done 2026-07-06. `telegram.ts` is now a 36-line barrel re-export; confirmed on disk (directory + slim file both present).
4. Split `App.tsx` by screen into `app/web/src/screens/`, `lib/`, `components/` — done 2026-07-06. Confirmed on disk (App.tsx now ~1048L per HANDOFF; screens/lib/components directories exist).
5. Unit tests + CI — done 2026-07-06. `node:test` + `tsx`, ~52 tests across lanes/expiry/migrations/telegram; `.github/workflows/ci.yml` runs `npm ci && npm run build && npm test` (smoke excluded, not headless-safe).
6. Inbox-resolve → run-resume (the M6 autonomy-loop contract from CONTEXT.md) — done 2026-07-06 via `inboxInject.ts`.

Not started (per PLAN.md, still accurate): patch-approve → squash-merge and
request-changes → resume flow (endpoints exist, backend incomplete); memory
stack (QMD/vector search/densification); multi-device/Tailscale dispatch;
Zebra agent registry and multi-bot personalities; image/OCR intake; Windows/Linux
service templates.

**Known stale/conflicting info**: `NORTHSTAR_HANDOFF_2026-06-17.md` and
`NORTHSTAR_SCAN_2026-06-17.md` predate the queue-lanes/tests/inbox-resume work
above and describe an earlier state (e.g. treat `UPG-TS-24-7-*` task IDs there as
likely resolved/superseded — `NORTHSTAR_SCAN_2026-06-18...md` already says as
much). `PLAN.md`'s "Problems observed in live DB" section (mixed-lane queue, no
expiry policy) is **resolved** by HANDOFF.md items 1–2 above; PLAN.md itself is
not updated to reflect this. Treat HANDOFF.md as authoritative for current status
and PLAN.md as authoritative for what's still ahead (items 7+ in its numbered list).

## Commands

```sh
npm install
npm run dev:server        # tsx watch app/server/src/index.ts — API on :4317
npm run dev:web           # vite --host 127.0.0.1 — cockpit on :5173
npm run build              # build:web + build:server (tsc + vite build)
npm test                   # node:test via tsx, app/server/src/**/*.test.ts
npm run smoke               # scripts/smoke.mjs — 50+ live endpoint checks (starts/reuses a server)
npm run setup:dropbox        # scripts/setup-dropbox-root.mjs
npm run launchd:install|:status|:uninstall   # macOS always-on service management
npm run startup:check[:strict]               # scripts/startup-check.mjs
npm run homepc:smoke[:offline]               # scripts/homepc-companion-smoke.mjs
npm run heartbeat:check|:watch               # scripts/heartbeat-watchdog.mjs
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build && npm test` on
push/PR (smoke is excluded — not headless-safe).

## Architecture Map

- `app/server/src/` — Fastify + SQLite backend (~30 files). Key modules:
  `index.ts` (routes), `agentRunner.ts` (dispatch/tmux run lifecycle),
  `database.ts` + `schema.ts` (SQLite + migrations via `runMigrations()`),
  `telegram.ts` (barrel) → `telegram/` (transport, commands, intake, natural
  language, lifecycle, bridge), `inboxInject.ts` (inbox-answer → run-resume),
  `expiry.ts` (stale inbox/task/run cleanup), `lanes.ts` (task lane inference),
  `graphify.ts`/`agentGraph.ts`/`projectGraph.ts` (Graph Cockpit data),
  `deviceFiles.ts` (Dropbox project support-file mirroring), `heartbeat.ts`,
  `scheduler.ts`, `onboarding.ts`, `guardrails.ts` (no-API-key / gating checks),
  `security/requestGuard.ts` (Fastify `onRequest` hook wired in `index.ts` right
  after CORS/websocket: rejects non-loopback `Host` (anti-DNS-rebinding) and
  cross-site `Origin` on state-changing methods / websocket upgrades; absent
  Origin is allowed — browser-attack guard, not token auth).
  `*.test.ts` files sit next to their subject (node:test convention here).
- `app/web/src/` — React/Vite cockpit. `App.tsx` (shell: Rail/HUD/CommandBar/
  SettingsView), `screens/` (Dashboard, Health, Inbox, Queue, Schedule, Graph,
  Review — one file per milestone screen), `lib/` (api, format, work helpers),
  `components/` (StatusTag, ModelChip, Sparkline, Ring), `types.ts`, `data/seed.ts`.
- `prototype/` — the original Claude-Design visual/interaction reference
  (`SPEC.md` + `.jsx` screens + `screenshots/`). **Reference only — do not edit
  unless explicitly asked to update the prototype itself.** Production code is
  `app/web` and `app/server`, built milestone-by-milestone (M1 Dashboard … M6
  local agent execution) against this reference.
- `dist/` — build output of `npm run build` (gitignored, not tracked). Ignore
  unless debugging a production build artifact.
- `scripts/` — operational Node scripts (smoke test, launchd setup, startup
  checks, heartbeat watchdog, Dropbox root setup, Codex usage import).
- Runtime data lives under `~/.northstar/` (SQLite DB, worktrees, logs, secrets,
  skills) — never in the repo. Dropbox project support files live under
  `Dropbox/projects/<repo>/` — never repos, never global Claude/agent roots.

Stack: TypeScript throughout. Backend: Fastify 5, better-sqlite3-style SQLite via
`database.ts`, grammY (Telegram), tmux-backed child processes. Frontend: React 19,
Vite 7, Tailwind 3 (content globs `app/web/index.html` + `app/web/src/**/*.{ts,tsx}`,
custom `star` color `#ffb454`, JetBrains Mono / Geist fonts), `@xyflow/react` for
the Graph Cockpit. Node 24, `tsx` for dev/test execution, no bundler-level test
runner (plain `node:test`).

## Doc Index (root)

- `README.md` — setup/dev/build/smoke instructions, launchd, tmux, Telegram
  bridge configuration walkthrough. Read for **how to run/configure** anything.
- `AGENTS.md` — working agreements and safety rules for agents (see below).
  Read **first**, every session.
- `GOALS.md` — target architecture and current-implementation-status summary,
  sourced from the original design email + a later clarifying thread. Read for
  **why** a feature exists and what "done" means for the vision.
- `CONTEXT.md` — implementation decisions the prototype hand-waved (agent-run
  model, queue/concurrency defaults, git/patch flow, inbox question schema,
  telemetry, Graphify data shape, memory-stack ordering, security rules). Read
  when implementing anything touching those subsystems.
- `PLAN.md` (2026-07-02) — the phased infrastructure plan (Phase 0–5) with a
  "current state assessment" that is now partly stale (see Known
  stale/conflicting info above). Read for **what's next and in what order**.
- `HANDOFF.md` (2026-07-06, most recently updated root doc) — the live session
  handoff: task-by-task status, exact code-location survey, next steps. Read
  **this** for current status, not the scan/handoff snapshots below.
- `NORTHSTAR_HANDOFF_2026-06-17.md` — **historical snapshot**, superseded; kept
  for audit trail only.
- `NORTHSTAR_SCAN_2026-06-17.md` — **historical snapshot**, superseded.
- `NORTHSTAR_SCAN_2026-06-18_FOR_5_5_READY_CONTINUATION.md` — **historical
  snapshot**; itself declares the two files above superseded and says not to
  create further same-day scan files without new evidence.

## Working Agreements (distilled from AGENTS.md — see that file for full text)

- `prototype/` is reference-only; implement in `app/web` + `app/server`; build
  milestone by milestone and compare against `prototype/*.jsx` + screenshots.
- Loopback-only services; private runtime data under `~/.northstar`, never in
  the repo; SQLite is the source of truth; no billing/hosted/cloud defaults.
- **Continuation Loop Guard**: on resume, check `git status` + live SQLite queue
  + the newest handoff note first — do not replay the whole prior thread. Don't
  create a new scan/handoff file unless there's new implementation or decision;
  prefer updating the newest existing handoff (currently `HANDOFF.md`). If two
  passes find the same remaining work with no progress, stop and report instead
  of continuing recursively.
- Before adding a queue task, check `~/.northstar/northstar.sqlite` for existing
  IDs/similar titles; merge or update duplicates rather than creating new ones.
- Agent runs: one queued task = one git worktree = one spawned local CLI
  process. Claude uses `claude.ai` auth, Codex uses ChatGPT auth — never
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CODEX_API_KEY`; strip API-key env vars
  from spawned children; verify no-API mode before real dispatch.
- Agents create branches/worktrees/patches but do not push or commit without
  explicit user approval. Risky ops (patch apply, commit, push, delete,
  reserved-model dispatch) stay gated regardless of caller (cockpit/Telegram).
- Inbox output should teach: explain what was done, why, and the smallest next
  decision needed — not just report completion.
