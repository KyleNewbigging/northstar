import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { backfillTaskLanes } from './database.js'
import { schemaSql } from './schema.js'

function seedTask(db: DatabaseSync, id: string, projectId: string, source: string, lane = 'dev') {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, source, lane)
     VALUES (?, ?, 'x', 'codex', 'orchestrator', 'queued', 'P2', ?, ?)`,
  ).run(id, projectId, source, lane)
}

describe('backfillTaskLanes', () => {
  it('sets telegram tasks to telegram-intent and non-northstar tasks to personal', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(schemaSql)
    seedTask(db, 'A', 'northstar', 'cockpit')
    seedTask(db, 'B', 'northstar', 'telegram')
    seedTask(db, 'C', 'other', 'cockpit')
    seedTask(db, 'D', 'other', 'telegram')

    backfillTaskLanes(db)

    const rows = (db.prepare('SELECT id, lane FROM tasks ORDER BY id').all() as Array<{ id: string; lane: string }>)
      .map((row) => ({ id: row.id, lane: row.lane }))
    assert.deepEqual(rows, [
      { id: 'A', lane: 'dev' },
      { id: 'B', lane: 'telegram-intent' },
      { id: 'C', lane: 'personal' },
      { id: 'D', lane: 'telegram-intent' },
    ])
  })

  it('skips backfill when any task already has a non-default lane', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(schemaSql)
    seedTask(db, 'A', 'other', 'telegram') // would move to telegram-intent
    seedTask(db, 'B', 'northstar', 'cockpit', 'personal') // pre-existing custom lane

    backfillTaskLanes(db)

    const rows = (db.prepare('SELECT id, lane FROM tasks ORDER BY id').all() as Array<{ id: string; lane: string }>)
      .map((row) => ({ id: row.id, lane: row.lane }))
    assert.deepEqual(rows, [
      { id: 'A', lane: 'dev' },
      { id: 'B', lane: 'personal' },
    ])
  })
})
