import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  _resetDeviceRegistryCachesForTests,
  collectDeviceProfile,
  listDevices,
  writeDeviceHeartbeat,
} from './deviceRegistry.js'
import { schemaSql } from './schema.js'
import { buildDevicesMessage } from './telegram/messages.js'

const originalRoot = process.env.NORTHSTAR_DROPBOX_ROOT
const originalDevice = process.env.NORTHSTAR_DEVICE_ID
const originalOffline = process.env.NORTHSTAR_DEVICE_OFFLINE_AFTER_MS
const originalTmux = process.env.NORTHSTAR_TMUX_BIN
const originalRg = process.env.NORTHSTAR_RIPGREP_BIN

function newDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('deviceRegistry', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'northstar-devices-'))
    process.env.NORTHSTAR_DROPBOX_ROOT = tempRoot
    process.env.NORTHSTAR_DEVICE_ID = 'test-device-alpha'
    process.env.NORTHSTAR_TMUX_BIN = '/nonexistent/tmux-does-not-exist'
    process.env.NORTHSTAR_RIPGREP_BIN = '/nonexistent/rg-does-not-exist'
    delete process.env.NORTHSTAR_DEVICE_OFFLINE_AFTER_MS
    _resetDeviceRegistryCachesForTests()
  })

  afterEach(() => {
    restoreEnv('NORTHSTAR_DROPBOX_ROOT', originalRoot)
    restoreEnv('NORTHSTAR_DEVICE_ID', originalDevice)
    restoreEnv('NORTHSTAR_DEVICE_OFFLINE_AFTER_MS', originalOffline)
    restoreEnv('NORTHSTAR_TMUX_BIN', originalTmux)
    restoreEnv('NORTHSTAR_RIPGREP_BIN', originalRg)
    _resetDeviceRegistryCachesForTests()
  })

  it('collectDeviceProfile returns expected shape', () => {
    const db = newDb()
    const profile = collectDeviceProfile(db)
    assert.equal(profile.deviceId, 'test-device-alpha')
    assert.equal(profile.platform, process.platform)
    assert.equal(profile.arch, process.arch)
    assert.equal(profile.nodeVersion, process.version)
    assert.equal(typeof profile.appVersion, 'string')
    assert.equal(profile.capabilities.tmux, false)
    assert.equal(profile.capabilities.ripgrep, false)
    assert.equal(typeof profile.capabilities.maxParallelRuns, 'number')
    assert.ok(Array.isArray(profile.capabilities.models))
    assert.ok(profile.startedAt)
    assert.ok(profile.updatedAt)
  })

  it('writeDeviceHeartbeat roundtrips through listDevices', () => {
    const db = newDb()
    const result = writeDeviceHeartbeat(db)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(existsSync(result.path))
    const devices = listDevices()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].deviceId, 'test-device-alpha')
    assert.equal(devices[0].self, true)
    assert.equal(devices[0].online, true)
  })

  it('writeDeviceHeartbeat returns dropbox_unavailable when root missing', () => {
    process.env.NORTHSTAR_DROPBOX_ROOT = join(tempRoot, 'does-not-exist')
    const db = newDb()
    const result = writeDeviceHeartbeat(db)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'dropbox_unavailable')
  })

  it('listDevices skips corrupt JSON files', () => {
    const db = newDb()
    writeDeviceHeartbeat(db)
    const dir = join(tempRoot, 'devices')
    writeFileSync(join(dir, 'broken.json'), '{not-json')
    const devices = listDevices()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].deviceId, 'test-device-alpha')
  })

  it('listDevices marks stale devices offline by updatedAt threshold', () => {
    const db = newDb()
    const dir = join(tempRoot, 'devices')
    mkdirSync(dir, { recursive: true })
    const stale = {
      deviceId: 'test-device-beta',
      hostname: 'beta',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.0.0',
      appVersion: '0.1.0',
      capabilities: { tmux: true, ripgrep: true, whisper: false, maxParallelRuns: 2, models: ['codex'] },
      tailscale: null,
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    }
    writeFileSync(join(dir, 'test-device-beta.json'), JSON.stringify(stale, null, 2))
    const devices = listDevices({ offlineAfterMs: 60_000 })
    const beta = devices.find((d) => d.deviceId === 'test-device-beta')
    assert.ok(beta)
    assert.equal(beta.online, false)
    assert.equal(beta.self, false)
  })

  it('listDevices uses injected now for threshold evaluation', () => {
    const db = newDb()
    const dir = join(tempRoot, 'devices')
    mkdirSync(dir, { recursive: true })
    const updatedAt = new Date('2026-01-01T00:00:00Z').toISOString()
    const profile = {
      deviceId: 'test-device-gamma',
      hostname: 'gamma',
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v24.0.0',
      appVersion: '0.1.0',
      capabilities: { tmux: true, ripgrep: false, whisper: false, maxParallelRuns: 4, models: ['opus'] },
      tailscale: null,
      startedAt: updatedAt,
      updatedAt,
    }
    writeFileSync(join(dir, 'test-device-gamma.json'), JSON.stringify(profile, null, 2))
    const nowJustAfter = Date.parse('2026-01-01T00:05:00Z')
    const withinWindow = listDevices({ now: nowJustAfter, offlineAfterMs: 15 * 60_000 })
    const nowMuchLater = Date.parse('2026-01-01T02:00:00Z')
    const outsideWindow = listDevices({ now: nowMuchLater, offlineAfterMs: 15 * 60_000 })
    assert.equal(withinWindow.find((d) => d.deviceId === 'test-device-gamma')?.online, true)
    assert.equal(outsideWindow.find((d) => d.deviceId === 'test-device-gamma')?.online, false)
  })

  it('listDevices marks self via NORTHSTAR_DEVICE_ID', () => {
    const db = newDb()
    writeDeviceHeartbeat(db)
    const dir = join(tempRoot, 'devices')
    const other = {
      deviceId: 'test-device-other',
      hostname: 'other',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.0.0',
      appVersion: '0.1.0',
      capabilities: { tmux: false, ripgrep: false, whisper: false, maxParallelRuns: 1, models: [] },
      tailscale: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(join(dir, 'test-device-other.json'), JSON.stringify(other, null, 2))
    const devices = listDevices()
    const self = devices.find((d) => d.self)
    assert.ok(self)
    assert.equal(self.deviceId, 'test-device-alpha')
    const otherEntry = devices.find((d) => d.deviceId === 'test-device-other')
    assert.equal(otherEntry?.self, false)
  })

  it('writeDeviceHeartbeat serializes JSON with stable capability structure', () => {
    const db = newDb()
    const result = writeDeviceHeartbeat(db)
    assert.equal(result.ok, true)
    if (!result.ok) return
    const raw = readFileSync(result.path, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.deviceId, 'test-device-alpha')
    assert.ok(parsed.capabilities)
    assert.equal(typeof parsed.capabilities.tmux, 'boolean')
    assert.equal(typeof parsed.capabilities.ripgrep, 'boolean')
    assert.ok(Array.isArray(parsed.capabilities.models))
  })

  it('buildDevicesMessage renders empty state when no devices', () => {
    const message = buildDevicesMessage([])
    assert.match(message, /No devices/i)
  })

  it('buildDevicesMessage renders online/offline lines with capabilities and self marker', () => {
    const now = Date.parse('2026-01-01T00:10:00Z')
    const message = buildDevicesMessage(
      [
        {
          deviceId: 'alpha',
          hostname: 'alpha',
          platform: 'darwin',
          arch: 'arm64',
          nodeVersion: 'v24.0.0',
          appVersion: '0.1.0',
          capabilities: { tmux: true, ripgrep: true, whisper: false, maxParallelRuns: 2, models: ['codex', 'opus'] },
          tailscale: null,
          startedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:09:30Z',
          online: true,
          self: true,
        },
        {
          deviceId: 'beta',
          hostname: 'beta',
          platform: 'linux',
          arch: 'x64',
          nodeVersion: 'v24.0.0',
          appVersion: '0.1.0',
          capabilities: { tmux: false, ripgrep: true, whisper: true, maxParallelRuns: 1, models: [] },
          tailscale: null,
          startedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2025-12-31T20:00:00Z',
          online: false,
          self: false,
        },
      ],
      { now },
    )
    assert.match(message, /alpha · self/)
    assert.match(message, /darwin/)
    assert.match(message, /tmux/)
    assert.match(message, /beta · offline/)
    assert.match(message, /last seen .* ago/)
  })
})
