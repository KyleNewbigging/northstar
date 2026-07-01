#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const usageDir = join(process.env.NORTHSTAR_HOME ?? join(homedir(), '.northstar'), 'usage')
const outputPath = join(usageDir, 'codex.json')

const args = process.argv.slice(2)
const stdin = await readStdin()
const inputPath = valueAfter('--file')
const input = inputPath ? readFileSync(inputPath, 'utf8') : stdin
const parsed = input.trim() ? JSON.parse(input) : null

const snapshot = normalizeSnapshot(parsed)
mkdirSync(usageDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
console.log(outputPath)

function normalizeSnapshot(value) {
  if (value?.source === 'chatgpt_codex_analytics') {
    return {
      source: 'chatgpt_codex_analytics',
      provider: 'OpenAI',
      capturedAt: value.capturedAt ?? new Date().toISOString(),
      staleAfterSeconds: value.staleAfterSeconds ?? 15 * 60,
      models: normalizeModels(value.models ?? []),
      raw: value.raw ?? value,
    }
  }

  const models = normalizeModels(value?.models ?? [
    {
      id: 'codex',
      fiveHourUsedPct: numericFlag('--codex-5h'),
      weeklyUsedPct: numericFlag('--codex-week'),
      fiveHourResetAt: valueAfter('--codex-5h-reset'),
      weeklyResetAt: valueAfter('--codex-week-reset'),
    },
    {
      id: 'spark',
      fiveHourUsedPct: numericFlag('--spark-5h'),
      weeklyUsedPct: numericFlag('--spark-week'),
      fiveHourResetAt: valueAfter('--spark-5h-reset'),
      weeklyResetAt: valueAfter('--spark-week-reset'),
    },
  ])

  return {
    source: 'chatgpt_codex_analytics',
    provider: 'OpenAI',
    capturedAt: new Date().toISOString(),
    staleAfterSeconds: numericFlag('--stale-after') ?? 15 * 60,
    models,
    raw: value ?? { args },
  }
}

function normalizeModels(models) {
  return models
    .filter((item) => item?.id === 'codex' || item?.id === 'spark')
    .map((item) => ({
      id: item.id,
      source: 'chatgpt_codex_analytics',
      provider: 'OpenAI',
      capturedAt: item.capturedAt ?? new Date().toISOString(),
      staleAfterSeconds: item.staleAfterSeconds ?? 15 * 60,
      fiveHourUsedPct: cleanPct(item.fiveHourUsedPct ?? item.five_hour_used_percentage ?? item.fiveHour?.used_percentage),
      weeklyUsedPct: cleanPct(item.weeklyUsedPct ?? item.sevenDayUsedPct ?? item.weekly_used_percentage ?? item.weekly?.used_percentage ?? item.seven_day?.used_percentage),
      fiveHourResetAt: normalizeReset(item.fiveHourResetAt ?? item.five_hour_reset_at ?? item.fiveHour?.resets_at),
      weeklyResetAt: normalizeReset(item.weeklyResetAt ?? item.sevenDayResetAt ?? item.weekly_reset_at ?? item.weekly?.resets_at ?? item.seven_day?.resets_at),
      raw: item,
    }))
}

function normalizeReset(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value)
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric
    return new Date(ms).toISOString()
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function cleanPct(value) {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return null
  return Math.min(100, Math.max(0, numberValue))
}

function numericFlag(name) {
  const value = valueAfter(name)
  if (value == null) return null
  return cleanPct(value)
}

function valueAfter(name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1] ?? null
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
  })
}
