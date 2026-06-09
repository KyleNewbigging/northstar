import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const northstarHome = process.env.NORTHSTAR_HOME ?? join(homedir(), '.northstar')
export const databasePath = join(northstarHome, 'northstar.sqlite')
export const worktreeRoot = join(northstarHome, 'worktrees')
export const logRoot = join(northstarHome, 'logs')
export const defaultDevRoot = process.env.NORTHSTAR_DEV_ROOT ?? join(homedir(), 'dev')

export function ensureRuntimeDirs() {
  mkdirSync(northstarHome, { recursive: true })
  mkdirSync(worktreeRoot, { recursive: true })
  mkdirSync(logRoot, { recursive: true })
}
