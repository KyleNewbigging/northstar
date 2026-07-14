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

CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  autonomous INTEGER NOT NULL DEFAULT 0,
  cadence TEXT NOT NULL DEFAULT 'slow',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  branch TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'cockpit',
  source_ref TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  dispatch_status TEXT NOT NULL DEFAULT 'unknown',
  dispatch_blocker TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT 'dev',
  target_device TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  worktree_path TEXT,
  transport TEXT NOT NULL DEFAULT 'spawn',
  base_path TEXT,
  tmux_session TEXT,
  stdout_log_path TEXT,
  stderr_log_path TEXT,
  exit_status_path TEXT,
  final_text_path TEXT,
  pid INTEGER,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT,
  final_text TEXT,
  exit_code INTEGER,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS patches (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  base_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  worktree TEXT NOT NULL,
  summary TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  checks_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  rationale_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  tokens_cap INTEGER NOT NULL DEFAULT 0,
  compute_pct INTEGER NOT NULL DEFAULT 0,
  background_slots_free INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scheduler_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  start_time TEXT NOT NULL DEFAULT '22:30',
  end_time TEXT NOT NULL DEFAULT '06:30',
  weekday_reserve_pct INTEGER NOT NULL DEFAULT 35,
  max_parallel_runs INTEGER NOT NULL DEFAULT 2,
  spark_enabled INTEGER NOT NULL DEFAULT 1,
  opus_enabled INTEGER NOT NULL DEFAULT 1,
  codex_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_onboarding (
  project_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  goals_json TEXT NOT NULL,
  queue_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS health_profile (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'garmin',
  connected INTEGER NOT NULL DEFAULT 0,
  last_sync TEXT NOT NULL DEFAULT 'No health sync yet',
  weight REAL NOT NULL DEFAULT 182,
  maintenance_calories INTEGER NOT NULL DEFAULT 2640,
  goal_id TEXT NOT NULL DEFAULT 'triathlon-base',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS health_daily_metrics (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_date TEXT NOT NULL,
  resting_hr REAL,
  sleep_hours REAL,
  active_calories INTEGER,
  training_minutes INTEGER,
  readiness REAL,
  raw_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_date)
);

CREATE TABLE IF NOT EXISTS health_activities (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_activity_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  distance_m REAL,
  calories REAL,
  avg_hr REAL,
  max_hr REAL,
  raw_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_activity_id)
);

CREATE TABLE IF NOT EXISTS health_sync_sources (
  source TEXT PRIMARY KEY,
  connected INTEGER NOT NULL DEFAULT 0,
  auth_state TEXT NOT NULL DEFAULT 'missing_config',
  last_sync_started_at TEXT,
  last_success_at TEXT,
  cursor TEXT,
  last_error TEXT,
  retry_at TEXT,
  config_json TEXT,
  token_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_bridge_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT NOT NULL DEFAULT '',
  allowed_user_ids_json TEXT NOT NULL DEFAULT '[]',
  notify_inbox INTEGER NOT NULL DEFAULT 1,
  notify_run_results INTEGER NOT NULL DEFAULT 1,
  notify_important INTEGER NOT NULL DEFAULT 1,
  notify_lifecycle_debug INTEGER NOT NULL DEFAULT 0,
  notify_run_telemetry_debug INTEGER NOT NULL DEFAULT 0,
  notify_digest INTEGER NOT NULL DEFAULT 1,
  debug_until TEXT,
  notify_scheduler INTEGER NOT NULL DEFAULT 0,
  notify_priorities_json TEXT NOT NULL DEFAULT '["P0","P1","P2"]',
  last_update_id INTEGER,
  last_seen_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_delivery_log (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  telegram_message_id INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_type, event_key, chat_id)
);

CREATE TABLE IF NOT EXISTS attention_alerts (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_type, event_key)
);

CREATE INDEX IF NOT EXISTS idx_attention_alerts_pending
  ON attention_alerts (status, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT 'main',
  project TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'opus',
  agent TEXT NOT NULL DEFAULT 'telegram',
  cwd TEXT NOT NULL DEFAULT '',
  session_key TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(chat_id, thread_id)
);

CREATE TABLE IF NOT EXISTS device_file_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  device_id TEXT NOT NULL,
  target_device TEXT,
  source_relpath TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  charter TEXT NOT NULL DEFAULT '',
  contract TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT 'spark',
  project_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_domain ON agents (domain);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  detail TEXT,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_subject ON audit_log (subject);
`
