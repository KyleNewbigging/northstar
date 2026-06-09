import { DatabaseSync } from 'node:sqlite'

import { databasePath, ensureRuntimeDirs } from './paths.js'
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
  }
  return db
}

function runMigrations(database: DatabaseSync) {
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
