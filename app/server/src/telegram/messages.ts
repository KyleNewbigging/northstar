import type { DatabaseSync } from 'node:sqlite'

import type { ContentMatch, DeviceFileActions, DeviceFileContentSearchResult, DeviceFileEntry, DeviceFileListResult, DeviceFilePreviewResult, DeviceFileSearchResult, DeviceFilesStatus, DeviceHandoffListResult, DeviceHandoffResult, ProjectResourceResult, ProjectWorkspaceResult } from '../deviceFiles.js'
import type { DeviceRegistryEntry } from '../deviceRegistry.js'
import type { HeartbeatWriteResult } from '../heartbeat.js'
import { defaultTelegramAgent, defaultTelegramModel } from './constants.js'
import { formatSessionRouteSummary, inferTelegramLane, maybeLaneMismatchWarning } from './naturalLanguage.js'
import { updateTelegramBridgeSettings } from './settings.js'
import type {
  BridgeInboxAction,
  BridgeOperationsOverview,
  BridgeQueueMutation,
  BridgeResolveResult,
  BridgeRun,
  BridgeRunTaskResult,
  BridgeSnapshot,
  BridgeTask,
  BridgeTaskDetail,
  TelegramPromptResult,
  TelegramSession,
} from './types.js'
import {
  clip,
  compareInboxActions,
  parseCommandArgs,
  telegramSessionScope,
} from './utils.js'

export function buildInboxMessage(action: BridgeInboxAction) {
  const recommendedIndex = typeof action.recommend === 'number' && action.recommend >= 0 && action.options?.[action.recommend]
    ? action.recommend
    : 0
  const lines = [
    action.urgency === 'high'
      ? 'Polaris needs your input'
      : 'Polaris has a question',
    action.title,
    `Project: ${action.project}`,
    `Priority: ${action.priority} · ${action.model}`,
  ]
  lines.push('', clip(action.ctx, 1200))
  if (action.options?.length) {
    lines.push('', 'Choices:')
    action.options.forEach((option, index) => {
      const recommended = action.recommend === index ? ' (recommended)' : ''
      lines.push(`${index + 1}. ${option}${recommended}`)
    })
    lines.push(
      '',
      `Tap a button, reply "yes" for ${action.options[recommendedIndex]}, or reply "first", "second", or "discard".`,
      `Fallback command: /resolve ${action.id} ${recommendedIndex + 1}`,
    )
  } else {
    lines.push('', 'Reply "noted" or "yes".', `Fallback command: /resolve ${action.id} noted`)
  }
  if (action.help) lines.push('', clip(action.help, 800))
  return lines.join('\n')
}

export function buildInboxKeyboard(action: BridgeInboxAction) {
  if (!action.options?.length) return undefined
  return {
    inline_keyboard: [
      action.options.slice(0, 6).map((option, index) => ({
        text: callbackButtonLabel(option, action.recommend === index),
        callback_data: `resolve:${action.id}:${index + 1}`,
      })),
    ],
  }
}

function callbackButtonLabel(option: string, recommended: boolean) {
  const label = option
    .replace(/^Queue\s+/, '')
    .replace(/\s+worktree$/, '')
    .replace(/\s+plan$/, ' plan')
  return clip(`${recommended ? '* ' : ''}${label}`, 40)
}

function deliveryLine(result: BridgeResolveResult) {
  if (!result.delivery) return null
  if (result.delivery === 'injected') return `Injected into live tmux run${result.deliveryRunId ? ` (${result.deliveryRunId})` : ''}.`
  if (result.delivery === 'requeued') return `Queued for next dispatch: ${result.deliveryDetail ?? 'run not live'}.`
  return null
}

export function buildResolveResultMessage(result: BridgeResolveResult) {
  if (!result.ok) return `Could not resolve ${result.id}: ${result.error ?? 'unknown error'}`

  const task = result.taskResolution
  const delivery = deliveryLine(result)
  if (task?.status === 'queued') {
    return [
      `Resolved ${result.id}: ${result.choice}`,
      `Task ${task.taskId ?? 'queued'} is queued for ${task.model ?? 'agent'} review.`,
      'No agent process starts until the scheduler/cockpit dispatch guardrails allow it.',
      delivery,
    ].filter((line): line is string => line !== null).join('\n')
  }

  if (task?.status === 'done') {
    return [
      `Resolved ${result.id}: ${result.choice}`,
      'The request was discarded and no agent process started.',
      delivery,
    ].filter((line): line is string => line !== null).join('\n')
  }

  return [`Resolved ${result.id}: ${result.choice || 'noted'}`, delivery]
    .filter((line): line is string => line !== null)
    .join('\n')
}

export function buildNaturalResolveResultMessage(action: BridgeInboxAction, choiceLabel: string, result: BridgeResolveResult) {
  if (!result.ok) return `Polaris could not apply that reply to ${action.title}: ${result.error ?? 'unknown error'}`
  return [
    `Done: ${choiceLabel || result.choice || 'noted'}`,
    action.title,
    result.taskResolution?.status ? `Task status: ${result.taskResolution.status}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildInboxDigest(actions: BridgeInboxAction[]) {
  if (!actions.length) return 'Northstar inbox is clear.'
  const sorted = actions.slice().sort(compareInboxActions)
  const lines = [
    'Northstar inbox',
    'Reply "yes" to accept the top recommended choice, or reply "first", "second", or "discard".',
  ]
  for (const action of sorted.slice(0, 8)) {
    const recommended = action.options?.[typeof action.recommend === 'number' ? action.recommend : 0]
    lines.push(`${action.priority}: ${action.title}${recommended ? ` · recommended: ${recommended}` : ''}`)
  }
  if (actions.length > 8) lines.push(`${actions.length - 8} more in the cockpit.`)
  return lines.join('\n')
}

export function buildStatusMessage(snapshot: BridgeSnapshot, session: TelegramSession | null = null) {
  const running = snapshot.tasks.filter((task) => task.status === 'running').length
  const queued = snapshot.tasks.filter((task) => task.status === 'queued').length
  const blocked = snapshot.tasks.filter((task) => task.status === 'blocked' || task.status === 'needs-input').length
  const activeProjects = snapshot.projects.filter((project) => project.active).length
  const liveRuns = snapshot.runs.filter((run) => run.status === 'running').length
  const lines = [
    'Northstar status',
    `Projects active: ${activeProjects}`,
    `Inbox open: ${snapshot.actions.length}`,
    `Queue: ${running} running, ${queued} queued, ${blocked} blocked/input`,
    `Live runs: ${liveRuns}`,
  ]
  if (session) {
    lines.push('', 'Current Telegram session', `${session.project} · ${session.model} · ${session.agent}`, `Workspace: ${session.cwd || `projects/${session.project}`}`)
  }
  return lines.join('\n')
}

export function buildOverviewMessage(overview: BridgeOperationsOverview, tasks: BridgeTask[] = []) {
  const summary = overview.summary ?? {}
  const queue = overview.queuePressure ?? {}
  const laneCounts = { dev: 0, personal: 0, 'telegram-intent': 0 }
  for (const task of tasks) {
    if (task.lane === 'dev' || task.lane === 'personal' || task.lane === 'telegram-intent') laneCounts[task.lane] += 1
  }
  const lines = [
    'Northstar overview',
    `Projects: ${summary.activeProjects ?? 0} active / ${summary.totalProjects ?? 0} tracked`,
    `Decisions: ${summary.openDecisions ?? 0} open`,
    `Queue: ${summary.runningTasks ?? 0} running, ${summary.queuedTasks ?? 0} queued, ${summary.blockedTasks ?? 0} blocked/input`,
    `Runnable: ${summary.runnableTasks ?? 0} safe/manual-runnable · manual ${summary.manualTasks ?? 0} · GitHub-only ${summary.githubOnlyTasks ?? 0}`,
    `Lanes: dev ${laneCounts.dev} · personal ${laneCounts.personal} · telegram-intent ${laneCounts['telegram-intent']}`,
    `Attention: pending ${summary.attentionPending ?? 0}, failed ${summary.attentionFailed ?? 0}`,
    '',
    'Queue pressure',
    `open=${queue.totalOpen ?? 0} runnable=${queue.runnable ?? 0} scheduler_waiting=${queue.schedulerWaiting ?? 0} blocked=${queue.blocked ?? 0} input=${queue.needsInput ?? 0}`,
  ]
  if (overview.nextAction) {
    lines.push('', 'Next', `${overview.nextAction.title ?? 'Review cockpit'}`, overview.nextAction.reason ?? '', `Command: ${overview.nextAction.command ?? '/overview'}`)
  }
  const active = overview.activeProjects?.slice(0, 5) ?? []
  if (active.length) {
    lines.push('', 'Active projects')
    for (const project of active) lines.push(`- ${project.name ?? project.id}: ${project.status ?? 'unknown'} · ${project.lastEvent ?? project.runtime ?? 'active'}`)
  }
  return lines.filter((line) => line !== '').join('\n')
}

export function buildNextMessage(overview: BridgeOperationsOverview) {
  const next = overview.nextAction
  if (!next) return 'Northstar has no recommended next action. Try /overview for queue pressure.'
  return [
    'Northstar next action',
    `${next.title ?? 'Review cockpit'}`,
    next.project ? `Project: ${next.project}` : null,
    next.taskId ? `Task: ${next.taskId}` : null,
    next.actionId ? `Inbox: ${next.actionId}` : null,
    next.priority ? `Priority: ${next.priority}` : null,
    '',
    next.reason ?? 'Northstar recommends this as the smallest useful next step.',
    next.kind === 'resolve-inbox'
      ? 'Reply "yes" to approve the recommended choice, or use /inbox for the options.'
      : `Command: ${next.command ?? '/overview'}`,
    next.command ? `Fallback command: ${next.command}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildTaskDetailMessage(detail: BridgeTaskDetail) {
  if (!detail.ok || !detail.task) return `Northstar task not found\n${detail.error ?? 'Unknown task error.'}`
  const task = detail.task
  const dispatchability = detail.dispatchability ?? task.dispatchability
  const lines = [
    `Northstar task ${task.id ?? 'unknown'}`,
    task.title ?? 'Untitled task',
    `Project: ${detail.project?.name ?? task.project ?? 'unknown'}`,
    `Status: ${task.status ?? 'unknown'} · ${task.priority ?? 'P?'} · ${task.model ?? 'agent'} · ${task.agent ?? 'agent'}`,
    task.stage ? `Stage: ${task.stage}` : null,
    task.source ? `Source: ${task.source}${task.sourceRef ? ` (${task.sourceRef})` : ''}` : null,
    '',
    `Dispatch: ${dispatchability?.status ?? 'unknown'}`,
    dispatchability?.reason ?? 'No dispatchability explanation available.',
    `Action: ${dispatchability?.action ?? 'Review in cockpit'}`,
    dispatchability?.stale ? 'Stale: yes' : null,
  ]
  const runs = detail.runs?.slice(0, 3) ?? []
  if (runs.length) {
    lines.push('', 'Runs')
    for (const run of runs) lines.push(`- ${run.id}: ${run.status}${run.attachCommand ? ` · ${run.attachCommand}` : ''}`)
  }
  const actions = detail.actions?.slice(0, 3) ?? []
  if (actions.length) {
    lines.push('', 'Inbox')
    for (const action of actions) lines.push(`- ${action.id}: ${action.title}`)
  }
  return lines.filter((line): line is string => line !== null).join('\n')
}

export function buildRunTaskResultMessage(taskId: string, result: BridgeRunTaskResult) {
  if (!result.ok) {
    return [
      `Northstar did not start ${taskId}`,
      result.error ?? 'Dispatch was blocked by cockpit guardrails.',
      result.dispatchability?.status ? `Dispatch: ${result.dispatchability.status}` : null,
      result.dispatchability?.reason ?? null,
      'No patch was applied, no commit was made, and no push was attempted.',
    ].filter((line): line is string => line !== null).join('\n')
  }
  return [
    `Northstar started ${taskId}`,
    result.run?.id ? `Run: ${result.run.id}` : null,
    result.run?.attachCommand ? `Attach: ${result.run.attachCommand}` : null,
    result.run?.status ? `Status: ${result.run.status}` : null,
    '',
    'The agent is running in an isolated worktree. Patch apply, commit, push, and deletes remain review-gated.',
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildRunMessage(run: Required<Pick<BridgeRun, 'id' | 'status'>> & BridgeRun) {
  const lines = [
    `Polaris ${run.status === 'done' ? 'finished' : 'paused'} ${run.taskTitle ?? 'an agent run'}`,
  ]
  if (run.projectId) lines.push(`Project: ${run.projectId}`)
  lines.push(`Status: ${run.status}`)
  if (run.model) lines.push(`Model: ${run.model}`)
  if (run.finalText) lines.push('', clip(run.finalText, 1400))
  return lines.join('\n')
}

export function buildDevicesMessage(devices: DeviceRegistryEntry[], options: { now?: number } = {}) {
  if (!devices.length) return 'Northstar devices\nNo devices have advertised via Dropbox yet.'
  const now = options.now ?? Date.now()
  const lines = ['Northstar devices']
  for (const device of devices) {
    lines.push(formatDeviceLine(device, now))
  }
  return lines.join('\n')
}

function formatDeviceLine(device: DeviceRegistryEntry, now: number): string {
  const parts: string[] = []
  parts.push(device.deviceId)
  parts.push(device.self ? 'self' : device.online ? 'online' : 'offline')
  if (!device.self) {
    const age = formatDeviceAge(device.updatedAt, now)
    if (age) parts.push(`last seen ${age}`)
  }
  if (device.platform) parts.push(device.platform)
  const caps: string[] = []
  if (device.capabilities.tmux) caps.push('tmux')
  if (device.capabilities.ripgrep) caps.push('rg')
  if (device.capabilities.whisper) caps.push('whisper')
  if (device.capabilities.models.length) caps.push(`models=${device.capabilities.models.join('/')}`)
  if (device.capabilities.maxParallelRuns > 0) caps.push(`slots=${device.capabilities.maxParallelRuns}`)
  if (caps.length) parts.push(caps.join(' '))
  return `- ${parts.join(' · ')}`
}

function formatDeviceAge(updatedAt: string, now: number): string {
  const ms = Date.parse(updatedAt)
  if (!Number.isFinite(ms)) return ''
  const diff = Math.max(0, now - ms)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function buildHeartbeatMessage(result: HeartbeatWriteResult) {
  return [
    result.content,
    '',
    `Heartbeat path: ${result.path || 'unavailable'}`,
    result.mirrorPath ? `Dropbox mirror: ${result.mirrorPath}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildFileListMessage(result: DeviceFileListResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  const location = result.relPath || '.'
  if (!result.entries.length) return `Dropbox files\n${location} is empty.`
  const lines = [
    'Dropbox files',
    `${location} · ${result.status.currentDevice}`,
    '',
    ...result.entries.map(formatFileEntry),
  ]
  if (result.truncated) lines.push('', 'More entries exist. Narrow the path or use /find.')
  return lines.join('\n')
}

export function buildFileSearchMessage(result: DeviceFileSearchResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  if (!result.results.length) return `Dropbox search\nNo matches for "${result.query}".`
  const lines = [
    'Dropbox search',
    `"${result.query}" · ${result.results.length} match${result.results.length === 1 ? '' : 'es'}`,
    '',
    ...result.results.map(formatFileEntry),
  ]
  if (result.truncated) lines.push('', `Search stopped after ${result.visited} folders/files. Narrow the query if needed.`)
  return lines.join('\n')
}

export function buildContentSearchMessage(result: DeviceFileContentSearchResult): string | null {
  if (!result.ok) return null
  if (!result.results.length) return null
  const lines = [
    `Content matches (${result.engine}) · ${result.results.length} hit${result.results.length === 1 ? '' : 's'}`,
    '',
    ...result.results.map((m: ContentMatch) => `${m.relPath}:${m.line} ${m.snippet}`),
  ]
  if (result.truncated) lines.push('', 'More content matches exist. Narrow the query.')
  return lines.join('\n')
}

export function buildFilePreviewMessage(result: DeviceFilePreviewResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  const lines = [
    'Dropbox file',
    formatFileEntry(result.entry),
  ]
  if (!result.previewable) {
    lines.push('', 'Preview is not available for this file type or size. Use the relative path as the reference.')
    return lines.join('\n')
  }
  lines.push('', result.preview || '(empty file)')
  if (result.truncated) lines.push('', 'Preview truncated.')
  return lines.join('\n')
}

export function buildHandoffMessage(result: DeviceHandoffResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  return [
    'Dropbox handoff created',
    `To: ${result.targetDevice}`,
    `Source: ${result.sourceRelPath || '.'}`,
    `Handoff: ${result.handoffRelPath}`,
    '',
    'The receiving device can open this handoff from its synced Dropbox folder.',
  ].join('\n')
}

export function buildHandoffListMessage(result: DeviceHandoffListResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  if (!result.handoffs.length) return `Dropbox handoffs\nNo handoffs for ${result.targetDevice}.`
  return [
    'Dropbox handoffs',
    `For: ${result.targetDevice}`,
    '',
    ...result.handoffs.map((item) => [
      item.id,
      item.summary,
      item.relPath,
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

export function buildProjectWorkspaceMessage(result: ProjectWorkspaceResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  return [
    'Dropbox project workspace',
    `Project: ${result.project}`,
    `Path: ${result.relPath}`,
    '',
    'Core files:',
    `CLAUDE.md: ${result.files.claude}`,
    `AGENTS.md: ${result.files.agents}`,
    `agent-profile.md: ${result.files.agentProfile}`,
    `implementation.md: ${result.files.implementation}`,
    `.claude: ${result.files.dotClaude}`,
    `resources: ${result.files.resources}`,
    `handoffs: ${result.files.handoffs}`,
    '',
    result.created.length ? `Created ${result.created.length} item${result.created.length === 1 ? '' : 's'}.` : 'Workspace already exists.',
  ].join('\n')
}

export function buildProjectResourceMessage(result: ProjectResourceResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  return [
    'Dropbox resource saved',
    `Project: ${result.project}`,
    `Path: ${result.relPath}`,
  ].join('\n')
}

export function buildSessionMessage(session: TelegramSession, createdCount: number) {
  const lane = inferTelegramLane(session)
  const warning = maybeLaneMismatchWarning(session.model, session.agent)
  return [
    'Telegram session routed',
    `Project: ${session.project}`,
    `Model: ${session.model}`,
    `Agent: ${session.agent}`,
    `Lane: ${lane}`,
    `Workspace: ${session.cwd || `projects/${session.project}`}`,
    `Scope: ${session.chatId}/${session.threadId}`,
    ...(warning ? ['', warning] : []),
    createdCount ? `Workspace created or extended with ${createdCount} item${createdCount === 1 ? '' : 's'}.` : 'Workspace already existed.',
    'Ordinary messages now start Codex worktree tasks automatically. Polaris will ask only when input, a blocker, or a risky action needs you.',
  ].join('\n')
}

export function buildNoSessionMessage(scope: ReturnType<typeof telegramSessionScope>, sessions: TelegramSession[]) {
  const topicLabel = `${scope.chatId}/${scope.threadId}`
  const examples = [
    'Send "work on Northstar" for the Northstar orchestrator lane.',
    'Send "work on Zebra dashboard" for the Zebra dashboard orchestrator lane.',
    'Mention "personal" or "Spark" only when you want the lighter personal lane.',
  ]
  if (!sessions.length) {
    return [
      `No Telegram project session is bound to this chat/topic (${topicLabel}) yet.`,
      'Send a normal request that mentions Northstar or Zebra dashboard and Polaris will route it automatically.',
      ...examples.map((line) => `  ${line}`),
      'No agent process has started.',
    ].join('\n')
  }
  return [
    `No Telegram project session is bound to this topic (${topicLabel}) yet.`,
    'Known routes on this chat:',
    ...sessions.map((session) => `  ${formatSessionRouteSummary(session)}`),
    '',
    'Send a normal request for the project you want:',
    ...examples.map((line) => `  ${line}`),
    'No agent process has started.',
  ].join('\n')
}

export function buildPromptIntakeMessage(result: TelegramPromptResult, session: TelegramSession) {
  if (!result.ok) {
    return [
      'Polaris could not capture that Telegram request.',
      result.error,
      'No agent process has started.',
    ].join('\n')
  }

  return [
    result.dispatch?.ok
      ? 'Polaris started a Codex worktree run.'
      : result.autoDispatched
        ? 'Polaris queued this for Codex, but it could not start yet.'
        : 'Polaris queued this for Codex.',
    `Project: ${result.project || session.project}`,
    `Status: ${result.dispatch?.ok ? 'running' : result.status ?? 'queued'}`,
    '',
    result.dispatch?.ok
      ? 'I will message only if it needs input, blocks, fails, or finishes.'
      : result.dispatch?.error
        ? `Reason: ${result.dispatch.error}`
        : 'Use /overview if you want details.',
  ].join('\n')
}

export function buildSessionsMessage(sessions: TelegramSession[]) {
  if (!sessions.length) return 'No Telegram sessions are registered yet. Use /use PROJECT to bind this chat or topic.'
  return [
    'Telegram sessions',
    '',
    ...sessions.slice(0, 12).map((session) => [
      `${session.chatId}/${session.threadId}`,
      `${session.project} · ${session.model} · ${session.agent} · ${inferTelegramLane(session)} lane`,
      session.cwd || `projects/${session.project}`,
    ].join('\n')),
  ].join('\n\n')
}

export function updateDebugMode(db: DatabaseSync, rest: string) {
  const parsed = parseDebugMode(rest)
  if (!parsed.ok) return parsed
  const settings = parsed.enabled
    ? updateTelegramBridgeSettings(db, {
      notifyLifecycleDebug: true,
      notifyRunTelemetryDebug: true,
      debugUntil: new Date(Date.now() + parsed.durationMs).toISOString(),
    })
    : updateTelegramBridgeSettings(db, {
      notifyLifecycleDebug: false,
      notifyRunTelemetryDebug: false,
      debugUntil: null,
    })
  return { ok: true as const, enabled: parsed.enabled, settings }
}

function parseDebugMode(rest: string) {
  const [modeRaw, durationRaw] = parseCommandArgs(rest)
  const mode = (modeRaw ?? '').toLowerCase()
  if (mode === 'off') return { ok: true as const, enabled: false as const, durationMs: 0 }
  if (mode === 'on') return { ok: true as const, enabled: true as const, durationMs: parseDebugDuration(durationRaw ?? '30m') }
  if (mode === 'status' || mode === '') return { ok: false as const, error: 'Usage: /debug on 30m or /debug off' }
  return { ok: false as const, error: 'Usage: /debug on 30m or /debug off' }
}

function parseDebugDuration(value: string) {
  const match = value.trim().match(/^(\d+)(m|h)?$/i)
  if (!match) return 30 * 60 * 1000
  const amount = Math.max(1, Math.min(24 * 60, Number(match[1])))
  const unit = (match[2] ?? 'm').toLowerCase()
  return unit === 'h' ? amount * 60 * 60 * 1000 : amount * 60 * 1000
}

export function buildDebugModeMessage(result: ReturnType<typeof updateDebugMode>) {
  if (!result.ok) return result.error
  if (!result.enabled) return 'Polaris debug notifications are off. Quiet important-only mode is active.'
  return [
    'Polaris debug notifications are on.',
    `Verbose lifecycle and run telemetry will expire at ${result.settings.debugUntil ?? 'the configured expiry'}.`,
    'Use /debug off to return to quiet mode sooner.',
  ].join('\n')
}

export function buildFileErrorMessage(result: { error: string; detail: string; status: DeviceFilesStatus }) {
  return [
    `Dropbox file action blocked: ${result.error}`,
    result.detail,
    '',
    `Root: ${result.status.rootPath}`,
    `Device: ${result.status.currentDevice}`,
  ].join('\n')
}

function formatFileEntry(entry: DeviceFileEntry) {
  const suffix = entry.kind === 'directory' ? '/' : ''
  const size = entry.size === null ? '' : ` · ${formatBytes(entry.size)}`
  return `${kindIcon(entry.kind)} ${entry.relPath}${suffix}${size}`
}

function kindIcon(kind: DeviceFileEntry['kind']) {
  if (kind === 'directory') return '[dir]'
  if (kind === 'file') return '[file]'
  if (kind === 'symlink') return '[link]'
  return '[item]'
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function disabledFileActions(): DeviceFileActions {
  const status: DeviceFilesStatus = {
    ok: true,
    configured: false,
    rootExists: false,
    rootPath: '',
    rootSource: 'default',
    projectsRelPath: 'projects',
    currentDevice: 'northstar-device',
    handoffsPath: null,
    env: {
      root: 'NORTHSTAR_DROPBOX_ROOT',
      device: 'NORTHSTAR_DEVICE_ID',
    },
    guidance: 'Device file actions are not wired into this Northstar server.',
  }
  const error = { ok: false as const, error: 'device_files_unavailable', detail: status.guidance, status }
  return {
    status: () => status,
    list: () => error,
    search: () => error,
    searchContent: () => error,
    preview: () => error,
    createHandoff: () => error,
    listHandoffs: () => error,
    ensureProjectWorkspace: () => error,
    saveProjectResource: () => error,
  }
}

export function parseResourceCommand(input: string) {
  const parsed = parseCommandArgs(input)
  const project = parsed[0]
  const rest = input.slice(project?.length ?? 0).trim()
  const [titleRaw, ...contentParts] = rest.split(/\s+::\s+/)
  const title = titleRaw?.trim() || 'resource'
  const content = contentParts.join(' :: ').trim()
  return { project, title, content }
}

export function parseUseCommand(input: string) {
  const parsed = parseCommandArgs(input)
  return {
    project: parsed[0],
    model: parsed[1] || defaultTelegramModel,
    agent: parsed[2] || defaultTelegramAgent,
  }
}

export type QueueLaneFilter = 'dev' | 'personal' | 'telegram-intent'
export type QueueStatusFilter = 'blocked' | 'queued' | 'running' | 'needs-input' | 'stale'

export type QueueCommandFilters = {
  lanes: QueueLaneFilter[]
  statuses: QueueStatusFilter[]
  unknown: string[]
}

const queueLaneTokens: Record<string, QueueLaneFilter> = {
  dev: 'dev',
  personal: 'personal',
  'telegram-intent': 'telegram-intent',
  telegram: 'telegram-intent',
}

const queueStatusTokens: Record<string, QueueStatusFilter> = {
  blocked: 'blocked',
  queued: 'queued',
  running: 'running',
  'needs-input': 'needs-input',
  needsinput: 'needs-input',
  input: 'needs-input',
  stale: 'stale',
}

export function parseQueueCommandArgs(rest: string): QueueCommandFilters {
  const args = parseCommandArgs(rest).map((arg) => arg.toLowerCase())
  const lanes: QueueLaneFilter[] = []
  const statuses: QueueStatusFilter[] = []
  const unknown: string[] = []
  for (const arg of args) {
    if (queueLaneTokens[arg]) {
      const lane = queueLaneTokens[arg]
      if (!lanes.includes(lane)) lanes.push(lane)
      continue
    }
    if (queueStatusTokens[arg]) {
      const status = queueStatusTokens[arg]
      if (!statuses.includes(status)) statuses.push(status)
      continue
    }
    unknown.push(arg)
  }
  return { lanes, statuses, unknown }
}

export function filterQueueTasks(tasks: BridgeTask[], filters: QueueCommandFilters) {
  return tasks.filter((task) => {
    if (filters.lanes.length && !filters.lanes.includes((task.lane ?? '') as QueueLaneFilter)) return false
    if (filters.statuses.length) {
      const matches = filters.statuses.some((status) => {
        if (status === 'stale') return Boolean(task.dispatchability?.stale)
        return task.status === status
      })
      if (!matches) return false
    }
    return true
  })
}

export function buildQueueMessage(tasks: BridgeTask[], filters: QueueCommandFilters, maxRows = 15) {
  const filtered = filterQueueTasks(tasks, filters)
  const header = 'Northstar queue'
  const filterLabelParts: string[] = []
  if (filters.lanes.length) filterLabelParts.push(`lanes: ${filters.lanes.join(', ')}`)
  if (filters.statuses.length) filterLabelParts.push(`filters: ${filters.statuses.join(', ')}`)
  const filterLine = filterLabelParts.length ? filterLabelParts.join(' · ') : 'all lanes · all statuses'
  const unknownLine = filters.unknown.length ? `Ignored: ${filters.unknown.join(', ')}` : null
  if (!filtered.length) {
    return [header, filterLine, unknownLine, '', 'No tasks match this filter.'].filter((line): line is string => line !== null && line !== '').join('\n')
  }
  const rows = filtered.slice(0, maxRows).map(formatQueueRow)
  const overflow = filtered.length > maxRows ? `...and ${filtered.length - maxRows} more` : null
  const lines: (string | null)[] = [header, `${filterLine} · ${filtered.length} match${filtered.length === 1 ? '' : 'es'}`, unknownLine, '', ...rows]
  if (overflow) lines.push('', overflow)
  return lines.filter((line): line is string => line !== null).join('\n')
}

function formatQueueRow(task: BridgeTask) {
  const id = task.id ?? '?'
  const title = clip((task.title ?? 'Untitled').replace(/\s+/g, ' '), 60)
  const status = task.status ?? 'unknown'
  const lane = task.lane ?? '?'
  const priority = task.priority ?? 'P?'
  const staleMark = task.dispatchability?.stale ? ' · stale' : ''
  const head = `${id} · ${title}`
  const meta = `${status} · ${lane} · ${priority}${staleMark}`
  const dispatch = task.status === 'running'
    ? null
    : task.dispatchability
      ? `${task.dispatchability.status ?? 'unknown'}: ${task.dispatchability.reason ?? 'no explanation'}`
      : null
  return [head, `  ${meta}`, dispatch ? `  ${clip(dispatch, 200)}` : null].filter((line): line is string => line !== null).join('\n')
}

export function matchTaskIdCandidates(tasks: BridgeTask[], query: string, max = 5) {
  const trimmed = query.trim()
  if (!trimmed) return { exact: null as BridgeTask | null, candidates: [] as BridgeTask[] }
  const lower = trimmed.toLowerCase()
  const ids = tasks.filter((task) => typeof task.id === 'string')
  const exact = ids.find((task) => (task.id ?? '').toLowerCase() === lower) ?? null
  if (exact) return { exact, candidates: [] }
  const prefix = ids.filter((task) => (task.id ?? '').toLowerCase().startsWith(lower))
  const contains = prefix.length ? [] : ids.filter((task) => (task.id ?? '').toLowerCase().includes(lower))
  const source = prefix.length ? prefix : contains
  return { exact: null, candidates: source.slice(0, max) }
}

export function buildTaskIdNotFoundMessage(action: string, query: string, candidates: BridgeTask[]) {
  const lines = [`Northstar could not match task "${query}" for /${action}.`]
  if (candidates.length) {
    lines.push('Candidates:')
    for (const task of candidates) {
      lines.push(`  ${task.id} · ${clip((task.title ?? '').replace(/\s+/g, ' '), 60)}`)
    }
  } else {
    lines.push('No candidate ids matched. Use /queue to browse tasks.')
  }
  return lines.join('\n')
}

export function buildQueueMutationMessage(action: 'pause' | 'requeue', result: BridgeQueueMutation) {
  if (!result.ok) return `Northstar could not ${action} ${result.id}: ${result.error ?? 'unknown error'}`
  if (action === 'pause') return `Northstar paused ${result.id}. Status: ${result.status ?? 'blocked'}.`
  return `Northstar requeued ${result.id}. Status: ${result.status ?? 'queued'}.`
}

export function helpText() {
  return [
    'Northstar Telegram bridge commands:',
    '/status - current cockpit summary',
    '/overview - operations overview across projects, queue, runs, and attention',
    '/next - recommended next action',
    '/task TASK_ID - task detail and dispatchability',
    '/run TASK_ID - start a safe review-gated local worktree run',
    '/queue [lane] [status] - list queue tasks (lanes: dev|personal|telegram-intent · statuses: blocked|queued|running|needs-input|stale)',
    '/dispatch TASK_ID - manual-approval dispatch, same guardrails as the cockpit',
    '/pause TASK_ID - move a queued/blocked task to paused manually',
    '/requeue TASK_ID - reset a blocked/needs-input task back to queued',
    '/heartbeat - live remote-control cockpit heartbeat',
    '/inbox - open decisions',
    '/resolve ACTION_ID choice - resolve one inbox item',
    '/files [path] - list Dropbox files',
    '/find query - search Dropbox filenames/paths and markdown content',
    '/file path - preview a small text/Markdown file',
    '/handoff DEVICE path [note] - create a Dropbox handoff for another device',
    '/handoffs [DEVICE] - list handoffs for this or another device',
    '/project PROJECT - create/show a Dropbox project workspace',
    '/use PROJECT [model] [agent] - route this chat/topic to a project workspace',
    '/sessions - list registered Telegram session routes',
    '/devices - list Northstar devices advertising via Dropbox',
    '/resource PROJECT title :: content - save a Markdown resource in Dropbox',
    '/debug on 30m - temporarily enable verbose lifecycle and run telemetry',
    '/debug off - return to quiet important-only notifications',
    '',
    'After /use binds a chat/topic, ordinary messages queue and start Codex worktree tasks automatically when local guardrails pass.',
    'Without /use, a first normal message auto-routes to Northstar or Zebra dashboard; Orchestrator is the default lane.',
    'Telegram can resolve inbox decisions and reference Dropbox files. Patch apply, commits, pushes, deletes, and blocked/risky actions stay in the local cockpit.',
  ].join('\n')
}
