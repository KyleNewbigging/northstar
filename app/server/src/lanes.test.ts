import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { inferTaskLane } from './lanes.js'

describe('inferTaskLane', () => {
  it('routes telegram source to telegram-intent lane', () => {
    assert.equal(inferTaskLane({ projectId: 'anything', source: 'telegram' }), 'telegram-intent')
  })

  it('matches telegram source case-insensitively', () => {
    assert.equal(inferTaskLane({ projectId: 'northstar', source: 'Telegram' }), 'telegram-intent')
    assert.equal(inferTaskLane({ projectId: 'other', source: 'TELEGRAM' }), 'telegram-intent')
  })

  it('routes northstar project to dev lane when non-telegram', () => {
    assert.equal(inferTaskLane({ projectId: 'northstar' }), 'dev')
    assert.equal(inferTaskLane({ projectId: 'northstar', source: 'cockpit' }), 'dev')
  })

  it('routes other projects to personal lane when non-telegram', () => {
    assert.equal(inferTaskLane({ projectId: 'zebra-dashboard' }), 'personal')
    assert.equal(inferTaskLane({ projectId: 'other', source: 'github' }), 'personal')
  })

  it('treats missing source as non-telegram', () => {
    assert.equal(inferTaskLane({ projectId: 'other' }), 'personal')
    assert.equal(inferTaskLane({ projectId: 'northstar' }), 'dev')
  })
})
