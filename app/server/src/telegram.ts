import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Bot } from 'grammy'
import { run, sequentialize } from '@grammyjs/runner'

import type { DeviceFileActions, DeviceFileEntry, DeviceFileListResult, DeviceFilePreviewResult, DeviceFileSearchResult, DeviceFilesStatus, DeviceHandoffListResult, DeviceHandoffResult, ProjectResourceResult, ProjectWorkspaceResult } from './deviceFiles.js'
import type { HeartbeatWriteResult } from './heartbeat.js'
import { telegramBotTokenPath } from './paths.js'
import { isWhisperAvailable, transcribeWithWhisper } from './transcribe.js'

export type TelegramBridgeSettings = {
  id: 'default'
  enabled: boolean
  chatId: string
  allowedUserIds: string[]
  notifyInbox: boolean
  notifyRunResults: boolean
  notifyImportant: boolean
  notifyLifecycleDebug: boolean
  notifyRunTelemetryDebug: boolean
  notifyDigest: boolean
  debugUntil: string | null
  notifyScheduler: boolean
  notifyPriorities: Array<'P0' | 'P1' | 'P2' | 'P3'>
  lastUpdateId: number | null
  lastSeenAt: string | null
  lastError: string | null
  updatedAt: string
}

type TelegramSettingsRow = {
  id: 'default'
  enabled: number
  chat_id: string
  allowed_user_ids_json: string
  notify_inbox: number
  notify_run_results: number
  notify_important?: number
  notify_lifecycle_debug?: number
  notify_run_telemetry_debug?: number
  notify_digest?: number
  debug_until?: string | null
  notify_scheduler: number
  notify_priorities_json: string
  last_update_id: number | null
  last_seen_at: string | null
  last_error: string | null
  updated_at: string
}

type TelegramBridgeInput = Partial<
  Pick<
    TelegramBridgeSettings,
    'enabled' | 'chatId' | 'allowedUserIds' | 'notifyInbox' | 'notifyRunResults' | 'notifyImportant' | 'notifyLifecycleDebug' | 'notifyRunTelemetryDebug' | 'notifyDigest' | 'debugUntil' | 'notifyScheduler' | 'notifyPriorities'
  >
>

type BridgePriority = TelegramBridgeSettings['notifyPriorities'][number]

type BridgeInboxAction = {
  id: string
  type: 'question' | 'review' | 'blocked' | 'suggest'
  project: string
  task: string | null
  model: string
  priority: BridgePriority
  urgency: 'high' | 'med' | 'low'
  title: string
  ctx: string
  options?: string[]
  recommend?: number
  help?: string
}

type BridgeTask = {
  status?: string
  id?: string
  title?: string
  project?: string
  source?: string
  sourceRef?: string
  priority?: BridgePriority
}

type BridgeRun = {
  id?: string
  taskId?: string
  taskTitle?: string | null
  taskSource?: string | null
  projectId?: string
  model?: string
  status?: string
  attachCommand?: string | null
  stdout?: string | null
  stderr?: string | null
  finalText?: string | null
  completedAt?: string | null
  updatedAt?: string | null
  startedAt?: string | null
}

type BridgeProject = {
  active?: boolean
}

type BridgeSnapshot = {
  actions: BridgeInboxAction[]
  tasks: BridgeTask[]
  runs: BridgeRun[]
  projects: BridgeProject[]
}

type BridgeOperationsOverview = {
  summary?: {
    activeProjects?: number
    totalProjects?: number
    openDecisions?: number
    runningTasks?: number
    queuedTasks?: number
    blockedTasks?: number
    liveRuns?: number
    runnableTasks?: number
    manualTasks?: number
    githubOnlyTasks?: number
    attentionPending?: number
    attentionFailed?: number
  }
  queuePressure?: {
    totalOpen?: number
    runnable?: number
    schedulerWaiting?: number
    blocked?: number
    needsInput?: number
    manual?: number
    githubOnly?: number
    modelDisabled?: number
    noFreeSlot?: number
  }
  nextAction?: {
    kind?: string
    title?: string
    reason?: string
    command?: string
    taskId?: string
    actionId?: string
    project?: string
    priority?: string
  } | null
  activeProjects?: Array<{ id?: string; name?: string; status?: string; runtime?: string; lastEvent?: string; lastAgo?: string }>
  openDecisions?: BridgeInboxAction[]
  liveRuns?: BridgeRun[]
  telegram?: { ready?: boolean; polling?: boolean; sessions?: TelegramSession[]; configuredChat?: boolean }
}

type BridgeTaskDetail = {
  ok: boolean
  error?: string
  task?: BridgeTask & {
    model?: string
    agent?: string
    priority?: string
    stage?: string
    source?: string
    sourceRef?: string
    dispatchability?: {
      status?: string
      runnable?: boolean
      canDispatchNow?: boolean
      reason?: string
      action?: string
      stale?: boolean
      schedulerWaiting?: boolean
    }
  }
  dispatchability?: {
    status?: string
    runnable?: boolean
    canDispatchNow?: boolean
    reason?: string
    action?: string
    stale?: boolean
    schedulerWaiting?: boolean
  }
  project?: { id?: string; name?: string; path?: string; source?: string; localExists?: boolean }
  runs?: BridgeRun[]
  actions?: BridgeInboxAction[]
}

type BridgeRunTaskResult = {
  ok?: boolean
  error?: string
  blocked?: boolean
  dispatchability?: BridgeTaskDetail['dispatchability']
  task?: BridgeTask
  queueTask?: BridgeTask
  run?: BridgeRun & { attachCommand?: string | null }
}

type BridgeResolveResult = {
  ok: boolean
  id: string
  choice: string
  error?: string
  taskResolution?: {
    taskId?: string
    status?: string
    model?: string
  } | null
}

type TelegramLogger = {
  info: (...args: any[]) => void
  warn: (...args: any[]) => void
  error?: (...args: any[]) => void
}

type TelegramBridgeOptions = {
  logger: TelegramLogger
  getSnapshot: () => BridgeSnapshot
  getOperationsOverview?: () => BridgeOperationsOverview
  getQueueTask?: (id: string) => BridgeTaskDetail
  runQueueTask?: (id: string) => BridgeRunTaskResult
  resolveInboxAction: (id: string, choice: string) => BridgeResolveResult
  queuePrompt?: (input: TelegramPromptInput) => TelegramPromptResult
  fileActions?: DeviceFileActions
  getHeartbeat?: () => HeartbeatWriteResult
}

type TelegramBridgeMode = 'poll' | 'grammy'

type TelegramPromptInput = {
  text: string
  session: TelegramSession
  messageId: number
  autoDispatch?: boolean
}

type TelegramPromptResult =
  | { ok: true; taskId: string; actionId?: string | null; project: string; model: string; status?: string; autoDispatched?: boolean; dispatch?: BridgeRunTaskResult; lane?: string; laneWarning?: string | null }
  | { ok: false; error: string }

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

type TelegramMessage = {
  message_id: number
  message_thread_id?: number
  text?: string
  caption?: string
  voice?: {
    file_id?: string
    file_unique_id?: string
    duration?: number
    mime_type?: string
  }
  document?: {
    file_id?: string
    file_name?: string
    mime_type?: string
    file_size?: number
  }
  chat: { id: number | string; type?: string }
  from?: { id: number; username?: string; first_name?: string }
}

type TelegramSentMessage = {
  message_id: number
}

type TelegramCallbackQuery = {
  id: string
  from?: { id: number; username?: string; first_name?: string }
  message?: TelegramMessage
  data?: string
}

export type TelegramSession = {
  chatId: string
  threadId: string
  project: string
  model: string
  agent: string
  cwd: string
  sessionKey: string
  updatedAt: string
}

type TelegramUseLane = 'orchestrator' | 'personal'

export type NaturalTelegramRoute = {
  project: string
  model: string
  agent: string
  reason: string
}

type TelegramSessionRow = {
  chat_id: string
  thread_id: string
  project: string
  model: string
  agent: string
  cwd: string
  session_key: string
  updated_at: string
}

const apiRoot = process.env.NORTHSTAR_TELEGRAM_API_ROOT ?? 'https://api.telegram.org'
const defaultPriorities: BridgePriority[] = ['P0', 'P1', 'P2']
const defaultTelegramModel = cleanSessionToken(process.env.NORTHSTAR_TELEGRAM_DEFAULT_MODEL ?? 'codex') || 'codex'
const defaultTelegramAgent = cleanSessionToken(process.env.NORTHSTAR_TELEGRAM_DEFAULT_AGENT ?? 'orchestrator') || 'orchestrator'
const defaultTelegramBridgeMode = resolveTelegramBridgeMode(process.env.NORTHSTAR_TELEGRAM_BRIDGE_IMPL ?? 'poll')
const defaultRunTelemetryChunkChars = 1200
const defaultRunTelemetryOutputMs = 15_000
const defaultDigestWindowMs = 120_000
const defaultMaxTelegramDocumentBytes = Number(process.env.NORTHSTAR_TELEGRAM_MAX_DOCUMENT_BYTES ?? '20000000')
const defaultMaxTelegramDocumentPromptChars = Number(process.env.NORTHSTAR_TELEGRAM_MAX_DOCUMENT_PROMPT_CHARS ?? '150000')
const telegramDigestWindowMs = Math.max(1_000, Number(process.env.NORTHSTAR_TELEGRAM_DIGEST_WINDOW_MS ?? defaultDigestWindowMs))
const telegramStaleInboxAgeMs = Math.max(60_000, Number(process.env.NORTHSTAR_TELEGRAM_STALE_INBOX_AGE_MS ?? 4 * 60 * 60 * 1000))
const telegramStaleInboxCooldownMs = Math.max(60_000, Number(process.env.NORTHSTAR_TELEGRAM_STALE_INBOX_COOLDOWN_MS ?? 6 * 60 * 60 * 1000))
const pdfToTextCommand = process.env.NORTHSTAR_PDF_TO_TEXT_COMMAND?.trim() || 'pdftotext'

export const telegramCommandNames = [
  '/status',
  '/overview',
  '/next',
  '/task',
  '/run',
  '/heartbeat',
  '/inbox',
  '/resolve',
  '/files',
  '/find',
  '/file',
  '/handoff',
  '/handoffs',
  '/project',
  '/use',
  '/sessions',
  '/resource',
  '/debug',
] as const

type AttentionAlertPriority = BridgePriority
type AttentionEventType = 'task' | 'run'

const attentionWebhookUrl = (process.env.NORTHSTAR_ATTENTION_WEBHOOK_URL || process.env.NORTHSTAR_PUSHCUT_WEBHOOK_URL || '').trim()
const attentionWebhookToken = (process.env.NORTHSTAR_ATTENTION_WEBHOOK_TOKEN || process.env.NORTHSTAR_PUSHCUT_WEBHOOK_TOKEN || '').trim()
const attentionWebhookSource = (process.env.NORTHSTAR_ATTENTION_WEBHOOK_SOURCE || 'northstar').trim() || 'northstar'
const attentionMinPriority = parseAttentionPriority(process.env.NORTHSTAR_ATTENTION_MIN_PRIORITY)
const attentionRetryMax = Number(process.env.NORTHSTAR_ATTENTION_RETRY_MAX ?? '8')
const maxTelegramDocumentBytes = Number.isFinite(defaultMaxTelegramDocumentBytes) && defaultMaxTelegramDocumentBytes > 0
  ? Math.floor(defaultMaxTelegramDocumentBytes)
  : 20_000_000
const maxTelegramDocumentPromptChars = Number.isFinite(defaultMaxTelegramDocumentPromptChars) && defaultMaxTelegramDocumentPromptChars > 0
  ? Math.floor(defaultMaxTelegramDocumentPromptChars)
  : 150_000
let pdfToTextAvailableCache: boolean | null = null

export type TelegramDocumentProbeInput = {
  fileName?: string
  mimeType?: string
  fileSize?: number
  caption?: string
  sourceText?: string
}

export type TelegramDocumentProbeResult =
  | { ok: true; prompt: string }
  | { ok: false; message: string }

export const telegramDocumentLimits = {
  maxBytes: maxTelegramDocumentBytes,
  maxPromptChars: maxTelegramDocumentPromptChars,
} satisfies {
  maxBytes: number
  maxPromptChars: number
}

export function isTextDocumentMime(mimeType?: string) {
  if (!mimeType) return false
  const normalized = String(mimeType).toLowerCase()
  return (
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/ld+json' ||
    normalized === 'application/xml' ||
    normalized === 'text/csv'
  )
}

export function isPdfDocumentMime(mimeType?: string) {
  if (!mimeType) return false
  return String(mimeType).toLowerCase() === 'application/pdf'
}

export function isTextDocumentName(name?: string) {
  const normalized = String(name ?? '').toLowerCase()
  return /(\.md|\.markdown|\.txt|\.text|\.json|\.csv|\.yml|\.yaml|\.toml|\.ini|\.cfg|\.conf|\.js|\.ts|\.tsx|\.jsx|\.py|\.rb|\.go|\.java|\.cs|\.cpp|\.c|\.h|\.css|\.html|\.xml|\.yaml|\.yml|\.sh)$/i.test(name ?? '')
}

export function isPdfDocumentName(name?: string) {
  const normalized = String(name ?? '').toLowerCase()
  return normalized.endsWith('.pdf')
}

export function isSupportedDocumentType(document: { mime_type?: string; file_name?: string }) {
  return isTextDocumentMime(document?.mime_type) || isTextDocumentName(document?.file_name)
    || isPdfDocumentMime(document?.mime_type) || isPdfDocumentName(document?.file_name)
}

export function formatDocumentBytes(value: number) {
  const normalized = Math.max(0, Math.floor(value || 0))
  const kb = 1024
  if (normalized >= kb * kb) return `${(normalized / (kb * kb)).toFixed(1)} MB`
  if (normalized >= kb) return `${(normalized / kb).toFixed(1)} KB`
  return `${normalized} B`
}

export function checkTelegramDocumentLimit(
  message: string,
  bytes?: number,
  byteLimit = maxTelegramDocumentBytes,
  promptCharsLimit = maxTelegramDocumentPromptChars,
) {
  if (Number.isFinite(bytes) && typeof bytes === 'number' && bytes > byteLimit) {
    return {
      ok: false as const,
      message: `Document is too large (${formatDocumentBytes(bytes)}) for Telegram prompt intake on this host. Limit is ${formatDocumentBytes(byteLimit)}. Try trimming the attachment or paste only the relevant section.`,
    }
  }
  if (message.length > promptCharsLimit) {
    return {
      ok: false as const,
      message: `Document prompt is too long (${message.length.toLocaleString()} chars). Northstar limits reviewed Telegram prompts to ${promptCharsLimit.toLocaleString()} chars right now.`,
    }
  }
  return { ok: true as const }
}

export function probeTelegramDocumentIntake(input: TelegramDocumentProbeInput): TelegramDocumentProbeResult {
  const safeDocument = {
    file_name: input.fileName,
    mime_type: input.mimeType,
    file_size: input.fileSize,
  } satisfies NonNullable<TelegramMessage['document']>

  if (!isSupportedDocumentType(safeDocument)) {
    return {
      ok: false,
      message: 'Document intake supports text documents and PDF files only. Unsupported document type for now.',
    }
  }

  const fileSizeCheck = checkTelegramDocumentLimit('', input.fileSize)
  if (!fileSizeCheck.ok) return { ok: false, message: fileSizeCheck.message }

  const source = [input.caption?.trim(), input.sourceText?.trim()].filter(Boolean).join('\n\n').trim()
  const sourceLimitCheck = checkTelegramDocumentLimit(source)
  if (!sourceLimitCheck.ok) return { ok: false, message: sourceLimitCheck.message }
  if (!source) {
    return { ok: false, message: 'Document content had no readable text prompt.' }
  }

  return { ok: true, prompt: source }
}

const attentionEnabled = () => attentionWebhookUrl.length > 0

type RunTelemetryState = {
  stdoutCursor: number
  stderrCursor: number
  sequence: number
  lastSentAt: number
}

type DigestState = {
  timer: NodeJS.Timeout | null
  taskKeys: Set<string>
  runKeys: Set<string>
  seenTaskKeys: Set<string>
  seenRunKeys: Set<string>
  needsInput: number
  runFinished: number
  blocked: number
  projects: Set<string>
  action: string | null
}

type AttentionAlertRow = {
  id: string
  event_type: AttentionEventType
  event_key: string
  payload_json: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  next_retry_at: string | null
}

type AttentionAlertPayload = {
  eventType: AttentionEventType
  key: string
  title: string
  text: string
  priority: AttentionAlertPriority
  channel: string
  project: string
  source?: string
}

type AttentionAlertDbRow = {
  id: string
  event_type: AttentionEventType
  event_key: string
  payload_json: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  next_retry_at: string | null
}

function resolveTelegramBridgeMode(value: string): TelegramBridgeMode {
  const normalized = value.trim().toLowerCase()
  return normalized === 'grammy' || normalized === 'runner' ? 'grammy' : 'poll'
}

export function listTelegramSessions(db: DatabaseSync): TelegramSession[] {
  const rows = db
    .prepare(
      `SELECT chat_id, thread_id, project, model, agent, cwd, session_key, updated_at
       FROM telegram_sessions
       ORDER BY datetime(updated_at) DESC
       LIMIT 50`,
    )
    .all() as TelegramSessionRow[]
  return rows.map(mapTelegramSessionRow)
}

export function upsertTelegramSession(db: DatabaseSync, input: {
  chatId: string
  threadId?: string
  project: string
  model?: string
  agent?: string
  cwd?: string
}): TelegramSession {
  const threadId = input.threadId?.trim() || 'main'
  const project = cleanProjectName(input.project)
  const model = cleanSessionToken(input.model || defaultTelegramModel) || defaultTelegramModel
  const agent = cleanSessionToken(input.agent || defaultTelegramAgent) || defaultTelegramAgent
  const cwd = input.cwd?.trim() || ''
  const sessionKey = `${cleanChatId(input.chatId)}:${threadId}:${project}`
  db.prepare(
    `INSERT INTO telegram_sessions
      (chat_id, thread_id, project, model, agent, cwd, session_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id, thread_id) DO UPDATE SET
       project = excluded.project,
       model = excluded.model,
       agent = excluded.agent,
       cwd = excluded.cwd,
       session_key = excluded.session_key,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(cleanChatId(input.chatId), threadId, project, model, agent, cwd, sessionKey)
  return getTelegramSession(db, cleanChatId(input.chatId), threadId) as TelegramSession
}

function getTelegramSession(db: DatabaseSync, chatId: string, threadId: string): TelegramSession | null {
  const row = db
    .prepare(
      `SELECT chat_id, thread_id, project, model, agent, cwd, session_key, updated_at
       FROM telegram_sessions
       WHERE chat_id = ? AND thread_id = ?`,
    )
    .get(chatId, threadId) as TelegramSessionRow | undefined
  return row ? mapTelegramSessionRow(row) : null
}

export function seedTelegramBridgeSettings(db: DatabaseSync) {
  const allowed = parseIdList(process.env.NORTHSTAR_TELEGRAM_ALLOWED_USER_IDS ?? '')
  const priorities = parsePriorities(process.env.NORTHSTAR_TELEGRAM_NOTIFY_PRIORITIES, defaultPriorities)
  db.prepare(
    `INSERT OR IGNORE INTO telegram_bridge_settings
      (id, enabled, chat_id, allowed_user_ids_json, notify_inbox, notify_run_results, notify_important, notify_lifecycle_debug, notify_run_telemetry_debug, notify_digest, notify_scheduler, notify_priorities_json)
     VALUES ('default', ?, ?, ?, 1, 1, 1, 0, 0, 1, 0, ?)`,
  ).run(
    process.env.NORTHSTAR_TELEGRAM_ENABLED === '1' ? 1 : 0,
    cleanChatId(process.env.NORTHSTAR_TELEGRAM_CHAT_ID ?? ''),
    JSON.stringify(allowed),
    JSON.stringify(priorities),
  )
}

export function getTelegramBridgeSettings(db: DatabaseSync): TelegramBridgeSettings {
  seedTelegramBridgeSettings(db)
  const row = db.prepare("SELECT * FROM telegram_bridge_settings WHERE id = 'default'").get() as TelegramSettingsRow
  const envChatId = cleanChatId(process.env.NORTHSTAR_TELEGRAM_CHAT_ID ?? '')
  const envAllowedUserIds = parseIdList(process.env.NORTHSTAR_TELEGRAM_ALLOWED_USER_IDS ?? '')
  const envPriorities = parsePriorities(process.env.NORTHSTAR_TELEGRAM_NOTIFY_PRIORITIES, [])
  const mapped = normalizeDebugSettings(mapSettingsRow(row))

  return {
    ...mapped,
    enabled: mapped.enabled || process.env.NORTHSTAR_TELEGRAM_ENABLED === '1',
    chatId: envChatId || mapped.chatId,
    allowedUserIds: uniqueIds([...mapped.allowedUserIds, ...envAllowedUserIds]),
    notifyPriorities: envPriorities.length ? envPriorities : mapped.notifyPriorities,
  }
}

export function updateTelegramBridgeSettings(db: DatabaseSync, input: TelegramBridgeInput) {
  const current = getTelegramBridgeSettings(db)
  const next = {
    ...current,
    ...input,
    chatId: cleanChatId(input.chatId ?? current.chatId),
    allowedUserIds: uniqueIds(input.allowedUserIds ?? current.allowedUserIds),
    notifyPriorities: parsePriorities(input.notifyPriorities, current.notifyPriorities),
    notifyImportant: input.notifyImportant ?? input.notifyRunResults ?? current.notifyImportant,
    notifyLifecycleDebug: input.notifyLifecycleDebug ?? current.notifyLifecycleDebug,
    notifyRunTelemetryDebug: input.notifyRunTelemetryDebug ?? current.notifyRunTelemetryDebug,
    notifyDigest: input.notifyDigest ?? current.notifyDigest,
    debugUntil: input.debugUntil === undefined ? current.debugUntil : input.debugUntil,
  }

  db.prepare(
    `INSERT INTO telegram_bridge_settings
      (id, enabled, chat_id, allowed_user_ids_json, notify_inbox, notify_run_results, notify_important, notify_lifecycle_debug, notify_run_telemetry_debug, notify_digest, debug_until, notify_scheduler, notify_priorities_json, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       chat_id = excluded.chat_id,
       allowed_user_ids_json = excluded.allowed_user_ids_json,
       notify_inbox = excluded.notify_inbox,
       notify_run_results = excluded.notify_run_results,
       notify_important = excluded.notify_important,
       notify_lifecycle_debug = excluded.notify_lifecycle_debug,
       notify_run_telemetry_debug = excluded.notify_run_telemetry_debug,
       notify_digest = excluded.notify_digest,
       debug_until = excluded.debug_until,
       notify_scheduler = excluded.notify_scheduler,
       notify_priorities_json = excluded.notify_priorities_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    next.enabled ? 1 : 0,
    next.chatId,
    JSON.stringify(next.allowedUserIds),
    next.notifyInbox ? 1 : 0,
    next.notifyImportant ? 1 : 0,
    next.notifyImportant ? 1 : 0,
    next.notifyLifecycleDebug ? 1 : 0,
    next.notifyRunTelemetryDebug ? 1 : 0,
    next.notifyDigest ? 1 : 0,
    next.debugUntil,
    next.notifyScheduler ? 1 : 0,
    JSON.stringify(next.notifyPriorities),
  )

  return getTelegramBridgeSettings(db)
}

export function createTelegramBridge(db: DatabaseSync, options: TelegramBridgeOptions) {
  let stopped = false
  let polling = false
  let bridgeMode: TelegramBridgeMode = defaultTelegramBridgeMode
  let grammyRunner: ReturnType<typeof run> | null = null
  let sweepTimer: NodeJS.Timeout | null = null
  let attentionFlushTimer: NodeJS.Timeout | null = null
  const chatQueues = new Map<string, Promise<void>>()
  const hydrated = { done: false }
  const notifiedTaskStatuses = new Map<string, string>()
  const notifiedRunStatuses = new Map<string, string>()
  const runTelemetryState = new Map<string, RunTelemetryState>()
  const runTelemetryChunkChars = Number(process.env.NORTHSTAR_TELEGRAM_RUN_TELEMETRY_CHARS ?? defaultRunTelemetryChunkChars)
  const runTelemetryOutputMs = Number(process.env.NORTHSTAR_TELEGRAM_RUN_TELEMETRY_MS ?? defaultRunTelemetryOutputMs)
  let attentionFlushInFlight: Promise<void> | null = null
  const attentionFlushIntervalMs = Number(process.env.NORTHSTAR_ATTENTION_FLUSH_INTERVAL_MS ?? '60000')
  const digestState: DigestState = {
    timer: null,
    taskKeys: new Set(),
    runKeys: new Set(),
    seenTaskKeys: new Set(),
    seenRunKeys: new Set(),
    needsInput: 0,
    runFinished: 0,
    blocked: 0,
    projects: new Set(),
    action: null,
  }

  async function start() {
    if (process.env.NORTHSTAR_TELEGRAM_POLL === '0') return
    stopped = false
    hydrateLifecycleStateIfNeeded(db, hydrated, notifiedTaskStatuses, notifiedRunStatuses)
    if (bridgeMode === 'grammy') {
      await startGrammyBridge()
    } else {
      if (!polling) void pollLoop()
    }
    if (!sweepTimer) {
      sweepTimer = setInterval(() => {
        void notifyPendingInbox()
      }, 30_000)
      sweepTimer.unref?.()
    }

    if (!attentionFlushTimer && attentionEnabled() && Number.isFinite(attentionFlushIntervalMs) && attentionFlushIntervalMs >= 1_000) {
      attentionFlushTimer = setInterval(() => {
        void queueAttentionFlush()
      }, attentionFlushIntervalMs)
      attentionFlushTimer.unref?.()
    }
  }

  async function stop() {
    stopped = true
    if (grammyRunner?.isRunning()) {
      try {
        await grammyRunner.stop()
      } catch (error) {
        options.logger.warn({ error: errorMessage(error) }, 'telegram bridge runner stop failed')
      }
    }
    grammyRunner = null
    polling = false
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
    if (digestState.timer) clearTimeout(digestState.timer)
    digestState.timer = null
    if (attentionFlushTimer) clearInterval(attentionFlushTimer)
    attentionFlushTimer = null
    attentionFlushInFlight = null
  }

  async function notify(type: string, payload: Record<string, unknown>) {
    const settings = getTelegramBridgeSettings(db)
    if (!isNotificationReady(settings)) return
    if (settings.notifyImportant && settings.notifyInbox && Array.isArray(payload.actions)) {
      await notifyActions(db, settings, payload.actions, { importantOnly: !isDebugEnabled(settings) })
    }
    if (Array.isArray(payload.runs)) {
      const tasks = parsePayloadTasks(payload)
      const runs = parsePayloadRuns(payload)
      await notifyLifecycle(db, settings, tasks, runs, notifiedTaskStatuses, notifiedRunStatuses, { sendTelegram: settings.notifyLifecycleDebug })
      if (settings.notifyRunTelemetryDebug) {
        await notifyRunningRunTelemetry(
          db,
          settings,
          runs,
          runTelemetryState,
          runTelemetryChunkChars,
          runTelemetryOutputMs,
        )
      }
      if (settings.notifyImportant) await notifyRuns(db, settings, runs, tasks)
      if (settings.notifyDigest) queueDigest(db, settings, digestState, tasks, runs)
    }
    await queueAttentionFlush()
    if (settings.notifyScheduler && type === 'scheduler:tick') {
      await notifySchedulerTick(db, settings, payload.result)
    }
  }

  async function notifyPendingInbox() {
    const settings = getTelegramBridgeSettings(db)
    if (!isNotificationReady(settings)) return
    const snapshot = options.getSnapshot()
    if (settings.notifyImportant && settings.notifyInbox) {
      await notifyActions(db, settings, snapshot.actions, { importantOnly: !isDebugEnabled(settings) })
      await notifyStaleInbox(db, settings)
    }
    if (snapshot.runs.length) {
      const tasks = parsePayloadTasks(snapshot)
      const runs = parsePayloadRuns(snapshot)
      await notifyLifecycle(db, settings, tasks, runs, notifiedTaskStatuses, notifiedRunStatuses, { sendTelegram: settings.notifyLifecycleDebug })
      if (settings.notifyRunTelemetryDebug) {
        await notifyRunningRunTelemetry(
          db,
          settings,
          runs,
          runTelemetryState,
          runTelemetryChunkChars,
          runTelemetryOutputMs,
        )
      }
      if (settings.notifyImportant) await notifyRuns(db, settings, runs, tasks)
      if (settings.notifyDigest) queueDigest(db, settings, digestState, tasks, runs)
    }
    await queueAttentionFlush()
  }

  async function queueAttentionFlush() {
    if (!attentionEnabled()) return
    if (attentionFlushInFlight) return attentionFlushInFlight
    const flushInProgress = flushPendingAttentionAlerts(db).finally(() => {
      if (attentionFlushInFlight === flushInProgress) {
        attentionFlushInFlight = null
      }
    })
    attentionFlushInFlight = flushInProgress
    return flushInProgress
  }

  async function sendTest() {
    const settings = getTelegramBridgeSettings(db)
    const token = readTelegramBotToken()
    if (!token) return { ok: false as const, error: 'telegram_token_missing', tokenPath: telegramBotTokenPath }
    if (!settings.chatId) return { ok: false as const, error: 'telegram_chat_missing' }
    const message = await sendMessage(token, settings.chatId, [
      'Polaris Telegram bridge online.',
      'Notifications mirror Inbox decisions; risky actions still require the local cockpit.',
    ].join('\n'))
    return { ok: true as const, messageId: message.message_id }
  }

  async function pollOnce() {
    const settings = getTelegramBridgeSettings(db)
    const token = readTelegramBotToken()
    if (!token) return { ok: false as const, error: 'telegram_token_missing', tokenPath: telegramBotTokenPath }
    if (!settings.enabled) return { ok: false as const, error: 'telegram_bridge_disabled' }
    return pollUpdates(token, settings)
  }

  function status() {
    const settings = getTelegramBridgeSettings(db)
    const tokenConfigured = Boolean(readTelegramBotToken())
    return {
      ok: true as const,
      settings,
      tokenConfigured,
      tokenPath: telegramBotTokenPath,
      polling: polling && !stopped,
      mode: bridgeMode,
      ready: settings.enabled && tokenConfigured && Boolean(settings.chatId),
      needs: {
        token: !tokenConfigured,
        chat: !settings.chatId,
        allowedUsers: settings.allowedUserIds.length === 0,
      },
    }
  }

  async function pollLoop() {
    polling = true
    while (!stopped) {
      const settings = getTelegramBridgeSettings(db)
      const token = readTelegramBotToken()
      if (!settings.enabled || !token) {
        await sleep(5000)
        continue
      }

      try {
        await pollUpdates(token, settings)
      } catch (error) {
        const message = errorMessage(error)
        recordTelegramError(db, message)
        options.logger.warn({ error: message }, 'telegram bridge poll failed')
        await sleep(5000)
      }
    }
    polling = false
  }

  async function startGrammyBridge() {
    if (polling && bridgeMode === 'grammy') return
    const settings = getTelegramBridgeSettings(db)
    const token = readTelegramBotToken()
    if (!settings.enabled || !token) return

    const bot = new Bot(token, { client: { apiRoot } })

    bot.use(async (ctx: { update?: { update_id?: unknown } }, next) => {
      const updateIdRaw = ctx?.update?.update_id
      const updateId = typeof updateIdRaw === 'number' ? updateIdRaw : typeof updateIdRaw === 'string' ? Number(updateIdRaw) : NaN
      if (Number.isFinite(updateId)) {
        recordTelegramUpdate(db, updateId)
      }
      await next()
    })

    bot.use(sequentialize((ctx: { message?: unknown; callback_query?: unknown; callbackQuery?: unknown }) => {
      const rawMessage = isObject(ctx.message)
        ? (ctx.message as { message_thread_id?: unknown; chat?: unknown })
        : isObject(ctx.callback_query)
          ? ((ctx.callback_query as { message?: unknown }).message)
          : isObject(ctx.callbackQuery)
            ? ((ctx.callbackQuery as { message?: unknown }).message)
          : null
      const normalized = telegramMessageFromUnknown(rawMessage, false)
      return normalized ? telegramSessionScope(normalized).queueKey : undefined
    }))

    bot.on('message', async (ctx: { message?: unknown }) => {
      const rawMessage = isObject(ctx.message)
        ? (ctx.message as { message_thread_id?: unknown; chat?: unknown; text?: string })
        : null
      const message = telegramMessageFromUnknown(rawMessage, false)
      if (!message) return
      if (typeof message.text !== 'string' || !message.text.trim()) return
      await enqueueMessage(token, message)
    })

    bot.on('callback_query', async (ctx: { callbackQuery?: unknown }) => {
      const callback = telegramCallbackFromUnknown(ctx.callbackQuery)
      if (!callback) return
      await enqueueCallback(token, callback)
    })

    try {
      grammyRunner = run(bot, {
        runner: {
          fetch: {
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
          },
        },
      })
      polling = true
      const task = grammyRunner.task?.()
      if (task) {
        task.catch((error) => {
          if (stopped) return
          const message = errorMessage(error)
          recordTelegramError(db, message)
          options.logger.warn({ error: message }, 'telegram bridge runner failed')
          polling = false
        })
      }
    } catch (error) {
      const message = errorMessage(error)
      recordTelegramError(db, message)
      options.logger.warn({ error: message }, 'telegram bridge runner startup failed')
      grammyRunner = null
      polling = false
    }
  }

  async function pollUpdates(token: string, settings: TelegramBridgeSettings) {
    const updates = await telegramCall<TelegramUpdate[]>(token, 'getUpdates', {
      offset: typeof settings.lastUpdateId === 'number' ? settings.lastUpdateId + 1 : undefined,
      timeout: 25,
      allowed_updates: ['message', 'callback_query'],
    })
    for (const update of updates) {
      recordTelegramUpdate(db, update.update_id)
      if (update.message) await enqueueMessage(token, update.message)
      if (update.callback_query) await enqueueCallback(token, update.callback_query)
    }
    return { ok: true as const, updates: updates.length }
  }

  function telegramMessageFromUnknown(raw: unknown, requireText: boolean) {
    if (!isObject(raw)) return null
    const rawChat = raw.chat
    if (!isObject(rawChat)) return null
    const chatId = rawChat.id
    if (chatId === undefined || chatId === null || chatId === '') return null
    const text = typeof raw.text === 'string' ? raw.text : undefined
    const messageIdRaw = raw.message_id
    const messageId = typeof messageIdRaw === 'number' ? messageIdRaw : typeof messageIdRaw === 'string' ? Number(messageIdRaw) : NaN
    if (!Number.isFinite(messageId)) return null
    if (requireText && typeof text !== 'string') return null

    return {
      message_id: messageId,
      message_thread_id: typeof raw.message_thread_id === 'number' ? raw.message_thread_id : undefined,
      text,
      chat: {
        id: String(chatId),
        type: typeof rawChat.type === 'string' ? rawChat.type : undefined,
      },
      from: (() => {
        if (!isObject(raw.from)) return undefined
        const rawFromId = (raw.from as { id?: unknown }).id
        const fromId = typeof rawFromId === 'number' ? rawFromId : typeof rawFromId === 'string' ? Number(rawFromId) : NaN
        if (!Number.isFinite(fromId)) return undefined
        return {
          id: fromId,
          username: typeof raw.from.username === 'string' ? raw.from.username : undefined,
          first_name: typeof raw.from.first_name === 'string' ? raw.from.first_name : undefined,
        }
      })(),
    }
  }

  function telegramCallbackFromUnknown(raw: unknown) {
    if (!isObject(raw)) return null
    if (typeof raw.id !== 'string' && typeof raw.id !== 'number') return null
    const message = telegramMessageFromUnknown(raw.message, false)
    if (!message) return null
    const rawFrom = isObject(raw.from) ? raw.from : undefined
    const rawFromId = rawFrom && isObject(rawFrom) ? (rawFrom as { id?: unknown }).id : undefined
    const fromId = typeof rawFromId === 'number' ? rawFromId : typeof rawFromId === 'string' ? Number(rawFromId) : NaN
    return {
      id: String(raw.id),
      message,
      data: typeof raw.data === 'string' ? raw.data : undefined,
      from: Number.isFinite(fromId)
        ? {
            id: fromId,
            username: typeof rawFrom?.username === 'string' ? rawFrom.username : undefined,
            first_name: typeof rawFrom?.first_name === 'string' ? rawFrom.first_name : undefined,
          }
        : undefined,
    }
  }

  async function enqueueMessage(token: string, message: TelegramMessage) {
    const key = telegramSessionScope(message).queueKey
    const previous = chatQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => handleMessage(token, message))
    chatQueues.set(key, next)
    try {
      await next
    } finally {
      if (chatQueues.get(key) === next) chatQueues.delete(key)
    }
  }

  async function enqueueCallback(token: string, callback: TelegramCallbackQuery) {
    if (!callback.message) return
    const key = telegramSessionScope(callback.message).queueKey
    const previous = chatQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => handleCallbackQuery(token, callback))
    chatQueues.set(key, next)
    try {
      await next
    } finally {
      if (chatQueues.get(key) === next) chatQueues.delete(key)
    }
  }

  type TelegramMediaPromptResult =
    | { ok: true; prompt: string }
    | { ok: false; message: string }

  function isTextDocumentMimeLocal(mimeType?: string) {
    return isTextDocumentMime(mimeType)
  }

  function isPdfDocumentMimeLocal(mimeType?: string) {
    return isPdfDocumentMime(mimeType)
  }

  function isTextDocumentNameLocal(name?: string) {
    return isTextDocumentName(name)
  }

  function isPdfDocumentNameLocal(name?: string) {
    return isPdfDocumentName(name)
  }

  function isSupportedDocumentType(document: NonNullable<TelegramMessage['document']>) {
    const mimeType = document.mime_type
    const fileName = document.file_name
    return isTextDocumentMimeLocal(mimeType) || isTextDocumentNameLocal(fileName) || isPdfDocumentMimeLocal(mimeType) || isPdfDocumentNameLocal(fileName)
  }

  function checkDocumentLimit(message: string, bytes?: number, limit = maxTelegramDocumentBytes) {
    return checkTelegramDocumentLimit(message, bytes, limit)
  }

  async function extractPromptFromMessageMedia(token: string, message: TelegramMessage): Promise<TelegramMediaPromptResult> {
    if (message.voice) {
      const voiceId = message.voice.file_id
      if (!voiceId) return { ok: false, message: 'Voice message arrived without a file reference.' }
      return extractPromptFromVoiceMessage(token, voiceId, message.voice.mime_type, message.caption)
    }
    if (message.document) {
      return extractPromptFromDocumentMessage(token, message.document, message.caption)
    }
    if (!message.text) {
      return { ok: false, message: 'Media intake is currently available for voice notes and text documents, including PDFs.' }
    }
    return { ok: false, message: 'No prompt text found in this message.' }
  }

  async function extractPromptFromVoiceMessage(token: string, fileId: string, mimeType: string | undefined, caption?: string): Promise<TelegramMediaPromptResult> {
    if (!isWhisperAvailable()) {
      return { ok: false, message: 'Voice intake is currently unavailable: local whisper is not installed on this machine.' }
    }

    const promptFromFile = await transcribeTelegramFileAudio(token, fileId, mimeType)
    if (!promptFromFile.ok) return { ok: false, message: `Voice intake failed: ${promptFromFile.reason}` }

    const prompt = [caption?.trim(), promptFromFile.text].filter(Boolean).join('\n\n').trim()
    if (!prompt) return { ok: false, message: 'Voice transcript was empty.' }
    return { ok: true, prompt }
  }

  async function transcribeTelegramFileAudio(token: string, fileId: string, mimeType?: string) {
    const fileInfo = await fetchTelegramFileInfo(token, fileId)
    if (!fileInfo.ok) return { ok: false as const, reason: 'Could not load file metadata from Telegram.' }
    const downloaded = await fetchTelegramFileContent(token, fileInfo.filePath)
    if (!downloaded.ok) return { ok: false as const, reason: 'Could not download voice payload from Telegram.' }
    const result = await transcribeWithWhisper(downloaded.base64, mimeType)
    if (!result.ok) return { ok: false as const, reason: result.reason }
    return { ok: true as const, text: result.text }
  }

  async function extractPromptFromDocumentMessage(
    token: string,
    document: NonNullable<TelegramMessage['document']>,
    caption?: string,
  ): Promise<TelegramMediaPromptResult> {
    const fileId = document.file_id
    const fileName = document.file_name
    const mimeType = document.mime_type
    if (!fileId) return { ok: false, message: 'Document message arrived without a file reference.' }
    if (!isSupportedDocumentType(document)) {
      return {
        ok: false,
        message: 'Document intake supports text documents and PDF files only. Unsupported document type for now.',
      }
    }

    const fileSize = document.file_size
    const sizeCheck = checkDocumentLimit('', fileSize)
    if (!sizeCheck.ok) return { ok: false, message: sizeCheck.message }

    const fileInfo = await fetchTelegramFileInfo(token, fileId)
    if (!fileInfo.ok) return { ok: false, message: 'Could not load document metadata from Telegram.' }
    const downloaded = await fetchTelegramFileContent(token, fileInfo.filePath)
    if (!downloaded.ok) return { ok: false, message: 'Could not download document payload from Telegram.' }
    const payloadCheck = checkDocumentLimit('', downloaded.bytes.byteLength, maxTelegramDocumentBytes)
    if (!payloadCheck.ok) return { ok: false, message: payloadCheck.message }

    const extracted = isPdfDocumentMime(mimeType) || isPdfDocumentName(fileName)
      ? await extractTextFromPdfDocument(downloaded.bytes, fileName, fileId)
      : extractTextFromDocumentBytes(downloaded.bytes)
    if (!extracted.ok) {
      return { ok: false, message: extracted.message }
    }

    const decoded = extracted.text
    const source = [caption?.trim(), decoded].filter(Boolean).join('\n\n').trim()
    const sourceCheck = checkDocumentLimit(source)
    if (!sourceCheck.ok) return { ok: false, message: sourceCheck.message }
    if (!source) return { ok: false, message: 'Document content had no readable text prompt.' }
    return { ok: true, prompt: source }
  }

  function extractTextFromDocumentBytes(bytes: Uint8Array) {
    const decoded = new TextDecoder().decode(bytes)
    return { ok: true as const, text: decoded }
  }

  async function extractTextFromPdfDocument(
    bytes: Uint8Array,
    fileName = 'document.pdf',
    fileId = 'document',
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    if (!isPdfToolAvailable()) {
      return {
        ok: false,
        message: `PDF extraction not configured: ${pdfToTextCommand} is unavailable on this host.`
          + ` Reply with text instead (or paste extracted text) for your prompt request from ${fileName}.`,
      }
    }

    const normalizedName = fileName.replace(/[^0-9A-Za-z_.-]/g, '_').slice(0, 96) || `${fileId}.pdf`
    const tempDir = await mkdtemp(join(tmpdir(), 'northstar-pdf-'))
    const sourcePath = join(tempDir, normalizedName)
    const cleanedPath = join(tempDir, `${randomUUID()}.txt`)
    try {
      await writeFile(sourcePath, bytes)
      const commandResult = await runCommand(pdfToTextCommand, [sourcePath, cleanedPath])
      if (commandResult.code !== 0) {
        return {
          ok: false,
          message: `PDF extraction failed for ${fileName}: ${commandResult.stderr || commandResult.stdout || 'pdf-to-text conversion returned non-zero'}`,
        }
      }
      const extracted = await readFileContentIfExists(cleanedPath)
      if (!extracted.ok) return { ok: false, message: `PDF extract output missing for ${fileName}.` }
      const text = extracted.text.trim()
      if (!text) {
        return { ok: false, message: `PDF extraction returned no readable text for ${fileName}. Use pasted text for scanned documents.` }
      }
      return { ok: true as const, text }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async function runCommand(command: string, args: string[]) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL')
      }, 45_000)
      proc.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      proc.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      proc.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      proc.on('close', (code) => {
        clearTimeout(timeout)
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })
  }

  async function readFileContentIfExists(path: string): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    try {
      const text = await readFile(path, 'utf8')
      return { ok: true, text }
    } catch {
      return { ok: false, message: `Could not read PDF extraction output file: ${path}` }
    }
  }

  function isPdfToolAvailable() {
    if (pdfToTextAvailableCache !== null) return pdfToTextAvailableCache
    try {
      const probe = spawnSync(pdfToTextCommand, ['--help'], { stdio: 'ignore', timeout: 5_000 })
      pdfToTextAvailableCache = probe.status === 0 || probe.status === 1
    } catch {
      pdfToTextAvailableCache = false
    }
    return pdfToTextAvailableCache
  }

  function formatBytes(value: number) {
    const normalized = Math.max(0, Math.floor(value || 0))
    const kb = 1024
    if (normalized >= kb * kb) return `${(normalized / (kb * kb)).toFixed(1)} MB`
    if (normalized >= kb) return `${(normalized / kb).toFixed(1)} KB`
    return `${normalized} B`
  }

  async function fetchTelegramFileInfo(token: string, fileId: string) {
    const fileInfo = await telegramCall<{ file_id: string; file_path: string }>(token, 'getFile', { file_id: fileId })
    if (!fileInfo?.file_path) return { ok: false as const, reason: 'file_path missing' }
    return { ok: true as const, filePath: fileInfo.file_path }
  }

  async function fetchTelegramFileContent(token: string, filePath: string) {
    const response = await fetch(`${apiRoot}/file/bot${token}/${filePath}`)
    if (!response.ok) return { ok: false as const, reason: `Telegram file download failed: ${response.status}` }
    const bytes = Buffer.from(await response.arrayBuffer())
    return { ok: true as const, bytes, base64: bytes.toString('base64') }
  }

  async function handleMessage(token: string, message: TelegramMessage) {
    const settings = getTelegramBridgeSettings(db)
    const text = message.text?.trim() || message.caption?.trim() || ''
    const command = commandName(text)
    const scope = telegramSessionScope(message)

    const auth = authorizeMessage(settings, message)
    if (!auth.ok) {
      if (command === '/start' && auth.reason === 'missing_chat' && auth.fromAllowed) {
        const updated = updateTelegramBridgeSettings(db, { chatId: String(message.chat.id), enabled: true })
        await sendMessage(token, updated.chatId, 'Northstar Telegram bridge paired to this chat.')
        return
      }
      return
    }

    if (command === '/start' || command === '/help') {
      await sendMessage(token, settings.chatId, helpText())
      return
    }
    if (command === '/status') {
      await sendMessage(token, settings.chatId, buildStatusMessage(options.getSnapshot(), getTelegramSession(db, scope.chatId, scope.threadId)))
      return
    }
    if (command === '/overview') {
      await sendMessage(token, settings.chatId, buildOverviewMessage(requireOperationsOverview()))
      return
    }
    if (command === '/next') {
      await sendMessage(token, settings.chatId, buildNextMessage(requireOperationsOverview()))
      return
    }
    if (command === '/task') {
      const taskId = commandRest(text).trim()
      await sendMessage(token, settings.chatId, buildTaskDetailMessage(requireQueueTask(taskId)))
      return
    }
    if (command === '/run') {
      const taskId = commandRest(text).trim()
      if (!taskId) {
        await sendMessage(token, settings.chatId, 'Usage: /run TASK_ID')
        return
      }
      const result = options.runQueueTask?.(taskId) ?? { ok: false, error: 'telegram_run_not_wired' }
      await sendMessage(token, settings.chatId, buildRunTaskResultMessage(taskId, result))
      return
    }
    if (command === '/heartbeat') {
      await sendMessage(token, settings.chatId, buildHeartbeatMessage(requireHeartbeat()))
      return
    }
    if (command === '/inbox') {
      await sendMessage(token, settings.chatId, buildInboxDigest(options.getSnapshot().actions))
      return
    }
    if (command === '/files') {
      await sendMessage(token, settings.chatId, buildFileListMessage(requireFileActions().list({ path: commandRest(text), limit: 30 })))
      return
    }
    if (command === '/find') {
      await sendMessage(token, settings.chatId, buildFileSearchMessage(requireFileActions().search({ query: commandRest(text), limit: 12 })))
      return
    }
    if (command === '/file') {
      await sendMessage(token, settings.chatId, buildFilePreviewMessage(requireFileActions().preview({ path: commandRest(text), maxChars: 1800 })))
      return
    }
    if (command === '/handoff') {
      const parsed = parseCommandArgs(commandRest(text))
      const targetDevice = parsed[0]
      const path = parsed[1]
      const note = parsed.slice(2).join(' ')
      await sendMessage(token, settings.chatId, buildHandoffMessage(requireFileActions().createHandoff({ targetDevice, path, note })))
      return
    }
    if (command === '/handoffs') {
      const targetDevice = commandRest(text)
      await sendMessage(token, settings.chatId, buildHandoffListMessage(requireFileActions().listHandoffs({ targetDevice, limit: 12 })))
      return
    }
    if (command === '/project') {
      const project = commandRest(text)
      const workspace = requireFileActions().ensureProjectWorkspace({ project })
      if (workspace.ok) upsertTelegramSession(db, { chatId: scope.chatId, threadId: scope.threadId, project: workspace.project, cwd: workspace.relPath })
      await sendMessage(token, settings.chatId, buildProjectWorkspaceMessage(workspace))
      return
    }
    if (command === '/use') {
      const parsed = parseUseCommand(commandRest(text))
      const workspace = requireFileActions().ensureProjectWorkspace({ project: parsed.project })
      if (!workspace.ok) {
        await sendMessage(token, settings.chatId, buildFileErrorMessage(workspace))
        return
      }
      const session = upsertTelegramSession(db, {
        chatId: scope.chatId,
        threadId: scope.threadId,
        project: workspace.project,
        model: parsed.model,
        agent: parsed.agent,
        cwd: workspace.relPath,
      })
      await sendMessage(token, settings.chatId, buildSessionMessage(session, workspace.created.length))
      return
    }
    if (command === '/sessions') {
      await sendMessage(token, settings.chatId, buildSessionsMessage(listTelegramSessions(db)))
      return
    }
    if (command === '/resource') {
      const parsed = parseResourceCommand(commandRest(text))
      await sendMessage(token, settings.chatId, buildProjectResourceMessage(requireFileActions().saveProjectResource(parsed)))
      return
    }
    if (command === '/resolve') {
      const result = resolveFromCommand(text)
      if (!result.ok) {
        await sendMessage(token, settings.chatId, result.error)
        return
      }
      const resolved = options.resolveInboxAction(result.id, result.choice)
      await sendMessage(token, settings.chatId, buildResolveResultMessage(resolved))
      return
    }
    if (command === '/debug') {
      const result = updateDebugMode(db, commandRest(text))
      await sendMessage(token, settings.chatId, buildDebugModeMessage(result))
      return
    }

    if (isCommandText(text)) {
      await sendMessage(token, settings.chatId, 'Unknown command. Send /help for the bridge commands.')
      return
    }

    if (!message.text && !text) {
      const media = await extractPromptFromMessageMedia(token, message)
      if (media.ok && media.prompt) {
        await handleNaturalLanguagePrompt(token, settings, scope, message, media.prompt)
        return
      }
      if (!media.ok && media.message) {
        await sendMessage(token, settings.chatId, media.message)
      }
      return
    }

    const naturalResolution = await handleNaturalLanguageResolution(token, settings, text)
    if (naturalResolution) return

    await handleNaturalLanguagePrompt(token, settings, scope, message, text)
  }

  async function handleCallbackQuery(token: string, callback: TelegramCallbackQuery) {
    const settings = getTelegramBridgeSettings(db)
    const message = callback.message
    if (!message) {
      await answerCallbackQuery(token, callback.id, 'Northstar could not read that Telegram message.')
      return
    }

    const auth = authorizeMessage(settings, { ...message, from: callback.from })
    if (!auth.ok) {
      await answerCallbackQuery(token, callback.id, 'This Telegram account is not allowed for Northstar.')
      return
    }

    const parsed = parseResolveCallback(callback.data ?? '')
    if (!parsed.ok) {
      await answerCallbackQuery(token, callback.id, 'This Northstar button is no longer valid.')
      return
    }

    const resolved = options.resolveInboxAction(parsed.id, parsed.choice)
    await answerCallbackQuery(token, callback.id, resolved.ok ? 'Northstar Inbox resolved.' : 'Northstar could not resolve that item.')
    await sendMessage(token, settings.chatId, buildResolveResultMessage(resolved))
  }

  async function handleNaturalLanguageResolution(token: string, settings: TelegramBridgeSettings, text: string) {
    const resolution = parseNaturalLanguageResolution(text, options.getSnapshot().actions)
    if (!resolution) return false

    if (!resolution.ok) {
      await sendMessage(token, settings.chatId, resolution.message)
      return true
    }

    const resolved = options.resolveInboxAction(resolution.action.id, resolution.choice)
    await sendMessage(token, settings.chatId, buildNaturalResolveResultMessage(resolution.action, resolution.choiceLabel, resolved))
    return true
  }

  async function handleNaturalLanguagePrompt(
    token: string,
    settings: TelegramBridgeSettings,
    scope: ReturnType<typeof telegramSessionScope>,
    message: TelegramMessage,
    text: string,
  ) {
    let session = getTelegramSession(db, scope.chatId, scope.threadId)
    if (!session) {
      const chatSessions = listTelegramSessions(db).filter((item) => item.chatId === scope.chatId)
      const route = inferNaturalTelegramRoute(text, chatSessions)
      if (!route) {
        await sendMessage(token, settings.chatId, buildNoSessionMessage(scope, chatSessions))
        return
      }
      const workspace = requireFileActions().ensureProjectWorkspace({ project: route.project })
      session = upsertTelegramSession(db, {
        chatId: scope.chatId,
        threadId: scope.threadId,
        project: workspace.ok ? workspace.project : route.project,
        model: route.model,
        agent: route.agent,
        cwd: workspace.ok ? workspace.relPath : `projects/${route.project}`,
      })
    }

    if (!options.queuePrompt) {
      await sendMessage(token, settings.chatId, 'Telegram prompt intake is not wired into this Northstar server. No agent process has started.')
      return
    }

    const result = options.queuePrompt({ text, session, messageId: message.message_id, autoDispatch: true })
    await sendMessage(token, settings.chatId, buildPromptIntakeMessage(result, session))
  }

  function requireFileActions(): DeviceFileActions {
    return options.fileActions ?? disabledFileActions()
  }

  function requireHeartbeat(): HeartbeatWriteResult {
    return options.getHeartbeat?.() ?? {
      ok: true,
      path: '',
      mirrorPath: null,
      updatedAt: new Date().toISOString(),
      content: 'Northstar heartbeat is not wired into this server.',
    }
  }

  function requireOperationsOverview(): BridgeOperationsOverview {
    return options.getOperationsOverview?.() ?? {
      summary: {},
      queuePressure: {},
      nextAction: {
        title: 'Northstar overview unavailable',
        reason: 'This server has not wired the operations overview yet.',
        command: '/status',
      },
    }
  }

  function requireQueueTask(id: string): BridgeTaskDetail {
    if (!id) return { ok: false, error: 'Usage: /task TASK_ID' }
    return options.getQueueTask?.(id) ?? { ok: false, error: 'telegram_task_detail_not_wired' }
  }

  return {
    start,
    stop,
    notify,
    notifyPendingInbox,
    pollOnce,
    sendTest,
    status,
    flushAttention: queueAttentionFlush,
  }
}

function isNotificationReady(settings: TelegramBridgeSettings) {
  return settings.enabled && Boolean(settings.chatId) && Boolean(readTelegramBotToken())
}

function hydrateLifecycleState(db: DatabaseSync, notifiedTaskStatuses: Map<string, string>, notifiedRunStatuses: Map<string, string>) {
  const tasks = db
    .prepare("SELECT id, status, source, source_ref AS sourceRef FROM tasks WHERE status IN ('needs-input','queued','running','blocked','done')")
    .all() as Array<{ id: string; status: string; source?: string; sourceRef?: string }>
  for (const task of tasks) {
    if (!task.id || !isNotificationTask(task)) continue
    notifiedTaskStatuses.set(task.id, task.status)
  }

  const runs = db
    .prepare("SELECT id, status FROM agent_runs WHERE status IN ('running','blocked','done')")
    .all() as Array<{ id: string; status: string }>
  for (const run of runs) {
    if (!run.id || !run.status) continue
    notifiedRunStatuses.set(run.id, run.status)
  }
}

function hydrateLifecycleStateIfNeeded(
  db: DatabaseSync,
  hydrated: { done: boolean },
  notifiedTaskStatuses: Map<string, string>,
  notifiedRunStatuses: Map<string, string>,
) {
  if (hydrated.done) return
  hydrated.done = true
  hydrateLifecycleState(db, notifiedTaskStatuses, notifiedRunStatuses)
}

function parseAttentionPriority(value?: string | null) {
  const normalized = (value ?? '').trim().toUpperCase()
  if (isPriority(normalized)) return normalized
  return null
}

function priorityWeight(value: AttentionAlertPriority) {
  if (value === 'P0') return 0
  if (value === 'P1') return 1
  if (value === 'P2') return 2
  return 3
}

function shouldSendAttention(taskPriority: AttentionAlertPriority | undefined, minPriority: AttentionAlertPriority | null) {
  if (!minPriority) return true
  if (!taskPriority) return true
  return priorityWeight(taskPriority) <= priorityWeight(minPriority)
}

function shouldSendAttentionTaskAlert(task: BridgeTask, from: string | undefined, to: string) {
  if (!task.id) return false
  if (!to || to === from) return false
  if (!['needs-input', 'queued', 'running', 'blocked', 'done'].includes(to)) return false
  return shouldSendAttention(task.priority, attentionMinPriority)
}

function runAlertPriority(model?: string | null): AttentionAlertPriority {
  const normalized = String(model ?? '').toLowerCase()
  if (normalized === 'codex') return 'P1'
  if (normalized === 'opus' || normalized === 'claude') return 'P0'
  return 'P2'
}

function shouldSendAttentionRunAlert(run: BridgeRun, from: string | undefined, status: string) {
  if (!run.id) return false
  if (!status || status === from) return false
  if (!['running', 'blocked', 'done'].includes(status)) return false
  return shouldSendAttention(runAlertPriority(run.model), attentionMinPriority)
}

function buildAttentionPayloadKey(payload: AttentionAlertPayload) {
  return `${payload.eventType}:${payload.key}`
}

function nextAttentionRetryDelaySeconds(attempts: number) {
  const normalizedAttempts = Math.min(Math.max(0, attempts), 8)
  const delaySeconds = 15 * 2 ** normalizedAttempts
  return Math.min(delaySeconds, 15 * 60)
}

async function sendAttentionAlert(payload: AttentionAlertPayload) {
  const body = {
    title: payload.title,
    message: payload.text,
    text: payload.text,
    priority: payload.priority,
    channel: payload.channel,
    source: payload.source,
    project: payload.project,
    eventType: payload.eventType,
    eventKey: payload.key,
    timestamp: new Date().toISOString(),
  }

  const response = await fetch(attentionWebhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(attentionWebhookToken ? { Authorization: `Bearer ${attentionWebhookToken}` } : {}),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`PushCut webhook failed: HTTP ${response.status} ${response.statusText} ${text}`.trim())
  }
}

function toAttentionAlertPayload(input: AttentionAlertPayload) {
  return JSON.stringify({
    eventType: input.eventType,
    key: input.key,
    title: input.title,
    text: input.text,
    priority: input.priority,
    channel: input.channel,
    source: input.source,
    project: input.project,
    createdAt: new Date().toISOString(),
  })
}

function fromAttentionAlertRow(row: AttentionAlertDbRow) {
  let payload: AttentionAlertPayload | null = null
  try {
    const parsed = JSON.parse(row.payload_json)
    if (isAttentionPayload(parsed)) payload = parsed
  } catch {
    payload = null
  }
  return {
    ...row,
    payload,
  }
}

function isAttentionPayload(value: unknown): value is AttentionAlertPayload {
  return (
    isObject(value)
    && (value.eventType === 'task' || value.eventType === 'run')
    && typeof value.key === 'string'
    && typeof value.title === 'string'
    && typeof value.text === 'string'
    && isPriority(value.priority)
    && typeof value.channel === 'string'
    && typeof value.project === 'string'
  )
}

async function enqueueAttentionAlert(db: DatabaseSync, payload: AttentionAlertPayload) {
  if (!attentionEnabled()) return
  if (!shouldSendAttention(payload.priority, attentionMinPriority)) return

  const rowId = `ATTN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const serializedPayload = toAttentionAlertPayload(payload)
  const eventKey = buildAttentionPayloadKey(payload)

  db.prepare(
    `INSERT INTO attention_alerts
      (id, event_type, event_key, payload_json, status)
     VALUES (?, ?, ?, ?, 'pending')
     ON CONFLICT(event_type, event_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       status = 'pending',
       attempts = 0,
       next_retry_at = NULL,
       last_error = NULL,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(rowId, payload.eventType, eventKey, serializedPayload)
}

async function flushPendingAttentionAlerts(db: DatabaseSync) {
  if (!attentionEnabled()) return

  const pending = db.prepare(
    `SELECT id, event_type AS event_type, event_key, payload_json, status, attempts, next_retry_at
     FROM attention_alerts
     WHERE status IN ('pending', 'failed')
       AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now'))
     ORDER BY created_at ASC`,
  ).all() as AttentionAlertDbRow[]

  if (!pending.length) return

  for (const row of pending) {
    const payload = fromAttentionAlertRow(row).payload
    if (!payload) {
      db.prepare("UPDATE attention_alerts SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run('invalid payload json', row.id)
      continue
    }

    const attempts = row.attempts + 1
    try {
      await sendAttentionAlert(payload)
      db.prepare("UPDATE attention_alerts SET status = 'sent', attempts = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(attempts, row.id)
    } catch (error) {
      const shouldRetry = attempts <= attentionRetryMax && attentionRetryMax > 0
      const nextRetryMs = shouldRetry ? nextAttentionRetryDelaySeconds(attempts) * 1000 : 0
      const nextRetryAt = shouldRetry ? new Date(Date.now() + nextRetryMs).toISOString() : null
      db.prepare(
        `UPDATE attention_alerts
         SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(shouldRetry ? 'failed' : 'failed', attempts, errorMessage(error), nextRetryAt, row.id)

      if (shouldRetry) continue
    }
  }
}

function parsePayloadRuns(payload: { runs?: unknown[] }) {
  return (Array.isArray(payload.runs) ? payload.runs : []).filter(isBridgeRun)
}

function parsePayloadTasks(payload: { tasks?: unknown[] }) {
  return (Array.isArray(payload.tasks) ? payload.tasks : []).filter(isBridgeTask).filter(isNotificationTask)
}

function trackLifecycleState(
  currentTasks: BridgeTask[],
  currentRuns: BridgeRun[],
  notifiedTaskStatuses: Map<string, string>,
  notifiedRunStatuses: Map<string, string>,
) {
  const activeTaskIds = new Set(currentTasks.map((task) => task.id).filter(Boolean) as string[])
  const activeRunIds = new Set(currentRuns.map((run) => run.id).filter(Boolean) as string[])
  for (const taskId of [...notifiedTaskStatuses.keys()]) {
    if (!activeTaskIds.has(taskId)) notifiedTaskStatuses.delete(taskId)
  }
  for (const runId of [...notifiedRunStatuses.keys()]) {
    if (!activeRunIds.has(runId)) notifiedRunStatuses.delete(runId)
  }
}

function isNotificationTask(task: { source?: string; sourceRef?: string }) {
  return task.source === 'telegram' || Boolean(task.sourceRef?.startsWith('telegram:'))
}

function isDebugEnabled(settings: TelegramBridgeSettings) {
  return settings.notifyLifecycleDebug || settings.notifyRunTelemetryDebug
}

function isImportantPriority(priority: BridgePriority) {
  return priority === 'P0' || priority === 'P1'
}

async function notifyLifecycle(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  tasks: BridgeTask[],
  runs: BridgeRun[],
  notifiedTaskStatuses: Map<string, string>,
  notifiedRunStatuses: Map<string, string>,
  options: { sendTelegram?: boolean } = {},
) {
  const taskTransitions = tasks
    .map((task) => [task, notifiedTaskStatuses.get(task.id || ''), task.status] as const)
    .filter((item): item is [BridgeTask, string | undefined, string] => Boolean(item[0].id) && Boolean(item[2]))
  const runTransitions = runs.map((run) => [run, notifiedRunStatuses.get(run.id || ''), run.status] as const).filter((item): item is [BridgeRun, string | undefined, string] => Boolean(item[0].id) && Boolean(item[2]))

  for (const [task, fromRaw, to] of taskTransitions) {
    const from = fromRaw
    if (task.id === undefined || to === from) continue
    if (!from && to !== 'queued') continue
    if (shouldSendAttentionTaskAlert(task, from, to)) {
      await enqueueAttentionAlert(db, buildTaskLifecycleAlertPayload(task, from, to))
    }
    if (options.sendTelegram) {
      await sendLifecycleTelegramMessage(
        db,
        settings,
        `task:${task.id}:${from ?? 'new'}:${to}`,
        buildTaskLifecycleMessage(task, from),
      )
    }
  }
  for (const [run, fromRaw, status] of runTransitions) {
    const from = fromRaw
    if (run.id === undefined || status === from) continue
    if (!from && !isRecentRun(run)) continue
    if (status !== 'running' && status !== 'blocked' && status !== 'done') continue
    if (shouldSendAttentionRunAlert(run, from, status)) {
      await enqueueAttentionAlert(db, buildRunLifecycleAlertPayload(run, from, status))
    }
    if (options.sendTelegram) {
      await sendLifecycleTelegramMessage(
        db,
        settings,
        `run:${run.id}:${from ?? 'new'}:${status}`,
        buildRunLifecycleMessage(run, from),
      )
    }
  }

  trackLifecycleState(tasks, runs, notifiedTaskStatuses, notifiedRunStatuses)
  for (const task of tasks) {
    if (task.id && task.status) notifiedTaskStatuses.set(task.id, task.status)
  }
  for (const run of runs) {
    if (run.id && run.status) notifiedRunStatuses.set(run.id, run.status)
  }
}

function buildTaskLifecycleAlertPayload(task: BridgeTask, from: string | undefined, to: string) {
  const message = [
    `${attentionWebhookSource} task update`,
    `Task: ${task.id}`,
    `Project: ${task.project || 'unknown'}`,
    `Status: ${from ?? 'new'} → ${to}`,
    task.source ? `Source: ${task.source}` : null,
    task.sourceRef ? `SourceRef: ${task.sourceRef}` : null,
    task.title ? `Title: ${task.title}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    eventType: 'task' as const,
    key: `${task.id}:${from ?? 'new'}:${to}`,
    title: `Northstar task ${to}: ${task.id}`,
    text: `${message}\nNo process starts until scheduler/cockpit gates this task.`,
    priority: task.priority ?? 'P2',
    channel: attentionWebhookSource,
    project: task.project ?? 'unknown',
    source: task.source,
  }
}

function buildRunLifecycleAlertPayload(run: BridgeRun, from: string | undefined, status: string): AttentionAlertPayload {
  const message = [
    `${attentionWebhookSource} run update`,
    `Run: ${run.id}`,
    `Status: ${from ?? 'new'} → ${status}`,
    run.taskId ? `Task: ${run.taskId}` : null,
    run.projectId ? `Project: ${run.projectId}` : null,
    run.model ? `Model: ${run.model}` : null,
    run.attachCommand ? `Attach: ${run.attachCommand}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    eventType: 'run' as const,
    key: `${run.id}:${from ?? 'new'}:${status}`,
    title: `Northstar run ${status}: ${run.id}`,
    text: message,
    priority: 'P1',
    channel: attentionWebhookSource,
    project: run.projectId || 'unknown',
  }
}

async function sendLifecycleTelegramMessage(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  key: string,
  message: string,
) {
  if (!message) return
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return
  if (hasSuccessfulDelivery(db, settings.chatId, 'lifecycle_update', key)) return
  try {
    const sent = await sendMessage(token, settings.chatId, message)
    recordDelivery(db, settings.chatId, 'lifecycle_update', key, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'lifecycle_update', key, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

function buildTaskLifecycleMessage(task: BridgeTask, from: string | undefined) {
  const status = `${from ?? 'new'} -> ${task.status ?? 'unknown'}`
  const lines = [
    `Polaris update: ${task.title ?? 'task update'}`,
    `Project: ${task.project || 'unknown'}`,
    `Status: ${status}`,
    task.source ? `Source: ${task.source}` : null,
  ].filter(Boolean)
  if (task.status === 'needs-input' || task.status === 'blocked') {
    lines.push('Polaris needs a decision before using more model time.')
  }
  return lines.join('\n')
}

function buildRunLifecycleMessage(run: BridgeRun, from: string | undefined) {
  const lines = [
    'Northstar run lifecycle',
    `Run: ${run.id}`,
    `Status: ${from ?? 'new'} → ${run.status ?? 'unknown'}`,
    run.taskId ? `Task: ${run.taskId}` : null,
    run.projectId ? `Project: ${run.projectId}` : null,
    run.model ? `Model: ${run.model}` : null,
  ].filter(Boolean)
  if (run.attachCommand) {
    lines.push(`Attach: ${run.attachCommand}`)
  }
  return lines.join('\n')
}

async function notifyActions(db: DatabaseSync, settings: TelegramBridgeSettings, rawActions: unknown[], options: { importantOnly?: boolean } = {}) {
  const actions = rawActions
    .filter(isBridgeInboxAction)
    .filter((action) => settings.notifyPriorities.includes(action.priority))
    .filter((action) => !options.importantOnly || isImportantPriority(action.priority))
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  for (const action of actions) {
    const key = action.id
    if (hasSuccessfulDelivery(db, settings.chatId, 'inbox_action', key)) continue
    try {
      const sent = await sendMessage(token, settings.chatId, buildInboxMessage(action), { replyMarkup: buildInboxKeyboard(action) })
      recordDelivery(db, settings.chatId, 'inbox_action', key, 'sent', sent.message_id)
    } catch (error) {
      recordDelivery(db, settings.chatId, 'inbox_action', key, 'failed', null, errorMessage(error))
      recordTelegramError(db, errorMessage(error))
    }
  }
}

async function notifyStaleInbox(db: DatabaseSync, settings: TelegramBridgeSettings) {
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  // Throttle: at most one stale-inbox reminder per cooldown window per chat.
  const recentReminder = db
    .prepare(
      `SELECT 1 FROM telegram_delivery_log
       WHERE event_type = 'stale_inbox' AND chat_id = ? AND status = 'sent'
         AND updated_at > datetime('now', ?)
       LIMIT 1`,
    )
    .get(settings.chatId, `-${Math.round(telegramStaleInboxCooldownMs / 1000)} seconds`)
  if (recentReminder) return

  // Stale = still unresolved and first notified longer than the age window ago.
  // inbox_actions has no created_at; the original inbox_action delivery is the age anchor.
  const stale = db
    .prepare(
      `SELECT ia.id, ia.priority, ia.title
       FROM inbox_actions ia
       JOIN telegram_delivery_log dl
         ON dl.event_type = 'inbox_action' AND dl.event_key = ia.id AND dl.chat_id = ? AND dl.status = 'sent'
       WHERE ia.resolved_at IS NULL
         AND dl.updated_at <= datetime('now', ?)
       ORDER BY dl.updated_at
       LIMIT 5`,
    )
    .all(settings.chatId, `-${Math.round(telegramStaleInboxAgeMs / 1000)} seconds`) as Array<{ id: string; priority: string; title: string }>
  if (!stale.length) return

  const total = (db
    .prepare('SELECT COUNT(*) AS count FROM inbox_actions WHERE resolved_at IS NULL')
    .get() as { count: number }).count
  const lines = [
    `Polaris reminder: ${total} inbox item${total === 1 ? '' : 's'} still waiting on you.`,
    ...stale.map((action) => `- ${action.priority} ${action.title.replace(/\s+/g, ' ').trim().slice(0, 70)} -> /resolve ${action.id} 1`),
    total > stale.length ? `...and ${total - stale.length} more. Use /overview for the full list.` : 'Reply with /resolve ID CHOICE to keep the loop moving.',
  ]

  const eventKey = `stale:${Date.now()}`
  try {
    const sent = await sendMessage(token, settings.chatId, lines.join('\n'))
    recordDelivery(db, settings.chatId, 'stale_inbox', eventKey, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'stale_inbox', eventKey, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

async function notifySchedulerTick(db: DatabaseSync, settings: TelegramBridgeSettings, result: unknown) {
  if (!isObject(result)) return
  const dispatched = Array.isArray(result.dispatched) ? result.dispatched.length : 0
  if (dispatched === 0) return
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return
  const key = `scheduler:${Date.now()}`
  try {
    const sent = await sendMessage(token, settings.chatId, `Northstar scheduler dispatched ${dispatched} queued task${dispatched === 1 ? '' : 's'}.`)
    recordDelivery(db, settings.chatId, 'scheduler_tick', key, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'scheduler_tick', key, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

async function notifyRuns(db: DatabaseSync, settings: TelegramBridgeSettings, rawRuns: unknown[], tasks: BridgeTask[] = []) {
  const telegramTaskIds = new Set(tasks.filter(isNotificationTask).map((task) => task.id).filter((id): id is string => Boolean(id)))
  const runs = rawRuns
    .filter(isBridgeRun)
    .filter((run) => isImportantRunNotification(run, telegramTaskIds))
    .slice(0, 5)
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  for (const run of runs) {
    const key = `${run.id}:${run.status}`
    if (hasSuccessfulDelivery(db, settings.chatId, 'run_result', key)) continue
    try {
      const sent = await sendMessage(token, settings.chatId, buildRunMessage(run))
      recordDelivery(db, settings.chatId, 'run_result', key, 'sent', sent.message_id)
    } catch (error) {
      recordDelivery(db, settings.chatId, 'run_result', key, 'failed', null, errorMessage(error))
      recordTelegramError(db, errorMessage(error))
    }
  }
}

function isImportantRunNotification(run: BridgeRun, telegramTaskIds: Set<string>) {
  if (!isRecentRun(run)) return false
  if (run.status === 'blocked' || run.status === 'failed') return true
  if (run.status !== 'done') return false
  return Boolean(run.taskId && (telegramTaskIds.has(run.taskId) || run.taskId.startsWith('TG-')))
}

function queueDigest(db: DatabaseSync, settings: TelegramBridgeSettings, state: DigestState, tasks: BridgeTask[], runs: BridgeRun[]) {
  for (const task of tasks) {
    if (!task.id) continue
    const status = task.status ?? ''
    if (!['needs-input', 'blocked', 'queued', 'running', 'done'].includes(status)) continue
    const key = `${task.id}:${status}`
    if (state.seenTaskKeys.has(key)) continue
    if (state.taskKeys.has(key)) continue
    state.seenTaskKeys.add(key)
    state.taskKeys.add(key)
    if (task.project) state.projects.add(task.project)
    if (status === 'needs-input') state.needsInput += 1
    if (status === 'blocked') state.blocked += 1
  }
  for (const run of runs) {
    if (!run.id) continue
    const status = run.status ?? ''
    if (!['blocked', 'failed', 'done'].includes(status)) continue
    const key = `${run.id}:${status}`
    if (state.seenRunKeys.has(key)) continue
    if (state.runKeys.has(key)) continue
    state.seenRunKeys.add(key)
    state.runKeys.add(key)
    if (run.projectId) state.projects.add(run.projectId)
    if (status === 'done') state.runFinished += 1
    if (status === 'blocked' || status === 'failed') state.blocked += 1
  }

  const changed = state.taskKeys.size + state.runKeys.size
  if (changed === 0 || state.timer) return
  state.timer = setTimeout(() => {
    state.timer = null
    void sendDigestMessage(db, settings, state)
  }, telegramDigestWindowMs)
  state.timer.unref?.()
}

async function sendDigestMessage(db: DatabaseSync, settings: TelegramBridgeSettings, state: DigestState) {
  const changed = state.taskKeys.size + state.runKeys.size
  if (changed === 0) return
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  const lines = [
    `Polaris update: ${changed} update${changed === 1 ? '' : 's'}`,
    state.needsInput ? `${state.needsInput} need${state.needsInput === 1 ? 's' : ''} input` : null,
    state.runFinished ? `${state.runFinished} run${state.runFinished === 1 ? '' : 's'} finished` : null,
    state.blocked ? `${state.blocked} blocked/failed` : null,
    state.projects.size ? `Projects: ${[...state.projects].slice(0, 4).join(', ')}${state.projects.size > 4 ? ', ...' : ''}` : null,
    state.action ?? 'Use /overview or /next for details.',
  ].filter((line): line is string => Boolean(line))

  const eventKey = `digest:${Date.now()}`
  try {
    const sent = await sendMessage(token, settings.chatId, lines.join('\n'))
    recordDelivery(db, settings.chatId, 'digest', eventKey, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'digest', eventKey, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  } finally {
    state.taskKeys.clear()
    state.runKeys.clear()
    state.needsInput = 0
    state.runFinished = 0
    state.blocked = 0
    state.projects.clear()
    state.action = null
  }
}

async function notifyRunningRunTelemetry(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  rawRuns: unknown[],
  runTelemetryState: Map<string, RunTelemetryState>,
  runTelemetryChunkChars: number,
  runTelemetryOutputMs: number,
) {
  const runs = rawRuns.filter(isBridgeRun).filter((run) => run.status === 'running')
  const token = readTelegramBotToken()
  if (!token || !settings.chatId) return

  const now = Date.now()
  const effectiveChunkChars = Number.isFinite(runTelemetryChunkChars) && runTelemetryChunkChars > 120 ? runTelemetryChunkChars : defaultRunTelemetryChunkChars
  const effectiveOutputMs = Number.isFinite(runTelemetryOutputMs) && runTelemetryOutputMs > 1 ? runTelemetryOutputMs : defaultRunTelemetryOutputMs

  const runningIds = new Set<string>()

  for (const run of runs) {
    if (!run.id) continue
    runningIds.add(run.id)
    const previous = runTelemetryState.get(run.id) ?? {
      stdoutCursor: 0,
      stderrCursor: 0,
      sequence: 0,
      lastSentAt: 0,
    }

    const stdout = run.stdout || ''
    const stderr = run.stderr || ''
    const normalizedStdout = typeof stdout === 'string' ? stdout : ''
    const normalizedStderr = typeof stderr === 'string' ? stderr : ''

    const hasCursorReset = previous.stdoutCursor > normalizedStdout.length || previous.stderrCursor > normalizedStderr.length
    const stdoutCursor = hasCursorReset ? 0 : previous.stdoutCursor
    const stderrCursor = hasCursorReset ? 0 : previous.stderrCursor
    const next = {
      stdoutCursor: hasCursorReset ? 0 : normalizedStdout.length,
      stderrCursor: hasCursorReset ? 0 : normalizedStderr.length,
      sequence: previous.sequence,
      lastSentAt: previous.lastSentAt,
    }

    const previousStdout = normalizedStdout.slice(stdoutCursor)
    const previousStderr = normalizedStderr.slice(stderrCursor)
    const hasDelta = previousStdout.length > 0 || previousStderr.length > 0
    if (!hasDelta && now - previous.lastSentAt < effectiveOutputMs) {
      runTelemetryState.set(run.id, next)
      continue
    }

    if (!hasDelta && now - previous.lastSentAt >= effectiveOutputMs) {
      const key = `run:${run.id}:idle:${++next.sequence}`
      const message = buildRunTelemetryHeartbeatMessage(run)
      await sendRunTelemetryMessage(db, settings, token, key, message)
      next.lastSentAt = now
      runTelemetryState.set(run.id, next)
      continue
    }

    const message = buildRunTelemetryMessage(run, previousStdout, previousStderr, effectiveChunkChars)
    const key = `run:${run.id}:stream:${++next.sequence}`
    await sendRunTelemetryMessage(db, settings, token, key, message)
    next.stdoutCursor = normalizedStdout.length
    next.stderrCursor = normalizedStderr.length
    next.lastSentAt = now
    runTelemetryState.set(run.id, next)
  }

  for (const runId of [...runTelemetryState.keys()]) {
    if (!runningIds.has(runId)) runTelemetryState.delete(runId)
  }
}

async function sendRunTelemetryMessage(
  db: DatabaseSync,
  settings: TelegramBridgeSettings,
  token: string,
  key: string,
  message: string,
) {
  if (!message) return
  if (hasSuccessfulDelivery(db, settings.chatId, 'run_telemetry', key)) return
  try {
    const sent = await sendMessage(token, settings.chatId, message)
    recordDelivery(db, settings.chatId, 'run_telemetry', key, 'sent', sent.message_id)
  } catch (error) {
    recordDelivery(db, settings.chatId, 'run_telemetry', key, 'failed', null, errorMessage(error))
    recordTelegramError(db, errorMessage(error))
  }
}

function buildRunTelemetryMessage(run: BridgeRun, stdoutDelta: string, stderrDelta: string, chunkChars: number) {
  const lines = [
    'Northstar run telemetry',
    `Run: ${run.id}`,
    `Task: ${run.taskId ?? 'unknown'}`,
    `Project: ${run.projectId ?? 'unknown'}`,
    `Model: ${run.model ?? 'unknown'}`,
    `Status: ${run.status ?? 'running'}`,
    run.attachCommand ? `Attach: ${run.attachCommand}` : null,
    '',
    'STDOUT',
  ]
  const stdoutLines = clip(stdoutDelta || '(no new stdout yet)', chunkChars)
  const stderrLines = clip(stderrDelta || '(no new stderr yet)', chunkChars)
  return [
    ...lines.filter((line): line is string => line !== null),
    stdoutLines,
    '',
    'STDERR',
    stderrLines,
  ].join('\n')
}

function buildRunTelemetryHeartbeatMessage(run: BridgeRun) {
  return [
    'Northstar run telemetry',
    `Run: ${run.id}`,
    `Task: ${run.taskId ?? 'unknown'}`,
    `Project: ${run.projectId ?? 'unknown'}`,
    `Model: ${run.model ?? 'unknown'}`,
    `Status: ${run.status ?? 'running'}`,
    run.attachCommand ? `Attach: ${run.attachCommand}` : null,
    '',
    'No new output captured in the latest poll window.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

async function sendMessage(token: string, chatId: string, text: string, options: { replyMarkup?: Record<string, unknown> } = {}) {
  return telegramCall<TelegramSentMessage>(token, 'sendMessage', {
    chat_id: chatId,
    text: clip(text, 4096),
    link_preview_options: { is_disabled: true },
    reply_markup: options.replyMarkup,
  })
}

async function answerCallbackQuery(token: string, callbackQueryId: string, text: string) {
  return telegramCall<true>(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: clip(text, 180),
    show_alert: false,
  })
}

async function telegramCall<T>(token: string, method: string, body: Record<string, unknown>) {
  const filteredBody = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))
  const response = await fetch(`${apiRoot}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(filteredBody),
  })
  const json = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null
  if (!response.ok || !json?.ok) {
    const detail = json?.description || `Telegram ${method} returned HTTP ${response.status}`
    throw new Error(detail)
  }
  return json.result as T
}

function readTelegramBotToken() {
  const env = process.env.NORTHSTAR_TELEGRAM_BOT_TOKEN?.trim()
  if (env) return env
  if (!existsSync(telegramBotTokenPath)) return ''
  return readFileSync(telegramBotTokenPath, 'utf8').trim()
}

function mapSettingsRow(row: TelegramSettingsRow): TelegramBridgeSettings {
  const notifyImportant = row.notify_important === undefined ? row.notify_run_results === 1 : row.notify_important === 1
  return {
    id: row.id,
    enabled: row.enabled === 1,
    chatId: row.chat_id,
    allowedUserIds: parseJson<string[]>(row.allowed_user_ids_json, []).map(String),
    notifyInbox: row.notify_inbox === 1,
    notifyRunResults: notifyImportant,
    notifyImportant,
    notifyLifecycleDebug: row.notify_lifecycle_debug === 1,
    notifyRunTelemetryDebug: row.notify_run_telemetry_debug === 1,
    notifyDigest: row.notify_digest === undefined ? true : row.notify_digest === 1,
    debugUntil: row.debug_until ?? null,
    notifyScheduler: row.notify_scheduler === 1,
    notifyPriorities: parsePriorities(parseJson<unknown[]>(row.notify_priorities_json, defaultPriorities), defaultPriorities),
    lastUpdateId: row.last_update_id,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }
}

function normalizeDebugSettings(settings: TelegramBridgeSettings): TelegramBridgeSettings {
  if (!settings.debugUntil) return settings
  const until = Date.parse(settings.debugUntil)
  if (!Number.isFinite(until) || until <= Date.now()) {
    return {
      ...settings,
      notifyLifecycleDebug: false,
      notifyRunTelemetryDebug: false,
      debugUntil: null,
    }
  }
  return settings
}

function authorizeMessage(settings: TelegramBridgeSettings, message: TelegramMessage) {
  const chatId = String(message.chat.id)
  const fromId = message.from?.id ? String(message.from.id) : ''
  const fromAllowed = Boolean(fromId && settings.allowedUserIds.includes(fromId))
  if (!settings.chatId) return { ok: false as const, reason: 'missing_chat' as const, fromAllowed }
  if (chatId !== settings.chatId) return { ok: false as const, reason: 'wrong_chat' as const, fromAllowed }
  if (settings.allowedUserIds.length > 0 && !fromAllowed) return { ok: false as const, reason: 'wrong_user' as const, fromAllowed }
  return { ok: true as const }
}

function resolveFromCommand(text: string) {
  const [, id = '', ...choiceParts] = text.split(/\s+/)
  const choice = choiceParts.join(' ').trim()
  if (!id) return { ok: false as const, error: 'Usage: /resolve ACTION_ID choice' }
  return { ok: true as const, id, choice }
}

export function parseNaturalLanguageResolution(text: string, actions: BridgeInboxAction[]) {
  const normalized = normalizeReplyText(text)
  if (!normalized || normalized.length > 80 || isCommandText(text)) return null

  const action = actions.filter(isBridgeInboxAction).sort(compareInboxActions)[0]
  if (!action) return null

  const directChoice = naturalChoiceForText(normalized, action)
  if (!directChoice) return null
  if (!directChoice.ok) {
    return {
      ok: false as const,
      message: [
        'Polaris can do that, but I need one clear choice.',
        `Current item: ${action.title}`,
        naturalChoiceHelp(action),
      ].join('\n'),
    }
  }
  return { ok: true as const, action, choice: directChoice.choice, choiceLabel: directChoice.label }
}

function naturalChoiceForText(normalized: string, action: BridgeInboxAction) {
  const options = action.options ?? []
  const recommendedIndex = typeof action.recommend === 'number' && action.recommend >= 0 && action.recommend < options.length
    ? action.recommend
    : 0

  const numeric = parseNaturalChoiceNumber(normalized)
  if (numeric !== null) {
    if (!options.length) return { ok: true as const, choice: normalized, label: normalized }
    const option = options[numeric - 1]
    return option
      ? { ok: true as const, choice: String(numeric), label: option }
      : { ok: false as const }
  }

  const optionIndex = options.findIndex((option) => normalizedMatchesOption(normalized, option))
  if (optionIndex >= 0) return { ok: true as const, choice: String(optionIndex + 1), label: options[optionIndex] }

  if (isDiscardReply(normalized)) {
    const discardIndex = options.findIndex((option) => /discard|cancel|stop/i.test(option))
    if (discardIndex >= 0) return { ok: true as const, choice: String(discardIndex + 1), label: options[discardIndex] }
    return { ok: true as const, choice: 'discard', label: 'discard' }
  }

  if (isApprovalReply(normalized)) {
    if (!options.length) return { ok: true as const, choice: 'noted', label: 'noted' }
    return { ok: true as const, choice: String(recommendedIndex + 1), label: options[recommendedIndex] }
  }

  return null
}

function parseNaturalChoiceNumber(value: string) {
  const match = value.match(/^(?:option\s*)?([1-6])$/) ?? value.match(/^(first|second|third|fourth|fifth|sixth)(?:\s+option)?$/)
  if (!match) return null
  const wordMap: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }
  const raw = match[1]
  return /^\d+$/.test(raw) ? Number(raw) : wordMap[raw] ?? null
}

function normalizedMatchesOption(normalized: string, option: string) {
  const optionText = normalizeReplyText(option)
  if (!optionText) return false
  if (normalized === optionText) return true
  if (optionText.includes(normalized) && normalized.length >= 4) return true
  if (normalized.includes(optionText) && optionText.length >= 4) return true
  const keywords = optionText.split(/\s+/).filter((word) => word.length >= 5)
  return keywords.length > 0 && keywords.every((word) => normalized.includes(word))
}

function isApprovalReply(value: string) {
  return /^(yes|y|yeah|yep|ok|okay|sure|approved|approve|go ahead|do it|do this|run it|proceed|continue|sounds good|recommended|use recommended|do recommended|push the button)$/.test(value)
}

function isDiscardReply(value: string) {
  return /^(no|nope|discard|cancel|stop|skip|drop it|ignore it)$/.test(value)
}

export function inferNaturalTelegramRoute(text: string, existingSessions: TelegramSession[] = []): NaturalTelegramRoute {
  const normalized = normalizeReplyText(text)
  const project = inferNaturalProject(normalized, existingSessions)
  const lane = inferNaturalLane(normalized)
  return {
    project,
    model: lane === 'personal' ? 'spark' : defaultTelegramModel,
    agent: lane,
    reason: normalized.includes('zebra') ? 'matched Zebra dashboard wording' : normalized.includes('northstar') ? 'matched Northstar wording' : 'default orchestrator route',
  }
}

function inferNaturalProject(normalized: string, existingSessions: TelegramSession[]) {
  const explicit = projectFromText(normalized)
  if (explicit) return explicit

  const existingOrchestrator = existingSessions.find((session) => inferTelegramLane(session) === 'orchestrator')
  if (existingOrchestrator?.project) return existingOrchestrator.project

  const existing = existingSessions[0]
  if (existing?.project) return existing.project

  return 'northstar'
}

function projectFromText(normalized: string) {
  if (/(^|\s)(zebra|zebra-dashboard|dashboard)(\s|$)/.test(normalized)) return 'zebra-dashboard'
  if (/(^|\s)(northstar|polaris)(\s|$)/.test(normalized)) return 'northstar'
  return null
}

function inferNaturalLane(normalized: string): TelegramUseLane {
  if (/(^|\s)(personal|spark|quick|lightweight)(\s|$)/.test(normalized)) return 'personal'
  return 'orchestrator'
}

function normalizeReplyText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compareInboxActions(a: BridgeInboxAction, b: BridgeInboxAction) {
  const priority = priorityRank(a.priority) - priorityRank(b.priority)
  if (priority !== 0) return priority
  const urgency = urgencyRank(a.urgency) - urgencyRank(b.urgency)
  if (urgency !== 0) return urgency
  return a.id.localeCompare(b.id)
}

function priorityRank(priority: BridgePriority) {
  if (priority === 'P0') return 0
  if (priority === 'P1') return 1
  if (priority === 'P2') return 2
  return 3
}

function urgencyRank(urgency: BridgeInboxAction['urgency']) {
  if (urgency === 'high') return 0
  if (urgency === 'med') return 1
  return 2
}

function naturalChoiceHelp(action: BridgeInboxAction) {
  if (!action.options?.length) return 'Reply "noted" or use /inbox for details.'
  const labels = action.options.map((option, index) => `${index + 1}. ${option}`).join('\n')
  return [
    'Reply with a number, an option word, or tap a button:',
    labels,
  ].join('\n')
}

function parseResolveCallback(value: string) {
  const [kind, id = '', choice = ''] = value.split(':')
  if (kind !== 'resolve' || !id || !choice) return { ok: false as const }
  return { ok: true as const, id, choice }
}

function commandRest(text: string) {
  const token = text.split(/\s+/, 1)[0] ?? ''
  return text.slice(token.length).trim()
}

function commandName(text: string) {
  const token = text.split(/\s+/, 1)[0] ?? ''
  return token.split('@', 1)[0]
}

function isCommandText(text: string) {
  return text.trim().startsWith('/')
}

function buildInboxMessage(action: BridgeInboxAction) {
  const recommendedIndex = typeof action.recommend === 'number' && action.recommend >= 0 && action.options?.[action.recommend]
    ? action.recommend
    : 0
  const lines = [
    action.urgency === 'high'
      ? 'Polaris needs your input'
      : 'Polaris has a question',
    action.title,
    `Project: ${action.project}`,
    `Priority: ${action.priority} · ${action.model}`,
  ]
  lines.push('', clip(action.ctx, 1200))
  if (action.options?.length) {
    lines.push('', 'Choices:')
    action.options.forEach((option, index) => {
      const recommended = action.recommend === index ? ' (recommended)' : ''
      lines.push(`${index + 1}. ${option}${recommended}`)
    })
    lines.push(
      '',
      `Tap a button, reply "yes" for ${action.options[recommendedIndex]}, or reply "first", "second", or "discard".`,
      `Fallback command: /resolve ${action.id} ${recommendedIndex + 1}`,
    )
  } else {
    lines.push('', 'Reply "noted" or "yes".', `Fallback command: /resolve ${action.id} noted`)
  }
  if (action.help) lines.push('', clip(action.help, 800))
  return lines.join('\n')
}

function buildInboxKeyboard(action: BridgeInboxAction) {
  if (!action.options?.length) return undefined
  return {
    inline_keyboard: [
      action.options.slice(0, 6).map((option, index) => ({
        text: callbackButtonLabel(option, action.recommend === index),
        callback_data: `resolve:${action.id}:${index + 1}`,
      })),
    ],
  }
}

function callbackButtonLabel(option: string, recommended: boolean) {
  const label = option
    .replace(/^Queue\s+/, '')
    .replace(/\s+worktree$/, '')
    .replace(/\s+plan$/, ' plan')
  return clip(`${recommended ? '* ' : ''}${label}`, 40)
}

function buildResolveResultMessage(result: BridgeResolveResult) {
  if (!result.ok) return `Could not resolve ${result.id}: ${result.error ?? 'unknown error'}`

  const task = result.taskResolution
  if (task?.status === 'queued') {
    return [
      `Resolved ${result.id}: ${result.choice}`,
      `Task ${task.taskId ?? 'queued'} is queued for ${task.model ?? 'agent'} review.`,
      'No agent process starts until the scheduler/cockpit dispatch guardrails allow it.',
    ].join('\n')
  }

  if (task?.status === 'done') {
    return [
      `Resolved ${result.id}: ${result.choice}`,
      'The request was discarded and no agent process started.',
    ].join('\n')
  }

  return `Resolved ${result.id}: ${result.choice || 'noted'}`
}

function buildNaturalResolveResultMessage(action: BridgeInboxAction, choiceLabel: string, result: BridgeResolveResult) {
  if (!result.ok) return `Polaris could not apply that reply to ${action.title}: ${result.error ?? 'unknown error'}`
  return [
    `Done: ${choiceLabel || result.choice || 'noted'}`,
    action.title,
    result.taskResolution?.status ? `Task status: ${result.taskResolution.status}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

function buildInboxDigest(actions: BridgeInboxAction[]) {
  if (!actions.length) return 'Northstar inbox is clear.'
  const sorted = actions.slice().sort(compareInboxActions)
  const lines = [
    'Northstar inbox',
    'Reply "yes" to accept the top recommended choice, or reply "first", "second", or "discard".',
  ]
  for (const action of sorted.slice(0, 8)) {
    const recommended = action.options?.[typeof action.recommend === 'number' ? action.recommend : 0]
    lines.push(`${action.priority}: ${action.title}${recommended ? ` · recommended: ${recommended}` : ''}`)
  }
  if (actions.length > 8) lines.push(`${actions.length - 8} more in the cockpit.`)
  return lines.join('\n')
}

function buildStatusMessage(snapshot: BridgeSnapshot, session: TelegramSession | null = null) {
  const running = snapshot.tasks.filter((task) => task.status === 'running').length
  const queued = snapshot.tasks.filter((task) => task.status === 'queued').length
  const blocked = snapshot.tasks.filter((task) => task.status === 'blocked' || task.status === 'needs-input').length
  const activeProjects = snapshot.projects.filter((project) => project.active).length
  const liveRuns = snapshot.runs.filter((run) => run.status === 'running').length
  const lines = [
    'Northstar status',
    `Projects active: ${activeProjects}`,
    `Inbox open: ${snapshot.actions.length}`,
    `Queue: ${running} running, ${queued} queued, ${blocked} blocked/input`,
    `Live runs: ${liveRuns}`,
  ]
  if (session) {
    lines.push('', 'Current Telegram session', `${session.project} · ${session.model} · ${session.agent}`, `Workspace: ${session.cwd || `projects/${session.project}`}`)
  }
  return lines.join('\n')
}

function buildOverviewMessage(overview: BridgeOperationsOverview) {
  const summary = overview.summary ?? {}
  const queue = overview.queuePressure ?? {}
  const lines = [
    'Northstar overview',
    `Projects: ${summary.activeProjects ?? 0} active / ${summary.totalProjects ?? 0} tracked`,
    `Decisions: ${summary.openDecisions ?? 0} open`,
    `Queue: ${summary.runningTasks ?? 0} running, ${summary.queuedTasks ?? 0} queued, ${summary.blockedTasks ?? 0} blocked/input`,
    `Runnable: ${summary.runnableTasks ?? 0} safe/manual-runnable · manual ${summary.manualTasks ?? 0} · GitHub-only ${summary.githubOnlyTasks ?? 0}`,
    `Attention: pending ${summary.attentionPending ?? 0}, failed ${summary.attentionFailed ?? 0}`,
    '',
    'Queue pressure',
    `open=${queue.totalOpen ?? 0} runnable=${queue.runnable ?? 0} scheduler_waiting=${queue.schedulerWaiting ?? 0} blocked=${queue.blocked ?? 0} input=${queue.needsInput ?? 0}`,
  ]
  if (overview.nextAction) {
    lines.push('', 'Next', `${overview.nextAction.title ?? 'Review cockpit'}`, overview.nextAction.reason ?? '', `Command: ${overview.nextAction.command ?? '/overview'}`)
  }
  const active = overview.activeProjects?.slice(0, 5) ?? []
  if (active.length) {
    lines.push('', 'Active projects')
    for (const project of active) lines.push(`- ${project.name ?? project.id}: ${project.status ?? 'unknown'} · ${project.lastEvent ?? project.runtime ?? 'active'}`)
  }
  return lines.filter((line) => line !== '').join('\n')
}

function buildNextMessage(overview: BridgeOperationsOverview) {
  const next = overview.nextAction
  if (!next) return 'Northstar has no recommended next action. Try /overview for queue pressure.'
  return [
    'Northstar next action',
    `${next.title ?? 'Review cockpit'}`,
    next.project ? `Project: ${next.project}` : null,
    next.taskId ? `Task: ${next.taskId}` : null,
    next.actionId ? `Inbox: ${next.actionId}` : null,
    next.priority ? `Priority: ${next.priority}` : null,
    '',
    next.reason ?? 'Northstar recommends this as the smallest useful next step.',
    next.kind === 'resolve-inbox'
      ? 'Reply "yes" to approve the recommended choice, or use /inbox for the options.'
      : `Command: ${next.command ?? '/overview'}`,
    next.command ? `Fallback command: ${next.command}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

function buildTaskDetailMessage(detail: BridgeTaskDetail) {
  if (!detail.ok || !detail.task) return `Northstar task not found\n${detail.error ?? 'Unknown task error.'}`
  const task = detail.task
  const dispatchability = detail.dispatchability ?? task.dispatchability
  const lines = [
    `Northstar task ${task.id ?? 'unknown'}`,
    task.title ?? 'Untitled task',
    `Project: ${detail.project?.name ?? task.project ?? 'unknown'}`,
    `Status: ${task.status ?? 'unknown'} · ${task.priority ?? 'P?'} · ${task.model ?? 'agent'} · ${task.agent ?? 'agent'}`,
    task.stage ? `Stage: ${task.stage}` : null,
    task.source ? `Source: ${task.source}${task.sourceRef ? ` (${task.sourceRef})` : ''}` : null,
    '',
    `Dispatch: ${dispatchability?.status ?? 'unknown'}`,
    dispatchability?.reason ?? 'No dispatchability explanation available.',
    `Action: ${dispatchability?.action ?? 'Review in cockpit'}`,
    dispatchability?.stale ? 'Stale: yes' : null,
  ]
  const runs = detail.runs?.slice(0, 3) ?? []
  if (runs.length) {
    lines.push('', 'Runs')
    for (const run of runs) lines.push(`- ${run.id}: ${run.status}${run.attachCommand ? ` · ${run.attachCommand}` : ''}`)
  }
  const actions = detail.actions?.slice(0, 3) ?? []
  if (actions.length) {
    lines.push('', 'Inbox')
    for (const action of actions) lines.push(`- ${action.id}: ${action.title}`)
  }
  return lines.filter((line): line is string => line !== null).join('\n')
}

function buildRunTaskResultMessage(taskId: string, result: BridgeRunTaskResult) {
  if (!result.ok) {
    return [
      `Northstar did not start ${taskId}`,
      result.error ?? 'Dispatch was blocked by cockpit guardrails.',
      result.dispatchability?.status ? `Dispatch: ${result.dispatchability.status}` : null,
      result.dispatchability?.reason ?? null,
      'No patch was applied, no commit was made, and no push was attempted.',
    ].filter((line): line is string => line !== null).join('\n')
  }
  return [
    `Northstar started ${taskId}`,
    result.run?.id ? `Run: ${result.run.id}` : null,
    result.run?.attachCommand ? `Attach: ${result.run.attachCommand}` : null,
    result.run?.status ? `Status: ${result.run.status}` : null,
    '',
    'The agent is running in an isolated worktree. Patch apply, commit, push, and deletes remain review-gated.',
  ].filter((line): line is string => line !== null).join('\n')
}

function buildRunMessage(run: Required<Pick<BridgeRun, 'id' | 'status'>> & BridgeRun) {
  const lines = [
    `Polaris ${run.status === 'done' ? 'finished' : 'paused'} ${run.taskTitle ?? 'an agent run'}`,
  ]
  if (run.projectId) lines.push(`Project: ${run.projectId}`)
  lines.push(`Status: ${run.status}`)
  if (run.model) lines.push(`Model: ${run.model}`)
  if (run.finalText) lines.push('', clip(run.finalText, 1400))
  return lines.join('\n')
}

function buildHeartbeatMessage(result: HeartbeatWriteResult) {
  return [
    result.content,
    '',
    `Heartbeat path: ${result.path || 'unavailable'}`,
    result.mirrorPath ? `Dropbox mirror: ${result.mirrorPath}` : null,
  ].filter((line): line is string => line !== null).join('\n')
}

function buildFileListMessage(result: DeviceFileListResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  const location = result.relPath || '.'
  if (!result.entries.length) return `Dropbox files\n${location} is empty.`
  const lines = [
    'Dropbox files',
    `${location} · ${result.status.currentDevice}`,
    '',
    ...result.entries.map(formatFileEntry),
  ]
  if (result.truncated) lines.push('', 'More entries exist. Narrow the path or use /find.')
  return lines.join('\n')
}

function buildFileSearchMessage(result: DeviceFileSearchResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  if (!result.results.length) return `Dropbox search\nNo matches for "${result.query}".`
  const lines = [
    'Dropbox search',
    `"${result.query}" · ${result.results.length} match${result.results.length === 1 ? '' : 'es'}`,
    '',
    ...result.results.map(formatFileEntry),
  ]
  if (result.truncated) lines.push('', `Search stopped after ${result.visited} folders/files. Narrow the query if needed.`)
  return lines.join('\n')
}

function buildFilePreviewMessage(result: DeviceFilePreviewResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  const lines = [
    'Dropbox file',
    formatFileEntry(result.entry),
  ]
  if (!result.previewable) {
    lines.push('', 'Preview is not available for this file type or size. Use the relative path as the reference.')
    return lines.join('\n')
  }
  lines.push('', result.preview || '(empty file)')
  if (result.truncated) lines.push('', 'Preview truncated.')
  return lines.join('\n')
}

function buildHandoffMessage(result: DeviceHandoffResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  return [
    'Dropbox handoff created',
    `To: ${result.targetDevice}`,
    `Source: ${result.sourceRelPath || '.'}`,
    `Handoff: ${result.handoffRelPath}`,
    '',
    'The receiving device can open this handoff from its synced Dropbox folder.',
  ].join('\n')
}

function buildHandoffListMessage(result: DeviceHandoffListResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  if (!result.handoffs.length) return `Dropbox handoffs\nNo handoffs for ${result.targetDevice}.`
  return [
    'Dropbox handoffs',
    `For: ${result.targetDevice}`,
    '',
    ...result.handoffs.map((item) => [
      item.id,
      item.summary,
      item.relPath,
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

function buildProjectWorkspaceMessage(result: ProjectWorkspaceResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  return [
    'Dropbox project workspace',
    `Project: ${result.project}`,
    `Path: ${result.relPath}`,
    '',
    'Core files:',
    `CLAUDE.md: ${result.files.claude}`,
    `AGENTS.md: ${result.files.agents}`,
    `agent-profile.md: ${result.files.agentProfile}`,
    `implementation.md: ${result.files.implementation}`,
    `.claude: ${result.files.dotClaude}`,
    `resources: ${result.files.resources}`,
    `handoffs: ${result.files.handoffs}`,
    '',
    result.created.length ? `Created ${result.created.length} item${result.created.length === 1 ? '' : 's'}.` : 'Workspace already exists.',
  ].join('\n')
}

function buildProjectResourceMessage(result: ProjectResourceResult) {
  if (!result.ok) return buildFileErrorMessage(result)
  return [
    'Dropbox resource saved',
    `Project: ${result.project}`,
    `Path: ${result.relPath}`,
  ].join('\n')
}

function buildSessionMessage(session: TelegramSession, createdCount: number) {
  const lane = inferTelegramLane(session)
  const warning = maybeLaneMismatchWarning(session.model, session.agent)
  return [
    'Telegram session routed',
    `Project: ${session.project}`,
    `Model: ${session.model}`,
    `Agent: ${session.agent}`,
    `Lane: ${lane}`,
    `Workspace: ${session.cwd || `projects/${session.project}`}`,
    `Scope: ${session.chatId}/${session.threadId}`,
    ...(warning ? ['', warning] : []),
    createdCount ? `Workspace created or extended with ${createdCount} item${createdCount === 1 ? '' : 's'}.` : 'Workspace already existed.',
    'Ordinary messages now start Codex worktree tasks automatically. Polaris will ask only when input, a blocker, or a risky action needs you.',
  ].join('\n')
}

function buildNoSessionMessage(scope: ReturnType<typeof telegramSessionScope>, sessions: TelegramSession[]) {
  const topicLabel = `${scope.chatId}/${scope.threadId}`
  const examples = [
    'Send "work on Northstar" for the Northstar orchestrator lane.',
    'Send "work on Zebra dashboard" for the Zebra dashboard orchestrator lane.',
    'Mention "personal" or "Spark" only when you want the lighter personal lane.',
  ]
  if (!sessions.length) {
    return [
      `No Telegram project session is bound to this chat/topic (${topicLabel}) yet.`,
      'Send a normal request that mentions Northstar or Zebra dashboard and Polaris will route it automatically.',
      ...examples.map((line) => `  ${line}`),
      'No agent process has started.',
    ].join('\n')
  }
  return [
    `No Telegram project session is bound to this topic (${topicLabel}) yet.`,
    'Known routes on this chat:',
    ...sessions.map((session) => `  ${formatSessionRouteSummary(session)}`),
    '',
    'Send a normal request for the project you want:',
    ...examples.map((line) => `  ${line}`),
    'No agent process has started.',
  ].join('\n')
}

function buildPromptIntakeMessage(result: TelegramPromptResult, session: TelegramSession) {
  if (!result.ok) {
    return [
      'Polaris could not capture that Telegram request.',
      result.error,
      'No agent process has started.',
    ].join('\n')
  }

  return [
    result.dispatch?.ok
      ? 'Polaris started a Codex worktree run.'
      : result.autoDispatched
        ? 'Polaris queued this for Codex, but it could not start yet.'
        : 'Polaris queued this for Codex.',
    `Project: ${result.project || session.project}`,
    `Status: ${result.dispatch?.ok ? 'running' : result.status ?? 'queued'}`,
    '',
    result.dispatch?.ok
      ? 'I will message only if it needs input, blocks, fails, or finishes.'
      : result.dispatch?.error
        ? `Reason: ${result.dispatch.error}`
        : 'Use /overview if you want details.',
  ].join('\n')
}

function buildSessionsMessage(sessions: TelegramSession[]) {
  if (!sessions.length) return 'No Telegram sessions are registered yet. Use /use PROJECT to bind this chat or topic.'
  return [
    'Telegram sessions',
    '',
    ...sessions.slice(0, 12).map((session) => [
      `${session.chatId}/${session.threadId}`,
      `${session.project} · ${session.model} · ${session.agent} · ${inferTelegramLane(session)} lane`,
      session.cwd || `projects/${session.project}`,
    ].join('\n')),
  ].join('\n\n')
}

function updateDebugMode(db: DatabaseSync, rest: string) {
  const parsed = parseDebugMode(rest)
  if (!parsed.ok) return parsed
  const settings = parsed.enabled
    ? updateTelegramBridgeSettings(db, {
      notifyLifecycleDebug: true,
      notifyRunTelemetryDebug: true,
      debugUntil: new Date(Date.now() + parsed.durationMs).toISOString(),
    })
    : updateTelegramBridgeSettings(db, {
      notifyLifecycleDebug: false,
      notifyRunTelemetryDebug: false,
      debugUntil: null,
    })
  return { ok: true as const, enabled: parsed.enabled, settings }
}

function parseDebugMode(rest: string) {
  const [modeRaw, durationRaw] = parseCommandArgs(rest)
  const mode = (modeRaw ?? '').toLowerCase()
  if (mode === 'off') return { ok: true as const, enabled: false as const, durationMs: 0 }
  if (mode === 'on') return { ok: true as const, enabled: true as const, durationMs: parseDebugDuration(durationRaw ?? '30m') }
  if (mode === 'status' || mode === '') return { ok: false as const, error: 'Usage: /debug on 30m or /debug off' }
  return { ok: false as const, error: 'Usage: /debug on 30m or /debug off' }
}

function parseDebugDuration(value: string) {
  const match = value.trim().match(/^(\d+)(m|h)?$/i)
  if (!match) return 30 * 60 * 1000
  const amount = Math.max(1, Math.min(24 * 60, Number(match[1])))
  const unit = (match[2] ?? 'm').toLowerCase()
  return unit === 'h' ? amount * 60 * 60 * 1000 : amount * 60 * 1000
}

function buildDebugModeMessage(result: ReturnType<typeof updateDebugMode>) {
  if (!result.ok) return result.error
  if (!result.enabled) return 'Polaris debug notifications are off. Quiet important-only mode is active.'
  return [
    'Polaris debug notifications are on.',
    `Verbose lifecycle and run telemetry will expire at ${result.settings.debugUntil ?? 'the configured expiry'}.`,
    'Use /debug off to return to quiet mode sooner.',
  ].join('\n')
}

function buildFileErrorMessage(result: { error: string; detail: string; status: DeviceFilesStatus }) {
  return [
    `Dropbox file action blocked: ${result.error}`,
    result.detail,
    '',
    `Root: ${result.status.rootPath}`,
    `Device: ${result.status.currentDevice}`,
  ].join('\n')
}

function formatFileEntry(entry: DeviceFileEntry) {
  const suffix = entry.kind === 'directory' ? '/' : ''
  const size = entry.size === null ? '' : ` · ${formatBytes(entry.size)}`
  return `${kindIcon(entry.kind)} ${entry.relPath}${suffix}${size}`
}

function kindIcon(kind: DeviceFileEntry['kind']) {
  if (kind === 'directory') return '[dir]'
  if (kind === 'file') return '[file]'
  if (kind === 'symlink') return '[link]'
  return '[item]'
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function disabledFileActions(): DeviceFileActions {
  const status: DeviceFilesStatus = {
    ok: true,
    configured: false,
    rootExists: false,
    rootPath: '',
    rootSource: 'default',
    projectsRelPath: 'projects',
    currentDevice: 'northstar-device',
    handoffsPath: null,
    env: {
      root: 'NORTHSTAR_DROPBOX_ROOT',
      device: 'NORTHSTAR_DEVICE_ID',
    },
    guidance: 'Device file actions are not wired into this Northstar server.',
  }
  const error = { ok: false as const, error: 'device_files_unavailable', detail: status.guidance, status }
  return {
    status: () => status,
    list: () => error,
    search: () => error,
    preview: () => error,
    createHandoff: () => error,
    listHandoffs: () => error,
    ensureProjectWorkspace: () => error,
    saveProjectResource: () => error,
  }
}

function parseResourceCommand(input: string) {
  const parsed = parseCommandArgs(input)
  const project = parsed[0]
  const rest = input.slice(project?.length ?? 0).trim()
  const [titleRaw, ...contentParts] = rest.split(/\s+::\s+/)
  const title = titleRaw?.trim() || 'resource'
  const content = contentParts.join(' :: ').trim()
  return { project, title, content }
}

function parseUseCommand(input: string) {
  const parsed = parseCommandArgs(input)
  return {
    project: parsed[0],
    model: parsed[1] || defaultTelegramModel,
    agent: parsed[2] || defaultTelegramAgent,
  }
}

function parseCommandArgs(input: string) {
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

function helpText() {
  return [
    'Northstar Telegram bridge commands:',
    '/status - current cockpit summary',
    '/overview - operations overview across projects, queue, runs, and attention',
    '/next - recommended next action',
    '/task TASK_ID - task detail and dispatchability',
    '/run TASK_ID - start a safe review-gated local worktree run',
    '/heartbeat - live remote-control cockpit heartbeat',
    '/inbox - open decisions',
    '/resolve ACTION_ID choice - resolve one inbox item',
    '/files [path] - list Dropbox files',
    '/find query - search Dropbox filenames/paths',
    '/file path - preview a small text/Markdown file',
    '/handoff DEVICE path [note] - create a Dropbox handoff for another device',
    '/handoffs [DEVICE] - list handoffs for this or another device',
    '/project PROJECT - create/show a Dropbox project workspace',
    '/use PROJECT [model] [agent] - route this chat/topic to a project workspace',
    '/sessions - list registered Telegram session routes',
    '/resource PROJECT title :: content - save a Markdown resource in Dropbox',
    '/debug on 30m - temporarily enable verbose lifecycle and run telemetry',
    '/debug off - return to quiet important-only notifications',
    '',
    'After /use binds a chat/topic, ordinary messages queue and start Codex worktree tasks automatically when local guardrails pass.',
    'Without /use, a first normal message auto-routes to Northstar or Zebra dashboard; Orchestrator is the default lane.',
    'Telegram can resolve inbox decisions and reference Dropbox files. Patch apply, commits, pushes, deletes, and blocked/risky actions stay in the local cockpit.',
  ].join('\n')
}

function hasSuccessfulDelivery(db: DatabaseSync, chatId: string, eventType: string, eventKey: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM telegram_delivery_log
       WHERE chat_id = ? AND event_type = ? AND event_key = ? AND status = 'sent'`,
    )
    .get(chatId, eventType, eventKey) as { count: number }
  return row.count > 0
}

function recordDelivery(db: DatabaseSync, chatId: string, eventType: string, eventKey: string, status: 'sent' | 'failed', messageId?: number | null, error?: string) {
  db.prepare(
    `INSERT INTO telegram_delivery_log
      (id, event_type, event_key, chat_id, telegram_message_id, status, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(event_type, event_key, chat_id) DO UPDATE SET
       telegram_message_id = excluded.telegram_message_id,
       status = excluded.status,
       error = excluded.error,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(`${eventType}:${eventKey}:${chatId}`, eventType, eventKey, chatId, messageId ?? null, status, error ?? null)
}

function recordTelegramUpdate(db: DatabaseSync, updateId: number) {
  db.prepare(
    `UPDATE telegram_bridge_settings
     SET last_update_id = ?, last_seen_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = 'default'`,
  ).run(updateId)
}

function recordTelegramError(db: DatabaseSync, error: string) {
  db.prepare(
    `UPDATE telegram_bridge_settings
     SET last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = 'default'`,
  ).run(clip(error, 500))
}

function isBridgeInboxAction(value: unknown): value is BridgeInboxAction {
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

function isBridgeRun(value: unknown): value is Required<Pick<BridgeRun, 'id' | 'status'>> & BridgeRun {
  return isObject(value) && typeof value.id === 'string' && typeof value.status === 'string'
}

function isBridgeTask(value: unknown): value is BridgeTask {
  return isObject(value) && typeof value.id === 'string' && typeof value.status === 'string'
}

function isRecentRun(run: BridgeRun) {
  const value = run.completedAt || run.updatedAt || run.startedAt
  if (!value) return false
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return false
  return time >= Date.now() - 24 * 60 * 60 * 1000
}

function telegramSessionScope(message: TelegramMessage) {
  const chatId = cleanChatId(String(message.chat.id))
  const threadId = message.message_thread_id ? cleanSessionToken(String(message.message_thread_id)) : 'main'
  return {
    chatId,
    threadId,
    queueKey: `${chatId}:${threadId}`,
  }
}

function mapTelegramSessionRow(row: TelegramSessionRow): TelegramSession {
  return {
    chatId: row.chat_id,
    threadId: row.thread_id,
    project: row.project,
    model: row.model,
    agent: row.agent,
    cwd: row.cwd,
    sessionKey: row.session_key,
    updatedAt: row.updated_at,
  }
}

function inferTelegramLane(session: TelegramSession) {
  const normalizedAgent = cleanSessionToken(session.agent).toLowerCase()
  const normalizedModel = cleanSessionToken(session.model).toLowerCase()

  if (normalizedAgent === 'personal') return 'personal'
  if (normalizedAgent === 'orchestrator') return 'orchestrator'

  if (normalizedModel === 'spark') return 'personal'
  return 'orchestrator'
}

function formatSessionRouteSummary(session: TelegramSession) {
  const lane = inferTelegramLane(session)
  return `${session.threadId}: ${session.project} (${session.model} · ${session.agent}) — ${lane}`
}

function maybeLaneMismatchWarning(model: string, agent: string) {
  const normalizedModel = cleanSessionToken(model).toLowerCase()
  const normalizedAgent = cleanSessionToken(agent).toLowerCase()
  const laneByModel = normalizedModel === 'spark' ? 'personal' : 'orchestrator'
  const laneByAgent = normalizedAgent === 'personal' ? 'personal' : 'orchestrator'

  if (laneByModel !== laneByAgent && normalizedAgent) {
    return [
      'Lane note: this /use pair is unusual.',
      `Model ${normalizedModel || 'unknown'} usually routes to ${laneByModel} lane,`,
      `while agent ${normalizedAgent || 'unknown'} usually routes to ${laneByAgent} lane.`,
      'No process started yet; you can keep this lane or reset with a corrected /use command.',
    ].join(' ')
  }
  return null
}

function parseIdList(value: string | string[]) {
  const values = Array.isArray(value) ? value : value.split(',')
  return uniqueIds(values.map((item) => cleanNumericId(item)))
}

function uniqueIds(values: string[]) {
  return [...new Set(values.map((item) => cleanNumericId(item)).filter(Boolean))]
}

function cleanNumericId(value: unknown) {
  return String(value ?? '').replace(/[^0-9-]/g, '').slice(0, 32)
}

function cleanChatId(value: string) {
  return value.trim().replace(/[^0-9A-Za-z_@-]/g, '').slice(0, 128)
}

function cleanProjectName(value: unknown) {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()?.replace(/\.git$/, '').replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 96) || ''
}

function cleanSessionToken(value: unknown) {
  return String(value ?? '').trim().replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 64)
}

function parsePriorities(value: unknown, fallback: BridgePriority[]) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const priorities = items.map((item) => String(item).trim()).filter(isPriority)
  return priorities.length ? [...new Set(priorities)] : fallback
}

function isPriority(value: unknown): value is BridgePriority {
  return value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3'
}

function parseJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
