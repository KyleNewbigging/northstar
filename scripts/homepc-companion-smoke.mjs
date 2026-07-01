#!/usr/bin/env node
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)

const mode = readArg('--mode') || 'online'
const endpoint = readArg('--endpoint') || 'http://127.0.0.1:4317'
const heartbeatPath = readArg('--heartbeat-path') || join(homedir(), '.northstar', 'heartbeat.md')
const mirrorPath = readArg('--mirror-path')
const maxAgeMs = Number(readArg('--heartbeat-max-age-ms') || '90000')
const queuePath = readArg('--queue-path') || '/api/queue'
const heartbeatApiPath = readArg('--heartbeat-api-path') || '/api/heartbeat'
const telegramStatusPath = readArg('--telegram-status-api-path') || '/api/telegram/status'
const timeoutMs = Number(readArg('--timeout-ms') || '5000')
const allowFailover = args.includes('--allow-failover')
const jsonOut = args.includes('--json')
const strict = args.includes('--strict')

if (!['online', 'offline'].includes(mode)) {
  throw new Error(`Invalid --mode: ${mode}. Use online or offline.`)
}
if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
  throw new Error(`Invalid --heartbeat-max-age-ms value: ${readArg('--heartbeat-max-age-ms')}`)
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error(`Invalid --timeout-ms value: ${readArg('--timeout-ms')}`)
}

const checks = []

if (mode === 'online') {
  const online = await checkOnline()
  if (online.status !== 'ok' && !allowFailover) {
    checks.push(online)
  } else if (online.status !== 'ok' && allowFailover) {
    checks.push(online)
    checks.push(await checkMirrorFallback('API unavailable, validating drop-in mirror fallback'))
  } else {
    checks.push(online)
  }
} else {
  checks.push(await checkMirrorFallback('Offline smoke mode'))
}

const failed = checks.some((check) => check.status === 'fail')
const warnings = checks.some((check) => check.status === 'warn')

if (!jsonOut) {
  for (const check of checks) {
    const status = check.status.toUpperCase().padEnd(5)
    const level = check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warn' : 'ok'
    const logger = level === 'ok' ? console.log : level === 'warn' ? console.warn : console.error
    logger(`${status} | ${check.name} :: ${check.detail}`)
  }
  console.info(`Smoke summary: ${checks.filter((item) => item.status === 'ok').length}/${checks.length} ok, ${checks.filter((item) => item.status === 'warn').length} warn, ${checks.filter((item) => item.status === 'fail').length} fail`)
} else {
  console.log(JSON.stringify({
    mode,
    endpoint,
    checks,
    heartbeatPath,
    mirrorPath: effectiveMirrorPath(true),
    timestamp: new Date().toISOString(),
  }, null, 2))
}

if (failed || (strict && warnings)) process.exit(2)

async function checkOnline() {
  const heartbeatCheck = await checkApi(heartbeatApiPath)
  const queueCheck = await checkApi(queuePath, false)
  const telegramCheck = await checkApi(telegramStatusPath, false)

  const checksLocal = [heartbeatCheck, queueCheck, telegramCheck]
  const failCount = checksLocal.filter((item) => item.required && item.status === 'fail').length
  const endpointOk = checksLocal.every((item) => item.status === 'ok')

  if (failCount > 0) {
    return {
      name: 'companion:online',
      required: 'required',
      status: 'fail',
      detail: `online checks failed: ${checksLocal.map((item) => `${item.name}=${item.status}`).join(', ')}`,
      checks: checksLocal,
    }
  }

  if (!endpointOk) {
    return {
      name: 'companion:online',
      required: 'required',
      status: 'warn',
      detail: `online checks returned warnings: ${checksLocal.filter((item) => item.status === 'warn').map((item) => `${item.name}=${item.detail}`).join('; ') || 'none'}`,
      checks: checksLocal,
    }
  }

  const heartbeatPayload = await checkHeartbeatPayload(heartbeatCheck.payload)
  const mirrorCandidate = heartbeatPayload?.mirrorPath || mirrorPath
  if (mirrorCandidate) {
    const mirrorCheck = validateHeartbeatFile(mirrorCandidate)
    if (mirrorCheck.status === 'fail') {
      return {
        name: 'companion:online',
        required: 'optional',
        status: strict ? 'fail' : 'warn',
        detail: `mirror check failed: ${mirrorCheck.reason}`,
        checks: [...checksLocal, mirrorCheck],
      }
    }
    return {
      name: 'companion:online',
      required: 'required',
      status: 'ok',
      detail: `online checks pass; heartbeat/mirror validated at ${heartbeatPayload.updatedAt}`,
      checks: [...checksLocal, mirrorCheck],
    }
  }

  return {
    name: 'companion:online',
    required: 'required',
    status: 'warn',
    detail: `heartbeat API reachable, but mirror heartbeat path not provided. Endpoint mode still healthy.`,
    checks: checksLocal,
  }
}

async function checkMirrorFallback(prefix) {
  const fallbackPath = effectiveMirrorPath()
  if (!fallbackPath) {
    return {
      name: 'companion:mirror-fallback',
      required: 'required',
      status: 'fail',
      detail: `${prefix}: no mirror path available (set --mirror-path).`,
    }
  }

  const fileCheck = validateHeartbeatFile(fallbackPath)
  if (fileCheck.status === 'ok') {
    return {
      ...fileCheck,
      name: 'companion:mirror-fallback',
      required: 'required',
      detail: `${prefix}: ${fileCheck.reason}`,
      path: fallbackPath,
    }
  }

  return {
    name: 'companion:mirror-fallback',
    required: 'required',
    status: 'fail',
    detail: `${prefix}: ${fileCheck.reason}`,
    path: fallbackPath,
  }
}

function effectiveMirrorPath(resolve = false) {
  if (mirrorPath) {
    return resolve ? resolveMirrorFilePath(mirrorPath) : mirrorPath
  }
  const linked = readLinkMirrorFromHeartbeat()
  if (!linked) return null
  return resolve ? resolveMirrorFilePath(linked) : linked
}

function readLinkMirrorFromHeartbeat() {
  try {
    const content = readFileSync(heartbeatPath, 'utf8')
    const match = content.match(/^Dropbox:\s*(.+)$/m)?.[1]?.trim() || ''
    if (!match || match === 'not configured') return null
    const marker = match.lastIndexOf(' (')
    return marker > 0 ? match.slice(0, marker).trim() : match
  } catch {
    return null
  }
}

function validateHeartbeatFile(path) {
  const resolvedPath = resolveMirrorFilePath(path)
  if (!resolvedPath) {
    return { status: 'fail', reason: 'missing heartbeat path' }
  }
  try {
    accessSync(resolvedPath, constants.R_OK)
  } catch {
    return { status: 'fail', reason: `cannot read mirror file at ${resolvedPath}` }
  }

  const content = readFileSync(resolvedPath, 'utf8')
  const lines = ['# Northstar Heartbeat', 'updated', 'current']
  if (!lines.some((token) => content.includes(token))) {
    return { status: 'warn', reason: `mirror file at ${resolvedPath} is not a recognized heartbeat` }
  }

  const heartbeatUpdatedAt = parseUpdatedAt(content)
  if (!heartbeatUpdatedAt || Number.isNaN(Date.parse(heartbeatUpdatedAt))) {
    return { status: 'warn', reason: `mirror file at ${resolvedPath} has invalid Updated: value` }
  }

  const ageMs = Date.now() - Date.parse(heartbeatUpdatedAt)
  if (ageMs > maxAgeMs) {
    return {
      status: 'warn',
      reason: `mirror heartbeat stale at ${resolvedPath}; age=${Math.round(ageMs / 1000)}s > ${Math.round(maxAgeMs / 1000)}s limit`,
      updatedAt: heartbeatUpdatedAt,
      path: resolvedPath,
    }
  }

  return {
    status: 'ok',
    reason: `mirror heartbeat fresh at ${resolvedPath}; updatedAt=${heartbeatUpdatedAt}`,
    updatedAt: heartbeatUpdatedAt,
    path: resolvedPath,
  }
}

function resolveMirrorFilePath(rawPath) {
  const trimmed = String(rawPath ?? '').trim()
  if (!trimmed) return null

  try {
    const stats = statSync(trimmed)
    return stats.isDirectory() ? join(trimmed, 'heartbeat.md') : trimmed
  } catch {
    return trimmed.endsWith('.md') ? trimmed : join(trimmed, 'heartbeat.md')
  }
}

function parseUpdatedAt(content) {
  const match = /^Updated:\s*(.+)$/m.exec(content)
  return match?.[1]?.trim() ?? null
}

async function checkApi(apiPath, required = true) {
  const url = `${endpoint.replace(/\/+$/, '')}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`
  try {
    const payload = await fetchJsonWithTimeout(url, timeoutMs)
    if (apiPath.endsWith('heartbeat')) {
      const heartbeatUpdatedAt = (payload && typeof payload.updatedAt === 'string') ? payload.updatedAt : parseUpdatedAt(payload?.content || '')
      if (!heartbeatUpdatedAt || Number.isNaN(Date.parse(heartbeatUpdatedAt))) {
        return {
          name: apiPath,
          required: required ? 'required' : 'optional',
          status: required ? 'fail' : 'warn',
          detail: `invalid heartbeat payload from ${url}`,
          updatedAt: heartbeatUpdatedAt,
        }
      }

      const ageMs = Date.now() - Date.parse(heartbeatUpdatedAt)
      if (ageMs > maxAgeMs) {
        return {
          name: apiPath,
          required: required ? 'required' : 'optional',
          status: required ? 'fail' : 'warn',
          detail: `heartbeat stale (${Math.round(ageMs / 1000)}s) from ${url}`,
          updatedAt: heartbeatUpdatedAt,
          payload,
          mirrorPath: payload?.mirrorPath ?? null,
        }
      }
      return {
        name: apiPath,
        required: required ? 'required' : 'optional',
        status: 'ok',
        detail: `fresh at ${heartbeatUpdatedAt}`,
        updatedAt: heartbeatUpdatedAt,
        payload,
        mirrorPath: payload?.mirrorPath ?? null,
      }
    }

    if (apiPath === queuePath) {
      if (!payload || !Array.isArray(payload.tasks)) {
        return {
          name: apiPath,
          required: required ? 'required' : 'optional',
          status: required ? 'fail' : 'warn',
          detail: `unexpected shape for ${url}`,
        }
      }
      return {
        name: apiPath,
        required: required ? 'required' : 'optional',
        status: 'ok',
        detail: `task entries=${payload.tasks.length}`,
      }
    }

    if (!payload || typeof payload !== 'object') {
      return {
        name: apiPath,
        required: required ? 'optional' : 'optional',
        status: required ? 'warn' : 'warn',
        detail: `payload not object from ${url}`,
      }
    }

    return {
      name: apiPath,
      required: required ? 'optional' : 'optional',
      status: 'ok',
      detail: `reachable ${url}`,
    }
  } catch (error) {
    return {
      name: apiPath,
      required: required ? 'required' : 'optional',
      status: required ? 'fail' : 'warn',
      detail: `${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function checkHeartbeatPayload(payload) {
  if (!payload) return { status: 'warn', reason: 'missing payload for heartbeat API' }
  if (!payload.updatedAt || Number.isNaN(Date.parse(payload.updatedAt))) return { status: 'warn', reason: 'heartbeat payload missing updatedAt' }
  const mirror = payload.mirrorPath || null
  const reason = `heartbeat updatedAt=${payload.updatedAt}${mirror ? ` mirror=${mirror}` : ''}`
  return { status: 'ok', reason, updatedAt: payload.updatedAt, mirrorPath: mirror }
}

async function fetchJsonWithTimeout(url, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function readArg(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
