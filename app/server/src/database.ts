import { DatabaseSync } from 'node:sqlite'

import { databasePath, ensureRuntimeDirs } from './paths.js'
import { seedSchedulerSettings } from './scheduler.js'
import { schemaSql } from './schema.js'

let db: DatabaseSync | null = null

export function getDb() {
  if (!db) {
    ensureRuntimeDirs()
    db = new DatabaseSync(databasePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(schemaSql)
    runMigrations(db)
    seedUsage(db)
    seedSchedulerSettings(db)
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
      codex_enabled INTEGER NOT NULL DEFAULT 0,
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
  `)
  ensureColumn(database, 'agent_runs', 'worktree_path', 'ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT')
  ensureColumn(database, 'agent_runs', 'pid', 'ALTER TABLE agent_runs ADD COLUMN pid INTEGER')
  ensureColumn(database, 'agent_runs', 'updated_at', 'ALTER TABLE agent_runs ADD COLUMN updated_at TEXT')
  database.prepare('UPDATE agent_runs SET updated_at = COALESCE(updated_at, started_at, CURRENT_TIMESTAMP)').run()
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
