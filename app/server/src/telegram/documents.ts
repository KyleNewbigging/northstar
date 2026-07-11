import type { TelegramDocumentProbeInput, TelegramDocumentProbeResult, TelegramMessage } from './types.js'
import { maxTelegramDocumentBytes, maxTelegramDocumentPromptChars } from './constants.js'

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
