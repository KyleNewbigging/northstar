import type { DatabaseSync } from 'node:sqlite'

import {
  attentionEnabled,
  attentionMinPriority,
  attentionRetryMax,
  attentionWebhookSource,
  attentionWebhookToken,
  attentionWebhookUrl,
} from './constants.js'
import type {
  AttentionAlertDbRow,
  AttentionAlertPayload,
  AttentionAlertPriority,
  BridgeRun,
  BridgeTask,
} from './types.js'
import { errorMessage, isObject, isPriority, priorityWeight } from './utils.js'

export function shouldSendAttention(taskPriority: AttentionAlertPriority | undefined, minPriority: AttentionAlertPriority | null) {
  if (!minPriority) return true
  if (!taskPriority) return true
  return priorityWeight(taskPriority) <= priorityWeight(minPriority)
}

export function shouldSendAttentionTaskAlert(task: BridgeTask, from: string | undefined, to: string) {
  if (!task.id) return false
  if (!to || to === from) return false
  if (!['needs-input', 'queued', 'running', 'blocked', 'done'].includes(to)) return false
  return shouldSendAttention(task.priority, attentionMinPriority)
}

export function runAlertPriority(model?: string | null): AttentionAlertPriority {
  const normalized = String(model ?? '').toLowerCase()
  if (normalized === 'codex') return 'P1'
  if (normalized === 'opus' || normalized === 'claude') return 'P0'
  return 'P2'
}

export function shouldSendAttentionRunAlert(run: BridgeRun, from: string | undefined, status: string) {
  if (!run.id) return false
  if (!status || status === from) return false
  if (!['running', 'blocked', 'done'].includes(status)) return false
  return shouldSendAttention(runAlertPriority(run.model), attentionMinPriority)
}

export function buildAttentionPayloadKey(payload: AttentionAlertPayload) {
  return `${payload.eventType}:${payload.key}`
}

export function nextAttentionRetryDelaySeconds(attempts: number) {
  const normalizedAttempts = Math.min(Math.max(0, attempts), 8)
  const delaySeconds = 15 * 2 ** normalizedAttempts
  return Math.min(delaySeconds, 15 * 60)
}

export async function sendAttentionAlert(payload: AttentionAlertPayload) {
  const body = {
    title: payload.title,
    message: payload.text,
    text: payload.text,
    priority: payload.priority,
    channel: payload.channel,
    source: payload.source,
    project: payload.project,
    eventType: payload.eventType,
    eventKey: payload.key,
    timestamp: new Date().toISOString(),
  }

  const response = await fetch(attentionWebhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(attentionWebhookToken ? { Authorization: `Bearer ${attentionWebhookToken}` } : {}),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`PushCut webhook failed: HTTP ${response.status} ${response.statusText} ${text}`.trim())
  }
}

export function toAttentionAlertPayload(input: AttentionAlertPayload) {
  return JSON.stringify({
    eventType: input.eventType,
    key: input.key,
    title: input.title,
    text: input.text,
    priority: input.priority,
    channel: input.channel,
    source: input.source,
    project: input.project,
    createdAt: new Date().toISOString(),
  })
}

export function fromAttentionAlertRow(row: AttentionAlertDbRow) {
  let payload: AttentionAlertPayload | null = null
  try {
    const parsed = JSON.parse(row.payload_json)
    if (isAttentionPayload(parsed)) payload = parsed
  } catch {
    payload = null
  }
  return {
    ...row,
    payload,
  }
}

export function isAttentionPayload(value: unknown): value is AttentionAlertPayload {
  return (
    isObject(value)
    && (value.eventType === 'task' || value.eventType === 'run')
    && typeof value.key === 'string'
    && typeof value.title === 'string'
    && typeof value.text === 'string'
    && isPriority(value.priority)
    && typeof value.channel === 'string'
    && typeof value.project === 'string'
  )
}

export async function enqueueAttentionAlert(db: DatabaseSync, payload: AttentionAlertPayload) {
  if (!attentionEnabled()) return
  if (!shouldSendAttention(payload.priority, attentionMinPriority)) return

  const rowId = `ATTN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const serializedPayload = toAttentionAlertPayload(payload)
  const eventKey = buildAttentionPayloadKey(payload)

  db.prepare(
    `INSERT INTO attention_alerts
      (id, event_type, event_key, payload_json, status)
     VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT(event_type, event_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       status = 'pending',
       attempts = 0,
       next_retry_at = NULL,
       last_error = NULL,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(rowId, payload.eventType, eventKey, serializedPayload)
}

export async function flushPendingAttentionAlerts(db: DatabaseSync) {
  if (!attentionEnabled()) return

  const pending = db.prepare(
    `SELECT id, event_type AS event_type, event_key, payload_json, status, attempts, next_retry_at
     FROM attention_alerts
     WHERE status IN ('pending', 'failed')
       AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now'))
     ORDER BY created_at ASC`,
  ).all() as AttentionAlertDbRow[]

  if (!pending.length) return

  for (const row of pending) {
    const payload = fromAttentionAlertRow(row).payload
    if (!payload) {
      db.prepare("UPDATE attention_alerts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run('invalid payload json', row.id)
      continue
    }

    const attempts = row.attempts + 1
    try {
      await sendAttentionAlert(payload)
      db.prepare("UPDATE attention_alerts SET status = 'sent', attempts = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(attempts, row.id)
    } catch (error) {
      const shouldRetry = attempts <= attentionRetryMax && attentionRetryMax > 0
      const nextRetryMs = shouldRetry ? nextAttentionRetryDelaySeconds(attempts) * 1000 : 0
      const nextRetryAt = shouldRetry ? new Date(Date.now() + nextRetryMs).toISOString() : null
      db.prepare(
        `UPDATE attention_alerts
         SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(shouldRetry ? 'failed' : 'failed', attempts, errorMessage(error), nextRetryAt, row.id)

      if (shouldRetry) continue
    }
  }
}

export function buildTaskLifecycleAlertPayload(task: BridgeTask, from: string | undefined, to: string) {
  const message = [
    `${attentionWebhookSource} task update`,
    `Task: ${task.id}`,
    `Project: ${task.project || 'unknown'}`,
    `Status: ${from ?? 'new'} → ${to}`,
    task.source ? `Source: ${task.source}` : null,
    task.sourceRef ? `SourceRef: ${task.sourceRef}` : null,
    task.title ? `Title: ${task.title}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    eventType: 'task' as const,
    key: `${task.id}:${from ?? 'new'}:${to}`,
    title: `Northstar task ${to}: ${task.id}`,
    text: `${message}\nNo process starts until scheduler/cockpit gates this task.`,
    priority: task.priority ?? 'P2',
    channel: attentionWebhookSource,
    project: task.project ?? 'unknown',
    source: task.source,
  }
}

export function buildRunLifecycleAlertPayload(run: BridgeRun, from: string | undefined, status: string): AttentionAlertPayload {
  const message = [
    `${attentionWebhookSource} run update`,
    `Run: ${run.id}`,
    `Status: ${from ?? 'new'} → ${status}`,
    run.taskId ? `Task: ${run.taskId}` : null,
    run.projectId ? `Project: ${run.projectId}` : null,
    run.model ? `Model: ${run.model}` : null,
    run.attachCommand ? `Attach: ${run.attachCommand}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    eventType: 'run' as const,
    key: `${run.id}:${from ?? 'new'}:${status}`,
    title: `Northstar run ${status}: ${run.id}`,
    text: message,
    priority: 'P1',
    channel: attentionWebhookSource,
    project: run.projectId || 'unknown',
  }
}
