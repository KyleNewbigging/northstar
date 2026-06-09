import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'

import { getDb } from './database.js'
import { readGraphifyGraph } from './graphify.js'
import { checkNoApiGuardrails } from './guardrails.js'
import { databasePath, northstarHome } from './paths.js'
import { discoverProjects } from './projects.js'
import { isWhisperAvailable, transcribeWithWhisper } from './transcribe.js'

const fastify = Fastify({ logger: true })
await fastify.register(cors, { origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] })
await fastify.register(websocket)

const db = getDb()

fastify.get('/api/health', async () => ({ ok: true, northstarHome, databasePath }))
fastify.get('/api/projects', async () => ({ projects: discoverProjects() }))
fastify.get('/api/projects/:id', async (request) => {
  const { id } = request.params as { id: string }
  return { project: discoverProjects().find((project) => project.id === id) ?? null }
})
fastify.post('/api/projects/:id/refresh', async (request) => {
  const { id } = request.params as { id: string }
  const project = discoverProjects().find((item) => item.id === id)
  if (!project) return { error: 'not_found' }
  const graph = readGraphifyGraph(project.path)
  return graph ? { status: 'graph_loaded', graph } : { status: 'graph_missing', expected: `${project.path}/graphify-out/graph.json` }
})
fastify.get('/api/inbox', async () => ({ actions: db.prepare('SELECT * FROM inbox_actions WHERE resolved_at IS NULL').all() }))
fastify.post('/api/inbox/:id/resolve', async (request) => {
  const { id } = request.params as { id: string }
  const body = request.body as { choice?: string }
  db.prepare("UPDATE inbox_actions SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?").run(body.choice ?? '', id)
  return { ok: true, id, choice: body.choice ?? '' }
})
fastify.get('/api/queue', async () => ({ tasks: db.prepare('SELECT * FROM tasks ORDER BY priority ASC').all() }))
fastify.post('/api/queue/:id/pause', async (request) => ({ ok: true, id: (request.params as { id: string }).id, status: 'paused' }))
fastify.post('/api/queue/:id/resume', async (request) => ({ ok: true, id: (request.params as { id: string }).id, status: 'resume-queued' }))
fastify.get('/api/graph/:project', async (request) => {
  const { project } = request.params as { project: string }
  const row = discoverProjects().find((item) => item.id === project)
  return row ? readGraphifyGraph(row.path) ?? { missing: true, nodes: [], edges: [], communities: [] } : { missing: true, nodes: [], edges: [], communities: [] }
})
fastify.get('/api/patches/:task', async () => ({ patch: null }))
fastify.post('/api/patches/:task/approve', async (request) => ({ ok: true, task: (request.params as { task: string }).task, status: 'merge_prepared', pushed: false }))
fastify.post('/api/patches/:task/request-changes', async (request) => ({ ok: true, task: (request.params as { task: string }).task, worktreeKept: true }))
fastify.get('/api/transcribe/capabilities', async () => ({ whisperAvailable: isWhisperAvailable() }))
fastify.post('/api/transcribe', async (request) => {
  const body = request.body as { audio?: string; mimeType?: string }
  if (!body?.audio || typeof body.audio !== 'string') return { ok: false, reason: 'invalid_payload' }
  if (!isWhisperAvailable()) return { ok: false, reason: 'whisper_missing', fallback: 'webspeech' }
  const result = await transcribeWithWhisper(body.audio, body.mimeType)
  return { ...result, ok: result.ok }
})
fastify.post('/api/dispatch', async (request) => {
  const guardrails = checkNoApiGuardrails()
  if (!guardrails.ok) return { ok: false, blocked: true, guardrails }
  return { ok: true, status: 'queued', request: request.body, note: 'Real child-process spawning starts in M6.' }
})
fastify.get('/api/usage', async () => ({ usage: db.prepare("SELECT * FROM usage WHERE day = date('now')").get() ?? null }))
fastify.get('/ws', { websocket: true }, (connection) => connection.send(JSON.stringify({ type: 'hello', payload: { northstarHome } })))

await fastify.listen({ host: '127.0.0.1', port: Number(process.env.NORTHSTAR_PORT ?? 4317) })
