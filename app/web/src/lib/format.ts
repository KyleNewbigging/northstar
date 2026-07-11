import type { InboxAction, ModelId, Project, QueueTask, Status } from '../types'

export const modelColor: Record<ModelId, string> = { opus: 'var(--c1)', codex: 'var(--c4)', spark: 'var(--cyan)' }
export const priorityColor = { P0: 'var(--err)', P1: 'var(--star)', P2: 'var(--cyan)', P3: 'var(--ink-3)' }
export const priorityRank: Record<InboxAction['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
export const urgencyRank: Record<InboxAction['urgency'], number> = { high: 0, med: 1, low: 2 }
export const statusDot: Record<Status, string> = {
  running: 'dot-run',
  'needs-input': 'dot-queue',
  queued: 'dot-queue',
  blocked: 'dot-block',
  done: 'dot-done',
  idle: 'dot-idle',
}

export function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

export function fmtNum(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value)
}

export function fmtTokens(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`
  return fmtNum(value)
}

export function fmtUsagePct(value?: number | null) {
  return typeof value === 'number' ? `${Math.round(value)}%` : null
}

export function fmtReset(value?: string | null) {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function projectName(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.name ?? id
}

export function projectContextLabel(projects: Project[], id: string) {
  if (id === 'active') return 'active-projects'
  if (id === 'all') return 'all-projects'
  return projectName(projects, id)
}

export function modelLabel(model: ModelId) {
  if (model === 'opus') return 'Claude Code'
  if (model === 'spark') return 'Spark'
  return 'GPT-5.5'
}

export function queueSourceLabel(task: QueueTask) {
  if (task.source !== 'telegram') return task.source
  const lane = task.model === 'codex' ? 'Codex' : modelLabel(task.model)
  return `Telegram -> ${lane} ${task.agent}`
}

export function taskAgeLabel(value: string) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return 'age ?'
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
  if (minutes < 60) return `${minutes}m old`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h old`
  return `${Math.round(hours / 24)}d old`
}
