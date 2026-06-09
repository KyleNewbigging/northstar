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

## Reference Prototype

`prototype/SPEC.md` and the files in `prototype/` are the visual and interaction source of truth. Production code lives under `app/web` and `app/server`.
