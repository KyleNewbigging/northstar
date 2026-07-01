#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const action = args.includes('--uninstall')
  ? 'uninstall'
  : args.includes('--status')
    ? 'status'
    : 'install'

const providedRepo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : undefined
const repoRoot = resolve(typeof providedRepo === 'string' ? providedRepo : process.cwd())
const home = homedir()
const nsHome = join(home, '.northstar')
const launchAgentsDir = join(home, 'Library', 'LaunchAgents')
const logDir = join(nsHome, 'logs', 'launchd')
const launchUser = args.includes('--user')
  ? args[args.indexOf('--user') + 1]
  : String(process.getuid())
const uid = Number(launchUser)
const userLabel = `gui/${uid}`

const services = [
  {
    label: 'local.northstar.server',
    name: 'server',
    command: 'npm run server',
  },
  {
    label: 'local.northstar.web',
    name: 'web',
    command: 'npm run dev:web',
  },
]

const defaultEnv = expandPath(process.env.PATH)

if (process.platform !== 'darwin') {
  throw new Error('setup-launchd.mjs is macOS-only. Use another launch method on this platform.')
}

if (isNaN(uid) || uid <= 0) {
  throw new Error(`Invalid uid: ${launchUser}. Pass --user <uid> if needed.`)
}

for (const service of services) {
  const plistPath = join(launchAgentsDir, `${service.label}.plist`)

  if (action === 'install') {
    writePlist(service, plistPath)
    bootstrap(service.label, plistPath)
    continue
  }

  if (action === 'status') {
    checkStatus(service.label)
    continue
  }

  removePlist(plistPath)
  bootout(service.label, true)
}

if (action === 'install') {
  console.info('Northstar launchd services installed with loopback-only commands.')
  checkStatus(services[0].label)
  checkStatus(services[1].label)
}

function writePlist(service, plistPath) {
  mkdirSync(launchAgentsDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  mkdirSync(nsHome, { recursive: true })

  const command = `cd ${shellEscape(repoRoot)} && ${service.command}`
  const outLog = join(logDir, `${service.name}.out.log`)
  const errLog = join(logDir, `${service.name}.err.log`)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${service.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${xmlText(command)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlText(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(errLog)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlText(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlText(home)}</string>
    <key>PATH</key>
    <string>${xmlText(defaultEnv)}</string>
    <key>NORTHSTAR_HOME</key>
    <string>${xmlText(nsHome)}</string>
  </dict>
</dict>
</plist>
`
  writeFileSync(plistPath, xml, 'utf8')
}

function bootstrap(label, plistPath) {
  try {
    bootout(label, true)
  } catch {
    // Ignore if the service was not loaded.
  }
  execSync(`launchctl bootstrap ${userLabel} "${plistPath}"`, { stdio: 'inherit' })
}

function bootout(label, ignoreMissing = false) {
  try {
    execSync(`launchctl bootout ${userLabel}/${label}`, { stdio: 'inherit' })
  } catch (error) {
    if (!ignoreMissing) {
      throw error
    }
  }
}

function removePlist(plistPath) {
  if (existsSync(plistPath)) {
    rmSync(plistPath)
  }
}

function checkStatus(label) {
  try {
    const result = execSync(`launchctl print ${userLabel}/${label}`, { encoding: 'utf8' }).toString()
    const runningMatch = /state = (running|stopped|inactive)/i.exec(result)
    const state = runningMatch?.[1] ?? 'unknown'
    const pidMatch = /pid = (\d+)/.exec(result)
    const pid = pidMatch?.[1] ? ` pid=${pidMatch[1]}` : ''
    console.info(`${label}: ${state}${pid}`)
  } catch {
    console.info(`${label}: not installed for ${userLabel}`)
  }
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function xmlText(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function expandPath(input) {
  const candidates = [
    ...(typeof input === 'string' && input.includes(':') ? input.split(':') : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  return [...new Set(candidates.filter(Boolean))].join(':')
}
