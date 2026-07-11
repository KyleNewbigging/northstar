import type { BridgePriority, TelegramBridgeMode, AttentionAlertPriority, BridgeInboxAction, BridgeRun, BridgeTask, TelegramBridgeSettings } from './types.js'

export function resolveTelegramBridgeMode(value: string): TelegramBridgeMode {
  const normalized = value.trim().toLowerCase()
  return normalized === 'grammy' || normalized === 'runner' ? 'grammy' : 'poll'
}

export function parseAttentionPriority(value?: string | null) {
  const normalized = (value ?? '').trim().toUpperCase()
  if (isPriority(normalized)) return normalized
  return null
}

export function priorityWeight(value: AttentionAlertPriority) {
  if (value === 'P0') return 0
  if (value === 'P1') return 1
  if (value === 'P2') return 2
  return 3
}

export function parseDispatchCommand(rest: string): { taskId: string; targetDevice: string | null } {
  const tokens = rest.split(/\s+/).filter(Boolean)
  let taskId = ''
  let targetDevice: string | null = null
  for (const token of tokens) {
    if (token.startsWith('@') && token.length > 1) {
      const cleaned = token.slice(1).trim().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 64)
      if (cleaned) targetDevice = cleaned
      continue
    }
    if (!taskId) taskId = token
  }
  return { taskId, targetDevice }
}

export function resolveFromCommand(text: string) {
  const [, id = '', ...choiceParts] = text.split(/\s+/)
  const choice = choiceParts.join(' ').trim()
  if (!id) return { ok: false as const, error: 'Usage: /resolve ACTION_ID choice' }
  return { ok: true as const, id, choice }
}

export function parseResolveCallback(value: string) {
  const [kind, id = '', choice = ''] = value.split(':')
  if (kind !== 'resolve' || !id || !choice) return { ok: false as const }
  return { ok: true as const, id, choice }
}

export function commandRest(text: string) {
  const token = text.split(/\s+/, 1)[0] ?? ''
  return text.slice(token.length).trim()
}

export function commandName(text: string) {
  const token = text.split(/\s+/, 1)[0] ?? ''
  return token.split('@', 1)[0]
}

export function isCommandText(text: string) {
  return text.trim().startsWith('/')
}

export function normalizeReplyText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compareInboxActions(a: BridgeInboxAction, b: BridgeInboxAction) {
  const priority = priorityRank(a.priority) - priorityRank(b.priority)
  if (priority !== 0) return priority
  const urgency = urgencyRank(a.urgency) - urgencyRank(b.urgency)
  if (urgency !== 0) return urgency
  return a.id.localeCompare(b.id)
}

export function priorityRank(priority: BridgePriority) {
  if (priority === 'P0') return 0
  if (priority === 'P1') return 1
  if (priority === 'P2') return 2
  return 3
}

export function urgencyRank(urgency: BridgeInboxAction['urgency']) {
  if (urgency === 'high') return 0
  if (urgency === 'med') return 1
  return 2
}

export function parseCommandArgs(input: string) {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false
  for (const char of input) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

export function parseIdList(value: string | string[]) {
  const values = Array.isArray(value) ? value : value.split(',')
  return uniqueIds(values.map((item) => cleanNumericId(item)))
}

export function uniqueIds(values: string[]) {
  return [...new Set(values.map((item) => cleanNumericId(item)).filter(Boolean))]
}

export function cleanNumericId(value: unknown) {
  return String(value ?? '').replace(/[^0-9-]/g, '').slice(0, 32)
}

export function cleanChatId(value: string) {
  return value.trim().replace(/[^0-9A-Za-z_@-]/g, '').slice(0, 128)
}

export function cleanProjectName(value: unknown) {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()?.replace(/\.git$/, '').replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 96) || ''
}

export function cleanSessionToken(value: unknown) {
  return String(value ?? '').trim().replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 64)
}

export function parsePriorities(value: unknown, fallback: BridgePriority[]) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const priorities = items.map((item) => String(item).trim()).filter(isPriority)
  return priorities.length ? [...new Set(priorities)] : fallback
}

export function isPriority(value: unknown): value is BridgePriority {
  return value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3'
}

export function parseJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function isBridgeInboxAction(value: unknown): value is BridgeInboxAction {
  if (!isObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.ctx === 'string' &&
    typeof value.project === 'string' &&
    isPriority(value.priority) &&
    typeof value.urgency === 'string' &&
    typeof value.type === 'string'
  )
}

export function isBridgeRun(value: unknown): value is Required<Pick<BridgeRun, 'id' | 'status'>> & BridgeRun {
  return isObject(value) && typeof value.id === 'string' && typeof value.status === 'string'
}

export function isBridgeTask(value: unknown): value is BridgeTask {
  return isObject(value) && typeof value.id === 'string' && typeof value.status === 'string'
}

export function isRecentRun(run: BridgeRun) {
  const value = run.completedAt || run.updatedAt || run.startedAt
  if (!value) return false
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return false
  return time >= Date.now() - 24 * 60 * 60 * 1000
}

export function isNotificationTask(task: { source?: string; sourceRef?: string }) {
  return task.source === 'telegram' || Boolean(task.sourceRef?.startsWith('telegram:'))
}

export function isDebugEnabled(settings: TelegramBridgeSettings) {
  return settings.notifyLifecycleDebug || settings.notifyRunTelemetryDebug
}

export function isImportantPriority(priority: BridgePriority) {
  return priority === 'P0' || priority === 'P1'
}

export function parsePayloadRuns(payload: { runs?: unknown[] }) {
  return (Array.isArray(payload.runs) ? payload.runs : []).filter(isBridgeRun)
}

export function parsePayloadTasks(payload: { tasks?: unknown[] }) {
  return (Array.isArray(payload.tasks) ? payload.tasks : []).filter(isBridgeTask).filter(isNotificationTask)
}

export function telegramSessionScope(message: { chat: { id: number | string }; message_thread_id?: number }) {
  const chatId = cleanChatId(String(message.chat.id))
  const threadId = message.message_thread_id ? cleanSessionToken(String(message.message_thread_id)) : 'main'
  return {
    chatId,
    threadId,
    queueKey: `${chatId}:${threadId}`,
  }
}
