import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { inferNaturalTelegramRoute, parseNaturalLanguageResolution } from './naturalLanguage.js'
import type { BridgeInboxAction, TelegramSession } from './types.js'

function action(overrides: Partial<BridgeInboxAction> = {}): BridgeInboxAction {
  return {
    id: 'A1',
    type: 'question',
    project: 'northstar',
    task: null,
    model: 'codex',
    priority: 'P1',
    urgency: 'high',
    title: 'Pick a path',
    ctx: 'Choose one',
    options: ['Do the recommended thing', 'Use the second path', 'Discard'],
    recommend: 0,
    ...overrides,
  }
}

describe('parseNaturalLanguageResolution', () => {
  it('picks the recommended option on natural approval', () => {
    const result = parseNaturalLanguageResolution('yes', [action()])
    assert.ok(result?.ok)
    assert.equal(result.choice, '1')
  })

  it('resolves numeric choices to the matching option', () => {
    const result = parseNaturalLanguageResolution('second option', [action()])
    assert.ok(result?.ok)
    assert.equal(result.choice, '2')
  })

  it('maps discard keywords to the discard option', () => {
    const result = parseNaturalLanguageResolution('discard', [action()])
    assert.ok(result?.ok)
    assert.equal(result.choice, '3')
  })

  it('rejects long free-text prompts', () => {
    const long = 'yes and also can you build a completely separate new dashboard feature for me right now please'
    assert.equal(parseNaturalLanguageResolution(long, [action()]), null)
  })

  it('rejects command-style text', () => {
    assert.equal(parseNaturalLanguageResolution('/status now', [action()]), null)
  })

  it('returns null when there are no actions to resolve', () => {
    assert.equal(parseNaturalLanguageResolution('yes', []), null)
  })

  it('returns null when the text has no matching option', () => {
    assert.equal(parseNaturalLanguageResolution('banana', [action()]), null)
  })
})

describe('inferNaturalTelegramRoute', () => {
  it('routes zebra wording to zebra-dashboard orchestrator with codex', () => {
    const route = inferNaturalTelegramRoute('Please handle this for zebra dashboard')
    assert.equal(route.project, 'zebra-dashboard')
    assert.equal(route.agent, 'orchestrator')
    assert.equal(route.model, 'codex')
    assert.match(route.reason, /Zebra/)
  })

  it('routes northstar wording to northstar orchestrator', () => {
    const route = inferNaturalTelegramRoute('northstar can you look at this')
    assert.equal(route.project, 'northstar')
    assert.equal(route.agent, 'orchestrator')
    assert.match(route.reason, /Northstar/)
  })

  it('defaults to northstar orchestrator on generic text', () => {
    const route = inferNaturalTelegramRoute('take a look at this workflow please')
    assert.equal(route.project, 'northstar')
    assert.equal(route.agent, 'orchestrator')
    assert.equal(route.model, 'codex')
  })

  it('routes personal keywords to the personal spark lane', () => {
    const route = inferNaturalTelegramRoute('quick personal note please')
    assert.equal(route.agent, 'personal')
    assert.equal(route.model, 'spark')
  })

  it('falls back to the existing orchestrator session project', () => {
    const session: TelegramSession = {
      chatId: 'c', threadId: 'main', project: 'zebra-dashboard',
      model: 'codex', agent: 'orchestrator', cwd: '', sessionKey: 'k',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    const route = inferNaturalTelegramRoute('do this thing', [session])
    assert.equal(route.project, 'zebra-dashboard')
  })
})
