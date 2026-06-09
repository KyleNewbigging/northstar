# Northstar — Implementation Spec (for Codex)

> Local AI **project command center**. This repo contains a high-fidelity HTML/React
> prototype under `/prototype`. It is the **visual + interaction source of truth**.
> Build the real product in the target stack below, matching the prototype 1:1.

---

## 1. Target stack

| Layer | Choice |
|---|---|
| Frontend | React + **Vite** + **TypeScript** |
| Styling | Tailwind + **shadcn/ui** (tokens in §4) |
| Graph | **React Flow** (Graph Cockpit) |
| State/data | TanStack Query + Zustand (light) |
| Backend | local **Node + Fastify** |
| DB | **SQLite** (better-sqlite3 or Drizzle) |
| Realtime | WebSocket (agent status / telemetry stream) |
| Voice | Web Speech API for the mic command bar |

Everything runs **locally**. No billing caps — surface **usage limits** in the HUD only.

---

## 2. App shell

Persistent across every screen (see `prototype/shell.jsx`, `layout.css`):

- **Left rail** — nav: Dashboard · Inbox (badge = open items) · Agent Queue · Graph Cockpit · Patch Review · Settings.
- **Top HUD** — breadcrumb title + live usage meters (tokens/day, compute, local Spark slots) + agents-in-flight + clock.
- **Bottom command bar** — mic (Web Speech), project-scope chip, free-text "direct an agent" input, **model selector** (Claude Opus / Codex 5.5 / Spark), Dispatch. Hotkeys: ⌘K palette, ⌘↵ dispatch.

---

## 3. Screens (build order)

**M1 — Dashboard** (`dashboard.jsx`): fleet stat tiles + project cards (health ring, sparkline, status, token-budget meter, work/personal label). Layout variants cards/list/mosaic. Telemetry stream feed. Clicking a project → Inbox filtered to it.

**M2 — Mission Inbox** (`inbox.jsx`): unified, priority-sorted action list across all projects. Master→detail. Top item flagged NEXT, auto-selected; resolving clears it and advances. Item types: `question | review | blocked | suggest`. Each decision shows agent **recommendation** ("Need help deciding?"). Filters: type tabs, work/personal, per-project chip.

**M3 — Agent Queue** (`queue.jsx`): live execution queue (running/queued/blocked/needs-input) with progress, ETA, worktree branch, model, stage. "What to work on next" highlight. Clarifying inbox side-panel.

**M4 — Graph Cockpit** (`graph.jsx`): React Flow knowledge graph (graphify-style) — communities (colored clusters), god-nodes sized by degree, confidence-tagged edges (extracted/inferred/ambiguous), agent-activity pulse on hot nodes, search, click→inspector. Layouts: constellation / dag / swimlane.

**M5 — Patch Review** (`review.jsx`): worktree-isolated diff (split/unified/stacked), changed-file list, CI checks, agent rationale + risk assessment, approve&merge / request-changes.

---

## 4. Design tokens (from `prototype/styles.css`)

Mono-forward, deep-space cockpit. **Amber `#ffb454` = the single "north star" signal color.**

```css
/* surfaces (oklch, cool blue-black) */
--void:#0c0f16  --bg:#10131b  --panel:#161a23  --panel-2:#1b2029  --panel-3:#222732
--line:#333a47  /* hairline */
/* text */ --ink:#f0f1f3  --ink-2:#aab0bb  --ink-3:#7c828f  --ink-4:#565c68
/* signal */ --star:#ffb454 (amber)  --cyan:#7fd5ff (telemetry)
/* status */ ok #5fe3b0  warn amber  err #f0766a  idle gray
/* graph community hues */ amber / cyan / violet / green / coral / indigo
/* radii */ 3 / 5 / 7 / 10px   /* rail 60px, hud 52px, cmdbar 66px */
```

Fonts: **JetBrains Mono** (all data/labels/IDs/code) + **Geist** sans (prose).
Motifs: HUD corner-brackets on panels, faint starfield + grid wash, amber glow on active.
Themes: deep-space (default) / observatory / carbon — see `prototype/themes.css`.

---

## 5. Data models (TypeScript — derived from `prototype/data.js`)

```ts
type Status = "running" | "needs-input" | "queued" | "blocked" | "done" | "idle";
type Label  = "work" | "personal";
type ModelId = "opus" | "codex" | "spark";

interface Project {
  id: string; name: string; path: string; branch: string; lang: string;
  status: Status; label: Label; health: number; agentsActive: number;
  openTasks: number; queued: number; coverage: number;
  tokens: number; budget: number; runtime: string;
  nodes: number; communities: number; lastEvent: string; lastAgo: string;
  spark: number[];
}

interface QueueTask {
  id: string; title: string; project: string; model: ModelId; agent: string;
  status: Status; progress: number; priority: "P0"|"P1"|"P2"|"P3";
  eta: string; stage: string; files: number; branch: string;
}

interface InboxAction {
  id: string; type: "question"|"review"|"blocked"|"suggest";
  project: string; task: string | null; model: ModelId;
  priority: "P0"|"P1"|"P2"|"P3"; ago: string; urgency: "high"|"med"|"low";
  title: string; ctx: string;
  options?: string[]; recommend?: number; help?: string;   // question/blocked/suggest
  add?: number; del?: number; files?: number; opensReview?: boolean; // review
}

interface GraphNode { id: string; c: number; deg: number;
  kind: "god"|"file"|"fn"; agent?: boolean; hot?: boolean; }
type GraphEdge = [from: string, to: string, conf: "ext"|"inf"|"amb"];
interface Community { id: number; name: string; color: string; }

interface Patch {
  task: string; title: string; project: string; model: ModelId;
  branch: string; base: string; worktree: string; summary: string;
  additions: number; deletions: number; filesChanged: number;
  checks: { name: string; state: "pass"|"running"|"fail"; ms: number; detail?: string }[];
  files: { path: string; add: number; del: number; status: "new"|"mod"|"del-partial" }[];
  diff: DiffLine[]; rationale: string[]; risks: { level: "low"|"med"|"high"; text: string }[];
}
```

---

## 6. Suggested SQLite schema

```sql
projects(id PK, name, path, branch, lang, status, label, health, coverage,
         tokens, budget, runtime, last_event, last_ago, created_at);
agents(id PK, project_id FK, name, model, status);
tasks(id PK, project_id FK, title, model, agent, status, priority, progress,
      eta, stage, files, branch, created_at);
inbox_actions(id PK, project_id FK, task_id FK NULL, type, model, priority,
              urgency, title, ctx, options JSON, recommend INT, help TEXT,
              resolved_at, resolution);
patches(id PK, task_id FK, branch, base, worktree, summary, additions,
        deletions, checks JSON, files JSON, diff JSON, rationale JSON, risks JSON);
graph_nodes(id, project_id FK, community INT, kind, degree, agent, hot);
graph_edges(project_id FK, from_id, to_id, confidence);
usage(day DATE, tokens_used, tokens_cap, compute_pct, local_slots_free);
```

---

## 7. Suggested Fastify API

```
GET  /api/projects                     list + telemetry
GET  /api/projects/:id                 detail
GET  /api/inbox?project&label&type     unified action list (priority-sorted)
POST /api/inbox/:id/resolve            { choice } → mark resolved, resume agent
GET  /api/queue                        live tasks
POST /api/queue/:id/pause | /resume
GET  /api/graph/:project               { nodes, edges, communities }
GET  /api/patches/:task                diff + rationale + checks
POST /api/patches/:task/approve        merge worktree → base
POST /api/patches/:task/request-changes { notes }
POST /api/dispatch                     { text, model, project } → spawn agent
WS   /ws                               agent status, telemetry, usage updates
GET  /api/usage                        HUD meters
```

Graph data should come from the project's `graphify-out/graph.json` (communities,
god-nodes, confidence-tagged edges) — see graphify. Overlay agent activity onto nodes.

---

## 8. Acceptance = matches the prototype

For each screen, open the matching `prototype/*.jsx` + screenshot and match layout,
density, states, and interactions. Keep the amber-on-deep-space cockpit aesthetic and
the mono-forward type. Don't introduce new colors outside §4.
