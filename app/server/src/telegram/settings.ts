import type { DatabaseSync } from 'node:sqlite'

import { defaultPriorities, defaultTelegramAgent, defaultTelegramModel } from './constants.js'
import type { TelegramBridgeInput, TelegramBridgeSettings, TelegramSession, TelegramSessionRow, TelegramSettingsRow } from './types.js'
import {
  cleanChatId,
  cleanProjectName,
  cleanSessionToken,
  parseIdList,
  parseJson,
  parsePriorities,
  uniqueIds,
} from './utils.js'

export function listTelegramSessions(db: DatabaseSync): TelegramSession[] {
  const rows = db
    .prepare(
      `SELECT chat_id, thread_id, project, model, agent, cwd, session_key, updated_at
       FROM telegram_sessions
       ORDER BY datetime(updated_at) DESC
       LIMIT 50`,
    )
    .all() as TelegramSessionRow[]
  return rows.map(mapTelegramSessionRow)
}

export function upsertTelegramSession(db: DatabaseSync, input: {
  chatId: string
  threadId?: string
  project: string
  model?: string
  agent?: string
  cwd?: string
}): TelegramSession {
  const threadId = input.threadId?.trim() || 'main'
  const project = cleanProjectName(input.project)
  const model = cleanSessionToken(input.model || defaultTelegramModel) || defaultTelegramModel
  const agent = cleanSessionToken(input.agent || defaultTelegramAgent) || defaultTelegramAgent
  const cwd = input.cwd?.trim() || ''
  const sessionKey = `${cleanChatId(input.chatId)}:${threadId}:${project}`
  db.prepare(
    `INSERT INTO telegram_sessions
      (chat_id, thread_id, project, model, agent, cwd, session_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id, thread_id) DO UPDATE SET
       project = excluded.project,
       model = excluded.model,
       agent = excluded.agent,
       cwd = excluded.cwd,
       session_key = excluded.session_key,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(cleanChatId(input.chatId), threadId, project, model, agent, cwd, sessionKey)
  return getTelegramSession(db, cleanChatId(input.chatId), threadId) as TelegramSession
}

export function getTelegramSession(db: DatabaseSync, chatId: string, threadId: string): TelegramSession | null {
  const row = db
    .prepare(
      `SELECT chat_id, thread_id, project, model, agent, cwd, session_key, updated_at
       FROM telegram_sessions
       WHERE chat_id = ? AND thread_id = ?`,
    )
    .get(chatId, threadId) as TelegramSessionRow | undefined
  return row ? mapTelegramSessionRow(row) : null
}

export function seedTelegramBridgeSettings(db: DatabaseSync) {
  const allowed = parseIdList(process.env.NORTHSTAR_TELEGRAM_ALLOWED_USER_IDS ?? '')
  const priorities = parsePriorities(process.env.NORTHSTAR_TELEGRAM_NOTIFY_PRIORITIES, defaultPriorities)
  db.prepare(
    `INSERT OR IGNORE INTO telegram_bridge_settings
      (id, enabled, chat_id, allowed_user_ids_json, notify_inbox, notify_run_results, notify_important, notify_lifecycle_debug, notify_run_telemetry_debug, notify_digest, notify_scheduler, notify_priorities_json)
     VALUES ('default', ?, ?, ?, 1, 1, 1, 0, 0, 1, 0, ?)`,
  ).run(
    process.env.NORTHSTAR_TELEGRAM_ENABLED === '1' ? 1 : 0,
    cleanChatId(process.env.NORTHSTAR_TELEGRAM_CHAT_ID ?? ''),
    JSON.stringify(allowed),
    JSON.stringify(priorities),
  )
}

export function getTelegramBridgeSettings(db: DatabaseSync): TelegramBridgeSettings {
  seedTelegramBridgeSettings(db)
  const row = db.prepare("SELECT * FROM telegram_bridge_settings WHERE id = 'default'").get() as TelegramSettingsRow
  const envChatId = cleanChatId(process.env.NORTHSTAR_TELEGRAM_CHAT_ID ?? '')
  const envAllowedUserIds = parseIdList(process.env.NORTHSTAR_TELEGRAM_ALLOWED_USER_IDS ?? '')
  const envPriorities = parsePriorities(process.env.NORTHSTAR_TELEGRAM_NOTIFY_PRIORITIES, [])
  const mapped = normalizeDebugSettings(mapSettingsRow(row))

  return {
    ...mapped,
    enabled: mapped.enabled || process.env.NORTHSTAR_TELEGRAM_ENABLED === '1',
    chatId: envChatId || mapped.chatId,
    allowedUserIds: uniqueIds([...mapped.allowedUserIds, ...envAllowedUserIds]),
    notifyPriorities: envPriorities.length ? envPriorities : mapped.notifyPriorities,
  }
}

export function updateTelegramBridgeSettings(db: DatabaseSync, input: TelegramBridgeInput) {
  const current = getTelegramBridgeSettings(db)
  const next = {
    ...current,
    ...input,
    chatId: cleanChatId(input.chatId ?? current.chatId),
    allowedUserIds: uniqueIds(input.allowedUserIds ?? current.allowedUserIds),
    notifyPriorities: parsePriorities(input.notifyPriorities, current.notifyPriorities),
    notifyImportant: input.notifyImportant ?? input.notifyRunResults ?? current.notifyImportant,
    notifyLifecycleDebug: input.notifyLifecycleDebug ?? current.notifyLifecycleDebug,
    notifyRunTelemetryDebug: input.notifyRunTelemetryDebug ?? current.notifyRunTelemetryDebug,
    notifyDigest: input.notifyDigest ?? current.notifyDigest,
    debugUntil: input.debugUntil === undefined ? current.debugUntil : input.debugUntil,
  }

  db.prepare(
    `INSERT INTO telegram_bridge_settings
      (id, enabled, chat_id, allowed_user_ids_json, notify_inbox, notify_run_results, notify_important, notify_lifecycle_debug, notify_run_telemetry_debug, notify_digest, debug_until, notify_scheduler, notify_priorities_json, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       chat_id = excluded.chat_id,
       allowed_user_ids_json = excluded.allowed_user_ids_json,
       notify_inbox = excluded.notify_inbox,
       notify_run_results = excluded.notify_run_results,
       notify_important = excluded.notify_important,
       notify_lifecycle_debug = excluded.notify_lifecycle_debug,
       notify_run_telemetry_debug = excluded.notify_run_telemetry_debug,
       notify_digest = excluded.notify_digest,
       debug_until = excluded.debug_until,
       notify_scheduler = excluded.notify_scheduler,
       notify_priorities_json = excluded.notify_priorities_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    next.enabled ? 1 : 0,
    next.chatId,
    JSON.stringify(next.allowedUserIds),
    next.notifyInbox ? 1 : 0,
    next.notifyImportant ? 1 : 0,
    next.notifyImportant ? 1 : 0,
    next.notifyLifecycleDebug ? 1 : 0,
    next.notifyRunTelemetryDebug ? 1 : 0,
    next.notifyDigest ? 1 : 0,
    next.debugUntil,
    next.notifyScheduler ? 1 : 0,
    JSON.stringify(next.notifyPriorities),
  )

  return getTelegramBridgeSettings(db)
}

export function mapSettingsRow(row: TelegramSettingsRow): TelegramBridgeSettings {
  const notifyImportant = row.notify_important === undefined ? row.notify_run_results === 1 : row.notify_important === 1
  return {
    id: row.id,
    enabled: row.enabled === 1,
    chatId: row.chat_id,
    allowedUserIds: parseJson<string[]>(row.allowed_user_ids_json, []).map(String),
    notifyInbox: row.notify_inbox === 1,
    notifyRunResults: notifyImportant,
    notifyImportant,
    notifyLifecycleDebug: row.notify_lifecycle_debug === 1,
    notifyRunTelemetryDebug: row.notify_run_telemetry_debug === 1,
    notifyDigest: row.notify_digest === undefined ? true : row.notify_digest === 1,
    debugUntil: row.debug_until ?? null,
    notifyScheduler: row.notify_scheduler === 1,
    notifyPriorities: parsePriorities(parseJson<unknown[]>(row.notify_priorities_json, defaultPriorities), defaultPriorities),
    lastUpdateId: row.last_update_id,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }
}

export function normalizeDebugSettings(settings: TelegramBridgeSettings): TelegramBridgeSettings {
  if (!settings.debugUntil) return settings
  const until = Date.parse(settings.debugUntil)
  if (!Number.isFinite(until) || until <= Date.now()) {
    return {
      ...settings,
      notifyLifecycleDebug: false,
      notifyRunTelemetryDebug: false,
      debugUntil: null,
    }
  }
  return settings
}

export function mapTelegramSessionRow(row: TelegramSessionRow): TelegramSession {
  return {
    chatId: row.chat_id,
    threadId: row.thread_id,
    project: row.project,
    model: row.model,
    agent: row.agent,
    cwd: row.cwd,
    sessionKey: row.session_key,
    updatedAt: row.updated_at,
  }
}
