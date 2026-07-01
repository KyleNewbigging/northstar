# Northstar Goals

Source of truth: Joey Hundert email, "How I Built My AI Command Centre - Full Architecture Guide", received June 14, 2026.

Additional source of truth: Codex thread "Refactor Northstar workflow", which captures Northstar-specific workflow clarifications and supersedes older `CloudHub`/`ClaudeHub` wrapper ideas with the direct Dropbox-root layout below.

## Target Workflow

Northstar should become a Telegram-powered remote-control cockpit for local Claude/Codex agents. A user sends a Telegram message, Northstar authenticates and sequentializes the request, routes it to the right project/session, lets the local agent operate from the correct working directory and `CLAUDE.md`, streams useful status back, and writes durable audit/session artifacts to Dropbox.

## Architecture Goals

- Telegram is the live command and conversation surface.
- Each Telegram chat or topic can map to a distinct project session with its own working directory, model, agent role, and `CLAUDE.md` context.
- Session routing must be sequentialized per chat/topic so overlapping messages cannot corrupt agent state.
- Dropbox root is the shared support layer between machines, with project support files under `projects/<repo>/`.
- GitHub remains the code sync layer; repos stay in normal machine-local clone folders.
- Agent runs must be durable with tmux-backed execution, persisted logs, and reattach commands.
- Northstar should support multiple bot personalities over time: admin, project gateway, cheap quick-task lane, workspace lane.
- Skills should remain modular Markdown-driven capabilities rather than hardcoded one-off integrations.
- Notifications should distinguish attention alerts from deep links: Telegram for command loop, PushCut for durable alerts, native Claude/app push for session deep-linking when reliable.

## Dropbox Root Layout

```text
Dropbox/
  heartbeat.md
  _handoffs/<device>/
  projects/<repo>/
    CLAUDE.md
    AGENTS.md
    implementation.md
    .claude/
    handoffs/
    resources/
    sessions/
    skills/
```

## Current Implementation Goals

- Keep `/status`, `/heartbeat`, `/files`, `/find`, `/file`, `/handoff`, `/handoffs`, `/project`, `/resource`, `/use`, and `/sessions` available from Telegram.
- Keep the local HTTP API equivalent for cockpit and automation use.
- Treat `/use PROJECT [model] [agent]` as the first project-session routing primitive.
- Treat `/project PROJECT` as the Dropbox project workspace initializer.
- Treat `/resource PROJECT title :: content` as the safe path for saving generated support resources outside git.
- Keep risky operations gated: patch apply, commits, pushes, deletes, and reserved model dispatch.

## Current Implementation Status

- Telegram routing, per-chat/topic sequentialization, review-gated free-text intake, grammY transport, and `/use` session binding are implemented.
- Local agent execution now has a tmux-backed runner with persisted logs, reattach commands, startup reconciliation, and live Telegram run telemetry.
- Telegram media intake supports voice, text documents, and PDFs with size/type/prompt safeguards. Image/OCR intake is still out of scope for this slice.
- Current-Mac reliability is implemented through loopback-only startup checks, launchd helpers, heartbeat writing, watchdog checks, and Home-PC companion smoke checks.
- Dropbox project support files and generated skill mirrors are implemented as one-way Northstar-managed artifacts.
- PushCut-style attention alerts have a durable queue, diagnostic API, manual flush endpoint, retry/backoff behavior, and smoke coverage.

## Next Steps

1. Clean queue hygiene before adding new autonomy: keep queue pressure meaningful and improve operator visibility for queued/running/blocked work.
2. Build the next queue/agent observability lane: clearer queue filters, stale-task handling, run state explanations, and operator-friendly retry/review actions.
3. Future capability lanes after stability: image/OCR Telegram intake, Windows/Linux service templates, and richer multi-bot personalities.
