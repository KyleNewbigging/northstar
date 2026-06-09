import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'

import { dispatchAgent, getRun, listRuns, type DispatchRequest } from './agentRunner.js'
import { getDb } from './database.js'
import { ensureProjectGraph, ensureProjectGraphs, readGraphifyGraph } from './graphify.js'
import { githubCatalogPath, loadGithubCatalog } from './github.js'
import { databasePath, northstarHome } from './paths.js'
import { buildProjectGraph, graphifyToPayload } from './projectGraph.js'
import { appendProjectLearning, ensureProjectSkillsFile, readProjectSkills, summarizeProjectSkills } from './projectSkills.js'
import { discoverProjects } from './projects.js'
import type { ProjectAutomationState, LocalProject } from './projects.js'
import { listOnboarding, seedProjectOnboarding } from './onboarding.js'
import { getSchedulerSettings, updateSchedulerSettings, type SchedulerSettings } from './scheduler.js'
import { isWhisperAvailable, transcribeWithWhisper } from './transcribe.js'

const fastify = Fastify({ logger: true })
await fastify.register(cors, { origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] })
await fastify.register(websocket)

const db = getDb()
const graphEnsureAttempts = new Set<string>()

type InboxRow = {
  id: string
  type: 'question' | 'review' | 'blocked' | 'suggest'
  project: string
  task: string | null
  model: 'opus' | 'codex' | 'spark'
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  urgency: 'high' | 'med' | 'low'
  title: string
  ctx: string
  options_json?: string | null
  recommend?: number | null
  help?: string | null
  add?: number
  del?: number
  files?: number
}

const autonomyQuestionTemplates = [
  {
    title: (project: LocalProject) => `What lane should ${project.name} work slowly in?`,
    ctx: (project: LocalProject) =>
      `${project.name} is active for autonomous local progress. Northstar will stay in no-API mode and ask before risky code changes.`,
    options: ['Graphify and map the project first', 'Look for safe cleanup tasks', 'Only ask questions for now'],
    recommend: 0,
    help: 'Graphify-first gives the cockpit better context before any local agent attempts code edits.',
  },
  {
    title: (project: LocalProject) => `How much autonomy should ${project.name} have?`,
    ctx: (project: LocalProject) =>
      `${project.name} can keep making slow progress by preparing tasks and questions. Real process dispatch remains blocked until M6 guardrails pass.`,
    options: ['Prepare plans only', 'Prepare patches but require review', 'Pause autonomous work'],
    recommend: 1,
    help: 'Review-gated patches preserve momentum while keeping every filesystem-changing step under your control.',
  },
  {
    title: (project: LocalProject) => `What should block ${project.name} automatically?`,
    ctx: (project: LocalProject) =>
      `${project.name} has an active autonomous lane. Northstar needs your preference for when to stop and ask instead of guessing.`,
    options: ['Ask on architecture choices', 'Ask on dependency changes', 'Ask on both'],
    recommend: 2,
    help: 'Architecture and dependency changes both carry hidden costs, so asking on both is the safest default.',
  },
]

function loadAutomationState() {
  const rows = db.prepare('SELECT project_id, active, autonomous, cadence FROM project_settings').all() as Array<{
    project_id: string
    active: number
    autonomous: number
    cadence: 'slow' | 'paused'
  }>
  return new Map<string, ProjectAutomationState>(
    rows.map((row) => [row.project_id, { active: row.active === 1, autonomous: row.autonomous === 1, cadence: row.cadence }]),
  )
}

function currentProjects() {
  const automation = loadAutomationState()
  const projects = discoverProjects(undefined, automation)
  const missingLocalGraphs = projects.filter((project) => project.localExists && !project.graphReady && !graphEnsureAttempts.has(project.id))
  if (!missingLocalGraphs.length) return projects

  ensureProjectGraphs(missingLocalGraphs).forEach((result, index) => {
    graphEnsureAttempts.add(missingLocalGraphs[index].id)
    if (!result.ok) fastify.log.warn({ project: missingLocalGraphs[index].id, result }, 'project graph generation skipped')
  })
  return discoverProjects(undefined, automation)
}

function listInboxActions() {
  const rows = db
    .prepare(
      `SELECT
        id,
        type,
        project_id AS project,
        task_id AS task,
        model,
        priority,
        urgency,
        title,
        ctx,
        options_json,
        recommend,
        help
      FROM inbox_actions
      WHERE resolved_at IS NULL
      ORDER BY priority ASC, id ASC`,
    )
    .all() as InboxRow[]
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    project: row.project,
    task: row.task,
    model: row.model,
    priority: row.priority,
    ago: 'now',
    urgency: row.urgency,
    title: row.title,
    ctx: row.ctx,
    options: row.options_json ? JSON.parse(row.options_json) as string[] : undefined,
    recommend: row.recommend ?? undefined,
    help: row.help ?? undefined,
    add: row.add,
    del: row.del,
    files: row.files,
  }))
}

function seedNextAutonomyQuestion(project: LocalProject) {
  const unresolved = db
    .prepare("SELECT COUNT(*) AS count FROM inbox_actions WHERE project_id = ? AND id LIKE ? AND resolved_at IS NULL")
    .get(project.id, `AUTO-${project.id}-%`) as { count: number }
  if (unresolved.count > 0) return null

  const total = db
    .prepare("SELECT COUNT(*) AS count FROM inbox_actions WHERE project_id = ? AND id LIKE ?")
    .get(project.id, `AUTO-${project.id}-%`) as { count: number }
  if (total.count >= autonomyQuestionTemplates.length) return null

  const template = autonomyQuestionTemplates[total.count]
  const id = `AUTO-${project.id}-${total.count + 1}`
  db.prepare(
    `INSERT OR IGNORE INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, NULL, 'question', 'spark', 'P2', 'med', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project.id,
    template.title(project),
    template.ctx(project),
    JSON.stringify(template.options),
    template.recommend,
    template.help,
  )
  return id
}

fastify.get('/api/health', async () => ({ ok: true, northstarHome, databasePath }))
fastify.get('/api/projects', async () => ({ projects: currentProjects() }))
fastify.get('/api/scheduler', async () => ({ scheduler: getSchedulerSettings(db) }))
fastify.post('/api/scheduler', async (request) => {
  return { ok: true, scheduler: updateSchedulerSettings(db, request.body as Partial<SchedulerSettings>) }
})
fastify.get('/api/onboarding', async () => ({ onboarding: listOnboarding(db) }))
fastify.post('/api/onboarding/seed', async () => seedProjectOnboarding(db, currentProjects()))
fastify.get('/api/github/repositories', async () => ({ source: githubCatalogPath, repositories: loadGithubCatalog() }))
fastify.get('/api/projects/:id', async (request) => {
  const { id } = request.params as { id: string }
  return { project: currentProjects().find((project) => project.id === id) ?? null }
})
fastify.post('/api/projects/:id/activation', async (request) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { active?: boolean }
  const known = discoverProjects().find((project) => project.id === id)
  if (!known) return { ok: false, error: 'not_found' }
  const active = body.active !== false
  db.prepare(
    `INSERT INTO project_settings (project_id, active, autonomous, cadence, updated_at)
     VALUES (?, ?, ?, 'slow', CURRENT_TIMESTAMP)
     ON CONFLICT(project_id) DO UPDATE SET
       active = excluded.active,
       autonomous = excluded.autonomous,
       cadence = CASE WHEN excluded.active = 1 THEN 'slow' ELSE 'paused' END,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(id, active ? 1 : 0, active ? 1 : 0)
  const projects = currentProjects()
  const project = projects.find((item) => item.id === id) ?? null
  const skills = active && project ? ensureProjectSkillsFile(project) : null
  const seeded = active && project ? seedNextAutonomyQuestion(project) : null
  const updatedProjects = currentProjects()
  return { ok: true, project: updatedProjects.find((item) => item.id === id) ?? project, projects: updatedProjects, seeded, skills, actions: listInboxActions() }
})
fastify.post('/api/projects/:id/refresh', async (request) => {
  const { id } = request.params as { id: string }
  const project = currentProjects().find((item) => item.id === id)
  if (!project) return { error: 'not_found' }
  if (project.localExists) ensureProjectGraph(project, { force: true })
  const graph = readGraphifyGraph(project.path)
  return graph ? { status: 'graph_loaded', graph } : { status: 'graph_missing', expected: `${project.path}/graphify-out/graph.json` }
})
fastify.get('/api/inbox', async () => ({ actions: listInboxActions() }))
fastify.get('/api/projects/:id/skills', async (request) => {
  const { id } = request.params as { id: string }
  const project = currentProjects().find((item) => item.id === id)
  if (!project) return { ok: false, error: 'not_found' }
  return {
    ok: true,
    project: project.id,
    summary: summarizeProjectSkills(project),
    content: readProjectSkills(project, 20000),
  }
})
fastify.post('/api/projects/:id/skills/learn', async (request) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { note?: string }
  const project = currentProjects().find((item) => item.id === id)
  if (!project) return { ok: false, error: 'not_found' }
  if (!body.note?.trim()) return { ok: false, error: 'note_required' }
  return { ok: true, project: project.id, summary: appendProjectLearning(project, body.note, 'manual') }
})
fastify.post('/api/inbox/:id/resolve', async (request) => {
  const { id } = request.params as { id: string }
  const body = request.body as { choice?: string }
  db.prepare("UPDATE inbox_actions SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?").run(body.choice ?? '', id)
  return { ok: true, id, choice: body.choice ?? '' }
})
fastify.post('/api/autonomy/tick', async () => {
  const projects = currentProjects()
  const target = projects.find((project) => project.active && project.autonomous)
  const seeded = target ? seedNextAutonomyQuestion(target) : null
  return { ok: true, seeded, projects: currentProjects(), actions: listInboxActions() }
})
fastify.get('/api/queue', async () => ({
  tasks: db.prepare(
    `SELECT
      id,
      title,
      project_id AS project,
      model,
      agent,
      status,
      priority,
      progress,
      eta,
      stage,
      files,
      branch
     FROM tasks
     ORDER BY
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      id ASC`,
  ).all(),
}))
fastify.post('/api/queue/:id/pause', async (request) => ({ ok: true, id: (request.params as { id: string }).id, status: 'paused' }))
fastify.post('/api/queue/:id/resume', async (request) => ({ ok: true, id: (request.params as { id: string }).id, status: 'resume-queued' }))
fastify.get('/api/graph/:project', async (request) => {
  const { project } = request.params as { project: string }
  const projects = currentProjects()
  if (project === 'all') return buildProjectGraph(projects)
  const row = projects.find((item) => item.id === project)
  if (!row) return buildProjectGraph(projects)
  const graph = row.localExists ? readGraphifyGraph(row.path) : null
  return graph ? graphifyToPayload(row, graph.source, graph.graph) : buildProjectGraph(projects, project)
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
  return dispatchAgent(db, currentProjects(), request.body as DispatchRequest)
})
fastify.get('/api/runs', async () => ({ runs: listRuns(db) }))
fastify.get('/api/runs/:id', async (request) => {
  const { id } = request.params as { id: string }
  return { run: getRun(db, id) }
})
fastify.get('/api/usage', async () => ({ usage: db.prepare("SELECT * FROM usage WHERE day = date('now')").get() ?? null }))
fastify.get('/ws', { websocket: true }, (connection) => connection.send(JSON.stringify({ type: 'hello', payload: { northstarHome } })))

await fastify.listen({ host: '127.0.0.1', port: Number(process.env.NORTHSTAR_PORT ?? 4317) })
