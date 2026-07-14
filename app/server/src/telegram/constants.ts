import type { BridgePriority, TelegramBridgeMode } from './types.js'
import { cleanSessionToken, parseAttentionPriority, resolveTelegramBridgeMode } from './utils.js'

export const apiRoot = process.env.NORTHSTAR_TELEGRAM_API_ROOT ?? 'https://api.telegram.org'
export const defaultPriorities: BridgePriority[] = ['P0', 'P1', 'P2']
export const defaultTelegramModel = cleanSessionToken(process.env.NORTHSTAR_TELEGRAM_DEFAULT_MODEL ?? 'codex') || 'codex'
export const defaultTelegramAgent = cleanSessionToken(process.env.NORTHSTAR_TELEGRAM_DEFAULT_AGENT ?? 'orchestrator') || 'orchestrator'
export const defaultTelegramBridgeMode: TelegramBridgeMode = resolveTelegramBridgeMode(process.env.NORTHSTAR_TELEGRAM_BRIDGE_IMPL ?? 'poll')
export const defaultRunTelemetryChunkChars = 1200
export const defaultRunTelemetryOutputMs = 15_000
export const defaultDigestWindowMs = 120_000
export const defaultMaxTelegramDocumentBytes = Number(process.env.NORTHSTAR_TELEGRAM_MAX_DOCUMENT_BYTES ?? '20000000')
export const defaultMaxTelegramDocumentPromptChars = Number(process.env.NORTHSTAR_TELEGRAM_MAX_DOCUMENT_PROMPT_CHARS ?? '150000')
export const telegramDigestWindowMs = Math.max(1_000, Number(process.env.NORTHSTAR_TELEGRAM_DIGEST_WINDOW_MS ?? defaultDigestWindowMs))
export const telegramStaleInboxAgeMs = Math.max(60_000, Number(process.env.NORTHSTAR_TELEGRAM_STALE_INBOX_AGE_MS ?? 4 * 60 * 60 * 1000))
export const telegramStaleInboxCooldownMs = Math.max(60_000, Number(process.env.NORTHSTAR_TELEGRAM_STALE_INBOX_COOLDOWN_MS ?? 6 * 60 * 60 * 1000))
export const pdfToTextCommand = process.env.NORTHSTAR_PDF_TO_TEXT_COMMAND?.trim() || 'pdftotext'

export const telegramCommandNames = [
  '/status',
  '/overview',
  '/next',
  '/task',
  '/run',
  '/queue',
  '/dispatch',
  '/pause',
  '/requeue',
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
  '/devices',
  '/agents',
  '/audit',
  '/debug',
] as const

export const attentionWebhookUrl = (process.env.NORTHSTAR_ATTENTION_WEBHOOK_URL || process.env.NORTHSTAR_PUSHCUT_WEBHOOK_URL || '').trim()
export const attentionWebhookToken = (process.env.NORTHSTAR_ATTENTION_WEBHOOK_TOKEN || process.env.NORTHSTAR_PUSHCUT_WEBHOOK_TOKEN || '').trim()
export const attentionWebhookSource = (process.env.NORTHSTAR_ATTENTION_WEBHOOK_SOURCE || 'northstar').trim() || 'northstar'
export const attentionMinPriority = parseAttentionPriority(process.env.NORTHSTAR_ATTENTION_MIN_PRIORITY)
export const attentionRetryMax = Number(process.env.NORTHSTAR_ATTENTION_RETRY_MAX ?? '8')
export const maxTelegramDocumentBytes = Number.isFinite(defaultMaxTelegramDocumentBytes) && defaultMaxTelegramDocumentBytes > 0
  ? Math.floor(defaultMaxTelegramDocumentBytes)
  : 20_000_000
export const maxTelegramDocumentPromptChars = Number.isFinite(defaultMaxTelegramDocumentPromptChars) && defaultMaxTelegramDocumentPromptChars > 0
  ? Math.floor(defaultMaxTelegramDocumentPromptChars)
  : 150_000

export const attentionEnabled = () => attentionWebhookUrl.length > 0
