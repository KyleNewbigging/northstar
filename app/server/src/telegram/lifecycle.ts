import type { DatabaseSync } from 'node:sqlite'

import {
  buildRunLifecycleAlertPayload,
  buildTaskLifecycleAlertPayload,
  enqueueAttentionAlert,
  shouldSendAttentionRunAlert,
  shouldSendAttentionTaskAlert,
} from './attention.js'
import {
  defaultRunTelemetryChunkChars,
  defaultRunTelemetryOutputMs,
  telegramDigestWindowMs,
  telegramStaleInboxAgeMs,
  telegramStaleInboxCooldownMs,
} from './constants.js'
import {
  hasSuccessfulDelivery,
  readTelegramBotToken,
  recordDelivery,
  recordTelegramError,
  sendMessage,
} from './api.js'
import { buildInboxKeyboard, buildInboxMessage, buildRunMessage } from './messages.js'
import type {
  BridgeRun,
  BridgeTask,
  DigestState,
  RunTelemetryState,
  TelegramBridgeSettings,
} from './types.js'
import {
  clip,
  errorMessage,
  isBridgeInboxAction,
  isBridgeRun,
  isImportantPriority,
  isNotificationTask,
  isRecentRun,
} from './utils.js'

export function isNotificationReady(settings: TelegramBridgeSettings) {
  return settings.enabled && Boolean(settings.chatId) && Boolean(readTelegramBotToken())
}

export function hydrateLifecycleState(db: DatabaseSync, notifiedTaskStatuses: Map<string, string>, notifiedRunStatuses: Map<string, string>) {
  const tasks = db
    .prepare("SELECT id, status, source, source_ref AS sourceRef FROM tasks WHERE status IN ('needs-input','queued','running','blocked','done')")
    .all() as Array<{ id: string; status: string; source?: string; sourceRef?: string }>
  for (const task of tasks) {
    if (!task.id || !isNotificationTask(task)) continue
    notifiedTaskStatuses.set(task.id, task.status)
  }

  const runs = db
    .prepare("SELECT id, status FROM agent_runs WHERE status IN ('running','blocked','done')")
    .all() as Array<{ id: string; status: string }>
  for (const run of runs) {
    if (!run.id || !run.status) continue
    notifiedRunStatuses.set(run.id, run.status)
  }
}

export function hydrateLifecycleStateIfNeeded(
  db: DatabaseSync,
  hydrated: { done: boolean },
  notifiedTaskStatuses: Map<string, string>,
  notifiedRunStatuses: Map<string, string>,
) {
  if (hydrated.done) return
  hydrated.done = true
  hydrateLifecycleState(db, notifiedTaskStatuses, notifiedRunStatuses)
}

export function trackLifecycleState(
  currentTasks: BridgeTask[],
  currentRuns: BridgeRun[],
  notifiedTaskStatuses: Map<string, string>,
  notifiedRunStatuses: Map<string, string>,
) {
  const activeTaskIds = new Set(currentTasks.map((task) => task.id).filter(Boolean) as string[])
  const activeRunIds = new Set(currentRuns.map((run) => run.id).filter(Boolean) as string[])
  for (const taskId of [...notifiedTaskStatuses.keys()]) {
    if (!activeTaskIds.has(taskId)) notifiedTaskStatuses.delete(taskId)
  }
  for (const runId of [...notifiedRunStatuses.keys()]) {
    if (!activeRunIds.has(runId)) notifiedRunStatuses.delete(runId)
  }
}

export async function notifyLifecycle(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  tasks: BridgeTask[],
  runs: BridgeRun[],
  notifiedTaskStatuses: Map<string, string>,
  notifiedRunStatuses: Map<string, string>,
  options: { sendTelegram?: boolean } = {},
) {
  const taskTransitions = tasks
    .map((task) => [task, notifiedTaskStatuses.get(task.id || ''), task.status] as const)
    .filter((item): item is [BridgeTask, string | undefined, string] => Boolean(item[0].id) && Boolean(item[2]))
  const runTransitions = runs.map((run) => [run, notifiedRunStatuses.get(run.id || ''), run.status] as const).filter((item): item is [BridgeRun, string | undefined, string] => Boolean(item[0].id) && Boolean(item[2]))

  for (const [task, fromRaw, to] of taskTransitions) {
    const from = fromRaw
    if (task.id === undefined || to === from) continue
    if (!from && to !== 'queued') continue
    if (shouldSendAttentionTaskAlert(task, from, to)) {
      await enqueueAttentionAlert(db, buildTaskLifecycleAlertPayload(task, from, to))
    }
    if (options.sendTelegram) {
      await sendLifecycleTelegramMessage(
        db,
        settings,
        `task:${task.id}:${from ?? 'new'}:${to}`,
        buildTaskLifecycleMessage(task, from),
      )
    }
  }
  for (const [run, fromRaw, status] of runTransitions) {
    const from = fromRaw
    if (run.id === undefined || status === from) continue
    if (!from && !isRecentRun(run)) continue
    if (status !== 'running' && status !== 'blocked' && status !== 'done') continue
    if (shouldSendAttentionRunAlert(run, from, status)) {
      await enqueueAttentionAlert(db, buildRunLifecycleAlertPayload(run, from, status))
    }
    if (options.sendTelegram) {
      await sendLifecycleTelegramMessage(
        db,
        settings,
        `run:${run.id}:${from ?? 'new'}:${status}`,
        buildRunLifecycleMessage(run, from),
      )
    }
  }

  trackLifecycleState(tasks, runs, notifiedTaskStatuses, notifiedRunStatuses)
  for (const task of tasks) {
    if (task.id && task.status) notifiedTaskStatuses.set(task.id, task.status)
  }
  for (const run of runs) {
    if (run.id && run.status) notifiedRunStatuses.set(run.id, run.status)
  }
}

async function sendLifecycleTelegramMessage(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  key: string,
  message: string,
) {
  if (!message) return
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return
  if (hasSuccessfulDelivery(db, settings.chatId, 'lifecycle_update', key)) return
  try {
    const sent = await sendMessage(token, settings.chatId, message)
    recordDelivery(db, settings.chatId, 'lifecycle_update', key, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'lifecycle_update', key, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

function buildTaskLifecycleMessage(task: BridgeTask, from: string | undefined) {
  const status = `${from ?? 'new'} -> ${task.status ?? 'unknown'}`
  const lines = [
    `Polaris update: ${task.title ?? 'task update'}`,
    `Project: ${task.project || 'unknown'}`,
    `Status: ${status}`,
    task.source ? `Source: ${task.source}` : null,
  ].filter(Boolean)
  if (task.status === 'needs-input' || task.status === 'blocked') {
    lines.push('Polaris needs a decision before using more model time.')
  }
  return lines.join('\n')
}

function buildRunLifecycleMessage(run: BridgeRun, from: string | undefined) {
  const lines = [
    'Northstar run lifecycle',
    `Run: ${run.id}`,
    `Status: ${from ?? 'new'} → ${run.status ?? 'unknown'}`,
    run.taskId ? `Task: ${run.taskId}` : null,
    run.projectId ? `Project: ${run.projectId}` : null,
    run.model ? `Model: ${run.model}` : null,
  ].filter(Boolean)
  if (run.attachCommand) {
    lines.push(`Attach: ${run.attachCommand}`)
  }
  return lines.join('\n')
}

export async function notifyActions(db: DatabaseSync, settings: TelegramBridgeSettings, rawActions: unknown[], options: { importantOnly?: boolean } = {}) {
  const actions = rawActions
    .filter(isBridgeInboxAction)
    .filter((action) => settings.notifyPriorities.includes(action.priority))
    .filter((action) => !options.importantOnly || isImportantPriority(action.priority))
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  for (const action of actions) {
    const key = action.id
    if (hasSuccessfulDelivery(db, settings.chatId, 'inbox_action', key)) continue
    try {
      const sent = await sendMessage(token, settings.chatId, buildInboxMessage(action), { replyMarkup: buildInboxKeyboard(action) })
      recordDelivery(db, settings.chatId, 'inbox_action', key, 'sent', sent.message_id)
    } catch (error) {
      recordDelivery(db, settings.chatId, 'inbox_action', key, 'failed', null, errorMessage(error))
      recordTelegramError(db, errorMessage(error))
    }
  }
}

export async function notifyStaleInbox(db: DatabaseSync, settings: TelegramBridgeSettings) {
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  // Throttle: at most one stale-inbox reminder per cooldown window per chat.
  const recentReminder = db
    .prepare(
      `SELECT 1 FROM telegram_delivery_log
       WHERE event_type = 'stale_inbox' AND chat_id = ? AND status = 'sent'
         AND updated_at > datetime('now', ?)
       LIMIT 1`,
    )
    .get(settings.chatId, `-${Math.round(telegramStaleInboxCooldownMs / 1000)} seconds`)
  if (recentReminder) return

  // Stale = still unresolved and first notified longer than the age window ago.
  // inbox_actions has no created_at; the original inbox_action delivery is the age anchor.
  const stale = db
    .prepare(
      `SELECT ia.id, ia.priority, ia.title
       FROM inbox_actions ia
       JOIN telegram_delivery_log dl
         ON dl.event_type = 'inbox_action' AND dl.event_key = ia.id AND dl.chat_id = ? AND dl.status = 'sent'
       WHERE ia.resolved_at IS NULL
         AND dl.updated_at <= datetime('now', ?)
       ORDER BY dl.updated_at
       LIMIT 5`,
    )
    .all(settings.chatId, `-${Math.round(telegramStaleInboxAgeMs / 1000)} seconds`) as Array<{ id: string; priority: string; title: string }>
  if (!stale.length) return

  const total = (db
    .prepare('SELECT COUNT(*) AS count FROM inbox_actions WHERE resolved_at IS NULL')
    .get() as { count: number }).count
  const lines = [
    `Polaris reminder: ${total} inbox item${total === 1 ? '' : 's'} still waiting on you.`,
    ...stale.map((action) => `- ${action.priority} ${action.title.replace(/\s+/g, ' ').trim().slice(0, 70)} -> /resolve ${action.id} 1`),
    total > stale.length ? `...and ${total - stale.length} more. Use /overview for the full list.` : 'Reply with /resolve ID CHOICE to keep the loop moving.',
  ]

  const eventKey = `stale:${Date.now()}`
  try {
    const sent = await sendMessage(token, settings.chatId, lines.join('\n'))
    recordDelivery(db, settings.chatId, 'stale_inbox', eventKey, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'stale_inbox', eventKey, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

export async function notifySchedulerTick(db: DatabaseSync, settings: TelegramBridgeSettings, result: unknown) {
  if (typeof result !== 'object' || result === null) return
  const record = result as { dispatched?: unknown }
  const dispatched = Array.isArray(record.dispatched) ? record.dispatched.length : 0
  if (dispatched === 0) return
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return
  const key = `scheduler:${Date.now()}`
  try {
    const sent = await sendMessage(token, settings.chatId, `Northstar scheduler dispatched ${dispatched} queued task${dispatched === 1 ? '' : 's'}.`)
    recordDelivery(db, settings.chatId, 'scheduler_tick', key, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'scheduler_tick', key, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

export async function notifyRuns(db: DatabaseSync, settings: TelegramBridgeSettings, rawRuns: unknown[], tasks: BridgeTask[] = []) {
  const telegramTaskIds = new Set(tasks.filter(isNotificationTask).map((task) => task.id).filter((id): id is string => Boolean(id)))
  const runs = rawRuns
    .filter(isBridgeRun)
    .filter((run) => isImportantRunNotification(run, telegramTaskIds))
    .slice(0, 5)
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  for (const run of runs) {
    const key = `${run.id}:${run.status}`
    if (hasSuccessfulDelivery(db, settings.chatId, 'run_result', key)) continue
    try {
      const sent = await sendMessage(token, settings.chatId, buildRunMessage(run))
      recordDelivery(db, settings.chatId, 'run_result', key, 'sent', sent.message_id)
    } catch (error) {
      recordDelivery(db, settings.chatId, 'run_result', key, 'failed', null, errorMessage(error))
      recordTelegramError(db, errorMessage(error))
    }
  }
}

function isImportantRunNotification(run: BridgeRun, telegramTaskIds: Set<string>) {
  if (!isRecentRun(run)) return false
  if (run.status === 'blocked' || run.status === 'failed') return true
  if (run.status !== 'done') return false
  return Boolean(run.taskId && (telegramTaskIds.has(run.taskId) || run.taskId.startsWith('TG-')))
}

export function queueDigest(db: DatabaseSync, settings: TelegramBridgeSettings, state: DigestState, tasks: BridgeTask[], runs: BridgeRun[]) {
  for (const task of tasks) {
    if (!task.id) continue
    const status = task.status ?? ''
    if (!['needs-input', 'blocked', 'queued', 'running', 'done'].includes(status)) continue
    const key = `${task.id}:${status}`
    if (state.seenTaskKeys.has(key)) continue
    if (state.taskKeys.has(key)) continue
    state.seenTaskKeys.add(key)
    state.taskKeys.add(key)
    if (task.project) state.projects.add(task.project)
    if (status === 'needs-input') state.needsInput += 1
    if (status === 'blocked') state.blocked += 1
  }
  for (const run of runs) {
    if (!run.id) continue
    const status = run.status ?? ''
    if (!['blocked', 'failed', 'done'].includes(status)) continue
    const key = `${run.id}:${status}`
    if (state.seenRunKeys.has(key)) continue
    if (state.runKeys.has(key)) continue
    state.seenRunKeys.add(key)
    state.runKeys.add(key)
    if (run.projectId) state.projects.add(run.projectId)
    if (status === 'done') state.runFinished += 1
    if (status === 'blocked' || status === 'failed') state.blocked += 1
  }

  const changed = state.taskKeys.size + state.runKeys.size
  if (changed === 0 || state.timer) return
  state.timer = setTimeout(() => {
    state.timer = null
    void sendDigestMessage(db, settings, state)
  }, telegramDigestWindowMs)
  state.timer.unref?.()
}

async function sendDigestMessage(db: DatabaseSync, settings: TelegramBridgeSettings, state: DigestState) {
  const changed = state.taskKeys.size + state.runKeys.size
  if (changed === 0) return
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  const lines = [
    `Polaris update: ${changed} update${changed === 1 ? '' : 's'}`,
    state.needsInput ? `${state.needsInput} need${state.needsInput === 1 ? 's' : ''} input` : null,
    state.runFinished ? `${state.runFinished} run${state.runFinished === 1 ? '' : 's'} finished` : null,
    state.blocked ? `${state.blocked} blocked/failed` : null,
    state.projects.size ? `Projects: ${[...state.projects].slice(0, 4).join(', ')}${state.projects.size > 4 ? ', ...' : ''}` : null,
    state.action ?? 'Use /overview or /next for details.',
  ].filter((line): line is string => Boolean(line))

  const eventKey = `digest:${Date.now()}`
  try {
    const sent = await sendMessage(token, settings.chatId, lines.join('\n'))
    recordDelivery(db, settings.chatId, 'digest', eventKey, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'digest', eventKey, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  } finally {
    state.taskKeys.clear()
    state.runKeys.clear()
    state.needsInput = 0
    state.runFinished = 0
    state.blocked = 0
    state.projects.clear()
    state.action = null
  }
}

export async function notifyRunningRunTelemetry(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  rawRuns: unknown[],
  runTelemetryState: Map<string, RunTelemetryState>,
  runTelemetryChunkChars: number,
  runTelemetryOutputMs: number,
) {
  const runs = rawRuns.filter(isBridgeRun).filter((run) => run.status === 'running')
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  const now = Date.now()
  const effectiveChunkChars = Number.isFinite(runTelemetryChunkChars) && runTelemetryChunkChars > 120 ? runTelemetryChunkChars : defaultRunTelemetryChunkChars
  const effectiveOutputMs = Number.isFinite(runTelemetryOutputMs) && runTelemetryOutputMs > 1 ? runTelemetryOutputMs : defaultRunTelemetryOutputMs

  const runningIds = new Set<string>()

  for (const run of runs) {
    if (!run.id) continue
    runningIds.add(run.id)
    const previous = runTelemetryState.get(run.id) ?? {
      stdoutCursor: 0,
      stderrCursor: 0,
      sequence: 0,
      lastSentAt: 0,
    }

    const stdout = run.stdout || ''
    const stderr = run.stderr || ''
    const normalizedStdout = typeof stdout === 'string' ? stdout : ''
    const normalizedStderr = typeof stderr === 'string' ? stderr : ''

    const hasCursorReset = previous.stdoutCursor > normalizedStdout.length || previous.stderrCursor > normalizedStderr.length
    const stdoutCursor = hasCursorReset ? 0 : previous.stdoutCursor
    const stderrCursor = hasCursorReset ? 0 : previous.stderrCursor
    const next = {
      stdoutCursor: hasCursorReset ? 0 : normalizedStdout.length,
      stderrCursor: hasCursorReset ? 0 : normalizedStderr.length,
      sequence: previous.sequence,
      lastSentAt: previous.lastSentAt,
    }

    const previousStdout = normalizedStdout.slice(stdoutCursor)
    const previousStderr = normalizedStderr.slice(stderrCursor)
    const hasDelta = previousStdout.length > 0 || previousStderr.length > 0
    if (!hasDelta && now - previous.lastSentAt < effectiveOutputMs) {
      runTelemetryState.set(run.id, next)
      continue
    }

    if (!hasDelta && now - previous.lastSentAt >= effectiveOutputMs) {
      const key = `run:${run.id}:idle:${++next.sequence}`
      const message = buildRunTelemetryHeartbeatMessage(run)
      await sendRunTelemetryMessage(db, settings, token, key, message)
      next.lastSentAt = now
      runTelemetryState.set(run.id, next)
      continue
    }

    const message = buildRunTelemetryMessage(run, previousStdout, previousStderr, effectiveChunkChars)
    const key = `run:${run.id}:stream:${++next.sequence}`
    await sendRunTelemetryMessage(db, settings, token, key, message)
    next.stdoutCursor = normalizedStdout.length
    next.stderrCursor = normalizedStderr.length
    next.lastSentAt = now
    runTelemetryState.set(run.id, next)
  }

  for (const runId of [...runTelemetryState.keys()]) {
    if (!runningIds.has(runId)) runTelemetryState.delete(runId)
  }
}

async function sendRunTelemetryMessage(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  token: string,
  key: string,
  message: string,
) {
  if (!message) return
  if (hasSuccessfulDelivery(db, settings.chatId, 'run_telemetry', key)) return
  try {
    const sent = await sendMessage(token, settings.chatId, message)
    recordDelivery(db, settings.chatId, 'run_telemetry', key, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'run_telemetry', key, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

function buildRunTelemetryMessage(run: BridgeRun, stdoutDelta: string, stderrDelta: string, chunkChars: number) {
  const lines = [
    'Northstar run telemetry',
    `Run: ${run.id}`,
    `Task: ${run.taskId ?? 'unknown'}`,
    `Project: ${run.projectId ?? 'unknown'}`,
    `Model: ${run.model ?? 'unknown'}`,
    `Status: ${run.status ?? 'running'}`,
    run.attachCommand ? `Attach: ${run.attachCommand}` : null,
    '',
    'STDOUT',
  ]
  const stdoutLines = clip(stdoutDelta || '(no new stdout yet)', chunkChars)
  const stderrLines = clip(stderrDelta || '(no new stderr yet)', chunkChars)
  return [
    ...lines.filter((line): line is string => line !== null),
    stdoutLines,
    '',
    'STDERR',
    stderrLines,
  ].join('\n')
}

function buildRunTelemetryHeartbeatMessage(run: BridgeRun) {
  return [
    'Northstar run telemetry',
    `Run: ${run.id}`,
    `Task: ${run.taskId ?? 'unknown'}`,
    `Project: ${run.projectId ?? 'unknown'}`,
    `Model: ${run.model ?? 'unknown'}`,
    `Status: ${run.status ?? 'running'}`,
    run.attachCommand ? `Attach: ${run.attachCommand}` : null,
    '',
    'No new output captured in the latest poll window.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}
