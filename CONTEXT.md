# Northstar Implementation Context

This file captures decisions that the prototype intentionally hand-waved.

## Agent Runs

An agent run is represented by:

- `tasks` row in SQLite.
- One isolated git worktree under `~/.northstar/worktrees/<project-id>/<task-id>`.
- One spawned local coding-agent process.
- Streamed stdout/stderr converted into telemetry events and persisted run logs.

Provider mapping:

- `opus`: `claude -p --output-format stream-json --model opus --permission-mode auto`.
- `codex`: `codex exec --json --model gpt-5.5 --sandbox workspace-write`.
- `spark`: `codex exec --json --model gpt-5.3-codex-spark --sandbox workspace-write`.

V1 dispatch may create queued tasks without spawning real agents until M6. The API and database should keep the same contract.

## Queue And Concurrency

Default slots:

- Total background agents: 2.
- Manual foreground agent: 1.
- P0 and `needs-input` items sort first, followed by P1-P3.
- Weekday daytime runs require manual dispatch; autonomous runs default to nights and weekends in `America/Toronto`.

Prototype text such as `4 / 6 slots · 2 local` is visual telemetry, not a locked capacity rule.

## Git And Patch Flow

- Branches use `agent/<task-id>-<slug>`.
- Worktrees live outside the repo under `~/.northstar/worktrees`.
- Agents edit only their task worktree.
- Patch Review shows the diff from base branch to task branch.
- Approve means merge/squash is prepared for the user, but no push happens in v1.
- Request changes keeps the worktree and appends review notes to the task so the same agent can resume later.

## Clarifying Questions

Agents pause by writing an inbox action:

```ts
type InboxQuestion = {
  type: "question" | "blocked" | "suggest";
  taskId: string;
  projectId: string;
  title: string;
  ctx: string;
  options: string[];
  recommend?: number;
  help?: string;
};
```

`POST /api/inbox/:id/resolve` persists the answer and emits a realtime `inbox.resolved` event. In M6 it also resumes the original run with the answer.

## Telemetry

Until provider usage APIs are available, HUD usage is Northstar's own meter:

- Tokens are parsed from Codex/Claude JSON streams when present.
- Compute percent is a local queue pressure estimate.
- Local slots are derived from configured concurrency and active runs.
- Provider limit warnings in logs should surface as high-priority inbox items.

## Graphify

Graph source path is `<project-root>/graphify-out/graph.json`.

Expected graph data should be normalized into:

- nodes with id, label, community, kind, degree, hot/agent flags.
- edges with from, to, and confidence `ext | inf | amb`.
- communities with deterministic color assignments.

If the graph file is missing, show an empty state with a refresh/index action instead of falling back silently forever.

## Long-Term Project Direction

Northstar should become a local-first agent cockpit that can keep work moving across machines, survive restarts, notify the user through chat, and preserve useful memory without turning the system into a hosted suite.

- Source of truth: Joey Hundert's June 14, 2026 email, "How I Built My AI Command Centre - Full Architecture Guide", defines the target architecture for Telegram-powered Claude/agent sessions, Dropbox support files, working-directory personalities, sequentialized message handling, and durable services.
- Source of truth: Joey's June 16, 2026 clarification says the Dell agent answers describe his personal assistant lane, while his Mac Studio "granny" corporate code orchestrator is a much deeper system for keeping many code agents, approaches, and communication protocols organized. Northstar should use the Dell pattern for reliability and personal-agent ergonomics, but the Zebra/corporate target is the higher-order orchestrator pattern.
- Source of truth: Codex thread "Refactor Northstar workflow" captures the user's Northstar-specific clarifications: remote-control cockpit, Tailscale-style device awareness, tmux-backed runs, direct Dropbox-root support files, Telegram commands/actions, PushCut attention lane, Markdown/vector memory, QMD search, and densification tournament. If older transcript turns mention `CloudHub` or `ClaudeHub`, treat those as superseded; the final Northstar rule is direct Dropbox root.
- Operating lanes: maintain a personal agent lane for life admin, light project help, and safe Telegram conversation, and a Zebra/corporate orchestrator lane for many project-specific coding agents, explicit protocol routing, audit trails, and review-gated implementation.
- Zebra target: model Zebra as the first corporate-grade orchestrator use case. It needs an agent/domain registry, per-agent communication contracts, project/session routing, queue ownership, and protocol/audit visibility before it needs more raw autonomy.
- Workflow model: Northstar is the remote-control cockpit for local/network agents. Use Tailscale-style device awareness to know which user machines are online, then schedule agent work onto available devices and keep projects progressing autonomously or on request.
- Heartbeat: continuously maintain `heartbeat.md` as the shared cockpit status artifact for agents, Telegram, and devices. It should show key updates, live runs, blocked items, device state, and the smallest useful next decisions.
- Run durability: agent execution should be stateful and hard to kill by default. Use tmux-backed runs so Northstar can restart while agents keep running, logs remain inspectable, and operators can reattach with `tmux attach`.
- Notifications: surface agent updates, blocked questions, review requests, and important status changes through a Telegram bridge, not only the browser UI.
- Notification lanes: Telegram is the command/conversation surface. PushCut should be considered the durable fast attention lane for significant updates across devices. Native Claude app push can be used for deep-linking into a specific session when it is reliable, but should not be the only critical alert path.
- Command workflow: the target loop is that the user sends a Telegram message, Northstar interprets the request, performs an allowed local/network action, and replies with status, artifacts, questions, or review links.
- Telegram bridge: use `linuz90/claude-telegram-bot` as the reference base for rich Claude-over-Telegram behavior, but adapt its patterns into Northstar rather than copying its app shape.
- Telegram library: prefer `grammy` plus `@grammyjs/runner` for the Windows 24/7 bot lane because it is TypeScript-native, long-polling friendly, and already fits the linuz90 base.
- First Telegram tasks: extract command/session patterns from linuz90, preserve per-chat/topic sequentialization, replace direct Bot API polling with a `grammy` bridge, store chat/session state in SQLite, and run the bot as a durable service with explicit allowlisted users.
- Agent chat: generate Telegram-style Markdown chats for agent-to-agent coordination when agents need asynchronous handoff, status exchange, or user-visible audit trails.
- File UX: prefer Dropbox-style file management over Google Drive-style file management: progressive disclosure, compact lists, clear local folders, and small revealed details instead of broad document-suite assumptions.
- File flow: Dropbox root is the session/project support layer, not the repo mirror. Git repos stay in normal machine-local clone folders and sync through GitHub; Dropbox stores project-adjacent agent files under `projects/<repo>` such as `CLAUDE.md`, `AGENTS.md`, `.claude`, `implementation.md`, skills, resources, session handoffs, and Telegram bot support files.
- Dropbox boundaries: never move or edit global Claude/agent roots that contain rules, auth state, or JSON logs. Only project-scoped support files belong in Dropbox. Repos should not carry large resources unless they are explicit source assets; save supporting resources into the Dropbox project folder instead.
- Memory stack: prefer native `CLAUDE.md` project memory first, then QMD Markdown search, then slower per-agent session search only when needed.
- Search: treat QMD as the fast tuned Markdown-line search service for reference and memory content when it is available.
- Vector memory: represent all chats as Markdown that can be vectorized for semantic retrieval while preserving original chronology for audit and replay.
- Memory quality: explore a densification tournament for long-term memory so memories compete on usefulness, compression, freshness, contradiction rate, and replay value.
- Model lanes: use Sonnet as the default lightweight subagent lane when delegated reasoning is useful; investigate DeepSeek Flash v4 as a possible fast/cheap lane.
- Interaction style: treat 4.6-class model behavior as more psychology/interaction-sensitive; prompts, reviews, and agent handoffs should account for user trust and emotional context.
- Blast radius: model blast radius with container-based isolation, then scale review depth to the size and risk of that blast radius.
- Memory hygiene: keep reference docs compact enough for agents to scan quickly; target roughly 245 lines or less unless the user asks for a fuller archive.

## Security

- Bind local services to `127.0.0.1`.
- Store secrets in OS auth stores or local untracked config, never in git.
- Do not add hosted deployment, billing, payment, or multi-user workspace features.
- Strict no-API means block dispatch when API key env vars are present.
