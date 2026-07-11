import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { expireStaleItems } from './expiry.js'
import { schemaSql } from './schema.js'

function newDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

describe('expireStaleItems', () => {
  it('marks old unresolved inbox actions as expired and leaves fresh ones alone', () => {
    const db = newDb()
    db.prepare(
      `INSERT INTO inbox_actions (id, project_id, type, model, priority, urgency, title, ctx, created_at)
       VALUES ('old', 'northstar', 'question', 'codex', 'P1', 'high', 'stale', 'ctx', datetime('now','-30 days'))`,
    ).run()
    db.prepare(
      `INSERT INTO inbox_actions (id, project_id, type, model, priority, urgency, title, ctx, created_at)
       VALUES ('new', 'northstar', 'question', 'codex', 'P1', 'high', 'fresh', 'ctx', datetime('now','-1 hours'))`,
    ).run()

    const result = expireStaleItems(db)
    assert.equal(result.inbox, 1)

    const old = db.prepare("SELECT resolution, resolved_at FROM inbox_actions WHERE id = 'old'").get() as any
    const fresh = db.prepare("SELECT resolution, resolved_at FROM inbox_actions WHERE id = 'new'").get() as any
    assert.equal(old.resolution, 'expired')
    assert.ok(old.resolved_at)
    assert.equal(fresh.resolution, null)
    assert.equal(fresh.resolved_at, null)
  })

  it('expires stale queued telegram-intent tasks with the expected stage', () => {
    const db = newDb()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, lane, updated_at, created_at)
       VALUES ('T-OLD', 'northstar', 'stale telegram', 'codex', 'telegram', 'queued', 'P2', 'telegram-intent',
               datetime('now','-30 days'), datetime('now','-30 days'))`,
    ).run()

    const result = expireStaleItems(db)
    assert.equal(result.tasks, 1)
    const row = db.prepare("SELECT status, stage FROM tasks WHERE id = 'T-OLD'").get() as any
    assert.equal(row.status, 'done')
    assert.equal(row.stage, 'expired: stale telegram intent')
  })

  it('leaves stale dev-lane queued tasks untouched', () => {
    const db = newDb()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, lane, updated_at, created_at)
       VALUES ('T-DEV', 'northstar', 'dev queued', 'codex', 'orchestrator', 'queued', 'P2', 'dev',
               datetime('now','-60 days'), datetime('now','-60 days'))`,
    ).run()

    const result = expireStaleItems(db)
    assert.equal(result.tasks, 0)
    const row = db.prepare("SELECT status, stage FROM tasks WHERE id = 'T-DEV'").get() as any
    assert.equal(row.status, 'queued')
    assert.equal(row.stage, 'queued')
  })

  it('expires stale non-telegram needs-input tasks with unanswered stage', () => {
    const db = newDb()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, lane, updated_at, created_at)
       VALUES ('T-NEED', 'northstar', 'ask user', 'codex', 'orchestrator', 'needs-input', 'P1', 'dev',
               datetime('now','-30 days'), datetime('now','-30 days'))`,
    ).run()

    const result = expireStaleItems(db)
    assert.equal(result.tasks, 1)
    const row = db.prepare("SELECT status, stage FROM tasks WHERE id = 'T-NEED'").get() as any
    assert.equal(row.status, 'done')
    assert.equal(row.stage, 'expired: unanswered')
  })

  it('expires old blocked agent runs and leaves fresh blocked runs untouched', () => {
    const db = newDb()
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, status, prompt,
        started_at, updated_at)
       VALUES ('R-OLD', 'T-OLD', 'northstar', 'codex', 'codex', 'run', '/tmp', 'blocked', 'p',
               datetime('now','-60 days'), datetime('now','-60 days'))`,
    ).run()
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, status, prompt,
        started_at, updated_at)
       VALUES ('R-NEW', 'T-NEW', 'northstar', 'codex', 'codex', 'run', '/tmp', 'blocked', 'p',
               datetime('now','-1 hours'), datetime('now','-1 hours'))`,
    ).run()

    const result = expireStaleItems(db)
    assert.equal(result.runs, 1)
    const oldRow = db.prepare("SELECT status FROM agent_runs WHERE id = 'R-OLD'").get() as any
    const freshRow = db.prepare("SELECT status FROM agent_runs WHERE id = 'R-NEW'").get() as any
    assert.equal(oldRow.status, 'done')
    assert.equal(freshRow.status, 'blocked')
  })
})
