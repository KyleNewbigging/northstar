import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { evaluateRequestGuard } from './requestGuard.js'

describe('evaluateRequestGuard', () => {
  it('allows a GET from a loopback Host', () => {
    assert.deepEqual(evaluateRequestGuard({ method: 'GET', host: '127.0.0.1:4317' }), { ok: true })
    assert.deepEqual(evaluateRequestGuard({ method: 'GET', host: 'localhost:5173' }), { ok: true })
    assert.deepEqual(evaluateRequestGuard({ method: 'GET', host: '[::1]:4317' }), { ok: true })
  })

  it('rejects a request with an external Host (DNS rebinding)', () => {
    const verdict = evaluateRequestGuard({ method: 'GET', host: 'evil.example.com' })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false && verdict.status, 403)
    assert.equal(verdict.ok === false && verdict.error, 'forbidden_host')
  })

  it('rejects a request with a missing Host header', () => {
    const verdict = evaluateRequestGuard({ method: 'GET', host: undefined })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false && verdict.error, 'forbidden_host')
  })

  it('rejects a cross-site Origin on a state-changing POST', () => {
    const verdict = evaluateRequestGuard({
      method: 'POST',
      host: '127.0.0.1:4317',
      origin: 'http://evil.example.com',
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false && verdict.status, 403)
    assert.equal(verdict.ok === false && verdict.error, 'forbidden_origin')
  })

  it('allows a POST with no Origin (curl, launchd scripts, server-to-server)', () => {
    assert.deepEqual(evaluateRequestGuard({ method: 'POST', host: '127.0.0.1:4317' }), { ok: true })
    assert.deepEqual(
      evaluateRequestGuard({ method: 'POST', host: '127.0.0.1:4317', origin: '' }),
      { ok: true },
    )
  })

  it('allows a POST carrying a loopback cockpit Origin on either host spelling and any port', () => {
    assert.deepEqual(
      evaluateRequestGuard({ method: 'POST', host: '127.0.0.1:4317', origin: 'http://127.0.0.1:5173' }),
      { ok: true },
    )
    assert.deepEqual(
      evaluateRequestGuard({ method: 'POST', host: 'localhost:4317', origin: 'http://localhost:5173' }),
      { ok: true },
    )
    // Vite preview / same-origin / other configured ports all pass.
    assert.deepEqual(
      evaluateRequestGuard({ method: 'POST', host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4173' }),
      { ok: true },
    )
    assert.deepEqual(
      evaluateRequestGuard({ method: 'POST', host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }),
      { ok: true },
    )
  })

  it('applies the Origin check to websocket upgrades even though they are GET', () => {
    const rejected = evaluateRequestGuard({
      method: 'GET',
      host: '127.0.0.1:4317',
      origin: 'http://evil.example.com',
      isWebsocketUpgrade: true,
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.ok === false && rejected.error, 'forbidden_origin')

    const allowed = evaluateRequestGuard({
      method: 'GET',
      host: '127.0.0.1:4317',
      origin: 'http://127.0.0.1:5173',
      isWebsocketUpgrade: true,
    })
    assert.deepEqual(allowed, { ok: true })
  })
})
