import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { getDeviceFilesStatus } from './deviceFiles.js'

const MAX_FILE_BYTES = 256 * 1024
const MAX_LOG_TAIL_BYTES = 16 * 1024
const MAX_LOG_TAIL_LINES = 200
const MAX_SECTION_BYTES = 128 * 1024

export type WriteRunTranscriptInput = { runId: string }

export type WriteRunTranscriptResult =
  | { ok: true; path: string; relPath: string; bytes: number }
  | { ok: false; code: 'dropbox_unavailable' | 'run_not_found' | 'write_failed'; detail?: string }

type AgentRunRow = {
  id: string
  task_id: string | null
  project_id: string | null
  model: string | null
  provider: string | null
  command: string | null
  cwd: string | null
  worktree_path: string | null
  transport: string | null
  base_path: string | null
  tmux_session: string | null
  stdout_log_path: string | null
  stderr_log_path: string | null
  status: string | null
  prompt: string | null
  final_text: string | null
  stderr: string | null
  exit_code: number | null
  started_at: string | null
  updated_at: string | null
  completed_at: string | null
}

type TaskRow = {
  id: string
  title: string | null
  branch: string | null
  project_id: string | null
}

type ProjectRow = {
  id: string
  name: string | null
}

type PatchRow = {
  files_changed: number
  additions: number
  deletions: number
  summary: string
  files_json: string
  checks_json: string
}

export type TranscriptCheck = { name: string; state: string; ms?: number; detail?: string }
export type TranscriptFile = { path: string; add?: number; del?: number; status?: string }

export type TranscriptData = {
  runId: string
  taskId: string
  taskTitle: string
  projectId: string
  projectName: string
  model: string
  status: string
  startedAt: string
  completedAt: string
  updatedAt: string
  tmuxSession: string
  worktreePath: string
  branch: string
  exitCode: number | null
  prompt: string
  finalText: string
  checks: TranscriptCheck[]
  patch: {
    summary: string
    filesChanged: number
    additions: number
    deletions: number
    files: TranscriptFile[]
  } | null
  logTail: string
}

export function writeRunTranscript(db: DatabaseSync, input: WriteRunTranscriptInput): WriteRunTranscriptResult {
  const runId = String(input?.runId ?? '').trim()
  if (!runId) return { ok: false, code: 'run_not_found' }

  const status = getDeviceFilesStatus()
  if (!status.rootExists) return { ok: false, code: 'dropbox_unavailable' }

  const data = collectTranscriptData(db, runId)
  if (!data) return { ok: false, code: 'run_not_found' }

  const projectDir = join(status.rootPath, 'projects', sanitizePathSegment(data.projectId || 'unknown'))
  const sessionsDir = join(projectDir, 'sessions')
  try {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return { ok: false, code: 'write_failed', detail: (error as Error).message }
  }

  const filename = buildTranscriptFilename(data.startedAt || data.updatedAt || new Date().toISOString(), data.taskId, data.runId)
  const path = join(sessionsDir, filename)
  const content = composeRunTranscript(data)

  try {
    writeFileSync(path, content, { mode: 0o600 })
  } catch (error) {
    return { ok: false, code: 'write_failed', detail: (error as Error).message }
  }

  const relPath = `projects/${sanitizePathSegment(data.projectId || 'unknown')}/sessions/${filename}`
  return { ok: true, path, relPath, bytes: Buffer.byteLength(content, 'utf8') }
}

export function buildTranscriptFilename(startedAt: string, taskId: string, runId: string) {
  const date = extractDatePart(startedAt) || new Date().toISOString().slice(0, 10)
  const taskSlug = sanitizeTaskSegment(taskId)
  const runSlug = sanitizeRunSegment(runId) || 'unknown'
  return `${date}-${taskSlug}-${runSlug}.md`
}

export function composeRunTranscript(data: TranscriptData): string {
  const lines: string[] = []
  const titleSuffix = data.taskTitle ? ` — ${collapseWhitespace(data.taskTitle)}` : ''
  lines.push(`# Session ${data.taskId}${titleSuffix}`)
  lines.push('')

  const meta: Array<[string, string]> = []
  if (data.runId) meta.push(['Run ID', data.runId])
  if (data.projectName || data.projectId) meta.push(['Project', data.projectName || data.projectId])
  if (data.model) meta.push(['Model', data.model])
  if (data.status) meta.push(['Status', data.status])
  if (data.startedAt) meta.push(['Started', data.startedAt])
  if (data.completedAt) meta.push(['Completed', data.completedAt])
  if (data.updatedAt) meta.push(['Updated', data.updatedAt])
  if (data.tmuxSession) meta.push(['Tmux session', data.tmuxSession])
  if (data.worktreePath) meta.push(['Worktree', data.worktreePath])
  if (data.branch) meta.push(['Branch', data.branch])
  if (data.exitCode !== null && data.exitCode !== undefined) meta.push(['Exit code', String(data.exitCode)])

  if (meta.length) {
    for (const [key, value] of meta) lines.push(`- ${key}: ${value}`)
    lines.push('')
  }

  if (hasText(data.prompt)) {
    lines.push('## Prompt')
    lines.push('')
    lines.push(clipSection(data.prompt))
    lines.push('')
  }

  if (hasText(data.finalText)) {
    lines.push('## Output (final)')
    lines.push('')
    lines.push(clipSection(data.finalText))
    lines.push('')
  }

  if (data.checks && data.checks.length) {
    lines.push('## Verification')
    lines.push('')
    for (const check of data.checks) {
      const detail = check.detail ? ` — ${collapseWhitespace(check.detail).slice(0, 200)}` : ''
      const ms = typeof check.ms === 'number' ? ` (${check.ms}ms)` : ''
      lines.push(`- [${check.state}] ${check.name}${ms}${detail}`)
    }
    lines.push('')
  }

  if (data.patch) {
    lines.push('## Patch')
    lines.push('')
    if (data.patch.summary) lines.push(clipSection(data.patch.summary))
    lines.push(`- Files changed: ${data.patch.filesChanged}`)
    lines.push(`- Additions: +${data.patch.additions}`)
    lines.push(`- Deletions: -${data.patch.deletions}`)
    if (data.patch.files.length) {
      lines.push('')
      const capped = data.patch.files.slice(0, 100)
      for (const file of capped) {
        const stats = typeof file.add === 'number' || typeof file.del === 'number' ? ` (+${file.add ?? 0} / -${file.del ?? 0})` : ''
        const status = file.status ? ` [${file.status}]` : ''
        lines.push(`- ${file.path}${status}${stats}`)
      }
      if (data.patch.files.length > capped.length) lines.push(`- ... ${data.patch.files.length - capped.length} more`)
    }
    lines.push('')
  }

  if (hasText(data.logTail)) {
    lines.push('## Log tail')
    lines.push('')
    lines.push('```')
    lines.push(data.logTail)
    lines.push('```')
    lines.push('')
  }

  let output = lines.join('\n')
  if (Buffer.byteLength(output, 'utf8') > MAX_FILE_BYTES) {
    output = truncateToBytes(output, MAX_FILE_BYTES - 64) + '\n\n<!-- transcript truncated -->\n'
  }
  return output
}

function collectTranscriptData(db: DatabaseSync, runId: string): TranscriptData | null {
  const run = db
    .prepare(
      `SELECT id, task_id, project_id, model, provider, command, cwd,
        worktree_path, transport, base_path, tmux_session,
        stdout_log_path, stderr_log_path, status, prompt, final_text, stderr, exit_code,
        started_at, updated_at, completed_at
       FROM agent_runs WHERE id = ?`,
    )
    .get(runId) as AgentRunRow | undefined
  if (!run) return null

  const task = run.task_id
    ? (db.prepare('SELECT id, title, branch, project_id FROM tasks WHERE id = ?').get(run.task_id) as TaskRow | undefined)
    : undefined

  const projectId = run.project_id || task?.project_id || ''
  const project = projectId
    ? (db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined)
    : undefined

  const patch = run.task_id
    ? (db
        .prepare(
          'SELECT files_changed, additions, deletions, summary, files_json, checks_json FROM patches WHERE task_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1',
        )
        .get(run.task_id) as PatchRow | undefined)
    : undefined

  const checks = parseChecksFromRun(run, patch)
  const patchData = patch
    ? {
        summary: patch.summary || '',
        filesChanged: patch.files_changed ?? 0,
        additions: patch.additions ?? 0,
        deletions: patch.deletions ?? 0,
        files: parseJsonArray<TranscriptFile>(patch.files_json),
      }
    : null

  return {
    runId: run.id,
    taskId: run.task_id ?? run.id,
    taskTitle: task?.title ?? '',
    projectId,
    projectName: project?.name ?? projectId,
    model: run.model ?? '',
    status: run.status ?? '',
    startedAt: run.started_at ?? '',
    completedAt: run.completed_at ?? '',
    updatedAt: run.updated_at ?? '',
    tmuxSession: run.tmux_session ?? '',
    worktreePath: run.worktree_path ?? run.cwd ?? '',
    branch: task?.branch ?? '',
    exitCode: run.exit_code ?? null,
    prompt: run.prompt ?? '',
    finalText: run.final_text ?? '',
    checks,
    patch: patchData,
    logTail: readLogTail(run.stdout_log_path ?? null),
  }
}

function parseChecksFromRun(_run: AgentRunRow, patch: PatchRow | undefined): TranscriptCheck[] {
  if (!patch) return []
  const parsed = parseJsonArray<TranscriptCheck>(patch.checks_json)
  return parsed.filter((check) => check && typeof check.name === 'string' && typeof check.state === 'string')
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

function readLogTail(path: string | null): string {
  if (!path) return ''
  try {
    if (!existsSync(path)) return ''
    const stat = statSync(path)
    const fd = readFileSync(path)
    let text = fd.toString('utf8')
    if (stat.size > MAX_LOG_TAIL_BYTES) {
      text = fd.subarray(fd.length - MAX_LOG_TAIL_BYTES).toString('utf8')
    }
    const lines = text.split('\n')
    const tail = lines.slice(-MAX_LOG_TAIL_LINES).join('\n')
    return tail.length > MAX_LOG_TAIL_BYTES ? tail.slice(tail.length - MAX_LOG_TAIL_BYTES) : tail
  } catch {
    return ''
  }
}

function clipSection(text: string): string {
  if (!text) return ''
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_SECTION_BYTES) return text
  return truncateToBytes(text, MAX_SECTION_BYTES - 32) + '\n... [truncated]'
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString('utf8')
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function extractDatePart(value: string): string {
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : ''
}

function sanitizeTaskSegment(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return cleaned || 'task'
}

function sanitizeRunSegment(value: string): string {
  return String(value ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)
}

function sanitizePathSegment(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return cleaned || 'unknown'
}
