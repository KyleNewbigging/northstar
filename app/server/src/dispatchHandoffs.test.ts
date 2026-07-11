import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { consumeDispatchHandoffs, produceDispatchHandoff } from './dispatchHandoffs.js'
import { schemaSql } from './schema.js'
import { parseDispatchCommand } from './telegram/utils.js'

const originalRoot = process.env.NORTHSTAR_DROPBOX_ROOT
const originalDevice = process.env.NORTHSTAR_DEVICE_ID

function newDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function seedQueuedTask(db: DatabaseSync, id: string, projectId = 'demo-project') {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, prompt, source, source_ref, lane, target_device)
     VALUES (?, ?, 'Do the thing', 'codex', 'orchestrator', 'queued', 'P1', 'run it', 'cockpit', '', 'dev', '')`,
  ).run(id, projectId)
}

describe('dispatchHandoffs', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'northstar-handoff-'))
    process.env.NORTHSTAR_DROPBOX_ROOT = tempRoot
    process.env.NORTHSTAR_DEVICE_ID = 'device-alpha'
  })

  afterEach(() => {
    restoreEnv('NORTHSTAR_DROPBOX_ROOT', originalRoot)
    restoreEnv('NORTHSTAR_DEVICE_ID', originalDevice)
  })

  it('produceDispatchHandoff writes JSON artifact and marks the task', () => {
    const db = newDb()
    seedQueuedTask(db, 'TASK-1')
    const result = produceDispatchHandoff(db, {
      id: 'TASK-1',
      projectId: 'demo-project',
      title: 'Do the thing',
      model: 'codex',
      agent: 'orchestrator',
      priority: 'P1',
      lane: 'dev',
      prompt: 'run it',
    }, 'device-beta')

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(result.artifactRelPath, /^_handoffs\/device-beta\/dispatch-TASK-1-/)
    assert.ok(existsSync(result.artifactPath))
    const parsed = JSON.parse(readFileSync(result.artifactPath, 'utf8'))
    assert.equal(parsed.kind, 'northstar-dispatch')
    assert.equal(parsed.version, 1)
    assert.equal(parsed.taskId, 'TASK-1')
    assert.equal(parsed.projectId, 'demo-project')
    assert.equal(parsed.sourceDevice, 'device-alpha')
    // no absolute paths inside artifact
    assert.ok(!JSON.stringify(parsed).includes(tempRoot))

    const row = db.prepare('SELECT target_device, dispatch_status, stage FROM tasks WHERE id = ?').get('TASK-1') as {
      target_device: string
      dispatch_status: string
      stage: string
    }
    assert.equal(row.target_device, 'device-beta')
    assert.equal(row.dispatch_status, 'remote-device')
    assert.match(row.stage, /handed off to device-beta/)
  })

  it('produceDispatchHandoff rejects empty target device', () => {
    const db = newDb()
    seedQueuedTask(db, 'TASK-2')
    const result = produceDispatchHandoff(db, {
      id: 'TASK-2', projectId: 'demo-project', title: 't', model: 'codex', agent: 'a', priority: 'P2', lane: 'dev', prompt: '',
    }, '')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error, 'target_device_required')
  })

  it('produceDispatchHandoff fails when Dropbox root missing', () => {
    const db = newDb()
    seedQueuedTask(db, 'TASK-3')
    process.env.NORTHSTAR_DROPBOX_ROOT = join(tempRoot, 'does-not-exist')
    const result = produceDispatchHandoff(db, {
      id: 'TASK-3', projectId: 'demo-project', title: 't', model: 'codex', agent: 'a', priority: 'P2', lane: 'dev', prompt: '',
    }, 'device-beta')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error, 'dropbox_root_missing')
  })

  it('consumeDispatchHandoffs intakes JSON artifact into local queue', () => {
    const senderDb = newDb()
    seedQueuedTask(senderDb, 'REMOTE-1')
    process.env.NORTHSTAR_DEVICE_ID = 'device-alpha'
    const produced = produceDispatchHandoff(senderDb, {
      id: 'REMOTE-1', projectId: 'demo-project', title: 'Hi', model: 'codex', agent: 'orchestrator', priority: 'P1', lane: 'dev', prompt: 'go',
    }, 'device-beta')
    assert.equal(produced.ok, true)

    // now switch identity to device-beta and consume
    process.env.NORTHSTAR_DEVICE_ID = 'device-beta'
    const receiver = newDb()
    const result = consumeDispatchHandoffs(receiver, [{ id: 'demo-project' }])
    assert.equal(result.intake, 1)
    assert.equal(result.consumed, 1)
    assert.equal(result.invalid, 0)
    const row = receiver.prepare('SELECT id, project_id, source, source_ref, status, lane FROM tasks WHERE id = ?').get('REMOTE-1') as {
      id: string
      project_id: string
      source: string
      source_ref: string
      status: string
      lane: string
    }
    assert.equal(row.id, 'REMOTE-1')
    assert.equal(row.project_id, 'demo-project')
    assert.equal(row.source, 'handoff')
    assert.equal(row.status, 'queued')
    assert.equal(row.lane, 'dev')
    assert.match(row.source_ref, /^_handoffs\/device-beta\/dispatch-REMOTE-1/)

    // artifact was renamed to .consumed
    const dir = join(tempRoot, '_handoffs', 'device-beta')
    const names = readdirSync(dir)
    assert.equal(names.filter((n) => n.endsWith('.json')).length, 0)
    assert.equal(names.filter((n) => n.endsWith('.consumed')).length, 1)
  })

  it('consumeDispatchHandoffs renames corrupt artifact to .invalid', () => {
    process.env.NORTHSTAR_DEVICE_ID = 'device-beta'
    const dir = join(tempRoot, '_handoffs', 'device-beta')
    mkdirSync(dir, { recursive: true })
    const bad = join(dir, 'dispatch-BAD-x.json')
    writeFileSync(bad, '{ not json')
    const db = newDb()
    const result = consumeDispatchHandoffs(db, [{ id: 'demo-project' }])
    assert.equal(result.invalid, 1)
    assert.equal(result.intake, 0)
    assert.ok(existsSync(`${bad}.invalid`))
    assert.ok(!existsSync(bad))
  })

  it('consumeDispatchHandoffs renames unknown-kind artifact to .invalid', () => {
    process.env.NORTHSTAR_DEVICE_ID = 'device-beta'
    const dir = join(tempRoot, '_handoffs', 'device-beta')
    mkdirSync(dir, { recursive: true })
    const bad = join(dir, 'dispatch-OTHER-y.json')
    writeFileSync(bad, JSON.stringify({ kind: 'something-else', taskId: 'X' }))
    const db = newDb()
    const result = consumeDispatchHandoffs(db, [{ id: 'demo-project' }])
    assert.equal(result.invalid, 1)
    assert.ok(existsSync(`${bad}.invalid`))
  })

  it('consumeDispatchHandoffs leaves unknown-project artifacts in place', () => {
    process.env.NORTHSTAR_DEVICE_ID = 'device-beta'
    const dir = join(tempRoot, '_handoffs', 'device-beta')
    mkdirSync(dir, { recursive: true })
    const artifact = {
      kind: 'northstar-dispatch',
      version: 1,
      taskId: 'ORPHAN-1',
      projectId: 'not-here',
      title: 'x',
      model: 'codex',
      agent: 'a',
      priority: 'P2',
      lane: 'dev',
      prompt: '',
      sourceDevice: 'device-alpha',
      createdAt: new Date().toISOString(),
    }
    const path = join(dir, 'dispatch-ORPHAN-1-z.json')
    writeFileSync(path, JSON.stringify(artifact))
    const db = newDb()
    const result = consumeDispatchHandoffs(db, [{ id: 'demo-project' }])
    assert.equal(result.intake, 0)
    assert.deepEqual(result.skippedUnknownProject, ['not-here'])
    assert.ok(existsSync(path))
    assert.ok(!existsSync(`${path}.consumed`))
    assert.ok(!existsSync(`${path}.invalid`))
  })

  it('consumeDispatchHandoffs skips duplicate taskId but still renames artifact', () => {
    process.env.NORTHSTAR_DEVICE_ID = 'device-beta'
    const dir = join(tempRoot, '_handoffs', 'device-beta')
    mkdirSync(dir, { recursive: true })
    const db = newDb()
    seedQueuedTask(db, 'DUP-1')
    const artifact = {
      kind: 'northstar-dispatch',
      version: 1,
      taskId: 'DUP-1',
      projectId: 'demo-project',
      title: 'x',
      model: 'codex',
      agent: 'a',
      priority: 'P2',
      lane: 'dev',
      prompt: '',
      sourceDevice: 'device-alpha',
      createdAt: new Date().toISOString(),
    }
    const path = join(dir, 'dispatch-DUP-1-z.json')
    writeFileSync(path, JSON.stringify(artifact))
    const result = consumeDispatchHandoffs(db, [{ id: 'demo-project' }])
    assert.equal(result.intake, 0)
    assert.deepEqual(result.skippedDuplicate, ['DUP-1'])
    assert.equal(result.consumed, 1)
    assert.ok(existsSync(`${path}.consumed`))
  })

  it('produce then consume roundtrip on same root works', () => {
    const db = newDb()
    seedQueuedTask(db, 'ROUND-1')
    process.env.NORTHSTAR_DEVICE_ID = 'device-alpha'
    const produced = produceDispatchHandoff(db, {
      id: 'ROUND-1', projectId: 'demo-project', title: 'roundtrip', model: 'codex', agent: 'orchestrator', priority: 'P1', lane: 'dev', prompt: 'go',
    }, 'device-beta')
    assert.equal(produced.ok, true)

    process.env.NORTHSTAR_DEVICE_ID = 'device-beta'
    const receiver = newDb()
    const result = consumeDispatchHandoffs(receiver, [{ id: 'demo-project' }])
    assert.equal(result.intake, 1)
    assert.equal(result.consumed, 1)
    const view = receiver.prepare('SELECT id FROM tasks WHERE id = ?').get('ROUND-1') as { id: string }
    assert.equal(view.id, 'ROUND-1')
  })

  it('consumeDispatchHandoffs is a no-op when handoff dir is missing', () => {
    process.env.NORTHSTAR_DEVICE_ID = 'device-gamma'
    const db = newDb()
    const result = consumeDispatchHandoffs(db, [{ id: 'demo-project' }])
    assert.equal(result.intake, 0)
    assert.equal(result.consumed, 0)
    assert.equal(result.invalid, 0)
  })

  it('parseDispatchCommand extracts @device from telegram argument', () => {
    assert.deepEqual(parseDispatchCommand('TASK-1'), { taskId: 'TASK-1', targetDevice: null })
    assert.deepEqual(parseDispatchCommand('TASK-1 @device-beta'), { taskId: 'TASK-1', targetDevice: 'device-beta' })
    assert.deepEqual(parseDispatchCommand('@device-beta TASK-2'), { taskId: 'TASK-2', targetDevice: 'device-beta' })
    assert.deepEqual(parseDispatchCommand('TASK-3 @device_gamma.01'), { taskId: 'TASK-3', targetDevice: 'device_gamma.01' })
    // sanitizer strips illegal characters
    const dirty = parseDispatchCommand('TASK-4 @device$$$beta!!')
    assert.equal(dirty.taskId, 'TASK-4')
    assert.equal(dirty.targetDevice, 'device-beta-')
  })
})
