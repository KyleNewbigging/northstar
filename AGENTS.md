# Northstar Agent Guide

Northstar is being rebuilt from the Claude Design prototype in `prototype/`.

## Source Of Truth

- Treat `prototype/SPEC.md` and the files under `prototype/` as the visual and interaction reference.
- Do not edit files under `prototype/` unless the user explicitly asks to update the reference prototype.
- Implement production code under `app/web` and `app/server`.
- Preserve the deep-space cockpit theme: mono-forward type, dense operational UI, amber `#ffb454` as the single north-star signal color.

## Milestone Workflow

- Build milestone by milestone: M1 Dashboard, M2 Mission Inbox, M3 Agent Queue, M4 Graph Cockpit, M5 Patch Review, M6 local agent execution.
- After each screen milestone, compare against the matching `prototype/*.jsx` and screenshots in `prototype/screenshots/`.
- Keep empty, loading, and error states even when the prototype only shows happy paths.
- Maintain keyboard access and roughly 44px hit targets for primary controls.

## Runtime Rules

- Everything is localhost-first. Bind development services to loopback.
- Private runtime data belongs under `~/.northstar`, never in the repo.
- SQLite is the source of truth for the local server. Realtime channels only push deltas.
- Never add billing, payments, hosted SaaS assumptions, or cloud defaults.

## Agent Execution Contract

- An agent run is one queued task, one git worktree, and one spawned local CLI process.
- Codex runs use the local `codex` CLI with ChatGPT authentication.
- Claude runs use the local `claude` CLI with `claude.ai` authentication.
- Spark means Codex Spark (`gpt-5.3-codex-spark`), not an Ollama or LM Studio endpoint.
- GPT-5.5 is a reserved/manual Codex model until Northstar has usage data proving it is safe to spend.
- Strict no-API mode is required before any real agent process is spawned.

## Graphify

- The Graph Cockpit should read `graphify-out/graph.json` from each project when available.
- Community colors must be deterministic across reloads.
- Mock graph data is acceptable only until the graphify reader is wired.

## Safety

- Do not rely on `OPENAI_API_KEY`, `CODEX_API_KEY`, or `ANTHROPIC_API_KEY`.
- Before real dispatch, verify `codex login status` reports ChatGPT auth and `claude auth status` reports `claude.ai`.
- Strip API key environment variables from spawned child processes.
- Agents create branches/worktrees and patches; they do not push or commit without explicit user approval.
