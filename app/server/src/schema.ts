export const schemaSql = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  lang TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'idle',
  label TEXT NOT NULL DEFAULT 'personal',
  health REAL NOT NULL DEFAULT 0,
  coverage REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  budget INTEGER NOT NULL DEFAULT 0,
  runtime TEXT NOT NULL DEFAULT '-',
  last_event TEXT NOT NULL DEFAULT '',
  last_ago TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  eta TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'queued',
  files INTEGER NOT NULL DEFAULT 0,
  branch TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS inbox_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  model TEXT NOT NULL,
  priority TEXT NOT NULL,
  urgency TEXT NOT NULL,
  title TEXT NOT NULL,
  ctx TEXT NOT NULL,
  options_json TEXT,
  recommend INTEGER,
  help TEXT,
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  tokens_cap INTEGER NOT NULL DEFAULT 0,
  compute_pct INTEGER NOT NULL DEFAULT 0,
  background_slots_free INTEGER NOT NULL DEFAULT 0
);
`
