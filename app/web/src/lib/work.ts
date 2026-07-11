import type { ModelId, QueueTask, Status } from '../types'
import { modelLabel } from './format'

export type AgentRun = {
  id: string
  taskId?: string
  task_id?: string
  projectId?: string
  project_id?: string
  status: string
  model: ModelId
  prompt?: string | null
  finalText?: string | null
  final_text?: string | null
  stdout?: string | null
  stderr?: string | null
  command?: string | null
  cwd?: string | null
  provider?: string | null
  transport?: string | null
  tmuxSession?: string | null
  tmux_session?: string | null
  attachCommand?: string | null
  attach_command?: string | null
  stdoutLogPath?: string | null
  stderrLogPath?: string | null
  exitStatusPath?: string | null
  finalTextPath?: string | null
  exitCode?: number | null
  exit_code?: number | null
  worktreePath?: string | null
  worktree_path?: string | null
  startedAt?: string | null
  started_at?: string | null
  updatedAt?: string | null
  updated_at?: string | null
}

export type ProjectWork = {
  id: string
  taskId?: string
  project: string
  title: string
  model: ModelId
  status: Status
  progress: number
  stage: string
  eta: string
  branch: string
  source: 'queue' | 'run' | 'decision'
  detail?: string
  worktree?: string
  updatedAt?: string | null
}

export function runOutput(run: AgentRun) {
  return run.finalText || run.final_text || run.stdout || run.stderr || ''
}

export function runWorktree(run: AgentRun) {
  return run.worktreePath || run.worktree_path || run.id
}

export function runCommand(run: AgentRun) {
  return run.command || `${modelLabel(run.model)} command pending`
}

export function runAttachCommand(run: AgentRun) {
  return run.attachCommand || run.attach_command || ''
}

export function runCwd(run: AgentRun) {
  return run.cwd || runWorktree(run)
}

export function runProjectId(run: AgentRun) {
  return run.projectId || run.project_id || 'northstar'
}

export function runTaskId(run: AgentRun) {
  return run.taskId || run.task_id || run.id
}

export function toStatus(status: string): Status {
  if (status === 'running' || status === 'needs-input' || status === 'queued' || status === 'blocked' || status === 'done' || status === 'idle') return status
  return status === 'complete' ? 'done' : 'queued'
}

export function progressForRun(run: AgentRun) {
  if (run.status === 'done') return 1
  if (run.status === 'blocked') return 0.2
  const output = runOutput(run)
  return output ? 0.48 : 0.12
}

export function workFromTask(task: QueueTask): ProjectWork {
  return {
    id: `task-${task.id}`,
    taskId: task.id,
    project: task.project,
    title: task.title,
    model: task.model,
    status: task.status,
    progress: task.progress,
    stage: task.stage,
    eta: task.eta,
    branch: task.branch,
    source: 'queue',
    detail: `${task.agent} · ${task.files} files`,
  }
}

export function workFromRun(run: AgentRun): ProjectWork {
  const taskId = runTaskId(run)
  const detail = (runOutput(run) || run.prompt || 'Waiting for CLI output...').replace(/\s+/g, ' ').slice(0, 180)
  return {
    id: `run-${run.id}`,
    taskId,
    project: runProjectId(run),
    title: run.prompt?.slice(0, 90) || `CLI run ${taskId}`,
    model: run.model,
    status: toStatus(run.status),
    progress: progressForRun(run),
    stage: run.status === 'running' ? `${modelLabel(run.model)} running` : `${modelLabel(run.model)} ${run.status}`,
    eta: run.status === 'running' ? 'live' : 'finished',
    branch: runWorktree(run),
    source: 'run',
    detail,
    worktree: runWorktree(run),
    updatedAt: run.updatedAt || run.updated_at,
  }
}

export function mergeProjectWork(queueTasks: QueueTask[], runs: AgentRun[], decisions: ProjectWork[]) {
  const byKey = new Map<string, ProjectWork>()
  ;[...queueTasks.map(workFromTask), ...runs.map(workFromRun), ...decisions].forEach((item) => {
    const key = item.taskId ? `${item.project}:${item.taskId}` : item.id
    const previous = byKey.get(key)
    if (!previous || item.source === 'run' || (previous.source === 'decision' && item.source === 'queue')) byKey.set(key, item)
  })
  return [...byKey.values()].sort((a, b) => {
    const rank: Record<Status, number> = { running: 0, 'needs-input': 1, queued: 2, blocked: 3, done: 4, idle: 5 }
    return rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)
  })
}
