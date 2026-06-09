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

## Security

- Bind local services to `127.0.0.1`.
- Store secrets in OS auth stores or local untracked config, never in git.
- Do not add cloud deployment, billing, payment, or multi-user workspace features.
- Strict no-API means block dispatch when API key env vars are present.
