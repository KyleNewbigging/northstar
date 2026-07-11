# Session Handoff — Northstar Infrastructure Plan

Date: 2026-07-02
Role: orchestrator (Fable) dispatching Opus subagents for coding tasks; orchestrator reviews all subagent output. Medium effort everywhere.

## Mission

Execute the "Northstar Infrastructure Plan" (see plan text below or original conversation). Phases 0–5, ordered by dependency. Each phase leaves system usable. Do NOT skip ahead — Phase 1 inbox-resume is the real bottleneck.

## Where we are

- Full plan received from user 2026-07-02.
- Codebase surveyed (summary below).
- Task list created (tasks #1–#12 in session task tracker — recreate if new session):
  1. P0.1 Queue lanes (dev/personal/telegram-intent) — **DONE 2026-07-02, uncommitted. Build + smoke pass. Reviewed by orchestrator.**
  2. P0.2 Queue triage + inbox expiry policy — **DONE 2026-07-06, uncommitted. Live DB triaged (7 stale tasks expired incl. 6 TG + NS-DSN-001; 3 dead blocked runs closed; CLOUD-IMMICH backlog + NS seeds + zebra inbox question kept). New expiry.ts: auto-expire unresolved inbox >14d, telegram-intent queued/needs-input tasks >10d, other needs-input >14d, blocked runs >14d (env-overridable NORTHSTAR_*_EXPIRY_MS); inbox_actions gained created_at (migration + all 5 INSERT sites). Wired at startup + tmuxReconcileTimer. Build + smoke pass.**
  3. P0.3 Split telegram.ts monolith — **DONE 2026-07-06, uncommitted. telegram.ts now 36L barrel re-exporting app/server/src/telegram/ (types, constants, utils, api, documents, settings, naturalLanguage, messages, attention, lifecycle, bridge). createTelegramBridge kept intact in bridge.ts. Importers unchanged. Build + smoke pass.**
  4. P0.4 Split App.tsx by screen — **DONE 2026-07-06, uncommitted. App.tsx 2918→1048L; screens/ (Dashboard, Health, Inbox, Queue, Schedule, Graph, Review), lib/ (api, format, work), components/ (StatusTag, ModelChip, Sparkline, Ring). App shell (Rail/HUD/CommandBar/SettingsView) stays in App.tsx. Build + smoke pass.**
  5. P0.5 Unit tests + CI — **DONE 2026-07-06, uncommitted. node:test + tsx runner (`npm test`, zero new deps), 39 tests (lanes, expiry, migrations, telegram naturalLanguage/utils); .github/workflows/ci.yml (npm ci/build/test; smoke excluded — not headless-safe). runMigrations/backfillTaskLanes exported for tests; tsconfig excludes *.test.ts from emit.**
  6. P1.1 Inbox resolve → run resume (M6) — **DONE 2026-07-06, uncommitted. New inboxInject.ts: deliverInboxResolution() — live tmux run gets resolution via new sendTmuxText (send-keys -l + Enter); dead/no session + needs-input/blocked task → requeued with resolution appended to prompt (no auto-dispatch); else record-only. Wired in resolveInboxAction (index.ts:638) so web + telegram /resolve + NL + callback paths all benefit. Result extended additively (delivery/deliveryDetail). +13 tests (52 total). Build/test/smoke pass.**
  7. P1.2 Finish patch flow — **DONE 2026-07-10 (commit 4628758). approvePatch stages exactly the changed files + one local commit (never pushes); request-changes resumes agent in existing worktree via resumeAgentInWorktree (opus resumes as spark — opus is plan-only). 70 tests.**
  8. P1.3 Queue observability lane — **DONE 2026-07-10 (commit a4878ec). Telegram /queue (lane/status/stale filters + dispatchability explanations), /dispatch /pause /requeue (shared core with HTTP routes); cockpit stale badge + requeue button. /run now manual-approval + broadcasts. 91 tests.**
  9. P2 Memory stack — **items 8-9 DONE 2026-07-10: run transcripts → Dropbox projects/<id>/sessions/*.md on every terminal run state (sessionTranscripts.ts, best-effort, bounded 256KB; commit 32eabda); content search over Dropbox *.md via ripgrep-with-node-fallback (searchDeviceFileContents, GET /api/device-files/search-content, telegram /find now filename+content). Items 10 (vector recall) + 11 (densification tournament) DEFERRED: strict no-API blocks hosted embeddings; local embedding model = new heavy dependency — needs user decision.**
  10. P3 Multi-device
  11. P4 Zebra/orchestrator lane
  12. P5 Capability extras
- P0.1 implemented, uncommitted at d616ba1: `lane` column (schema.ts) + ensureColumn/backfillTaskLanes migration (database.ts), shared lanes.ts (TaskLane + inferTaskLane), `?lane=` filter on GET /api/queue, lane set at all 4 INSERT sites (telegram intake ×2 → 'telegram-intent', onboarding.ts, agentRunner.ts with ON CONFLICT lane preservation for non-cockpit sources), web types.ts + seed.ts, App.tsx Queue lane chips, telegram /overview per-lane counts. Backfill verified against live DB read-only (11 telegram → telegram-intent, 6 non-northstar → personal, 42 → dev).
- User paused to grant more permissions; then requested this handoff.

## Codebase survey (verified 2026-07-02)

- Repo: /Users/kylenewbigging/dev/northstar. Server app/server/src (~12.6k lines, 21 files), web app/web/src (App.tsx 2902L + types.ts 365L).
- Schema: app/server/src/schema.ts (275L). Migrations: database.ts `runMigrations()` (lines 25–222) with `ensureColumn()` ALTER TABLE pattern.
- tasks table (schema.ts ~28–49): id, project_id, title, model, agent, status (queued/running/blocked/done/idle/needs-input), priority, progress, eta, stage, files, branch, source, source_ref, prompt, created_at, updated_at, completed_at, dispatch_status, dispatch_blocker. **No lane column yet.**
- inbox_actions (~100–115): id, project_id, task_id, type (question/review/blocked/suggest), model, priority, urgency, title, ctx, options_json, recommend, help, resolved_at, resolution.
- agent_runs (~51–77): tmux-backed; worktree_path, tmux_session, stdout/stderr/exit_status/final_text paths, pid, status.
- Key routes in index.ts: GET /api/queue (1211), POST /api/queue/:id/resume (1229 — just requeues, does NOT resume tmux), POST /api/inbox/:id/resolve (1196 — resolves record only, does NOT inject into run: this is the M6 gap), patches routes (1250–1261: approve/request-changes exist as endpoints, backend flow incomplete), POST /api/dispatch (1292), POST /api/telegram/intake (1000), WS /ws (1328).
- agentRunner.ts (1721L): dispatchAgent() ~line 368, reconcileStaleRuns() ~204.
- telegram.ts (3305L) sections: types/constants 17–375, doc intake 376–483, settings CRUD 542–676, bridge lifecycle createTelegramBridge() 677–1537, notifications/guardrails 1538–1788, attention alerts 1621–1752, lifecycle/digest 1760–2100+.
- App.tsx screens: Dashboard 1158–1262, Health 1414–1696, Inbox 1840–2105, Queue 2106–2360, Schedule 2375–2472, Graph 2473–2591, Review 2592–2671, App main 2676–end.
- No tests exist. Root scripts: build, smoke (scripts/smoke.mjs, 50+ endpoint checks), launchd helpers, homepc:smoke.
- Live DB issues: 14 queued + 1 needs-input mixed-lane tasks, 3 blocked runs, 33 stale inbox actions.

## Next steps (exact)

1. P0.3 (telegram.ts split) + P0.4 (App.tsx split) dispatched in parallel 2026-07-06 (opus subagents, background). Each verifies own compile only; orchestrator runs full build+smoke after both land, then reviews diffs.
2. Then P0.5 tests/CI, then Phase 1 in order 6→7→8.
3. Review each subagent diff before marking task complete (orchestrator verifies, not trusts).
4. All changes still uncommitted — commit not yet authorized by user.
5. Model policy (user 2026-07-06): opus subagents for complex tasks, sonnet for easy tasks.

## Standing constraints

- Loopback-only; secrets outside git; no hosted/billing/multi-user.
- Strict no-API: block dispatch when API key env vars present.
- Gated: patch apply, commits, pushes, deletes, reserved-model dispatch.
- Dropbox: project support files only — never repos, never global Claude roots.
- Subagents: Opus, medium effort. No behavior change during mechanical splits; smoke must pass after every task.
- If near 80% token limit: update this file with status + next steps, stop.
