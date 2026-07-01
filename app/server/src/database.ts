import { DatabaseSync } from 'node:sqlite'

import { databasePath, ensureRuntimeDirs } from './paths.js'
import { seedSchedulerSettings } from './scheduler.js'
import { schemaSql } from './schema.js'
import { seedTelegramBridgeSettings } from './telegram.js'

let db: DatabaseSync | null = null

export function getDb() {
  if (!db) {
    ensureRuntimeDirs()
    db = new DatabaseSync(databasePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(schemaSql)
    runMigrations(db)
    seedUsage(db)
    seedNorthstarWorkflow(db)
    seedSchedulerSettings(db)
    seedTelegramBridgeSettings(db)
  }
  return db
}

function runMigrations(database: DatabaseSync) {
  database.exec(`
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
  `)
  ensureColumn(database, 'agent_runs', 'worktree_path', 'ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT')
  ensureColumn(database, 'agent_runs', 'transport', "ALTER TABLE agent_runs ADD COLUMN transport TEXT NOT NULL DEFAULT 'spawn'")
  ensureColumn(database, 'agent_runs', 'base_path', 'ALTER TABLE agent_runs ADD COLUMN base_path TEXT')
  ensureColumn(database, 'agent_runs', 'tmux_session', 'ALTER TABLE agent_runs ADD COLUMN tmux_session TEXT')
  ensureColumn(database, 'agent_runs', 'stdout_log_path', 'ALTER TABLE agent_runs ADD COLUMN stdout_log_path TEXT')
  ensureColumn(database, 'agent_runs', 'stderr_log_path', 'ALTER TABLE agent_runs ADD COLUMN stderr_log_path TEXT')
  ensureColumn(database, 'agent_runs', 'exit_status_path', 'ALTER TABLE agent_runs ADD COLUMN exit_status_path TEXT')
  ensureColumn(database, 'agent_runs', 'final_text_path', 'ALTER TABLE agent_runs ADD COLUMN final_text_path TEXT')
  ensureColumn(database, 'agent_runs', 'pid', 'ALTER TABLE agent_runs ADD COLUMN pid INTEGER')
  ensureColumn(database, 'agent_runs', 'updated_at', 'ALTER TABLE agent_runs ADD COLUMN updated_at TEXT')
  ensureColumn(database, 'tasks', 'source', "ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'cockpit'")
  ensureColumn(database, 'tasks', 'source_ref', "ALTER TABLE tasks ADD COLUMN source_ref TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'tasks', 'prompt', "ALTER TABLE tasks ADD COLUMN prompt TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'tasks', 'created_at', 'ALTER TABLE tasks ADD COLUMN created_at TEXT')
  ensureColumn(database, 'tasks', 'updated_at', 'ALTER TABLE tasks ADD COLUMN updated_at TEXT')
  ensureColumn(database, 'tasks', 'completed_at', 'ALTER TABLE tasks ADD COLUMN completed_at TEXT')
  ensureColumn(database, 'tasks', 'dispatch_status', "ALTER TABLE tasks ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'unknown'")
  ensureColumn(database, 'tasks', 'dispatch_blocker', "ALTER TABLE tasks ADD COLUMN dispatch_blocker TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'telegram_bridge_settings', 'notify_important', 'ALTER TABLE telegram_bridge_settings ADD COLUMN notify_important INTEGER NOT NULL DEFAULT 1')
  ensureColumn(database, 'telegram_bridge_settings', 'notify_lifecycle_debug', 'ALTER TABLE telegram_bridge_settings ADD COLUMN notify_lifecycle_debug INTEGER NOT NULL DEFAULT 0')
  ensureColumn(database, 'telegram_bridge_settings', 'notify_run_telemetry_debug', 'ALTER TABLE telegram_bridge_settings ADD COLUMN notify_run_telemetry_debug INTEGER NOT NULL DEFAULT 0')
  ensureColumn(database, 'telegram_bridge_settings', 'notify_digest', 'ALTER TABLE telegram_bridge_settings ADD COLUMN notify_digest INTEGER NOT NULL DEFAULT 1')
  ensureColumn(database, 'telegram_bridge_settings', 'debug_until', 'ALTER TABLE telegram_bridge_settings ADD COLUMN debug_until TEXT')
  ensureColumn(database, 'patches', 'run_id', "ALTER TABLE patches ADD COLUMN run_id TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'patches', 'project_id', "ALTER TABLE patches ADD COLUMN project_id TEXT NOT NULL DEFAULT 'northstar'")
  ensureColumn(database, 'patches', 'base_path', "ALTER TABLE patches ADD COLUMN base_path TEXT NOT NULL DEFAULT ''")
  ensureColumn(database, 'patches', 'files_changed', 'ALTER TABLE patches ADD COLUMN files_changed INTEGER NOT NULL DEFAULT 0')
  ensureColumn(database, 'patches', 'created_at', 'ALTER TABLE patches ADD COLUMN created_at TEXT')
  ensureColumn(database, 'patches', 'updated_at', 'ALTER TABLE patches ADD COLUMN updated_at TEXT')
  database.prepare('UPDATE agent_runs SET updated_at = COALESCE(updated_at, started_at, CURRENT_TIMESTAMP)').run()
  database.prepare('UPDATE tasks SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)').run()
  database.prepare('UPDATE tasks SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)').run()
  database.prepare("UPDATE tasks SET completed_at = COALESCE(completed_at, updated_at, created_at, CURRENT_TIMESTAMP) WHERE status = 'done'").run()
  database.prepare('UPDATE patches SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)').run()
  database.prepare('UPDATE patches SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)').run()
}

function ensureColumn(database: DatabaseSync, table: string, column: string, sql: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((item) => item.name === column)) database.exec(sql)
}

function seedUsage(database: DatabaseSync) {
  database
    .prepare(
      `INSERT OR IGNORE INTO usage (day, tokens_used, tokens_cap, compute_pct, background_slots_free)
       VALUES (date('now'), 1320000, 4000000, 61, 2)`,
    )
    .run()
}

function seedNorthstarWorkflow(database: DatabaseSync) {
  database
    .prepare(
      `INSERT INTO project_settings (project_id, active, autonomous, cadence, updated_at)
       VALUES ('northstar', 1, 1, 'slow', CURRENT_TIMESTAMP)
       ON CONFLICT(project_id) DO UPDATE SET
         active = 1,
         autonomous = 1,
         cadence = 'slow',
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run()

  const tasks = [
    ['NS-MGR-001', 'Northstar manager coordinates the continuous agent loop', 'opus', 'manager', 'running', 'P0', 0.46, 'live', 'routing specialist agents'],
    ['NS-FE-001', 'Frontend agent keeps dashboard, queue, and graph cockpit usable', 'spark', 'frontend', 'queued', 'P1', 0, 'next window', 'watching UI milestones'],
    ['NS-BE-001', 'Backend agent protects local scheduler, SQLite, and guardrails', 'spark', 'backend', 'queued', 'P1', 0, 'next window', 'checking dispatch contracts'],
    ['NS-DSN-001', 'Design agent preserves the deep-space cockpit language', 'opus', 'design', 'needs-input', 'P2', 0.2, 'waiting', 'needs visual review after graph changes'],
    ['NS-GRAPH-001', 'Graph agent maps project and agent communication topology', 'spark', 'graph', 'running', 'P1', 0.62, 'live', 'streaming mesh updates'],
    ['NS-GTM-001', 'Marketing agent captures positioning and release notes when needed', 'spark', 'marketing', 'queued', 'P3', 0, 'later', 'standing by for outward-facing work'],
  ] as const

  const insert = database.prepare(
    `INSERT OR IGNORE INTO tasks (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch)
     VALUES (?, 'northstar', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
  for (const [id, title, model, agent, status, priority, progress, eta, stage] of tasks) {
    insert.run(id, title, model, agent, status, priority, progress, eta, stage, `agent/${agent}-northstar`)
  }
}
