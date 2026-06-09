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
    seedUsage(db)
  }
  return db
}

function seedUsage(database: DatabaseSync) {
  database
    .prepare(
      `INSERT OR IGNORE INTO usage (day, tokens_used, tokens_cap, compute_pct, background_slots_free)
       VALUES (date('now'), 1320000, 4000000, 61, 2)`,
    )
    .run()
}
