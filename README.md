# Northstar

Northstar is a localhost-first AI project command center for developer work. It is being rebuilt from the Claude Design prototype in `prototype/` into a real React/Vite frontend with a local Fastify/SQLite backend foundation.

## Development

```sh
npm install
npm run dev:server
npm run dev:web
```

The web app runs through Vite at `http://127.0.0.1:5173`. The local API server binds to `127.0.0.1:4317`, scans git repos under `~/dev`, and stores runtime data under `~/.northstar`.

## Build

```sh
npm run build
```

## Smoke Test

```sh
npm run smoke
```

The smoke test verifies the local API, project discovery, GitHub catalog loading, the all-project graph, and a focused project graph. It uses an already-running API server when present, or starts one temporarily.

## Project Skills

Northstar keeps project-specific learned skills out of git under `~/.northstar/skills/<project-id>.md`. Activating a project or dispatching a local agent creates that project's skills file if it does not exist yet. Plan-mode dispatch reads the skills file into the prompt, and explicit `Learning candidate:` lines from an agent run are appended back to that same project file.

When the Dropbox device file bridge is configured, Northstar mirrors the canonical skills file to `Dropbox/projects/<project-id>/skills/northstar-skills.md`. That Dropbox copy is generated/read-only in v1; edits there are not reverse-synced.

## Current Mac Reliability

The first always-on target is the current Mac workspace. Keep both services bound to loopback, keep private runtime files under `~/.northstar`, and let `tmux` preserve spawned CLI runs across browser or server restarts. The heartbeat at `~/.northstar/heartbeat.md` is the local status artifact, and it mirrors to `Dropbox/heartbeat.md` when Dropbox is configured.

For a simple local launch, run the API and Vite in separate terminals:

```sh
npm run dev:server
npm run dev:web
```

Use `NORTHSTAR_HEARTBEAT_MS` to tune heartbeat frequency, `NORTHSTAR_DROPBOX_ROOT` to pin the Dropbox folder, and `NORTHSTAR_DEVICE_ID` to label this Mac in handoffs. Linux systemd and Windows power-recovery automation are intentionally out of scope for this slice.

### Launchd Startup (Optional)

Northstar includes a lightweight macOS setup helper for always-on operation:

```sh
npm run launchd:install
```

The helper installs and bootstraps:

- `local.northstar.server` → `npm run dev:server`
- `local.northstar.web` → `npm run dev:web`

Both run loopback-only on `127.0.0.1` and log to `~/.northstar/logs/launchd/`.

Useful commands:

```sh
npm run launchd:status     # show whether each service is installed and running
npm run launchd:uninstall  # remove launchd entries and stop services
```

Use `--repo` if you run scripts from a different directory:

```sh
node scripts/setup-launchd.mjs --repo /path/to/northstar --status
```

## Stateful Agent Runs

Real agent dispatch requires `tmux` so Codex and Claude runs survive Northstar server or browser restarts. Install it with:

```sh
brew install tmux
```

Northstar resolves `tmux` from `NORTHSTAR_TMUX_BIN` first, then `command -v tmux`. Each run starts a detached session named `northstar-...`, writes private runtime files under `~/.northstar/logs/runs/<run-id>/`, and exposes an attach command such as:

```sh
tmux attach -t northstar-run-example
```

If Northstar restarts, it reconciles running tmux sessions on startup and every few seconds. A live session remains running, a completed session is finalized from `exit.status` and log files, and a missing session without an exit status is marked blocked with the worktree and logs preserved. Northstar does not auto-restart crashed agents.

## Telegram Bridge

Northstar can mirror high-priority Inbox decisions to a private Telegram bot. The bridge is optional, can use either classic Bot API polling or the newer grammY long-poll runner, and does not require exposing localhost or a webhook. Telegram can resolve Inbox items, but it cannot apply patches, commit, push, or bypass reserved-model guardrails.

1. Create a bot with BotFather and place the token outside the repo:

   ```sh
   mkdir -p ~/.northstar/secrets
   printf '%s' '123456:bot-token' > ~/.northstar/secrets/telegram-bot-token
   chmod 600 ~/.northstar/secrets/telegram-bot-token
   ```

2. Start Northstar with your Telegram user ID allowlisted:

   ```sh
   NORTHSTAR_TELEGRAM_ENABLED=1 NORTHSTAR_TELEGRAM_ALLOWED_USER_IDS=123456789 npm run dev:server
   ```

3. Send `/start` to the bot from that allowlisted account, or set `NORTHSTAR_TELEGRAM_CHAT_ID` before launch. Use `/status`, `/heartbeat`, `/inbox`, `/resolve ACTION_ID 1`, `/files`, `/find`, `/file`, `/handoff`, `/handoffs`, `/project`, `/use`, `/sessions`, `/resource`, and `/debug` from Telegram.

To prefer the grammY runner transport (recommended for larger traffic and better concurrency), set:

```sh
NORTHSTAR_TELEGRAM_BRIDGE_IMPL=grammy
```

You can keep classic polling with:

```sh
NORTHSTAR_TELEGRAM_BRIDGE_IMPL=poll
```

After `/use PROJECT [model] [agent]` binds a chat or topic, ordinary non-command Telegram messages are treated as Codex worktree requests by default. If model and agent are omitted, Northstar stores the route as `codex orchestrator`; override that route label with `NORTHSTAR_TELEGRAM_DEFAULT_MODEL` and `NORTHSTAR_TELEGRAM_DEFAULT_AGENT`. The execution model defaults to Codex and can be changed with `NORTHSTAR_TELEGRAM_AUTOMATION_MODEL=codex|spark|opus`. Live Telegram messages queue the task and immediately try to start the local worktree run. The diagnostic `/api/telegram/intake` endpoint queues without dispatch unless `autoDispatch: true` is passed. Polaris still stops for missing project sessions, no local checkout, auth/guardrail failures, loop-guard limits, blocked runs, and final review.

### Telegram Lane Protocol

Northstar keeps two lane names for operational separation:

- `personal`: short-lived planning, coordination, and safe one-off tasks.
- `orchestrator`: longer coding work with stricter review and queue visibility.

Lane selection currently follows:

- explicit `agent` value first when it is `personal` or `orchestrator`;
- otherwise defaults by model (`spark` => `personal`, `opus`/`codex` => `orchestrator`).

`/use PROJECT spark personal` and `/use PROJECT codex orchestrator` are common starts.

If the pair is unusual (for example `model=spark` + `agent=orchestrator`), Northstar still records the request but attaches a lane mismatch warning to the prompt context so you can correct it before dispatch.

Northstar currently supports voice notes and document attachments for Telegram prompts:

- Text formats (`.txt`, `.md`, `.json`, `.csv`, source files, and similar) and PDFs.
- PDF extraction uses `pdftotext` when installed (`NORTHSTAR_PDF_TO_TEXT_COMMAND` to override the binary).
- Document safeguards are enforced before queueing:
  - `NORTHSTAR_TELEGRAM_MAX_DOCUMENT_BYTES` (default `20000000`)
  - `NORTHSTAR_TELEGRAM_MAX_DOCUMENT_PROMPT_CHARS` (default `150000`)

Scanned image-only PDFs require pasting extracted text manually because OCR is not built into Northstar's Telegram media intake yet.

Polaris defaults to quiet Telegram notifications. Normal mode sends P0/P1 Inbox decisions, blocked or failed runs, final summaries for Telegram-started runs, and consolidated digests instead of one message per lifecycle transition. Pull commands such as `/status`, `/overview`, `/next`, `/task`, `/inbox`, and `/heartbeat` remain available whenever you want detail.

Verbose lifecycle and live run telemetry are debugging tools, not the default. Enable them temporarily from Telegram:

```sh
/debug on 30m
/debug off
```

While debug mode is active, Northstar streams live run telemetry for running tasks back to Telegram. Telegram receives incremental `stdout`/`stderr` updates (up to a capped chunk size) plus attach-command context. To keep debug noise controlled, updates follow the configured interval and include deltas only. Optional overrides:

```sh
NORTHSTAR_TELEGRAM_RUN_TELEMETRY_MS=15000      # minimum interval between repeated run stream messages
NORTHSTAR_TELEGRAM_RUN_TELEMETRY_CHARS=1200    # per-stream snippet size cap (characters)
```

If a chat/topic has no matching session, Northstar requires `/use` first and returns session instructions plus known routes for that chat before capture.

The local API exposes `/api/telegram/status`, `/api/telegram/settings`, `/api/telegram/test`, `/api/telegram/poll`, and `/api/telegram/intake` for cockpit controls and diagnostics.

For high-signal external routing (the PushCut lane), set:

```sh
NORTHSTAR_ATTENTION_WEBHOOK_URL="https://api.pushcut.io/..."
NORTHSTAR_ATTENTION_WEBHOOK_TOKEN="optional"
NORTHSTAR_ATTENTION_WEBHOOK_SOURCE="northstar"
NORTHSTAR_ATTENTION_MIN_PRIORITY="P1"   # optional, defaults to all priorities
NORTHSTAR_ATTENTION_RETRY_MAX="8"       # optional, per alert retry attempts
NORTHSTAR_ATTENTION_FLUSH_INTERVAL_MS="60000" # optional
```

Those alerts are written to a durable queue first (`attention_alerts`), then flushed by webhook. You can inspect and manually flush this queue with:

- `/api/attention-alerts` (diagnostic readback)
- `/api/attention-alerts/flush` (force retry flush)

Alert rows follow a small state model:

- `pending`: queued for delivery but not yet attempted.
- `failed`: delivery failed and will retry after backoff if a retry window is available.
- `sent`: successfully delivered at least once.

Each row also tracks `attempts` and `nextRetryAt`:

- `attempts` increments on every webhook call attempt.
- `nextRetryAt` is set when a retry is scheduled after transient failures.
- `lastError` stores the latest webhook error text for troubleshooting.

If `nextRetryAt` is non-null and in the past, Northstar will retry on the next flush window. If it is in the future, delivery is currently waiting on backoff.

If the webhook URL is absent, attention queueing is disabled and no alerts are emitted.

### 24/7 Attention Operations

Before relying on Telegram plus the attention lane unattended, run this from the current Mac:

```sh
npm run build
npm run smoke
npm run startup:check -- --once --json --max-attention-pending 0 --max-attention-failed 0
npm run homepc:smoke -- --mode online --strict --endpoint http://127.0.0.1:4317
```

Use `/api/attention-alerts` when the startup check reports pending or failed alert pressure:

- `pending` with `attempts=0`: queued but not flushed yet; run `/api/attention-alerts/flush` or wait for the next flush interval.
- `failed` with future `nextRetryAt`: webhook delivery failed and is waiting on backoff.
- `failed` with past or empty `nextRetryAt`: retry now with `/api/attention-alerts/flush`.
- repeated `lastError` values: check `NORTHSTAR_ATTENTION_WEBHOOK_URL`, token, network access, and PushCut/webhook-side rate limits.

Keep `NORTHSTAR_ATTENTION_MIN_PRIORITY="P1"` for daily use if the lane feels noisy. Temporarily lower or unset it only while testing lower-priority alerts. If smoke/test rows ever appear in the live attention queue with keys starting `smoke-` or `test-smoke-`, they are test residue and should be deleted before treating backlog counts as operational signal.

Joey Hundert's June 14, 2026 architecture email is the source of truth for the Telegram workflow direction: Telegram message, allowlist auth, per-chat/topic sequentialization, project/session routing, local Claude/agent execution from a working directory with `CLAUDE.md`, streaming status back, and durable audit/session files.

Joey's June 16, 2026 clarification separates his Dell personal-agent setup from the Mac Studio "granny" corporate code orchestrator. Northstar should use the Dell guidance for personal-agent reliability, but Zebra/corporate work should aim at the bigger orchestration shape: many project-specific agents, communication protocols, routing, audit trails, and review-gated codebase coordination.

The Codex thread "Refactor Northstar workflow" is the companion source of truth for Northstar-specific workflow decisions: remote-control cockpit, direct Dropbox-root support files, tmux-backed agent durability, PushCut-style attention alerts, Telegram-safe action boundaries, and Markdown/vector memory. Its later direct Dropbox-root clarification supersedes earlier `CloudHub`/`ClaudeHub` wrapper wording.

## Heartbeat

Northstar continuously writes `~/.northstar/heartbeat.md` as the shared status artifact for the remote-control cockpit. It includes the current device, Dropbox status, active/autonomous project counts, queue pressure, live runs, inbox items, recent runs, and reattach commands when available.

When the device file bridge is configured, Northstar mirrors the same file to `Dropbox/heartbeat.md` so other devices can reference the current cockpit state. The default refresh interval is 30 seconds and can be changed with:

```sh
NORTHSTAR_HEARTBEAT_MS=15000 npm run dev:server
```

Use `/heartbeat` from Telegram or `GET /api/heartbeat` locally to force a fresh heartbeat write.

For quick startup/readiness checks on the current Mac, run:

```sh
npm run startup:check
npm run startup:watch   # keeps checking every 30s while you need confirmation
npm run startup:check -- --max-blocked 3 --max-needs-input 8 --max-queued 150
```

`startup:check` validates loopback bind readiness, runtime directory, tmux availability, Telegram bridge visibility, heartbeat freshness, queue pressure (blocked / needs-input / queued), launchd service state (optional), and optional live gateway checks.
You can also include attention backlog thresholds:

```sh
npm run startup:check -- --max-attention-pending 120 --max-attention-failed 5
```

For 24/7 local all-systems-green confidence, combine both checks:

```sh
npm run startup:check -- --strict   # fail on any warning for immediate red status
npm run startup:watch -- --strict --interval-ms 30000   # continuous strict monitoring
```

If the tunnel is live from another machine, use:

```sh
npm run startup:check -- --endpoint http://127.0.0.1:4317 --strict --json
```

For unattended alerting, run a local watchdog check:

```sh
npm run heartbeat:check
npm run heartbeat:watch  # continuous polling (disabled notifications by default)
```

Optional Telegram alerting:

```sh
NORTHSTAR_TELEGRAM_CHAT_ID=123456789 node scripts/heartbeat-watchdog.mjs --notify --max-age-ms 90000
```

### Companion-Device Notes

For a home-PC companion that you already reach privately from the current Mac, keep the Cockpit on macOS as the source of truth and only expose it through a secure tunnel (for example SSH local port-forward). Example:

```sh
ssh -N -L 4317:127.0.0.1:4317 -L 5173:127.0.0.1:5173 you@home-mac.local
```

Then from the home PC:

- API base: `http://127.0.0.1:4317`
- Web UI: `http://127.0.0.1:5173`

Use shared `Dropbox/heartbeat.md` as a read-only operational mirror when the tunnel is down.

Use this smoke command on the companion to validate access patterns before broader use:

```sh
# With live tunnel + local endpoint
npm run homepc:smoke -- --mode online --strict --endpoint http://127.0.0.1:4317

# When you only have mirror access
npm run homepc:smoke -- --mode offline --strict --mirror-path /path/to/Dropbox/heartbeat.md

# If Northstar is temporarily unavailable, force failover validation to mirror path
npm run homepc:smoke -- --mode online --strict --allow-failover --mirror-path /path/to/Dropbox/heartbeat.md
```

`--mirror-path` accepts either the full heartbeat file path or a Dropbox root directory.

## Device File Bridge

Northstar can treat a local Dropbox folder as the device-to-device file sharing layer for machines on your network. This is for referencing, previewing, and handing off project-adjacent agent files between devices; git still owns code history, branches, worktrees, patch review, and explicit publish or PR flows.

Configure the local Dropbox root per machine:

```sh
NORTHSTAR_DROPBOX_ROOT="$HOME/Dropbox" NORTHSTAR_DEVICE_ID=macbook npm run dev:server
```

If `NORTHSTAR_DROPBOX_ROOT` is not set, Northstar looks for common Dropbox locations under the current user's home folder. All commands use relative paths inside the Dropbox root and block traversal or symlink escapes.

Dropbox root layout:

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

Do not clone repos into Dropbox. Local coding agents can keep using normal machine-local checkouts, and GitHub remains the code sync layer. Dropbox is for session handoffs, implementation notes, skills, reusable resources, and project-scoped agent memory. Northstar should not touch global Claude/agent roots that contain auth state, central rules, or JSON logs.

Telegram file commands:

- `/files [path]` lists a Dropbox folder.
- `/find query` searches Dropbox filenames and relative paths.
- `/file path` previews small text, Markdown, QMD, JSON, YAML, CSV, TSV, and log files.
- `/handoff DEVICE path [note]` writes a Markdown handoff under `Dropbox/_handoffs/<DEVICE>/`.
- `/handoffs [DEVICE]` lists handoffs for the current or named device.
- `/project PROJECT` creates or shows `Dropbox/projects/<PROJECT>/`.
- `/use PROJECT [model] [agent]` routes the current chat/topic to a project workspace.
- `/sessions` lists registered Telegram project-session routes.
- Use `orchestrator` for high-value coding/longer-running work (`codex orchestrator`) and `personal` for short life-admin / planning work (`spark personal`).
- `/resource PROJECT title :: content` saves a Markdown resource in `Dropbox/projects/<PROJECT>/resources/`.

The local API exposes `/api/device-files/status`, `/api/device-files/list`, `/api/device-files/search`, `/api/device-files/preview`, `/api/device-files/handoffs`, `/api/telegram/sessions`, and Dropbox project workspace/resource endpoints for the same workflow.

## GitHub Catalog

Local repos are discovered from `~/dev`. GitHub-only projects are loaded from `~/.northstar/github-repos.json` or the comma-separated `NORTHSTAR_GITHUB_REPOS` environment variable. This keeps private project inventory out of git while still letting the dashboard show GitHub projects that are not cloned locally.

## Reference Prototype

`prototype/SPEC.md` and the files in `prototype/` are the visual and interaction source of truth. Production code lives under `app/web` and `app/server`.
