import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { schemaSql } from './schema.js'
import {
  buildTranscriptFilename,
  composeRunTranscript,
  writeRunTranscript,
  type TranscriptData,
} from './sessionTranscripts.js'

function baseData(overrides: Partial<TranscriptData> = {}): TranscriptData {
  return {
    runId: 'run-abcdef123456',
    taskId: 'T-001',
    taskTitle: 'Improve retries',
    projectId: 'p1',
    projectName: 'northstar',
    model: 'codex',
    status: 'done',
    startedAt: '2026-07-02T14:15:00Z',
    completedAt: '2026-07-02T14:20:00Z',
    updatedAt: '2026-07-02T14:20:01Z',
    tmuxSession: 'ns-session',
    worktreePath: '/tmp/worktree',
    branch: 'agent/foo',
    exitCode: 0,
    prompt: 'do the thing',
    finalText: 'did the thing',
    checks: [],
    patch: null,
    logTail: '',
    ...overrides,
  }
}

describe('buildTranscriptFilename', () => {
  it('uses YYYY-MM-DD date, task id, and first 8 chars of run id', () => {
    const name = buildTranscriptFilename('2026-07-02T14:15:00Z', 'T-001', 'abcdef1234567890')
    assert.equal(name, '2026-07-02-T-001-abcdef12.md')
  })

  it('sanitizes task ids that contain filesystem-hostile characters', () => {
    const name = buildTranscriptFilename('2026-07-02T00:00:00Z', 'weird/task id..!', 'abcdef12')
    assert.match(name, /^2026-07-02-weird-task-id-abcdef12\.md$/)
  })

  it('falls back to today when startedAt is empty', () => {
    const name = buildTranscriptFilename('', 'T-2', 'abcdef12')
    assert.match(name, /^\d{4}-\d{2}-\d{2}-T-2-abcdef12\.md$/)
  })

  it('handles short run ids without crashing', () => {
    const name = buildTranscriptFilename('2026-01-01T00:00:00Z', 'T', 'ab')
    assert.equal(name, '2026-01-01-T-ab.md')
  })
})

describe('composeRunTranscript', () => {
  it('renders header with task id and title', () => {
    const out = composeRunTranscript(baseData())
    assert.match(out, /^# Session T-001 — Improve retries/)
  })

  it('includes metadata list with run id and status', () => {
    const out = composeRunTranscript(baseData())
    assert.match(out, /- Run ID: run-abcdef123456/)
    assert.match(out, /- Status: done/)
    assert.match(out, /- Exit code: 0/)
  })

  it('omits sections that have no content', () => {
    const out = composeRunTranscript(baseData({ prompt: '', finalText: '', checks: [], patch: null, logTail: '' }))
    assert.doesNotMatch(out, /## Prompt/)
    assert.doesNotMatch(out, /## Output/)
    assert.doesNotMatch(out, /## Verification/)
    assert.doesNotMatch(out, /## Patch/)
    assert.doesNotMatch(out, /## Log tail/)
  })

  it('renders verification checks with states and details', () => {
    const out = composeRunTranscript(
      baseData({
        checks: [
          { name: 'npm test', state: 'pass', ms: 1200 },
          { name: 'npm run lint', state: 'fail', ms: 800, detail: 'unused var foo' },
        ],
      }),
    )
    assert.match(out, /## Verification/)
    assert.match(out, /\[pass\] npm test \(1200ms\)/)
    assert.match(out, /\[fail\] npm run lint \(800ms\) — unused var foo/)
  })

  it('renders patch section with files list', () => {
    const out = composeRunTranscript(
      baseData({
        patch: {
          summary: 'refactored retries',
          filesChanged: 2,
          additions: 30,
          deletions: 10,
          files: [
            { path: 'a.ts', add: 20, del: 5, status: 'mod' },
            { path: 'b.ts', add: 10, del: 5, status: 'new' },
          ],
        },
      }),
    )
    assert.match(out, /## Patch/)
    assert.match(out, /refactored retries/)
    assert.match(out, /- Files changed: 2/)
    assert.match(out, /- Additions: \+30/)
    assert.match(out, /- a\.ts \[mod\] \(\+20 \/ -5\)/)
  })

  it('caps total file size around 256KB', () => {
    const huge = 'x'.repeat(400 * 1024)
    const out = composeRunTranscript(baseData({ finalText: huge, prompt: huge }))
    assert.ok(Buffer.byteLength(out, 'utf8') <= 256 * 1024, `size was ${Buffer.byteLength(out, 'utf8')}`)
    assert.match(out, /transcript truncated/)
  })

  it('truncates a very large section but keeps other sections rendered', () => {
    const huge = 'y'.repeat(80 * 1024)
    const out = composeRunTranscript(baseData({ finalText: huge, prompt: 'short prompt' }))
    assert.match(out, /short prompt/)
    assert.match(out, /## Output/)
  })

  it('renders log tail inside a code fence', () => {
    const out = composeRunTranscript(baseData({ logTail: 'line 1\nline 2' }))
    assert.match(out, /## Log tail/)
    assert.match(out, /```\nline 1\nline 2\n```/)
  })
})

describe('writeRunTranscript', () => {
  const originalRoot = process.env.NORTHSTAR_DROPBOX_ROOT
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'northstar-transcript-'))
    process.env.NORTHSTAR_DROPBOX_ROOT = tempRoot
  })

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.NORTHSTAR_DROPBOX_ROOT
    else process.env.NORTHSTAR_DROPBOX_ROOT = originalRoot
  })

  function newDb() {
    const db = new DatabaseSync(':memory:')
    db.exec(schemaSql)
    return db
  }

  function seed(db: DatabaseSync, runId: string, taskId: string, projectId: string) {
    db.prepare(
      `INSERT INTO projects (id, name, path, branch, lang, status, label, health, coverage, tokens, budget, runtime, last_event, last_ago)
       VALUES (?, ?, '/tmp/p', 'main', 'ts', 'ready', 'personal', 0, 0, 0, 0, 'tmux', 'seeded', 'now')`,
    ).run(projectId, 'northstar')
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, prompt, branch)
       VALUES (?, ?, 'Improve retries', 'codex', 'orchestrator', 'done', 'P1', 'do the thing', 'agent/foo')`,
    ).run(taskId, projectId)
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, worktree_path, transport,
        tmux_session, stdout_log_path, status, prompt, final_text, stderr, exit_code, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'codex', 'codex-cli', 'run cmd', '/tmp/wt', '/tmp/wt', 'tmux',
        'ns-session', ?, 'done', 'do the thing', 'did the thing', '', 0,
        '2026-07-02T14:15:00Z', '2026-07-02T14:20:00Z', '2026-07-02T14:20:01Z')`,
    ).run(runId, taskId, projectId, join(tempRoot, 'no-such.log'))
  }

  it('returns dropbox_unavailable when the root does not exist', () => {
    process.env.NORTHSTAR_DROPBOX_ROOT = join(tempRoot, 'missing-root')
    const db = newDb()
    seed(db, 'run-abcdef123456', 'T-001', 'p1')
    const result = writeRunTranscript(db, { runId: 'run-abcdef123456' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'dropbox_unavailable')
  })

  it('returns run_not_found when the run does not exist', () => {
    const db = newDb()
    const result = writeRunTranscript(db, { runId: 'missing' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'run_not_found')
  })

  it('writes a transcript file into projects/<id>/sessions/', () => {
    const db = newDb()
    seed(db, 'run-abcdef123456', 'T-001', 'p1')
    const result = writeRunTranscript(db, { runId: 'run-abcdef123456' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.relPath, 'projects/p1/sessions/2026-07-02-T-001-run-abcd.md')
    const contents = readFileSync(result.path, 'utf8')
    assert.match(contents, /# Session T-001 — Improve retries/)
    assert.match(contents, /- Model: codex/)
    assert.match(contents, /do the thing/)
    assert.match(contents, /did the thing/)
  })

  it('is idempotent when called twice for the same runId', () => {
    const db = newDb()
    seed(db, 'run-abcdef123456', 'T-001', 'p1')
    const first = writeRunTranscript(db, { runId: 'run-abcdef123456' })
    const second = writeRunTranscript(db, { runId: 'run-abcdef123456' })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (first.ok && second.ok) assert.equal(first.path, second.path)
  })

  it('includes the log tail when the stdout log file exists', () => {
    const db = newDb()
    const projectDir = join(tempRoot, 'logs')
    mkdirSync(projectDir, { recursive: true })
    const logPath = join(projectDir, 'run.log')
    writeFileSync(logPath, 'first line\nsecond line\nthird line\n')
    db.prepare(
      `INSERT INTO projects (id, name, path, branch, lang, status, label, health, coverage, tokens, budget, runtime, last_event, last_ago)
       VALUES ('p1', 'northstar', '/tmp/p', 'main', 'ts', 'ready', 'personal', 0, 0, 0, 0, 'tmux', 'seeded', 'now')`,
    ).run()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, prompt, branch)
       VALUES ('T-1', 'p1', 'Log tail', 'codex', 'orchestrator', 'done', 'P1', 'p', 'agent/x')`,
    ).run()
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, worktree_path, transport,
        tmux_session, stdout_log_path, status, prompt, final_text, stderr, exit_code, started_at)
       VALUES ('run-log-01', 'T-1', 'p1', 'codex', 'codex-cli', 'x', '/tmp', '/tmp', 'tmux',
        'sess', ?, 'done', 'p', 'f', '', 0, '2026-07-02T00:00:00Z')`,
    ).run(logPath)

    const result = writeRunTranscript(db, { runId: 'run-log-01' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const contents = readFileSync(result.path, 'utf8')
    assert.match(contents, /## Log tail/)
    assert.match(contents, /third line/)
  })
})
