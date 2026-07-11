import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { approvePatch, buildApprovalCommitMessage, buildResumePrompt, resumeAgentInWorktree } from './agentRunner.js'
import { schemaSql } from './schema.js'

function newDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function seedTask(db: DatabaseSync, id: string, title: string, status = 'blocked') {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, prompt)
     VALUES (?, 'p1', ?, 'spark', 'agent', ?, 'P1', 'p')`,
  ).run(id, title, status)
}

function seedPatch(db: DatabaseSync, taskId: string, basePath: string, worktree: string) {
  db.prepare(
    `INSERT INTO patches
      (task_id, run_id, project_id, base_path, branch, base, worktree, summary, additions, deletions, files_changed, checks_json, files_json, diff_json, rationale_json, risks_json)
     VALUES (?, 'RUN-1', 'p1', ?, 'agent/x', 'abc', ?, 'sum', 1, 0, 1, '[]', '[]', '[]', '[]', '[]')`,
  ).run(taskId, basePath, worktree)
}

function seedRun(db: DatabaseSync, id: string, taskId: string, worktreePath: string, basePath: string) {
  db.prepare(
    `INSERT INTO agent_runs
      (id, task_id, project_id, model, provider, command, cwd, worktree_path, transport, base_path, tmux_session, status, prompt, stdout, stderr, final_text)
     VALUES (?, ?, 'p1', 'spark', 'codex-cli', 'run', ?, ?, 'tmux', ?, 'sess', 'blocked', 'p', '', '', '')`,
  ).run(id, taskId, worktreePath, worktreePath, basePath)
}

describe('buildApprovalCommitMessage', () => {
  it('includes task id and title body', () => {
    const msg = buildApprovalCommitMessage('T-1', 'Fix dashboard header spacing')
    assert.equal(msg, 'Apply T-1 patch via Northstar review\n\nFix dashboard header spacing\n')
  })

  it('omits body block when title is empty', () => {
    const msg = buildApprovalCommitMessage('T-2', '')
    assert.equal(msg, 'Apply T-2 patch via Northstar review\n')
  })

  it('collapses whitespace in title', () => {
    const msg = buildApprovalCommitMessage('T-3', '  multi\nline   title  ')
    assert.equal(msg, 'Apply T-3 patch via Northstar review\n\nmulti line title\n')
  })
})

describe('buildResumePrompt', () => {
  it('includes task id, title, notes verbatim, and worktree path', () => {
    const prompt = buildResumePrompt({
      taskId: 'T-1',
      taskTitle: 'Refactor login',
      notes: 'Please rename foo to bar.',
      worktreePath: '/tmp/worktree/t-1',
    })
    assert.match(prompt, /resuming your reviewed patch for task T-1 \(Refactor login\)/)
    assert.match(prompt, /\/tmp\/worktree\/t-1/)
    assert.match(prompt, /Amend your prior work in place; do not start over\./)
    assert.match(prompt, /Please rename foo to bar\./)
  })

  it('falls back to task id when title missing and notes placeholder when empty', () => {
    const prompt = buildResumePrompt({ taskId: 'T-9', taskTitle: '', notes: '', worktreePath: '/tmp/w' })
    assert.match(prompt, /task T-9 \(T-9\)/)
    assert.match(prompt, /\(no additional notes provided\)/)
  })

  it('preserves newlines and content in reviewer notes verbatim', () => {
    const notes = 'line one\nline two\n- bullet'
    const prompt = buildResumePrompt({ taskId: 'T-2', taskTitle: 'x', notes, worktreePath: '/w' })
    assert.ok(prompt.includes(notes))
  })
})

describe('approvePatch missing patch', () => {
  it('returns patch_not_found when no patch row exists for task', () => {
    const db = newDb()
    const result = approvePatch(db, 'T-MISSING')
    assert.equal(result.ok, false)
    if (result.ok === false) assert.equal(result.error, 'patch_not_found')
  })
})

describe('resumeAgentInWorktree missing patch', () => {
  it('returns patch_not_found when no patch or run exists', () => {
    const db = newDb()
    const result = resumeAgentInWorktree(db, [], 'T-MISSING', 'notes')
    assert.equal(result.ok, false)
    if (result.ok === false) assert.equal(result.error, 'patch_not_found')
  })

  it('returns worktree_missing when patch points to a non-existent worktree path', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'title')
    seedPatch(db, 'T-1', '/base/nope', '/tmp/does-not-exist-northstar-test-xyz')
    const result = resumeAgentInWorktree(db, [], 'T-1', 'notes')
    assert.equal(result.ok, false)
    if (result.ok === false) assert.equal(result.error, 'worktree_missing')
  })

  it('falls back to agent_runs row when no patch row exists', () => {
    const db = newDb()
    seedTask(db, 'T-RUN', 'title')
    seedRun(db, 'R-1', 'T-RUN', '/tmp/does-not-exist-northstar-test-2', '/base')
    const result = resumeAgentInWorktree(db, [], 'T-RUN', 'notes')
    // worktree does not exist so we should still get worktree_missing (proving we found the run row)
    assert.equal(result.ok, false)
    if (result.ok === false) assert.equal(result.error, 'worktree_missing')
  })

  it('does not mark task running when it fails early with patch_not_found', () => {
    const db = newDb()
    seedTask(db, 'T-1', 'title', 'blocked')
    const result = resumeAgentInWorktree(db, [], 'T-1', 'notes')
    assert.equal(result.ok, false)
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('T-1') as { status: string }
    assert.equal(row.status, 'blocked')
  })
})
