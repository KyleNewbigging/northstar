# Northstar Infrastructure Plan

Date: 2026-07-02
Source: full-project evaluation (code, DB state, GOALS.md, CONTEXT.md, handoff docs).
Goal: take Northstar from "working cockpit with gaps" to fully functional local-first AI infrastructure.

## Current State Assessment

### Working (verified 2026-07-02)

- Fastify/SQLite API (`127.0.0.1:4317`) and React/Vite cockpit (`127.0.0.1:5173`), both running under launchd (`local.northstar.server`, `local.northstar.web`), loopback-only.
- Smoke test passes end-to-end: API health, project discovery, GitHub catalog, all-project graph, focused graph, attention-alert queue with retry/backoff, Garmin import, skills mirror, Dropbox workspace template.
- Telegram bridge: grammY transport, per-chat/topic sequentialization, review-gated free-text intake, `/use` session binding, voice/doc/PDF media intake, run lifecycle notifications, stale-inbox reminders.
- Agent execution: tmux-backed runner with isolated worktrees under `~/.northstar/worktrees`, persisted logs, reattach commands, startup reconciliation.
- Reliability: heartbeat + watchdog + Dropbox mirroring, launchd helpers, startup checks, home-PC companion smoke script.
- Guardrails: no patch apply / commit / push / delete from Telegram; reserved-model dispatch gated; strict no-API blocking when API key env vars present.
- Scheduler settings exist (night/weekend autonomy windows, parallel-run caps, per-provider toggles).

### Problems (observed in live DB)

- Queue mixes three unrelated lanes with no separation: Northstar dev tasks, personal projects (Immich/Tailscale/cloud), and raw Telegram utterances stored as tasks ("Fix the blocker", complaint messages). 14 queued + 1 needs-input. Queue pressure is currently meaningless.
- 3 blocked agent runs sitting unresolved.
- 33 inbox actions accumulated with no expiry policy.

### Architecture gaps vs GOALS/CONTEXT targets

1. **Autonomy loop not closed.** Inbox resolve does not resume the original agent run (the M6 contract in CONTEXT.md). Only manual `POST /api/queue/:id/resume` exists. Every agent question dead-ends into a manual poke.
2. **Patch flow half-built.** Review UI exists; approve → prepared merge and request-changes → same-agent resume are not wired.
3. **Memory stack not started.** No QMD search, no vector memory, no session-transcript indexing, no densification tournament. Memory today = `CLAUDE.md` + skills files.
4. **Single device.** Tailscale device awareness, home-PC 24/7 companion, dispatch-to-available-machine: all conceptual.
5. **Zebra/orchestrator lane not started.** No agent registry, no per-agent protocol contracts, no multi-bot personalities.
6. **No safety net.** Zero unit tests, no CI, only the smoke script. Two monoliths carry most logic: `app/server/src/telegram.ts` (~3,300 lines) and `app/web/src/App.tsx` (~2,900 lines).
7. Image/OCR intake and Windows/Linux service templates: known deferred, fine to stay deferred.

## Plan

Ordered by dependency, not ambition. Each phase leaves the system usable. Do not skip ahead to Phase 4 — inbox-resume (Phase 1) is the real bottleneck; without it, autonomy stalls at the first ambiguous question regardless of how many agents or bots exist.

### Phase 0 — Hygiene + safety net (1–2 sessions)

1. **Queue lanes.** Add a lane/tag field to `tasks` (`dev` / `personal` / `telegram-intent`). Backfill existing rows. Filter cockpit and Telegram views by lane so queue pressure means something.
2. **Queue triage.** Archive stale Telegram utterance-tasks. Resolve or kill the 3 blocked runs. Drain the 33 inbox items and add an auto-stale/expiry policy for future ones.
3. **Split monoliths.** Break `telegram.ts` into modules: transport, routing, commands, intake, notifications. Split `App.tsx` by screen. No behavior change — mechanical extraction, verified by smoke.
4. **Tests + CI.** Unit tests for guardrails, routing, and sequentialization (the highest-risk invariants). GitHub Actions running typecheck + build + offline-capable smoke subset. Everything after this phase depends on this safety net.

### Phase 1 — Close the autonomy loop (core value)

5. **Inbox resolve → run resume (M6 contract).** `POST /api/inbox/:id/resolve` injects the answer back into the original tmux run and resumes it. This is the single highest-value item in the plan: agent asks → human answers on Telegram → agent continues.
6. **Finish patch flow.** Approve prepares squash-merge locally (still no auto-push in v1). Request-changes appends review notes to the task and resumes the same agent in the same worktree.
7. **Queue observability lane** (GOALS next-step #2). Filters by lane/status, stale-task handling, run-state explanations, operator retry/review actions from both cockpit and Telegram.

### Phase 2 — Memory

8. **Session transcripts as Markdown** persisted under Dropbox `projects/<repo>/sessions/`, preserving chronology for audit/replay.
9. **Fast Markdown search.** QMD if available, otherwise a ripgrep-backed equivalent service. Expose to agents and to Telegram `/find`.
10. **Vector recall.** Semantic index over transcripts + skills. Native `CLAUDE.md` first, QMD second, vector search third — per the CONTEXT.md memory-stack ordering.
11. **Densification tournament** — experimental, last. Memories compete on usefulness, compression, freshness, contradiction rate, replay value.

### Phase 3 — Multi-device

12. **Device registry.** Tailscale-aware: each machine writes heartbeat with device ID, capabilities, online state.
13. **Device-aware dispatch.** Scheduler picks target device by availability. Home-PC runs the 24/7 grammY lane as a durable Windows service.
14. **Wire handoffs into dispatch.** `_handoffs/<device>/` artifacts already exist; make dispatch produce/consume them.

### Phase 4 — Zebra / orchestrator lane

15. **Agent/domain registry** with per-agent communication contracts. Existing role tasks (NS-FE-001, NS-BE-001, NS-DSN-001, NS-GTM-001) are seeds.
16. **Multi-bot personalities.** Admin bot, project gateway bot, cheap quick-task lane (Spark/Haiku-class).
17. **Protocol + audit visibility before more raw autonomy** — matches the Dell (personal) vs. granny/Zebra (corporate orchestrator) distinction in CONTEXT.md.

### Phase 5 — Capability extras

18. Image/OCR Telegram intake.
19. PushCut deep-link alerts.
20. DeepSeek-class cheap model lane.
21. Linux/Windows service templates.

## Standing constraints (do not violate in any phase)

- Loopback-only services; secrets outside git; no hosted deployment/billing/multi-user features.
- Strict no-API: block dispatch when API key env vars are present.
- Risky operations stay gated: patch apply, commits, pushes, deletes, reserved-model dispatch.
- Dropbox holds project support files only — never repos, never global Claude/agent roots.
