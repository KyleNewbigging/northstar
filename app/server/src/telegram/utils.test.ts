import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  cleanChatId,
  cleanNumericId,
  cleanProjectName,
  cleanSessionToken,
  clip,
  commandName,
  commandRest,
  isCommandText,
  isPriority,
  normalizeReplyText,
  parseAttentionPriority,
  parseCommandArgs,
  parseIdList,
  parseJson,
  parseResolveCallback,
  priorityRank,
  resolveFromCommand,
  resolveTelegramBridgeMode,
  telegramSessionScope,
  uniqueIds,
  urgencyRank,
} from './utils.js'

describe('resolveTelegramBridgeMode', () => {
  it('returns grammy for grammy/runner and poll otherwise', () => {
    assert.equal(resolveTelegramBridgeMode('grammy'), 'grammy')
    assert.equal(resolveTelegramBridgeMode('  RUNNER '), 'grammy')
    assert.equal(resolveTelegramBridgeMode('poll'), 'poll')
    assert.equal(resolveTelegramBridgeMode(''), 'poll')
    assert.equal(resolveTelegramBridgeMode('other'), 'poll')
  })
})

describe('parseAttentionPriority', () => {
  it('accepts P0-P3 and rejects garbage', () => {
    assert.equal(parseAttentionPriority('p1'), 'P1')
    assert.equal(parseAttentionPriority('  P3 '), 'P3')
    assert.equal(parseAttentionPriority('X'), null)
    assert.equal(parseAttentionPriority(null), null)
    assert.equal(parseAttentionPriority(undefined), null)
  })
})

describe('resolveFromCommand', () => {
  it('parses id and choice arguments', () => {
    assert.deepEqual(resolveFromCommand('/resolve ABC yes please'), { ok: true, id: 'ABC', choice: 'yes please' })
  })

  it('rejects missing id', () => {
    const r = resolveFromCommand('/resolve')
    assert.equal(r.ok, false)
  })
})

describe('parseResolveCallback', () => {
  it('accepts well-formed callback payloads', () => {
    assert.deepEqual(parseResolveCallback('resolve:ABC:2'), { ok: true, id: 'ABC', choice: '2' })
  })

  it('rejects other kinds or missing pieces', () => {
    assert.deepEqual(parseResolveCallback('other:ABC:1'), { ok: false })
    assert.deepEqual(parseResolveCallback('resolve::1'), { ok: false })
    assert.deepEqual(parseResolveCallback('resolve:ABC:'), { ok: false })
  })
})

describe('command text helpers', () => {
  it('extracts rest and command name', () => {
    assert.equal(commandRest('/task run this now'), 'run this now')
    assert.equal(commandName('/task@bot'), '/task')
    assert.equal(isCommandText('/next'), true)
    assert.equal(isCommandText('hello'), false)
    assert.equal(isCommandText(''), false)
  })
})

describe('normalizeReplyText', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    assert.equal(normalizeReplyText('  Yes “Please”!  '), 'yes please')
    assert.equal(normalizeReplyText(''), '')
    assert.equal(normalizeReplyText('!!!'), '')
  })
})

describe('parseCommandArgs', () => {
  it('handles quoted and escaped arguments', () => {
    assert.deepEqual(parseCommandArgs('one "two three" four'), ['one', 'two three', 'four'])
    assert.deepEqual(parseCommandArgs('a\\ b c'), ['a b', 'c'])
    assert.deepEqual(parseCommandArgs(''), [])
  })
})

describe('id list helpers', () => {
  it('parses and dedupes numeric-ish ids', () => {
    assert.deepEqual(parseIdList('1, 2, 2, -3, abc'), ['1', '2', '-3', ''].filter(Boolean))
    assert.deepEqual(uniqueIds(['1', '1', '2']), ['1', '2'])
    assert.equal(cleanNumericId('abc123-45'), '123-45')
    assert.equal(cleanNumericId(null), '')
  })
})

describe('cleanChatId / cleanSessionToken / cleanProjectName', () => {
  it('sanitizes and clips inputs', () => {
    assert.equal(cleanChatId('  @chat_id!! '), '@chat_id')
    assert.equal(cleanSessionToken('bad name!'), 'bad-name-')
    assert.equal(cleanSessionToken(''), '')
    assert.equal(cleanProjectName('/repos/my-project.git'), 'my-project')
    assert.equal(cleanProjectName(''), '')
    assert.equal(cleanProjectName('weird///path'), 'path')
  })
})

describe('priority + urgency ranks', () => {
  it('orders correctly', () => {
    assert.ok(priorityRank('P0') < priorityRank('P1'))
    assert.ok(priorityRank('P2') < priorityRank('P3'))
    assert.equal(urgencyRank('high'), 0)
    assert.equal(urgencyRank('low'), 2)
    assert.equal(isPriority('P1'), true)
    assert.equal(isPriority('nope'), false)
  })
})

describe('parseJson + clip', () => {
  it('returns fallback on invalid JSON', () => {
    assert.deepEqual(parseJson('{"a":1}', { a: 0 }), { a: 1 })
    assert.deepEqual(parseJson('not json', { a: 0 }), { a: 0 })
  })

  it('clips long strings with ellipsis', () => {
    assert.equal(clip('abcdefgh', 5), 'abcd...')
    assert.equal(clip('abc', 5), 'abc')
  })
})

describe('telegramSessionScope', () => {
  it('produces a chat/thread scope + queue key', () => {
    const scope = telegramSessionScope({ chat: { id: 42 }, message_thread_id: 7 })
    assert.equal(scope.chatId, '42')
    assert.equal(scope.threadId, '7')
    assert.equal(scope.queueKey, '42:7')

    const noThread = telegramSessionScope({ chat: { id: '99' } })
    assert.equal(noThread.threadId, 'main')
    assert.equal(noThread.queueKey, '99:main')
  })
})
