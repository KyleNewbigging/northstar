import type { FastifyInstance } from 'fastify'

// Northstar binds to 127.0.0.1 only, but "loopback bind" is not an auth boundary:
// a DNS-rebinding page or local malware can still reach these process-spawning /
// git-apply routes from a browser. This guard closes the two browser-reachable
// holes without adding tokens (token auth is a future step):
//   1. Host header must be a loopback host  -> kills DNS rebinding.
//   2. State-changing requests (and websocket upgrades) with a cross-site Origin
//      are rejected -> kills cross-site POST / WebSocket-hijack from evil pages.
// An absent Origin (curl, launchd scripts, server-to-server) is allowed on
// purpose: this is a browser-attack guard, not full authentication.

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export type RequestGuardInput = {
  method: string
  host?: string
  origin?: string
  isWebsocketUpgrade?: boolean
}

export type RequestGuardVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string; detail: string }

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

// Extract the bare hostname from a Host header value, dropping any port and the
// IPv6 brackets Host headers use (e.g. "[::1]:4317" -> "::1").
function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host) return null
  const trimmed = host.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? null : trimmed.slice(1, end)
  }
  const colon = trimmed.indexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

// A loopback Origin is any http(s) origin whose host is a loopback name, on any
// port. This deliberately accepts every configured port (Vite cockpit on 5173,
// the API on NORTHSTAR_PORT, vite preview on 4173, and same-origin), so no port
// env var needs to be threaded here.
function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  return isLoopbackHostname(hostname)
}

export function evaluateRequestGuard(input: RequestGuardInput): RequestGuardVerdict {
  const hostname = hostnameFromHostHeader(input.host)
  if (!hostname || !isLoopbackHostname(hostname)) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden_host',
      detail: 'Host header is not a loopback host.',
    }
  }

  const originGuarded =
    STATE_CHANGING_METHODS.has(input.method.toUpperCase()) || Boolean(input.isWebsocketUpgrade)
  if (originGuarded && input.origin !== undefined && input.origin !== '') {
    if (!isLoopbackOrigin(input.origin)) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden_origin',
        detail: 'Origin is not a loopback origin.',
      }
    }
  }

  return { ok: true }
}

// Registers an onRequest hook enforcing the Host/Origin guard on every route,
// including the /ws websocket upgrade. Wire this in immediately after the CORS
// and websocket plugins are registered.
export function registerRequestGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const verdict = evaluateRequestGuard({
      method: request.method,
      host: request.headers.host,
      origin: request.headers.origin,
      isWebsocketUpgrade: String(request.headers.upgrade ?? '').toLowerCase() === 'websocket',
    })
    if (!verdict.ok) {
      request.log.warn(
        { reason: verdict.error, method: request.method, host: request.headers.host, origin: request.headers.origin },
        'request guard rejected request',
      )
      reply.code(verdict.status).send({ ok: false, error: verdict.error, detail: verdict.detail })
      return reply
    }
  })
}
