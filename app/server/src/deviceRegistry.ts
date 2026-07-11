import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'

import { getDeviceFilesStatus } from './deviceFiles.js'
import { getSchedulerSettings } from './scheduler.js'
import { isWhisperAvailable } from './transcribe.js'

export type DeviceCapabilities = {
  tmux: boolean
  ripgrep: boolean
  whisper: boolean
  maxParallelRuns: number
  models: string[]
}

export type DeviceTailscale = {
  hostname?: string
  ips?: string[]
} | null

export type DeviceProfile = {
  deviceId: string
  hostname: string
  platform: string
  arch: string
  nodeVersion: string
  appVersion: string
  capabilities: DeviceCapabilities
  tailscale: DeviceTailscale
  startedAt: string
  updatedAt: string
}

export type DeviceRegistryEntry = DeviceProfile & {
  online: boolean
  self: boolean
}

export type DeviceHeartbeatWrite =
  | { ok: true; path: string; deviceId: string }
  | { ok: false; code: 'dropbox_unavailable' | 'write_failed'; error?: string }

const processStartedAt = new Date().toISOString()
const defaultOfflineAfterMs = 15 * 60 * 1000
const minOfflineAfterMs = 60 * 1000

let cachedAppVersion: string | null = null
let cachedTmux: boolean | null = null
let cachedRipgrep: boolean | null = null
let cachedWhisper: boolean | null = null
let cachedTailscale: DeviceTailscale | undefined

export function collectDeviceProfile(db: DatabaseSync): DeviceProfile {
  const status = getDeviceFilesStatus()
  const scheduler = getSchedulerSettings(db)
  const capabilities: DeviceCapabilities = {
    tmux: probeTmux(),
    ripgrep: probeRipgrep(),
    whisper: probeWhisper(),
    maxParallelRuns: scheduler.maxParallelRuns,
    models: enabledModels(scheduler),
  }
  return {
    deviceId: status.currentDevice,
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    appVersion: readAppVersion(),
    capabilities,
    tailscale: probeTailscale(),
    startedAt: processStartedAt,
    updatedAt: new Date().toISOString(),
  }
}

export function writeDeviceHeartbeat(db: DatabaseSync): DeviceHeartbeatWrite {
  const status = getDeviceFilesStatus()
  if (!status.rootExists) return { ok: false, code: 'dropbox_unavailable' }
  try {
    const profile = collectDeviceProfile(db)
    const dir = join(status.rootPath, 'devices')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${profile.deviceId}.json`)
    writeFileSync(path, stableStringify(profile), { mode: 0o600 })
    return { ok: true, path, deviceId: profile.deviceId }
  } catch (error) {
    return { ok: false, code: 'write_failed', error: error instanceof Error ? error.message : String(error) }
  }
}

export function listDevices(options: { now?: number; offlineAfterMs?: number } = {}): DeviceRegistryEntry[] {
  const status = getDeviceFilesStatus()
  if (!status.rootExists) return []
  const dir = join(status.rootPath, 'devices')
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const now = options.now ?? Date.now()
  const threshold = clampOfflineMs(options.offlineAfterMs ?? configuredOfflineMs())
  const selfId = status.currentDevice
  const entries: DeviceRegistryEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    const profile = safeReadProfile(path)
    if (!profile) continue
    const updated = Date.parse(profile.updatedAt)
    const online = Number.isFinite(updated) ? now - updated <= threshold : false
    entries.push({ ...profile, online, self: profile.deviceId === selfId })
  }
  entries.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
  return entries
}

function safeReadProfile(path: string): DeviceProfile | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId.trim() : ''
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : ''
  if (!deviceId || !updatedAt) return null
  const capabilitiesRaw = (record.capabilities && typeof record.capabilities === 'object') ? record.capabilities as Record<string, unknown> : {}
  const capabilities: DeviceCapabilities = {
    tmux: Boolean(capabilitiesRaw.tmux),
    ripgrep: Boolean(capabilitiesRaw.ripgrep),
    whisper: Boolean(capabilitiesRaw.whisper),
    maxParallelRuns: Number.isFinite(Number(capabilitiesRaw.maxParallelRuns)) ? Number(capabilitiesRaw.maxParallelRuns) : 0,
    models: Array.isArray(capabilitiesRaw.models) ? capabilitiesRaw.models.filter((m): m is string => typeof m === 'string') : [],
  }
  return {
    deviceId,
    hostname: typeof record.hostname === 'string' ? record.hostname : '',
    platform: typeof record.platform === 'string' ? record.platform : '',
    arch: typeof record.arch === 'string' ? record.arch : '',
    nodeVersion: typeof record.nodeVersion === 'string' ? record.nodeVersion : '',
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : '',
    capabilities,
    tailscale: normalizeTailscale(record.tailscale),
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    updatedAt,
  }
}

function normalizeTailscale(value: unknown): DeviceTailscale {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const out: { hostname?: string; ips?: string[] } = {}
  if (typeof record.hostname === 'string' && record.hostname) out.hostname = record.hostname
  if (Array.isArray(record.ips)) {
    const ips = record.ips.filter((ip): ip is string => typeof ip === 'string')
    if (ips.length) out.ips = ips
  }
  return Object.keys(out).length ? out : null
}

function enabledModels(scheduler: ReturnType<typeof getSchedulerSettings>): string[] {
  const models: string[] = []
  if (scheduler.sparkEnabled) models.push('spark')
  if (scheduler.opusEnabled) models.push('opus')
  if (scheduler.codexEnabled) models.push('codex')
  return models
}

function probeTmux(): boolean {
  if (cachedTmux !== null) return cachedTmux
  const configured = process.env.NORTHSTAR_TMUX_BIN?.trim()
  if (configured) {
    const result = spawnSync(configured, ['-V'], { encoding: 'utf8', timeout: 3000 })
    cachedTmux = result.status === 0
    return cachedTmux
  }
  const found = spawnSync('/bin/sh', ['-lc', 'command -v tmux'], { encoding: 'utf8', timeout: 3000 })
  cachedTmux = found.status === 0 && found.stdout.trim().length > 0
  return cachedTmux
}

function probeRipgrep(): boolean {
  if (cachedRipgrep !== null) return cachedRipgrep
  const envBin = process.env.NORTHSTAR_RIPGREP_BIN?.trim()
  const bin = envBin || 'rg'
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 })
  cachedRipgrep = result.status === 0
  return cachedRipgrep
}

function probeWhisper(): boolean {
  if (cachedWhisper !== null) return cachedWhisper
  try {
    cachedWhisper = isWhisperAvailable()
  } catch {
    cachedWhisper = false
  }
  return cachedWhisper
}

function probeTailscale(): DeviceTailscale {
  if (cachedTailscale !== undefined) return cachedTailscale
  try {
    const result = spawnSync('tailscale', ['status', '--json', '--self=true', '--peers=false'], { encoding: 'utf8', timeout: 3000 })
    if (result.status !== 0 || !result.stdout) {
      cachedTailscale = null
      return cachedTailscale
    }
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    const self = (parsed.Self && typeof parsed.Self === 'object') ? parsed.Self as Record<string, unknown> : null
    if (!self) {
      cachedTailscale = null
      return cachedTailscale
    }
    const out: { hostname?: string; ips?: string[] } = {}
    if (typeof self.HostName === 'string' && self.HostName) out.hostname = self.HostName
    if (Array.isArray(self.TailscaleIPs)) {
      const ips = self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
      if (ips.length) out.ips = ips
    }
    cachedTailscale = Object.keys(out).length ? out : null
    return cachedTailscale
  } catch {
    cachedTailscale = null
    return cachedTailscale
  }
}

function readAppVersion(): string {
  if (cachedAppVersion !== null) return cachedAppVersion
  const candidates = new Set<string>()
  try {
    const here = fileURLToPath(import.meta.url)
    let dir = dirname(here)
    for (let i = 0; i < 6; i++) {
      candidates.add(join(dir, 'package.json'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // ignore
  }
  candidates.add(resolve(process.cwd(), 'package.json'))
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (parsed && parsed.name === 'northstar' && typeof parsed.version === 'string') {
        cachedAppVersion = parsed.version
        return cachedAppVersion
      }
    } catch {
      continue
    }
  }
  cachedAppVersion = '0.0.0'
  return cachedAppVersion
}

function stableStringify(profile: DeviceProfile): string {
  const ordered: Record<string, unknown> = {
    deviceId: profile.deviceId,
    hostname: profile.hostname,
    platform: profile.platform,
    arch: profile.arch,
    nodeVersion: profile.nodeVersion,
    appVersion: profile.appVersion,
    capabilities: {
      tmux: profile.capabilities.tmux,
      ripgrep: profile.capabilities.ripgrep,
      whisper: profile.capabilities.whisper,
      maxParallelRuns: profile.capabilities.maxParallelRuns,
      models: [...profile.capabilities.models].sort(),
    },
    tailscale: profile.tailscale
      ? {
          ...(profile.tailscale.hostname ? { hostname: profile.tailscale.hostname } : {}),
          ...(profile.tailscale.ips ? { ips: [...profile.tailscale.ips].sort() } : {}),
        }
      : null,
    startedAt: profile.startedAt,
    updatedAt: profile.updatedAt,
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

function configuredOfflineMs(): number {
  const raw = Number(process.env.NORTHSTAR_DEVICE_OFFLINE_AFTER_MS)
  if (!Number.isFinite(raw) || raw <= 0) return defaultOfflineAfterMs
  return raw
}

function clampOfflineMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return defaultOfflineAfterMs
  return Math.max(minOfflineAfterMs, Math.floor(value))
}

export function _resetDeviceRegistryCachesForTests() {
  cachedAppVersion = null
  cachedTmux = null
  cachedRipgrep = null
  cachedWhisper = null
  cachedTailscale = undefined
}
