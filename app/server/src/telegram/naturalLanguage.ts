import { defaultTelegramModel } from './constants.js'
import type { BridgeInboxAction, NaturalTelegramRoute, TelegramSession, TelegramUseLane } from './types.js'
import { cleanSessionToken, compareInboxActions, isBridgeInboxAction, isCommandText, normalizeReplyText } from './utils.js'

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

function naturalChoiceHelp(action: BridgeInboxAction) {
  if (!action.options?.length) return 'Reply "noted" or use /inbox for details.'
  const labels = action.options.map((option, index) => `${index + 1}. ${option}`).join('\n')
  return [
    'Reply with a number, an option word, or tap a button:',
    labels,
  ].join('\n')
}

export function inferTelegramLane(session: TelegramSession) {
  const normalizedAgent = cleanSessionToken(session.agent).toLowerCase()
  const normalizedModel = cleanSessionToken(session.model).toLowerCase()

  if (normalizedAgent === 'personal') return 'personal'
  if (normalizedAgent === 'orchestrator') return 'orchestrator'

  if (normalizedModel === 'spark') return 'personal'
  return 'orchestrator'
}

export function formatSessionRouteSummary(session: TelegramSession) {
  const lane = inferTelegramLane(session)
  return `${session.threadId}: ${session.project} (${session.model} · ${session.agent}) — ${lane}`
}

export function maybeLaneMismatchWarning(model: string, agent: string) {
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

