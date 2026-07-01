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

## Continuation Loop Guard

- On model switches, resumes, or vague "continue" goals, inspect current state first: `git status`, the live SQLite queue, and the newest relevant handoff note. Do not replay the whole prior thread unless current evidence is missing.
- If multiple same-day `NORTHSTAR_SCAN_*` or handoff files repeat the same remaining queue IDs, read the newest concise file plus live queue state, then stop scanning. Treat repeated scan files as a loop signal.
- Do not create a new scan or handoff markdown file unless there is new implementation, a new decision, or materially changed queue state. Prefer updating the newest existing handoff when a note is still needed.
- Before adding any queue task, query `~/.northstar/northstar.sqlite` for existing IDs and similar titles. Merge, supersede, or update duplicates instead of creating another continuation task.
- Do not rerun build/smoke/startup checks in a loop after no code or runtime state has changed. One verification pass is enough unless a new edit or failure requires another pass.
- If two consecutive continuation passes find the same remaining work and make no implementation progress, stop and report the stable next task IDs to the user instead of continuing recursively.
- Treat model switching as context transfer, not as evidence that prior work failed. A new model should verify current state, then either implement the next concrete task or stop with a concise handoff.
- The newest user request wins over an older persistent goal. If the user asks for an audit or loop-prevention pass, do that directly and do not let an older broad "continue" objective keep expanding scope.

## Thread Naming

- When renaming Codex chats, use `Title: task summary`.
- Keep the title before the colon short and stable. Put the concrete task, decision, or automation target after the colon.
- For delegated/background agent chats, include the branch or workflow in the title and the review/build/patch task after the colon.

## Agent Execution Contract

- An agent run is one queued task, one git worktree, and one spawned local CLI process.
- Codex runs use the local `codex` CLI with ChatGPT authentication.
- Claude runs use the local `claude` CLI with `claude.ai` authentication.
- Spark means Codex Spark (`gpt-5.3-codex-spark`), not an Ollama or LM Studio endpoint.
- GPT-5.5 is a reserved/manual Codex model until Northstar has usage data proving it is safe to spend.
- Strict no-API mode is required before any real agent process is spawned.
- Inbox output should teach, not merely report. Every agent-facing summary should briefly explain what was done, why that approach was chosen, what the user can learn from it, and the smallest useful next decision when input is needed.

## Graphify

- The Graph Cockpit should read `graphify-out/graph.json` from each project when available.
- Community colors must be deterministic across reloads.
- Mock graph data is acceptable only until the graphify reader is wired.

## Safety

- Do not rely on `OPENAI_API_KEY`, `CODEX_API_KEY`, or `ANTHROPIC_API_KEY`.
- Before real dispatch, verify `codex login status` reports ChatGPT auth and `claude auth status` reports `claude.ai`.
- Strip API key environment variables from spawned child processes.
- Agents create branches/worktrees and patches; they do not push or commit without explicit user approval.
