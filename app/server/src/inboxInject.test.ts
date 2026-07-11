import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { composeInboxInjection, deliverInboxResolution, sanitizeInjectionText, type TmuxInjectContext } from './inboxInject.js'
import { schemaSql } from './schema.js'

function newDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function seedInbox(db: DatabaseSync, id: string, taskId: string | null, title: string) {
  db.prepare(
    `INSERT INTO inbox_actions (id, project_id, task_id, type, model, priority, urgency, title, ctx)
     VALUES (?, 'p1', ?, 'question', 'codex', 'P1', 'high', ?, 'ctx')`,
  ).run(id, taskId, title)
}

function seedTask(db: DatabaseSync, id: string, status: string, prompt: string) {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, prompt)
     VALUES (?, 'p1', 'test task', 'codex', 'orchestrator', ?, 'P1', ?)`,
  ).run(id, status, prompt)
}

function seedRun(db: DatabaseSync, id: string, taskId: string, transport: string, status: string, tmuxSession: string | null) {
  db.prepare(
    `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, transport, tmux_session, status, prompt)
     VALUES (?, ?, 'p1', 'codex', 'codex', 'run', '/tmp', ?, ?, ?, 'p')`,
  ).run(id, taskId, transport, tmuxSession, status)
}

function tmuxOk(sent: string[]): TmuxInjectContext {
  return {
    resolveExecutable: () => ({ ok: true, executable: '/usr/bin/tmux' }),
    isAlive: () => true,
    sendText: (_exec, session, text) => {
      sent.push(`${session}::${text}`)
      return true
    },
  }
}

const tmuxDead: TmuxInjectContext = {
  resolveExecutable: () => ({ ok: true, executable: '/usr/bin/tmux' }),
  isAlive: () => false,
  sendText: () => false,
}

const tmuxMissing: TmuxInjectContext = {
  resolveExecutable: () => ({ ok: false, error: 'tmux_unavailable' }),
  isAlive: () => false,
  sendText: () => false,
}

describe('sanitizeInjectionText', () => {
  it('collapses whitespace, trims, and caps length', () => {
    assert.equal(sanitizeInjectionText('  hello\n\tworld  \r\n'), 'hello world')
    const long = 'a'.repeat(2500)
    assert.equal(sanitizeInjectionText(long).length, 2000)
  })
})

describe('composeInboxInjection', () => {
  it('prefixes with northstar inbox and includes title', () => {
    const msg = composeInboxInjection('Pick model', 'use codex')
    assert.equal(msg, '[northstar inbox] Pick model: use codex')
  })

  it('handles empty title', () => {
    const msg = composeInboxInjection('', 'yes')
    assert.equal(msg, '[northstar inbox] yes')
  })

  it('sanitizes newlines in title and body', () => {
    const msg = composeInboxInjection('multi\nline', 'answer\n\nmore')
    assert.equal(msg, '[northstar inbox] multi line: answer more')
  })
})

describe('deliverInboxResolution', () => {
  it('returns record-only when action has no task', () => {
    const db = newDb()
    seedInbox(db, 'IA-1', null, 'ask')
    const result = deliverInboxResolution(db, 'IA-1', 'yes', tmuxMissing)
    assert.equal(result.delivery, 'record-only')
  })

  it('returns record-only when task no longer exists', () => {
    const db = newDb()
    seedInbox(db, 'IA-1', 'T-GONE', 'ask')
    const result = deliverInboxResolution(db, 'IA-1', 'yes', tmuxMissing)
    assert.equal(result.delivery, 'record-only')
  })

  it('injects into live tmux run and flips blocked run/task to running', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'blocked', 'original prompt')
    seedRun(db, 'R-1', 'T-1', 'tmux', 'blocked', 'ns-session-1')
    seedInbox(db, 'IA-1', 'T-1', 'Pick model')

    const sent: string[] = []
    const result = deliverInboxResolution(db, 'IA-1', 'use codex', tmuxOk(sent))

    assert.equal(result.delivery, 'injected')
    assert.equal(result.tmuxSession, 'ns-session-1')
    assert.equal(sent.length, 1)
    assert.equal(sent[0], 'ns-session-1::[northstar inbox] Pick model: use codex')

    const runStatus = db.prepare("SELECT status FROM agent_runs WHERE id = 'R-1'").get() as { status: string }
    assert.equal(runStatus.status, 'running')
    const taskStatus = db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get() as { status: string }
    assert.equal(taskStatus.status, 'running')
  })

  it('injects when run is running without changing task status if not needs-input', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'running', 'p')
    seedRun(db, 'R-1', 'T-1', 'tmux', 'running', 'sess')
    seedInbox(db, 'IA-1', 'T-1', 'Q')
    const sent: string[] = []
    const result = deliverInboxResolution(db, 'IA-1', 'A', tmuxOk(sent))
    assert.equal(result.delivery, 'injected')
    const taskStatus = db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get() as { status: string }
    assert.equal(taskStatus.status, 'running')
  })

  it('falls back to requeue when tmux session is dead and task needs-input', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'needs-input', 'original prompt')
    seedRun(db, 'R-1', 'T-1', 'tmux', 'blocked', 'ns-dead')
    seedInbox(db, 'IA-1', 'T-1', 'Q')

    const result = deliverInboxResolution(db, 'IA-1', 'the answer', tmuxDead)
    assert.equal(result.delivery, 'requeued')

    const task = db.prepare("SELECT status, prompt, stage FROM tasks WHERE id = 'T-1'").get() as { status: string; prompt: string; stage: string }
    assert.equal(task.status, 'queued')
    assert.equal(task.stage, 'resolution received: ready for dispatch')
    assert.ok(task.prompt.includes('original prompt'))
    assert.ok(task.prompt.includes('[inbox resolution '))
    assert.ok(task.prompt.includes('the answer'))
  })

  it('falls back to requeue when tmux is unavailable', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'blocked', 'p')
    seedRun(db, 'R-1', 'T-1', 'tmux', 'running', 'sess')
    seedInbox(db, 'IA-1', 'T-1', 'Q')

    const result = deliverInboxResolution(db, 'IA-1', 'answer', tmuxMissing)
    assert.equal(result.delivery, 'requeued')
    assert.match(result.detail, /tmux unavailable/)
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get() as { status: string }
    assert.equal(task.status, 'queued')
  })

  it('falls back to requeue when run transport is spawn and task needs-input', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'needs-input', 'p')
    seedRun(db, 'R-1', 'T-1', 'spawn', 'blocked', null)
    seedInbox(db, 'IA-1', 'T-1', 'Q')

    const result = deliverInboxResolution(db, 'IA-1', 'answer', tmuxOk([]))
    assert.equal(result.delivery, 'requeued')
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get() as { status: string }
    assert.equal(task.status, 'queued')
  })

  it('returns record-only when no live run and task is done', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'done', 'p')
    seedInbox(db, 'IA-1', 'T-1', 'Q')

    const result = deliverInboxResolution(db, 'IA-1', 'answer', tmuxMissing)
    assert.equal(result.delivery, 'record-only')
    const task = db.prepare("SELECT status FROM tasks WHERE id = 'T-1'").get() as { status: string }
    assert.equal(task.status, 'done')
  })

  it('picks the latest run by updated_at', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'blocked', 'p')
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, transport, tmux_session, status, prompt, started_at, updated_at)
       VALUES ('R-OLD', 'T-1', 'p1', 'codex', 'codex', 'run', '/tmp', 'tmux', 'old-sess', 'blocked', 'p', datetime('now','-2 hours'), datetime('now','-2 hours'))`,
    ).run()
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, transport, tmux_session, status, prompt, started_at, updated_at)
       VALUES ('R-NEW', 'T-1', 'p1', 'codex', 'codex', 'run', '/tmp', 'tmux', 'new-sess', 'blocked', 'p', datetime('now','-1 hours'), datetime('now','-1 hours'))`,
    ).run()
    seedInbox(db, 'IA-1', 'T-1', 'Q')

    const sent: string[] = []
    const result = deliverInboxResolution(db, 'IA-1', 'answer', tmuxOk(sent))
    assert.equal(result.delivery, 'injected')
    assert.equal(result.runId, 'R-NEW')
    assert.equal(result.tmuxSession, 'new-sess')
  })
})
