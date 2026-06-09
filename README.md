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

## GitHub Catalog

Local repos are discovered from `~/dev`. GitHub-only projects are loaded from `~/.northstar/github-repos.json` or the comma-separated `NORTHSTAR_GITHUB_REPOS` environment variable. This keeps private project inventory out of git while still letting the dashboard show GitHub projects that are not cloned locally.

## Reference Prototype

`prototype/SPEC.md` and the files in `prototype/` are the visual and interaction source of truth. Production code lives under `app/web` and `app/server`.
