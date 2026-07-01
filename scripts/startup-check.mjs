#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)

const endpoint = readArg('--endpoint') ?? 'http://127.0.0.1:4317'
const heartbeatPath = readArg('--heartbeat-path') ?? join(homedir(), '.northstar', 'heartbeat.md')
const heartbeatMaxAgeMs = Number(readArg('--heartbeat-max-age-ms') ?? '90000')
const intervalMs = Number(readArg('--interval-ms') ?? '0')
const skipHeartbeatCheck = args.includes('--skip-heartbeat')
const skipServer = args.includes('--skip-server')
const skipTmux = args.includes('--skip-tmux')
const strict = args.includes('--strict')
const checkQueue = !args.includes('--skip-queue-check')
const runOnce = args.includes('--once') || !intervalMs
const jsonOut = args.includes('--json')
const checkLaunchd = args.includes('--check-launchd') || args.includes('--launchd')
const launchdUser = readArg('--launchd-user') ?? String(process.getuid())
const launchdServicesArg = readArg('--launchd-services') ?? 'local.northstar.server,local.northstar.web'
const launchdServices = launchdServicesArg
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean)
const queueMaxBlocked = Number(readArg('--max-blocked') ?? '5')
const queueMaxNeedsInput = Number(readArg('--max-needs-input') ?? '10')
const queueMaxQueued = Number(readArg('--max-queued') ?? '250')
const queueMaxAttentionPending = Number(readArg('--max-attention-pending') ?? '100')
const queueMaxAttentionFailed = Number(readArg('--max-attention-failed') ?? '5')

if (!Number.isFinite(heartbeatMaxAgeMs) || heartbeatMaxAgeMs <= 0) {
  throw new Error(`Invalid --heartbeat-max-age-ms value: ${readArg('--heartbeat-max-age-ms')}`)
}
if (!Number.isFinite(intervalMs) || intervalMs < 0) {
  throw new Error(`Invalid --interval-ms value: ${readArg('--interval-ms')}`)
}
if (!Number.isFinite(queueMaxBlocked) || queueMaxBlocked < 0) {
  throw new Error(`Invalid --max-blocked value: ${readArg('--max-blocked')}`)
}
if (!Number.isFinite(queueMaxNeedsInput) || queueMaxNeedsInput < 0) {
  throw new Error(`Invalid --max-needs-input value: ${readArg('--max-needs-input')}`)
}
if (!Number.isFinite(queueMaxQueued) || queueMaxQueued < 0) {
  throw new Error(`Invalid --max-queued value: ${readArg('--max-queued')}`)
}
if (!Number.isFinite(queueMaxAttentionPending) || queueMaxAttentionPending < 0) {
  throw new Error(`Invalid --max-attention-pending value: ${readArg('--max-attention-pending')}`)
}
if (!Number.isFinite(queueMaxAttentionFailed) || queueMaxAttentionFailed < 0) {
  throw new Error(`Invalid --max-attention-failed value: ${readArg('--max-attention-failed')}`)
}

await runLoop()

async function runLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const checkRunners = [runtimeHomeCheck, heartbeatFileCheck]
    if (!skipTmux) checkRunners.push(tmuxCheck)
    if (checkLaunchd) checkRunners.push(launchdCheck)
    if (!skipServer) {
      checkRunners.push(heartbeatEndpointCheck)
      checkRunners.push(telegramEndpointCheck)
      checkRunners.push(telegramTokenCheck)
      if (checkQueue) checkRunners.push(queueHealthCheck)
      if (checkQueue) checkRunners.push(attentionAlertHealthCheck)
    }

    const checks = await Promise.all(checkRunners.map((runCheck) => Promise.resolve(runCheck())))

    const hasFail = checks.some((item) => item.status === 'fail')
    const hasWarn = checks.some((item) => item.status === 'warn')
    const hasRequiredFail = checks.some((item) => item.required === 'required' && item.status === 'fail')

    if (!jsonOut) {
      checks.forEach((item) => {
        const status = item.status.toUpperCase().padEnd(5)
        const requiredText = item.required === 'required' ? 'REQUIRED' : 'optional'
        const line = `${status} | ${requiredText.padEnd(8)} | ${item.name} :: ${item.detail}`
        if (item.status === 'fail') {
          console.error(line)
        } else if (item.status === 'warn') {
          console.warn(line)
        } else {
          console.log(line)
        }
      })

      console.info(`check summary: ${checks.filter((item) => item.status === 'ok').length}/${checks.length} ok, ${checks.filter((item) => item.status === 'warn').length} warn, ${checks.filter((item) => item.status === 'fail').length} fail`)
    } else {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        endpoint,
        heartbeatPath,
        checks,
      }, null, 2))
    }

    if (hasFail || (strict && hasWarn)) {
      process.exit(hasRequiredFail || hasFail ? 2 : 1)
    }

    if (!intervalMs || runOnce) break
    await delay(intervalMs)
  }
}

function runtimeHomeCheck() {
  const path = join(homedir(), '.northstar')
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
    return {
      name: 'northstar_home',
      required: 'required',
      status: 'ok',
      detail: `writable runtime directory exists at ${path}`,
    }
  } catch {
    return {
      name: 'northstar_home',
      required: 'required',
      status: 'fail',
      detail: `cannot read/write ${path}`,
    }
  }
}

function heartbeatFileCheck() {
  if (!existsSync(heartbeatPath)) {
    return {
      name: 'heartbeat_file',
      required: 'optional',
      status: 'warn',
      detail: `missing heartbeat file at ${heartbeatPath}`,
    }
  }

  try {
    const content = readFileSync(heartbeatPath, 'utf8')
    const updatedAt = parseUpdatedAt(content)
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
      return {
        name: 'heartbeat_file',
        required: 'optional',
        status: 'warn',
        detail: `heartbeat file exists at ${heartbeatPath} but updated time is unreadable`,
      }
    }

    const ageMs = Date.now() - Date.parse(updatedAt)
    const detail = `heartbeat updatedAt=${updatedAt} age=${Math.round(ageMs / 1000)}s`

    if (skipHeartbeatCheck) {
      return {
        name: 'heartbeat_file',
        required: 'optional',
        status: 'ok',
        detail: 'skipped freshness gating with --skip-heartbeat',
      }
    }

    if (ageMs <= heartbeatMaxAgeMs) {
      return {
        name: 'heartbeat_file',
        required: skipHeartbeatCheck ? 'optional' : 'required',
        status: 'ok',
        detail,
      }
    }

    return {
      name: 'heartbeat_file',
      required: skipHeartbeatCheck ? 'optional' : 'required',
      status: skipHeartbeatCheck ? 'warn' : 'fail',
      detail: `${detail}; stale beyond ${Math.round(heartbeatMaxAgeMs / 1000)}s threshold`,
    }
  } catch (error) {
    return {
      name: 'heartbeat_file',
      required: 'optional',
      status: skipHeartbeatCheck ? 'warn' : 'fail',
      detail: `failed to read heartbeat file: ${errorMessage(error)}`,
    }
  }
}

function tmuxCheck() {
  const configured = process.env.NORTHSTAR_TMUX_BIN?.trim()
  const result = resolveTmuxExecutable(configured)

  if (result.ok) {
    return {
      name: 'tmux',
      required: 'required',
      status: 'ok',
      detail: `tmux available: ${result.value}`,
    }
  }

  return {
    name: 'tmux',
    required: 'required',
    status: 'fail',
    detail: result.error,
  }
}

async function heartbeatEndpointCheck() {
  if (skipHeartbeatCheck) {
    return {
      name: 'heartbeat_endpoint',
      required: 'required',
      status: 'ok',
      detail: 'skipped by --skip-heartbeat',
    }
  }

  try {
    const payload = await fetchJson(`${endpoint}/api/heartbeat`)
    const updatedAt = typeof payload.updatedAt === 'string' ? payload.updatedAt : null
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
      return {
        name: 'heartbeat_endpoint',
        required: 'required',
        status: 'fail',
        detail: 'endpoint response missing valid updatedAt',
      }
    }

    const ageMs = Date.now() - Date.parse(updatedAt)
    const detail = `serving heartbeat updatedAt=${updatedAt}`
    if (ageMs > heartbeatMaxAgeMs) {
      return {
        name: 'heartbeat_endpoint',
        required: 'required',
        status: 'fail',
        detail: `${detail} · stale by ${Math.round(ageMs / 1000)}s`,
      }
    }

    return {
      name: 'heartbeat_endpoint',
      required: 'required',
      status: 'ok',
      detail,
    }
  } catch (error) {
    return {
      name: 'heartbeat_endpoint',
      required: 'required',
      status: skipServer ? 'warn' : 'fail',
      detail: `cannot reach ${endpoint}/api/heartbeat: ${errorMessage(error)}`,
    }
  }
}

async function telegramEndpointCheck() {
  try {
    const payload = await fetchJson(`${endpoint}/api/telegram/status`)
    const status = payload?.settings
    const needs = payload?.needs

    if (!status) {
      return {
        name: 'telegram_endpoint',
        required: 'optional',
        status: 'warn',
        detail: 'telegram status payload missing settings',
      }
    }

    if (status.enabled !== true) {
      return {
        name: 'telegram_endpoint',
        required: 'optional',
        status: 'warn',
        detail: 'telegram bridge is not enabled',
      }
    }

    const missing = [
      needs?.token ? 'token' : null,
      needs?.chat ? 'chat' : null,
      needs?.allowedUsers ? 'allowed_users' : null,
    ].filter(Boolean)

    if (missing.length === 0) {
      return {
        name: 'telegram_endpoint',
        required: 'required',
        status: 'ok',
        detail: `bridge ready for chat ${String(status.chatId)}`,
      }
    }

    return {
      name: 'telegram_endpoint',
      required: 'required',
      status: 'warn',
      detail: `bridge enabled but readiness missing: ${missing.join(', ')}`,
    }
  } catch (error) {
    return {
      name: 'telegram_endpoint',
      required: 'optional',
      status: 'warn',
      detail: `cannot reach ${endpoint}/api/telegram/status: ${errorMessage(error)}`,
    }
  }
}

function telegramTokenCheck() {
  const token = (process.env.NORTHSTAR_TELEGRAM_BOT_TOKEN || '').trim()
  const tokenFile = join(homedir(), '.northstar', 'secrets', 'telegram-bot-token')
  const fileToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''

  if (token || fileToken) {
    return {
      name: 'telegram_token',
      required: 'optional',
      status: 'ok',
      detail: token ? 'token configured via NORTHSTAR_TELEGRAM_BOT_TOKEN' : `token file exists at ${tokenFile}`,
    }
  }

  return {
    name: 'telegram_token',
    required: 'required',
    status: 'warn',
    detail: 'telegram enabled but no token source detected',
  }
}

async function queueHealthCheck() {
  try {
    const payload = await fetchJson(`${endpoint}/api/queue`)
    if (!payload || !Array.isArray(payload.tasks)) {
      return {
        name: 'queue_health',
        required: 'required',
        status: 'fail',
        detail: 'queue payload missing tasks array',
      }
    }

    const tasks = payload.tasks
    const blocked = tasks.filter((item) => item?.status === 'blocked' || item?.status === 'needs-input').length
    const needsInput = tasks.filter((item) => item?.status === 'needs-input').length
    const queued = tasks.filter((item) => item?.status === 'queued').length
    const detail = `blocked=${blocked}, needs_input=${needsInput}, queued=${queued}, total=${tasks.length}`

    if (blocked > queueMaxBlocked) {
      return {
        name: 'queue_health',
        required: 'required',
        status: strict ? 'fail' : 'warn',
        detail: `${detail}; blocked items exceed threshold ${queueMaxBlocked}`,
      }
    }
    if (needsInput > queueMaxNeedsInput) {
      return {
        name: 'queue_health',
        required: 'optional',
        status: 'warn',
        detail: `${detail}; needs-input items exceed threshold ${queueMaxNeedsInput}`,
      }
    }
    if (queued > queueMaxQueued) {
      return {
        name: 'queue_health',
        required: 'optional',
        status: 'warn',
        detail: `${detail}; queued items exceed threshold ${queueMaxQueued}`,
      }
    }

    return {
      name: 'queue_health',
      required: 'required',
      status: 'ok',
      detail,
    }
  } catch (error) {
    return {
      name: 'queue_health',
      required: 'required',
      status: skipServer ? 'warn' : 'fail',
      detail: `cannot reach ${endpoint}/api/queue: ${errorMessage(error)}`,
    }
  }
}

async function attentionAlertHealthCheck() {
  try {
    const payload = await fetchJson(`${endpoint}/api/attention-alerts`)
    if (!payload || !Array.isArray(payload.alerts)) {
      return {
        name: 'attention_alerts',
        required: 'optional',
        status: strict ? 'fail' : 'warn',
        detail: 'attention alerts endpoint response missing alerts array',
      }
    }

    const alerts = payload.alerts
    const failed = alerts.filter((item) => item?.status === 'failed').length
    const pending = alerts.filter((item) => item?.status === 'pending').length
    const sent = alerts.filter((item) => item?.status === 'sent').length
    const detail = `attention alerts: pending=${pending}, failed=${failed}, sent=${sent}`

    if (failed > queueMaxAttentionFailed) {
      return {
        name: 'attention_alerts',
        required: 'optional',
        status: strict ? 'fail' : 'warn',
        detail: `${detail}; failed items exceed threshold ${queueMaxAttentionFailed}`,
      }
    }
    if (pending > queueMaxAttentionPending) {
      return {
        name: 'attention_alerts',
        required: 'optional',
        status: strict ? 'fail' : 'warn',
        detail: `${detail}; pending items exceed threshold ${queueMaxAttentionPending}`,
      }
    }

    return {
      name: 'attention_alerts',
      required: 'optional',
      status: 'ok',
      detail,
    }
  } catch (error) {
    return {
      name: 'attention_alerts',
      required: 'optional',
      status: strict ? 'fail' : 'warn',
      detail: `cannot reach ${endpoint}/api/attention-alerts: ${errorMessage(error)}`,
    }
  }
}

function launchdCheck() {
  if (process.platform !== 'darwin') {
    return {
      name: 'launchd_services',
      required: 'optional',
      status: 'warn',
      detail: 'launchd checks are macOS-only',
    }
  }

  const missing = []
  const stopped = []

  for (const label of launchdServices) {
    try {
      const output = execSync(`launchctl print gui/${launchdUser}/${label}`, { encoding: 'utf8' })
      if (!/state = running/i.test(output)) {
        stopped.push(label)
      }
    } catch {
      missing.push(label)
    }
  }

  if (missing.length === 0 && stopped.length === 0) {
    return {
      name: 'launchd_services',
      required: 'optional',
      status: 'ok',
      detail: `services running: ${launchdServices.join(', ')}`,
    }
  }

  if (missing.length > 0) {
    return {
      name: 'launchd_services',
      required: 'optional',
      status: 'warn',
      detail: `missing service labels: ${missing.join(', ')}`,
    }
  }

  return {
    name: 'launchd_services',
    required: 'optional',
    status: 'warn',
    detail: `services not running: ${stopped.join(', ')}`,
  }
}

function resolveTmuxExecutable(configured) {
  if (configured) {
    const configuredResult = spawnSync(configured, ['-V'], { encoding: 'utf8', env: sanitizedEnv() })
    if (configuredResult.status === 0) return { ok: true, value: configured }
    return { ok: false, error: `NORTHSTAR_TMUX_BIN set to ${configured} but not runnable` }
  }

  const found = spawnSync('/bin/sh', ['-lc', 'command -v tmux'], { encoding: 'utf8', env: sanitizedEnv() })
  if (found.status !== 0) {
    return { ok: false, error: 'tmux is not in PATH; install it with `brew install tmux` or set NORTHSTAR_TMUX_BIN' }
  }

  const executable = found.stdout.trim().split('\n')[0]
  if (!executable) {
    return { ok: false, error: 'command -v tmux returned no executable path' }
  }

  const version = spawnSync(executable, ['-V'], { encoding: 'utf8', env: sanitizedEnv() })
  if (version.status !== 0) {
    return { ok: false, error: `tmux exists at ${executable} but could not run version check` }
  }

  return { ok: true, value: executable }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function parseUpdatedAt(content = '') {
  const match = /^Updated:\s*(.+)$/m.exec(content)
  return match?.[1]?.trim() ?? null
}

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function sanitizedEnv() {
  return {
    ...process.env,
    NODE_OPTIONS: undefined,
    NODE_NO_WARNINGS: '1',
  }
}
