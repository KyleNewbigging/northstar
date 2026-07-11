import type { DatabaseSync } from 'node:sqlite'

export type InboxInjectionDelivery = 'injected' | 'requeued' | 'record-only'

export type InboxInjectionResult = {
  delivery: InboxInjectionDelivery
  detail: string
  runId?: string
  taskId?: string
  tmuxSession?: string
}

export type TmuxInjectContext = {
  resolveExecutable: () => { ok: true; executable: string } | { ok: false; error: string }
  isAlive: (executable: string, session: string) => boolean
  sendText: (executable: string, session: string, text: string) => boolean
}

type LatestRunRow = {
  id: string
  transport: string | null
  status: string
  tmuxSession: string | null
}

type TaskRow = {
  id: string
  status: string
  prompt: string | null
}

type InboxRow = {
  taskId: string | null
  title: string
}

const maxInjectionChars = 2000

export function sanitizeInjectionText(value: string) {
  const collapsed = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= maxInjectionChars) return collapsed
  return collapsed.slice(0, maxInjectionChars)
}

export function composeInboxInjection(title: string, resolution: string) {
  const cleanTitle = sanitizeInjectionText(title)
  const cleanResolution = sanitizeInjectionText(resolution)
  const prefix = '[northstar inbox]'
  const composed = cleanTitle ? `${prefix} ${cleanTitle}: ${cleanResolution}` : `${prefix} ${cleanResolution}`
  return sanitizeInjectionText(composed)
}

function readInboxRow(db: DatabaseSync, actionId: string): InboxRow | null {
  const row = db
    .prepare('SELECT task_id AS taskId, title FROM inbox_actions WHERE id = ?')
    .get(actionId) as { taskId?: string | null; title?: string | null } | undefined
  if (!row) return null
  return { taskId: row.taskId ?? null, title: row.title ?? '' }
}

function readTaskRow(db: DatabaseSync, taskId: string): TaskRow | null {
  const row = db
    .prepare('SELECT id, status, prompt FROM tasks WHERE id = ?')
    .get(taskId) as { id?: string; status?: string; prompt?: string | null } | undefined
  if (!row || !row.id || !row.status) return null
  return { id: row.id, status: row.status, prompt: row.prompt ?? '' }
}

function readLatestRunForTask(db: DatabaseSync, taskId: string): LatestRunRow | null {
  const row = db
    .prepare(
      `SELECT id, transport, tmux_session AS tmuxSession, status
       FROM agent_runs
       WHERE task_id = ?
       ORDER BY COALESCE(updated_at, started_at) DESC, started_at DESC
       LIMIT 1`,
    )
    .get(taskId) as { id?: string; transport?: string | null; tmuxSession?: string | null; status?: string } | undefined
  if (!row || !row.id || !row.status) return null
  return { id: row.id, transport: row.transport ?? null, tmuxSession: row.tmuxSession ?? null, status: row.status }
}

function requeueTaskWithResolution(db: DatabaseSync, task: TaskRow, resolutionText: string) {
  const cleaned = sanitizeInjectionText(resolutionText)
  const date = new Date().toISOString().slice(0, 10)
  const appended = `${task.prompt ?? ''}\n\n[inbox resolution ${date}] ${cleaned}`.trim()
  db.prepare(
    `UPDATE tasks
     SET status = 'queued',
       prompt = ?,
       eta = 'next window',
       stage = 'resolution received: ready for dispatch',
       updated_at = CURRENT_TIMESTAMP,
       completed_at = NULL
     WHERE id = ?`,
  ).run(appended, task.id)
}

function markRunRunning(db: DatabaseSync, runId: string) {
  db.prepare(
    `UPDATE agent_runs
     SET status = 'running', updated_at = CURRENT_TIMESTAMP, completed_at = NULL
     WHERE id = ? AND status = 'blocked'`,
  ).run(runId)
}

function markTaskRunning(db: DatabaseSync, taskId: string) {
  db.prepare(
    `UPDATE tasks
     SET status = 'running',
       eta = 'in progress',
       stage = 'resolution injected via tmux',
       updated_at = CURRENT_TIMESTAMP,
       completed_at = NULL
     WHERE id = ?`,
  ).run(taskId)
}

export function deliverInboxResolution(
  db: DatabaseSync,
  actionId: string,
  resolutionText: string,
  tmux: TmuxInjectContext,
): InboxInjectionResult {
  const inbox = readInboxRow(db, actionId)
  if (!inbox || !inbox.taskId) return { delivery: 'record-only', detail: 'action has no linked task' }

  const task = readTaskRow(db, inbox.taskId)
  if (!task) return { delivery: 'record-only', detail: 'linked task no longer exists' }

  const run = readLatestRunForTask(db, inbox.taskId)
  const injectionMessage = composeInboxInjection(inbox.title, resolutionText)

  const canConsiderTmux = run && run.transport === 'tmux' && run.tmuxSession && (run.status === 'running' || run.status === 'blocked')
  if (canConsiderTmux) {
    const exec = tmux.resolveExecutable()
    if (!exec.ok) {
      requeueTaskWithResolution(db, task, resolutionText)
      return { delivery: 'requeued', detail: `tmux unavailable: ${exec.error}`, taskId: task.id, runId: run!.id }
    }
    const session = run!.tmuxSession as string
    if (!tmux.isAlive(exec.executable, session)) {
      requeueTaskWithResolution(db, task, resolutionText)
      return { delivery: 'requeued', detail: `tmux session ${session} is not alive`, taskId: task.id, runId: run!.id, tmuxSession: session }
    }
    const sent = tmux.sendText(exec.executable, session, injectionMessage)
    if (!sent) {
      requeueTaskWithResolution(db, task, resolutionText)
      return { delivery: 'requeued', detail: `failed to send-keys into tmux session ${session}`, taskId: task.id, runId: run!.id, tmuxSession: session }
    }
    if (run!.status === 'blocked') markRunRunning(db, run!.id)
    if (task.status === 'needs-input' || task.status === 'blocked') markTaskRunning(db, task.id)
    return { delivery: 'injected', detail: `sent resolution to tmux session ${session}`, taskId: task.id, runId: run!.id, tmuxSession: session }
  }

  if (task.status === 'needs-input' || task.status === 'blocked') {
    requeueTaskWithResolution(db, task, resolutionText)
    return { delivery: 'requeued', detail: 'no live tmux run: task requeued with resolution appended to prompt', taskId: task.id, runId: run?.id }
  }

  return { delivery: 'record-only', detail: 'no live tmux run and task not awaiting input', taskId: task.id, runId: run?.id }
}
