import { existsSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import { telegramBotTokenPath } from '../paths.js'
import { apiRoot } from './constants.js'
import type { TelegramApiResponse, TelegramSentMessage } from './types.js'
import { clip } from './utils.js'

export async function sendMessage(token: string, chatId: string, text: string, options: { replyMarkup?: Record<string, unknown> } = {}) {
  return telegramCall<TelegramSentMessage>(token, 'sendMessage', {
    chat_id: chatId,
    text: clip(text, 4096),
    link_preview_options: { is_disabled: true },
    reply_markup: options.replyMarkup,
  })
}

export async function answerCallbackQuery(token: string, callbackQueryId: string, text: string) {
  return telegramCall<true>(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: clip(text, 180),
    show_alert: false,
  })
}

export async function telegramCall<T>(token: string, method: string, body: Record<string, unknown>) {
  const filteredBody = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))
  const response = await fetch(`${apiRoot}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(filteredBody),
  })
  const json = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null
  if (!response.ok || !json?.ok) {
    const detail = json?.description || `Telegram ${method} returned HTTP ${response.status}`
    throw new Error(detail)
  }
  return json.result as T
}

export function readTelegramBotToken() {
  const env = process.env.NORTHSTAR_TELEGRAM_BOT_TOKEN?.trim()
  if (env) return env
  if (!existsSync(telegramBotTokenPath)) return ''
  return readFileSync(telegramBotTokenPath, 'utf8').trim()
}

export function hasSuccessfulDelivery(db: DatabaseSync, chatId: string, eventType: string, eventKey: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM telegram_delivery_log
       WHERE chat_id = ? AND event_type = ? AND event_key = ? AND status = 'sent'`,
    )
    .get(chatId, eventType, eventKey) as { count: number }
  return row.count > 0
}

export function recordDelivery(db: DatabaseSync, chatId: string, eventType: string, eventKey: string, status: 'sent' | 'failed', messageId?: number | null, error?: string) {
  db.prepare(
    `INSERT INTO telegram_delivery_log
      (id, event_type, event_key, chat_id, telegram_message_id, status, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(event_type, event_key, chat_id) DO UPDATE SET
       telegram_message_id = excluded.telegram_message_id,
       status = excluded.status,
       error = excluded.error,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(`${eventType}:${eventKey}:${chatId}`, eventType, eventKey, chatId, messageId ?? null, status, error ?? null)
}

export function recordTelegramUpdate(db: DatabaseSync, updateId: number) {
  db.prepare(
    `UPDATE telegram_bridge_settings
     SET last_update_id = ?, last_seen_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = 'default'`,
  ).run(updateId)
}

export function recordTelegramError(db: DatabaseSync, error: string) {
  db.prepare(
    `UPDATE telegram_bridge_settings
     SET last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = 'default'`,
  ).run(clip(error, 500))
}
