import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const northstarHome = process.env.NORTHSTAR_HOME ?? join(homedir(), '.northstar')
export const databasePath = join(northstarHome, 'northstar.sqlite')
export const worktreeRoot = join(northstarHome, 'worktrees')
export const logRoot = join(northstarHome, 'logs')
export const skillsRoot = join(northstarHome, 'skills')
export const usageRoot = join(northstarHome, 'usage')
export const secretsRoot = join(northstarHome, 'secrets')
export const importsRoot = join(northstarHome, 'imports')
export const garminImportRoot = process.env.NORTHSTAR_GARMIN_IMPORT_DIR ?? join(importsRoot, 'garmin')
export const heartbeatPath = join(northstarHome, 'heartbeat.md')
export const telegramBotTokenPath = join(secretsRoot, 'telegram-bot-token')
export const defaultDevRoot = process.env.NORTHSTAR_DEV_ROOT ?? join(homedir(), 'dev')

export function ensureRuntimeDirs() {
  mkdirSync(northstarHome, { recursive: true })
  mkdirSync(worktreeRoot, { recursive: true })
  mkdirSync(logRoot, { recursive: true })
  mkdirSync(skillsRoot, { recursive: true })
  mkdirSync(usageRoot, { recursive: true })
  mkdirSync(secretsRoot, { recursive: true })
  mkdirSync(importsRoot, { recursive: true })
  mkdirSync(garminImportRoot, { recursive: true })
}
