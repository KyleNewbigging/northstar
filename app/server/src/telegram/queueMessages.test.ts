import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  buildQueueMessage,
  buildQueueMutationMessage,
  buildTaskIdNotFoundMessage,
  filterQueueTasks,
  matchTaskIdCandidates,
  parseQueueCommandArgs,
} from './messages.js'
import type { BridgeTask } from './types.js'

const tasks: BridgeTask[] = [
  { id: 'T-100', title: 'Ship queue observability', status: 'queued', lane: 'dev', priority: 'P1', stage: 'ready for dispatch', dispatchability: { status: 'runnable', canDispatchNow: true, reason: 'ready', stale: false } },
  { id: 'T-101', title: 'Personal errand', status: 'blocked', lane: 'personal', priority: 'P2', stage: 'awaiting decision', dispatchability: { status: 'blocked', canDispatchNow: false, reason: 'awaiting user confirmation', stale: false } },
  { id: 'T-102', title: 'Ancient chore', status: 'blocked', lane: 'dev', priority: 'P2', stage: 'paused manually', dispatchability: { status: 'blocked', canDispatchNow: false, reason: 'manually paused', stale: true } },
  { id: 'T-200', title: 'Telegram intent capture', status: 'needs-input', lane: 'telegram-intent', priority: 'P0', stage: 'inbox reply pending', dispatchability: { status: 'needs-input', canDispatchNow: false, reason: 'reply pending', stale: false } },
  { id: 'T-300', title: 'Running build', status: 'running', lane: 'dev', priority: 'P1', stage: 'running', dispatchability: { status: 'running', canDispatchNow: false, reason: 'attached', stale: false } },
]

describe('parseQueueCommandArgs', () => {
  it('parses no args as no filter', () => {
    assert.deepEqual(parseQueueCommandArgs(''), { lanes: [], statuses: [], unknown: [] })
  })

  it('parses a lane token', () => {
    assert.deepEqual(parseQueueCommandArgs('dev'), { lanes: ['dev'], statuses: [], unknown: [] })
  })

  it('maps telegram to telegram-intent lane', () => {
    assert.deepEqual(parseQueueCommandArgs('telegram'), { lanes: ['telegram-intent'], statuses: [], unknown: [] })
  })

  it('combines lane + status and is case insensitive', () => {
    const parsed = parseQueueCommandArgs('DEV Blocked')
    assert.deepEqual(parsed.lanes, ['dev'])
    assert.deepEqual(parsed.statuses, ['blocked'])
  })

  it('collects unknown tokens without failing', () => {
    const parsed = parseQueueCommandArgs('dev garbage stale')
    assert.deepEqual(parsed.lanes, ['dev'])
    assert.deepEqual(parsed.statuses, ['stale'])
    assert.deepEqual(parsed.unknown, ['garbage'])
  })

  it('accepts needs-input and needsinput as the same status', () => {
    const parsed = parseQueueCommandArgs('needsinput needs-input')
    assert.deepEqual(parsed.statuses, ['needs-input'])
  })
})

describe('filterQueueTasks', () => {
  it('filters by lane', () => {
    const filtered = filterQueueTasks(tasks, { lanes: ['personal'], statuses: [], unknown: [] })
    assert.deepEqual(filtered.map((t) => t.id), ['T-101'])
  })

  it('filters by stale', () => {
    const filtered = filterQueueTasks(tasks, { lanes: [], statuses: ['stale'], unknown: [] })
    assert.deepEqual(filtered.map((t) => t.id), ['T-102'])
  })

  it('combines lane + status', () => {
    const filtered = filterQueueTasks(tasks, { lanes: ['dev'], statuses: ['blocked'], unknown: [] })
    assert.deepEqual(filtered.map((t) => t.id), ['T-102'])
  })
})

describe('buildQueueMessage', () => {
  it('formats an empty-match message', () => {
    const message = buildQueueMessage(tasks, { lanes: ['personal'], statuses: ['stale'], unknown: [] })
    assert.match(message, /No tasks match this filter/)
  })

  it('lists filtered tasks with dispatchability lines and no line for running', () => {
    const message = buildQueueMessage(tasks, { lanes: [], statuses: [], unknown: [] })
    assert.match(message, /T-100/)
    assert.match(message, /runnable: ready/)
    assert.match(message, /T-300/)
    assert.doesNotMatch(message, /running: attached/)
  })

  it('caps rows and reports overflow', () => {
    const many: BridgeTask[] = Array.from({ length: 20 }, (_, i) => ({ id: `Q-${i}`, title: `t${i}`, status: 'queued', lane: 'dev', priority: 'P2', dispatchability: { status: 'runnable', canDispatchNow: true, reason: 'ready' } }))
    const message = buildQueueMessage(many, { lanes: [], statuses: [], unknown: [] })
    assert.match(message, /\.\.\.and 5 more/)
  })

  it('renders a stale marker in the meta line', () => {
    const message = buildQueueMessage(tasks, { lanes: [], statuses: ['stale'], unknown: [] })
    assert.match(message, /· stale/)
  })
})

describe('matchTaskIdCandidates', () => {
  it('returns exact case-insensitive match', () => {
    const result = matchTaskIdCandidates(tasks, 't-100')
    assert.equal(result.exact?.id, 'T-100')
    assert.deepEqual(result.candidates, [])
  })

  it('returns prefix candidates when no exact match', () => {
    const result = matchTaskIdCandidates(tasks, 'T-1')
    assert.equal(result.exact, null)
    assert.deepEqual(result.candidates.map((t) => t.id), ['T-100', 'T-101', 'T-102'])
  })

  it('caps candidate count to max', () => {
    const many: BridgeTask[] = Array.from({ length: 10 }, (_, i) => ({ id: `Q-${i}`, title: 't', status: 'queued', lane: 'dev', priority: 'P2' }))
    const result = matchTaskIdCandidates(many, 'Q', 3)
    assert.equal(result.candidates.length, 3)
  })

  it('returns empty candidates for empty query', () => {
    const result = matchTaskIdCandidates(tasks, '')
    assert.equal(result.exact, null)
    assert.deepEqual(result.candidates, [])
  })

  it('falls back to contains match when prefix misses', () => {
    const result = matchTaskIdCandidates(tasks, '200')
    assert.equal(result.exact, null)
    assert.deepEqual(result.candidates.map((t) => t.id), ['T-200'])
  })
})

describe('buildTaskIdNotFoundMessage + buildQueueMutationMessage', () => {
  it('renders candidates when present', () => {
    const message = buildTaskIdNotFoundMessage('dispatch', 'T-1', tasks.slice(0, 2))
    assert.match(message, /Candidates:/)
    assert.match(message, /T-100/)
  })

  it('reports pause success', () => {
    const message = buildQueueMutationMessage('pause', { ok: true, id: 'T-100', status: 'blocked' })
    assert.match(message, /paused T-100/)
  })

  it('reports requeue failure with error verbatim', () => {
    const message = buildQueueMutationMessage('requeue', { ok: false, id: 'T-100', error: 'task_running_cannot_requeue' })
    assert.match(message, /task_running_cannot_requeue/)
  })
})
