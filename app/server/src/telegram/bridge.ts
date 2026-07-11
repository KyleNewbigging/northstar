import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

import { Bot } from 'grammy'
import { run, sequentialize } from '@grammyjs/runner'

import type { DeviceFileActions } from '../deviceFiles.js'
import { listDevices } from '../deviceRegistry.js'
import type { HeartbeatWriteResult } from '../heartbeat.js'
import { telegramBotTokenPath } from '../paths.js'
import { isWhisperAvailable, transcribeWithWhisper } from '../transcribe.js'

import { flushPendingAttentionAlerts } from './attention.js'
import {
  answerCallbackQuery,
  readTelegramBotToken,
  recordTelegramError,
  recordTelegramUpdate,
  sendMessage,
  telegramCall,
} from './api.js'
import {
  apiRoot,
  attentionEnabled,
  defaultRunTelemetryChunkChars,
  defaultRunTelemetryOutputMs,
  defaultTelegramBridgeMode,
  maxTelegramDocumentBytes,
  pdfToTextCommand,
} from './constants.js'
import {
  checkTelegramDocumentLimit,
  isPdfDocumentMime,
  isPdfDocumentName,
  isTextDocumentMime,
  isTextDocumentName,
} from './documents.js'
import {
  hydrateLifecycleStateIfNeeded,
  isNotificationReady,
  notifyActions,
  notifyLifecycle,
  notifyRunningRunTelemetry,
  notifyRuns,
  notifySchedulerTick,
  notifyStaleInbox,
  queueDigest,
} from './lifecycle.js'
import {
  buildContentSearchMessage,
  buildDebugModeMessage,
  buildDevicesMessage,
  buildFileErrorMessage,
  buildFileListMessage,
  buildFilePreviewMessage,
  buildFileSearchMessage,
  buildHandoffListMessage,
  buildHandoffMessage,
  buildHeartbeatMessage,
  buildInboxDigest,
  buildNaturalResolveResultMessage,
  buildNextMessage,
  buildNoSessionMessage,
  buildOverviewMessage,
  buildProjectResourceMessage,
  buildProjectWorkspaceMessage,
  buildPromptIntakeMessage,
  buildQueueMessage,
  buildQueueMutationMessage,
  buildResolveResultMessage,
  buildRunTaskResultMessage,
  buildSessionMessage,
  buildSessionsMessage,
  buildStatusMessage,
  buildTaskDetailMessage,
  buildTaskIdNotFoundMessage,
  matchTaskIdCandidates,
  parseQueueCommandArgs,
  disabledFileActions,
  helpText,
  parseResourceCommand,
  parseUseCommand,
  updateDebugMode,
} from './messages.js'
import { inferNaturalTelegramRoute } from './naturalLanguage.js'
import {
  getTelegramBridgeSettings,
  getTelegramSession,
  listTelegramSessions,
  updateTelegramBridgeSettings,
  upsertTelegramSession,
} from './settings.js'
import type {
  BridgeOperationsOverview,
  BridgeTaskDetail,
  DigestState,
  RunTelemetryState,
  TelegramBridgeMode,
  TelegramBridgeOptions,
  TelegramBridgeSettings,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from './types.js'
import {
  commandName,
  commandRest,
  errorMessage,
  isCommandText,
  isDebugEnabled,
  isObject,
  parseCommandArgs,
  parsePayloadRuns,
  parsePayloadTasks,
  parseResolveCallback,
  resolveFromCommand,
  telegramSessionScope,
} from './utils.js'
import { parseNaturalLanguageResolution } from './naturalLanguage.js'

let pdfToTextAvailableCache: boolean | null = null

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
      await sendMessage(token, settings.chatId, buildOverviewMessage(requireOperationsOverview(), options.getSnapshot().tasks))
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
    if (command === '/queue') {
      const filters = parseQueueCommandArgs(commandRest(text))
      const tasks = options.listQueueTasks?.() ?? options.getSnapshot().tasks
      await sendMessage(token, settings.chatId, buildQueueMessage(tasks, filters))
      return
    }
    if (command === '/dispatch') {
      const raw = commandRest(text).trim()
      if (!raw) {
        await sendMessage(token, settings.chatId, 'Usage: /dispatch TASK_ID')
        return
      }
      const tasks = options.listQueueTasks?.() ?? options.getSnapshot().tasks
      const match = matchTaskIdCandidates(tasks, raw)
      if (!match.exact) {
        await sendMessage(token, settings.chatId, buildTaskIdNotFoundMessage('dispatch', raw, match.candidates))
        return
      }
      const result = options.runQueueTask?.(match.exact.id ?? raw) ?? { ok: false, error: 'telegram_run_not_wired' }
      await sendMessage(token, settings.chatId, buildRunTaskResultMessage(match.exact.id ?? raw, result))
      return
    }
    if (command === '/pause' || command === '/requeue') {
      const raw = commandRest(text).trim()
      const action = command === '/pause' ? 'pause' as const : 'requeue' as const
      if (!raw) {
        await sendMessage(token, settings.chatId, `Usage: /${action} TASK_ID`)
        return
      }
      const tasks = options.listQueueTasks?.() ?? options.getSnapshot().tasks
      const match = matchTaskIdCandidates(tasks, raw)
      if (!match.exact) {
        await sendMessage(token, settings.chatId, buildTaskIdNotFoundMessage(action, raw, match.candidates))
        return
      }
      const callback = action === 'pause' ? options.pauseQueueTask : options.requeueQueueTask
      if (!callback) {
        await sendMessage(token, settings.chatId, `telegram_${action}_not_wired`)
        return
      }
      const result = callback(match.exact.id ?? raw)
      await sendMessage(token, settings.chatId, buildQueueMutationMessage(action, result))
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
      const q = commandRest(text)
      const fileResult = requireFileActions().search({ query: q, limit: 12 })
      const contentResult = requireFileActions().searchContent({ query: q, limit: 5 })
      const filePart = buildFileSearchMessage(fileResult)
      const contentPart = buildContentSearchMessage(contentResult)
      const combined = contentPart ? `${filePart}\n\n${contentPart}` : filePart
      await sendMessage(token, settings.chatId, combined.slice(0, 3500))
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
    if (command === '/devices') {
      await sendMessage(token, settings.chatId, buildDevicesMessage(listDevices()))
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

function authorizeMessage(settings: TelegramBridgeSettings, message: TelegramMessage) {
  const chatId = String(message.chat.id)
  const fromId = message.from?.id ? String(message.from.id) : ''
  const fromAllowed = Boolean(fromId && settings.allowedUserIds.includes(fromId))
  if (!settings.chatId) return { ok: false as const, reason: 'missing_chat' as const, fromAllowed }
  if (chatId !== settings.chatId) return { ok: false as const, reason: 'wrong_chat' as const, fromAllowed }
  if (settings.allowedUserIds.length > 0 && !fromAllowed) return { ok: false as const, reason: 'wrong_user' as const, fromAllowed }
  return { ok: true as const }
}
