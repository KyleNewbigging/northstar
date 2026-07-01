import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { DeviceFilesStatus } from './deviceFiles.js'
import { heartbeatPath } from './paths.js'

export type HeartbeatProject = {
  id?: string
  name?: string
  active?: boolean
  autonomous?: boolean
  status?: string
  runtime?: string
  lastEvent?: string
  lastAgo?: string
}

export type HeartbeatTask = {
  id?: string
  title?: string
  project?: string
  model?: string
  status?: string
  priority?: string
  stage?: string
  source?: string
  sourceRef?: string
}

export type HeartbeatRun = {
  id?: string
  taskId?: string
  projectId?: string
  model?: string
  status?: string
  attachCommand?: string | null
  finalText?: string | null
  startedAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
}

export type HeartbeatAction = {
  id?: string
  title?: string
  project?: string
  task?: string | null
  type?: string
  priority?: string
  urgency?: string
}

export type HeartbeatSnapshot = {
  projects: HeartbeatProject[]
  tasks: HeartbeatTask[]
  runs: HeartbeatRun[]
  actions: HeartbeatAction[]
  deviceFiles: DeviceFilesStatus
  telegram?: HeartbeatTelegramStatus | null
  nextAction?: {
    title?: string
    reason?: string
    command?: string
    taskId?: string
    actionId?: string
    project?: string
  } | null
}

export type HeartbeatTelegramStatus = {
  enabled: boolean
  ready: boolean
  polling: boolean
  tokenConfigured: boolean
  chatConfigured: boolean
  allowedUsersConfigured: boolean
  lastSeenAt: string | null
  lastError: string | null
}

export type HeartbeatWriteResult = {
  ok: true
  path: string
  mirrorPath: string | null
  updatedAt: string
  content: string
}

export type HeartbeatLogger = {
  warn: (...args: any[]) => void
}

export type HeartbeatRuntime = {
  writeNow: () => HeartbeatWriteResult
  read: () => HeartbeatWriteResult
  stop: () => void
}

const defaultHeartbeatIntervalMs = 30_000

export function startHeartbeat(options: {
  snapshot: () => HeartbeatSnapshot
  logger: HeartbeatLogger
  intervalMs?: number
}): HeartbeatRuntime {
  let last = writeHeartbeat(options.snapshot())
  const interval = setInterval(() => {
    try {
      last = writeHeartbeat(options.snapshot())
    } catch (error) {
      options.logger.warn({ error: errorMessage(error) }, 'heartbeat write failed')
    }
  }, Math.max(5000, options.intervalMs ?? configuredHeartbeatIntervalMs()))
  interval.unref?.()

  return {
    writeNow: () => {
      last = writeHeartbeat(options.snapshot())
      return last
    },
    read: () => {
      if (existsSync(heartbeatPath)) {
        return {
          ...last,
          content: readFileSync(heartbeatPath, 'utf8'),
        }
      }
      last = writeHeartbeat(options.snapshot())
      return last
    },
    stop: () => clearInterval(interval),
  }
}

export function writeHeartbeat(snapshot: HeartbeatSnapshot): HeartbeatWriteResult {
  const updatedAt = new Date().toISOString()
  const content = buildHeartbeatMarkdown(snapshot, updatedAt)
  mkdirSync(dirname(heartbeatPath), { recursive: true })
  writeFileSync(heartbeatPath, content, { mode: 0o600 })

  const mirrorPath = snapshot.deviceFiles.rootExists
    ? join(snapshot.deviceFiles.rootPath, 'heartbeat.md')
    : null
  if (mirrorPath) {
    mkdirSync(dirname(mirrorPath), { recursive: true })
    writeFileSync(mirrorPath, content, { mode: 0o600 })
  }

  return { ok: true, path: heartbeatPath, mirrorPath, updatedAt, content }
}

function buildHeartbeatMarkdown(snapshot: HeartbeatSnapshot, updatedAt: string) {
  const activeProjects = snapshot.projects.filter((project) => project.active)
  const autonomousProjects = activeProjects.filter((project) => project.autonomous !== false)
  const runningTasks = snapshot.tasks.filter((task) => task.status === 'running')
  const queuedTasks = snapshot.tasks.filter((task) => task.status === 'queued')
  const blockedTasks = snapshot.tasks.filter((task) => task.status === 'blocked' || task.status === 'needs-input')
  const highPriorityTasks = snapshot.tasks.filter((task) => task.status !== 'done' && (task.priority === 'P0' || task.priority === 'P1'))
  const telegramTasks = snapshot.tasks.filter((task) => task.source === 'telegram' && task.status !== 'done')
  const liveRuns = snapshot.runs.filter((run) => run.status === 'running')
  const recentRuns = [...snapshot.runs]
    .sort((a, b) => timeForRun(b) - timeForRun(a))
    .slice(0, 6)
  const recentBlockedRuns = [...snapshot.runs]
    .filter((run) => run.status === 'blocked')
    .sort((a, b) => timeForRun(b) - timeForRun(a))
    .slice(0, 6)

  return [
    '# Northstar Heartbeat',
    '',
    `Updated: ${updatedAt}`,
    `Device: ${snapshot.deviceFiles.currentDevice}`,
    `Dropbox: ${snapshot.deviceFiles.rootExists ? `${snapshot.deviceFiles.rootPath} (${snapshot.deviceFiles.rootSource})` : 'not configured'}`,
    `Telegram: ${telegramLine(snapshot.telegram)}`,
    '',
    '## Operating Mode',
    '',
    '- Northstar is the remote-control cockpit for local/network agents.',
    '- Agents may run autonomously or complete requested tasks, with key updates routed back through Telegram and this heartbeat.',
    '- Git still owns code history and patch review; Dropbox is for device-to-device file reference and handoff.',
    '',
    '## Current Load',
    '',
    `- Active projects: ${activeProjects.length}`,
    `- Autonomous projects: ${autonomousProjects.length}`,
    `- Tasks: ${runningTasks.length} running, ${queuedTasks.length} queued, ${blockedTasks.length} blocked/input`,
    `- Queue pressure: ${highPriorityTasks.length} P0/P1 open, ${telegramTasks.length} Telegram-gated`,
    `- Live runs: ${liveRuns.length}`,
    `- Open inbox items: ${snapshot.actions.length}`,
    snapshot.nextAction ? `- Next action: ${snapshot.nextAction.title ?? 'Review cockpit'} (${snapshot.nextAction.command ?? 'open dashboard'})` : '- Next action: no recommendation',
    '',
    '## Recommended Next Action',
    '',
    snapshot.nextAction ? nextActionLine(snapshot.nextAction) : '- No recommended action.',
    '',
    '## Live Tmux Runs',
    '',
    ...sectionLines(liveRuns, runLine, 'No live tmux/agent runs.'),
    '',
    '## Recent Blocked Runs',
    '',
    ...sectionLines(recentBlockedRuns, runLine, 'No blocked runs recorded.'),
    '',
    '## Inbox',
    '',
    ...sectionLines(snapshot.actions.slice(0, 8), actionLine, 'Inbox is clear.'),
    '',
    '## Recent Runs',
    '',
    ...sectionLines(recentRuns, runLine, 'No recent runs recorded.'),
    '',
    '## Active Projects',
    '',
    ...sectionLines(activeProjects.slice(0, 12), projectLine, 'No active projects.'),
    '',
  ].join('\n')
}

function nextActionLine(action: NonNullable<HeartbeatSnapshot['nextAction']>) {
  const parts = [
    action.project ? `project=${action.project}` : null,
    action.taskId ? `task=${action.taskId}` : null,
    action.actionId ? `action=${action.actionId}` : null,
    action.command ? `command="${action.command}"` : null,
  ].filter(Boolean)
  return `- ${action.title ?? 'Review cockpit'}: ${action.reason ?? 'Northstar has a suggested next step.'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`
}

function sectionLines<T>(items: T[], formatter: (item: T) => string, empty: string) {
  return items.length ? items.map(formatter) : [`- ${empty}`]
}

function runLine(run: HeartbeatRun) {
  const parts = [
    run.id ?? 'unknown-run',
    run.status ?? 'unknown',
    run.model ? `model=${run.model}` : null,
    run.taskId ? `task=${run.taskId}` : null,
    run.attachCommand ? `attach="${run.attachCommand}"` : null,
  ].filter(Boolean)
  return `- ${parts.join(' · ')}`
}

function actionLine(action: HeartbeatAction) {
  const parts = [
    action.priority ?? 'P?',
    action.urgency ?? 'unknown',
    action.type ?? 'action',
    action.id ?? 'unknown-action',
  ]
  return `- ${parts.join(' · ')}: ${action.title ?? 'Untitled'}`
}

function projectLine(project: HeartbeatProject) {
  return `- ${project.name ?? project.id ?? 'Unknown project'} · ${project.status ?? 'unknown'} · ${project.runtime ?? 'local'} · ${project.lastEvent ?? 'no event'} ${project.lastAgo ? `(${project.lastAgo})` : ''}`.trim()
}

function telegramLine(status?: HeartbeatTelegramStatus | null) {
  if (!status) return 'not wired into heartbeat yet'
  const state = status.ready ? 'ready' : status.enabled ? 'configured but not ready' : 'disabled'
  const needs = [
    status.tokenConfigured ? null : 'token',
    status.chatConfigured ? null : 'chat',
    status.allowedUsersConfigured ? null : 'allowlist',
  ].filter(Boolean)
  const parts = [
    state,
    status.polling ? 'polling' : 'poll stopped',
    needs.length ? `needs ${needs.join('/')}` : null,
    status.lastSeenAt ? `last seen ${status.lastSeenAt}` : null,
    status.lastError ? `last error: ${status.lastError}` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

function timeForRun(run: HeartbeatRun) {
  const value = run.completedAt || run.updatedAt || run.startedAt
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

function configuredHeartbeatIntervalMs() {
  const value = Number(process.env.NORTHSTAR_HEARTBEAT_MS)
  return Number.isFinite(value) && value > 0 ? value : defaultHeartbeatIntervalMs
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
