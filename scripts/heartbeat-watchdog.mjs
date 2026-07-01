#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const endpoint = readArg('--endpoint') ?? 'http://127.0.0.1:4317/api/heartbeat'
const staleLimitMs = Number(readArg('--max-age-ms') ?? '90000')
const pollMs = Number(readArg('--interval-ms') ?? '0')
const notify = args.includes('--notify')
const once = args.includes('--once')
const heartbeatPath = readArg('--heartbeat-path') ?? join(homedir(), '.northstar', 'heartbeat.md')
const logPath = join(homedir(), '.northstar', 'logs', 'heartbeat-watchdog.log')
const statePath = join(homedir(), '.northstar', 'heartbeat-watchdog-state.json')
const telegramToken = readArg('--telegram-token') ?? readFile(join(homedir(), '.northstar', 'secrets', 'telegram-bot-token')) ?? process.env.NORTHSTAR_TELEGRAM_BOT_TOKEN
const telegramChatId = readArg('--telegram-chat-id') ?? process.env.NORTHSTAR_TELEGRAM_CHAT_ID
const minimumAlertMs = Number(readArg('--notify-cooldown-ms') ?? '900000')

if (!Number.isFinite(staleLimitMs) || staleLimitMs <= 0) {
  throw new Error(`Invalid --max-age-ms value: ${readArg('--max-age-ms')}`)
}
if (!Number.isFinite(pollMs) || pollMs < 0) {
  throw new Error(`Invalid --interval-ms value: ${readArg('--interval-ms')}`)
}

await runLoop()

async function runLoop() {
  let hadFailure = false
  let lastAlertAt = readState()

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now()
    const result = await checkHeartbeat()
    if (result.healthy) {
      console.info(`[ok] heartbeat fresh | updated=${result.updatedAt ?? 'n/a'} | endpoint=${endpoint}`)
      lastAlertAt = 0
    } else {
      hadFailure = true
      const ageMs = result.updatedAt ? now - Date.parse(result.updatedAt) : Number.NaN
      const message = `[warn] heartbeat stale: ${result.reason} | ageMs=${Number.isFinite(ageMs) ? Math.round(ageMs) : 'n/a'} | endpoint=${endpoint}`
      console.warn(message)
      if (
        notify &&
        telegramToken &&
        telegramChatId &&
        (lastAlertAt === 0 || now - lastAlertAt > minimumAlertMs)
      ) {
        await sendTelegramAlert(`${message}\n${result.detail}`)
        lastAlertAt = now
      }
    }

    await appendLog(result.healthy ? 'healthy' : 'stale', result.reason)
    if (!pollMs || once) break
    await delay(pollMs)
  }

  writeState(lastAlertAt)
  process.exit(hadFailure ? 2 : 0)
}

async function checkHeartbeat() {
  const localStatus = readLocalHeartbeat()
  try {
    const response = await fetch(endpoint, { headers: { accept: 'application/json' } })
  if (!response.ok) {
      return {
        healthy: false,
        reason: `endpoint_http_${response.status}`,
        detail: `endpoint: ${endpoint}`,
        updatedAt: localStatus.updatedAt,
      }
    }
    const payload = (await response.json())
    const payloadObj = typeof payload === 'object' && payload !== null ? payload : null
    const payloadUpdatedAt = getPayloadString(payloadObj, 'updatedAt')
    const payloadContent = getPayloadString(payloadObj, 'content')
    const updatedAt = payloadUpdatedAt || parseUpdatedAt(payloadContent ?? '')
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
      return {
        healthy: false,
        reason: 'missing_updated_at',
        detail: `Could not read updated time from ${endpoint}`,
        updatedAt: localStatus.updatedAt,
      }
    }
    const ageMs = Date.now() - Date.parse(updatedAt)
    if (ageMs <= staleLimitMs) {
      return { healthy: true, reason: 'fresh', detail: `ageMs=${Math.round(ageMs)} endpoint=${endpoint}`, updatedAt }
    }
    return {
      healthy: false,
      reason: `stale_${Math.round(ageMs / 1000)}s`,
      detail: `Updated at ${updatedAt}, limit ${Math.round(staleLimitMs / 1000)}s`,
      updatedAt,
    }
  } catch (error) {
    return {
      healthy: false,
      reason: `endpoint_error_${errorMessage(error)}`,
      detail: String(error),
      updatedAt: localStatus.updatedAt,
    }
  }
}

function readLocalHeartbeat() {
  if (!existsSync(heartbeatPath)) return { updatedAt: null, exists: false }
  try {
    const content = readFileSync(heartbeatPath, 'utf8')
    return { updatedAt: parseUpdatedAt(content), exists: true }
  } catch {
    return { updatedAt: null, exists: false }
  }
}

function parseUpdatedAt(content = '') {
  const match = /^Updated:\s*(.+)$/m.exec(content)
  return match?.[1]?.trim() ?? null
}

async function sendTelegramAlert(text) {
  try {
    const safeMessage = text.slice(0, 3500)
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: safeMessage, link_preview_options: { is_disabled: true } }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.ok === false) {
      throw new Error(body?.description ?? `HTTP ${response.status}`)
    }
  } catch (error) {
    console.warn(`Telegram alert failed: ${errorMessage(error)}`)
  }
}

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function readFile(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function getPayloadString(payload, key) {
  if (!payload || typeof payload !== 'object') return null
  const value = Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : null
  return typeof value === 'string' ? value : null
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}

function appendLog(level, reason) {
  const now = new Date().toISOString()
  mkdirSync(join(logPath, '..'), { recursive: true })
  writeFileSync(logPath, `${now} ${level} ${reason}\n`, { flag: 'a' })
}

function readState() {
  try {
    const raw = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    return Number.isFinite(parsed.lastAlertAt) ? parsed.lastAlertAt : 0
  } catch {
    return 0
  }
}

function writeState(lastAlertAt) {
  try {
    mkdirSync(join(statePath, '..'), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ lastAlertAt }), 'utf8')
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
