import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { usageRoot } from './paths.js'
import type { DispatchModel } from './agentRunner.js'

export type UsageSourceKind = 'claude_statusline' | 'chatgpt_codex_analytics' | 'codex_app_server' | 'local_estimate'

export type ProviderUsageSnapshot = {
  id?: DispatchModel
  source: UsageSourceKind
  provider: string
  capturedAt: string
  staleAfterSeconds?: number
  fiveHourUsedPct?: number | null
  weeklyUsedPct?: number | null
  fiveHourResetAt?: string | null
  weeklyResetAt?: string | null
  currentTokens?: number | null
  weeklyTokens?: number | null
  raw?: unknown
}

export type CodexUsageSnapshot = {
  source: 'chatgpt_codex_analytics' | 'codex_app_server'
  provider: 'OpenAI'
  capturedAt: string
  staleAfterSeconds?: number
  models?: Array<ProviderUsageSnapshot & { id: 'codex' | 'spark' }>
  raw?: unknown
}

type CodexAppServerRateLimitWindow = {
  usedPercent?: number | null
  windowDurationMins?: number | null
  resetsAt?: number | null
}

type CodexAppServerRateLimit = {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexAppServerRateLimitWindow | null
  secondary?: CodexAppServerRateLimitWindow | null
}

type CodexAppServerRateLimitResponse = {
  rateLimits?: CodexAppServerRateLimit | null
  rateLimitsByLimitId?: Record<string, CodexAppServerRateLimit | undefined> | null
}

export const claudeUsagePath = join(usageRoot, 'claude-code.json')
export const codexUsagePath = join(usageRoot, 'codex.json')

export function readClaudeUsageSnapshot() {
  return readSnapshot<ProviderUsageSnapshot>(claudeUsagePath)
}

export function readCodexUsageSnapshot() {
  return readSnapshot<CodexUsageSnapshot>(codexUsagePath)
}

export function writeCodexUsageSnapshot(snapshot: CodexUsageSnapshot) {
  writeFileSync(codexUsagePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  return codexUsagePath
}

export async function readOrRefreshCodexUsageSnapshot() {
  const cached = readCodexUsageSnapshot()
  if (isFresh(cached, 60)) return cached
  return (await readCodexUsageFromAppServer().catch(() => null)) ?? cached
}

export async function readCodexUsageFromAppServer(timeoutMs = 12000) {
  const result = await requestCodexAppServerRateLimits(timeoutMs)
  const snapshot = codexSnapshotFromRateLimits(result)
  if (!snapshot.models?.length) return null
  writeCodexUsageSnapshot(snapshot)
  return snapshot
}

export function isFresh(snapshot: { capturedAt?: string; staleAfterSeconds?: number } | null, fallbackSeconds = 15 * 60) {
  if (!snapshot?.capturedAt) return false
  const captured = Date.parse(snapshot.capturedAt)
  if (!Number.isFinite(captured)) return false
  const maxAge = (snapshot.staleAfterSeconds ?? fallbackSeconds) * 1000
  return Date.now() - captured <= maxAge
}

function readSnapshot<T>(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function requestCodexAppServerRateLimits(timeoutMs: number) {
  return new Promise<CodexAppServerRateLimitResponse>((resolve, reject) => {
    const env = { ...process.env }
    delete env.OPENAI_API_KEY
    delete env.CODEX_API_KEY
    delete env.ANTHROPIC_API_KEY

    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    })
    let buffer = ''
    let settled = false
    let childExited = false
    const timer = setTimeout(() => finish(null, new Error('codex app-server rate limit read timed out')), timeoutMs)

    const send = (message: unknown) => {
      if (settled || child.stdin.destroyed || child.stdin.writableEnded) return false
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) finish(null, error)
        })
        return true
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)))
        return false
      }
    }
    const finish = (result: CodexAppServerRateLimitResponse | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!childExited) child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(result ?? {})
    }

    child.on('error', (error) => finish(null, error))
    child.stdin.on('error', (error) => finish(null, error))
    child.stdout.on('error', (error) => finish(null, error))
    child.on('exit', () => {
      childExited = true
      if (!settled) finish(null, new Error('codex app-server exited before returning rate limits'))
    })
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) handleMessage(line)
        newline = buffer.indexOf('\n')
      }
    })

    const handleMessage = (line: string) => {
      let message: { id?: number; method?: string; result?: CodexAppServerRateLimitResponse; error?: unknown }
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id === 0 && message.result) {
        send({ method: 'initialized', params: {} })
        send({ id: 1, method: 'account/rateLimits/read' })
        return
      }
      if (message.id === 1) {
        if (message.error) finish(null, new Error(JSON.stringify(message.error)))
        else finish(message.result ?? {})
      }
    }

    send({
      id: 0,
      method: 'initialize',
      params: {
        clientInfo: { name: 'northstar_usage_probe', title: 'Northstar Usage Probe', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })
  })
}

function codexSnapshotFromRateLimits(response: CodexAppServerRateLimitResponse): CodexUsageSnapshot {
  const limits: CodexAppServerRateLimit[] = []
  for (const [limitId, limit] of Object.entries(response.rateLimitsByLimitId ?? {})) {
    if (limit) limits.push({ ...limit, limitId: limit.limitId ?? limitId })
  }
  if (response.rateLimits && !limits.some((limit) => limit.limitId === response.rateLimits?.limitId)) {
    limits.push(response.rateLimits)
  }

  const codex = limits.find((limit) => limit.limitId === 'codex')
  const spark = limits.find((limit) =>
    limit.limitId === 'codex_bengalfox' ||
    limit.limitName?.toLowerCase().includes('spark') ||
    limit.limitId?.toLowerCase().includes('spark'),
  )

  const models: Array<ProviderUsageSnapshot & { id: 'codex' | 'spark' }> = []
  if (codex) models.push(providerSnapshotFromRateLimit('codex', codex))
  if (spark) models.push(providerSnapshotFromRateLimit('spark', spark))

  return {
    source: 'codex_app_server',
    provider: 'OpenAI',
    capturedAt: new Date().toISOString(),
    staleAfterSeconds: 60,
    models,
    raw: response,
  }
}

function providerSnapshotFromRateLimit(id: 'codex' | 'spark', limit: CodexAppServerRateLimit): ProviderUsageSnapshot & { id: 'codex' | 'spark' } {
  const fiveHour = rateLimitWindow(limit, 300) ?? limit.primary ?? null
  const weekly = rateLimitWindow(limit, 10080) ?? limit.secondary ?? null
  return {
    id,
    source: 'codex_app_server' as const,
    provider: 'OpenAI',
    capturedAt: new Date().toISOString(),
    staleAfterSeconds: 60,
    fiveHourUsedPct: pct(fiveHour?.usedPercent),
    weeklyUsedPct: pct(weekly?.usedPercent),
    fiveHourResetAt: resetIso(fiveHour?.resetsAt),
    weeklyResetAt: resetIso(weekly?.resetsAt),
    raw: limit,
  }
}

function rateLimitWindow(limit: CodexAppServerRateLimit, durationMins: number) {
  return [limit.primary, limit.secondary].find((window) => window?.windowDurationMins === durationMins) ?? null
}

function pct(value: unknown) {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return null
  return Math.max(0, Math.min(100, numberValue))
}

function resetIso(epochSeconds: unknown) {
  const numberValue = Number(epochSeconds)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null
  return new Date(numberValue * 1000).toISOString()
}
