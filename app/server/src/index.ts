import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'

import { buildAgentGraph, type AgentGraphRun } from './agentGraph.js'
import { approvePatch, cancelRun, dispatchAgent, getPatch, getRun, listRuns, reconcileStaleRuns, refreshPatchArtifact, tmuxReconcileIntervalMs, type DispatchModel, type DispatchRequest, type TaskPriority } from './agentRunner.js'
import { getDb } from './database.js'
import { createDeviceFileActions } from './deviceFiles.js'
import { ensureProjectGraph, ensureProjectGraphs, readGraphifyGraph } from './graphify.js'
import { githubCatalogPath, loadGithubCatalog } from './github.js'
import { startHeartbeat, type HeartbeatAction, type HeartbeatProject, type HeartbeatRun, type HeartbeatTask, type HeartbeatTelegramStatus } from './heartbeat.js'
import { modelAuthStatus } from './guardrails.js'
import { databasePath, northstarHome } from './paths.js'
import { buildProjectGraph, graphifyToPayload } from './projectGraph.js'
import { appendProjectLearning, ensureProjectSkillsFile, readProjectSkills, summarizeProjectSkills } from './projectSkills.js'
import { discoverProjects } from './projects.js'
import type { ProjectAutomationState, LocalProject } from './projects.js'
import { buildStravaAuthorizationUrl, configureStrava, getHealthOverview, getHealthSyncStatus, handleStravaCallback, syncHealthSource } from './health.js'
import { listOnboarding, seedProjectOnboarding } from './onboarding.js'
import { getSchedulerSettings, updateSchedulerSettings, type SchedulerSettings } from './scheduler.js'
import {
  createTelegramBridge,
  listTelegramSessions,
  probeTelegramDocumentIntake,
  telegramCommandNames,
  updateTelegramBridgeSettings,
  upsertTelegramSession,
  type TelegramSession,
} from './telegram.js'
import { isWhisperAvailable, transcribeWithWhisper } from './transcribe.js'
import { codexUsagePath, isFresh, readClaudeUsageSnapshot, readOrRefreshCodexUsageSnapshot, writeCodexUsageSnapshot, type CodexUsageSnapshot, type ProviderUsageSnapshot } from './usageSources.js'

const maxTaskDispatchAttempts = Number(process.env.NORTHSTAR_TASK_MAX_DISPATCH_ATTEMPTS ?? '3')
const maxTaskModelAttempts = Number(process.env.NORTHSTAR_TASK_MAX_MODEL_ATTEMPTS ?? '2')
const fastify = Fastify({ logger: true })
await fastify.register(cors, { origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/] })
await fastify.register(websocket)

const db = getDb()
const staleRecovery = reconcileStaleRuns(db)
if (staleRecovery.recovered.length) fastify.log.warn({ recovered: staleRecovery.recovered }, 'recovered stale agent runs')
if (staleRecovery.finalized.length) fastify.log.info({ finalized: staleRecovery.finalized }, 'finalized tmux agent runs')
const graphEnsureAttempts = new Set<string>()
const realtimeClients = new Set<RealtimeSocket>()
const deviceFiles = createDeviceFileActions(db)
const telegramIntakeSerializers = new Map<string, Promise<void>>()
let telegramStatusForHeartbeat: (() => HeartbeatTelegramStatus) | null = null
const heartbeat = startHeartbeat({
  logger: fastify.log,
  snapshot: () => {
    const overview = buildOperationsOverviewSync()
    return {
      projects: overview.projects as HeartbeatProject[],
      tasks: overview.tasks as HeartbeatTask[],
      runs: listRuns(db) as HeartbeatRun[],
      actions: overview.openDecisions as HeartbeatAction[],
      deviceFiles: deviceFiles.status(),
      telegram: telegramStatusForHeartbeat?.() ?? null,
      nextAction: overview.nextAction,
    }
  },
})
const telegramBridge = createTelegramBridge(db, {
  logger: fastify.log,
  getSnapshot: () => ({
    actions: listInboxActions(),
    tasks: listQueueTasks(),
    runs: listRuns(db) as BridgeRunSnapshot[],
    projects: currentProjects(),
  }),
  getOperationsOverview: () => buildOperationsOverviewSync(),
  getQueueTask: (id) => queueTaskDetail(id),
  runQueueTask: (id) => dispatchQueuedTask(id),
  resolveInboxAction: (id, choice) => {
    const result = resolveInboxAction(id, choice)
    if (result.ok) broadcastRealtime('inbox:updated', result)
    return result
  },
  queuePrompt: (input) => {
    const result = queueTelegramPrompt(input)
    broadcastRealtime('telegram:prompt-queued', { result, tasks: listQueueTasks(), actions: listInboxActions(), projects: currentProjects() })
    return result
  },
  fileActions: deviceFiles,
  getHeartbeat: () => heartbeat.writeNow(),
})
telegramStatusForHeartbeat = () => {
  const status = telegramBridge.status()
  return {
    enabled: status.settings.enabled,
    ready: status.ready,
    polling: status.polling,
    tokenConfigured: status.tokenConfigured,
    chatConfigured: Boolean(status.settings.chatId),
    allowedUsersConfigured: status.settings.allowedUserIds.length > 0,
    lastSeenAt: status.settings.lastSeenAt,
    lastError: status.settings.lastError,
  }
}
await telegramBridge.start()
const tmuxReconcileTimer = setInterval(() => {
  const result = reconcileStaleRuns(db)
  if (!result.recovered.length && !result.finalized.length) return
  if (result.recovered.length) fastify.log.warn({ recovered: result.recovered }, 'recovered stale agent runs')
  if (result.finalized.length) fastify.log.info({ finalized: result.finalized }, 'finalized tmux agent runs')
  broadcastRealtime('runs:updated', { result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions(), projects: currentProjects() })
}, Math.max(1000, tmuxReconcileIntervalMs))
tmuxReconcileTimer.unref?.()

type RealtimeSocket = {
  readyState?: number
  send: (data: string) => void
  on?: (event: 'close' | 'error', handler: () => void) => void
  addEventListener?: (event: 'close' | 'error', handler: () => void) => void
}

type RealtimeEvent = {
  type: string
  payload: Record<string, unknown>
  at: string
}

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

type QueueRow = {
  id: string
  title: string
  project: string
  model: DispatchModel
  agent: string
  status: 'running' | 'needs-input' | 'queued' | 'blocked' | 'done' | 'idle'
  priority: TaskPriority
  progress: number
  eta: string
  stage: string
  files: number
  branch: string
  source: string
  sourceRef: string
  prompt: string
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  dispatchStatus?: string | null
  dispatchBlocker?: string | null
}

type QueueDispatchStatus =
  | 'runnable'
  | 'scheduler-waiting'
  | 'running'
  | 'done'
  | 'needs-input'
  | 'blocked'
  | 'manual'
  | 'github-only'
  | 'missing-project'
  | 'model-disabled'
  | 'no-free-slot'
  | 'guarded'

type QueueDispatchability = {
  status: QueueDispatchStatus
  runnable: boolean
  canDispatchNow: boolean
  reason: string
  action: string
  stale: boolean
  schedulerWaiting: boolean
}

type QueueTaskView = QueueRow & {
  dispatchability: QueueDispatchability
}

type AttentionAlert = {
  id: string
  eventType: 'task' | 'run'
  eventKey: string
  payload: {
    eventType: 'task' | 'run'
    key: string
    title: string
    text: string
    priority: 'P0' | 'P1' | 'P2' | 'P3'
    channel: string
    source?: string
    project: string
    createdAt: string
  }
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  nextRetryAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

type RunUsageRow = {
  model: DispatchModel
  status: string
  prompt?: string | null
  stdout?: string | null
  stderr?: string | null
  final_text?: string | null
  started_at?: string | null
  updated_at?: string | null
  completed_at?: string | null
}

type ManualProjectRow = {
  id: string
  name: string
  path: string
  branch: string
  lang: string
  status: LocalProject['status']
  label: LocalProject['label']
  health: number
  coverage: number
  tokens: number
  budget: number
  runtime: string
  last_event: string
  last_ago: string
}

type SchedulerTickBody = {
  force?: boolean
  dryRun?: boolean
}

type ManualApprovalBody = {
  manualApproval?: boolean
}

type OperationsOverview = {
  ok: true
  generatedAt: string
  summary: {
    activeProjects: number
    totalProjects: number
    openDecisions: number
    runningTasks: number
    queuedTasks: number
    blockedTasks: number
    liveRuns: number
    runnableTasks: number
    manualTasks: number
    githubOnlyTasks: number
    attentionPending: number
    attentionFailed: number
  }
  queuePressure: {
    totalOpen: number
    runnable: number
    schedulerWaiting: number
    blocked: number
    needsInput: number
    manual: number
    githubOnly: number
    modelDisabled: number
    noFreeSlot: number
  }
  nextAction: OperationsNextAction | null
  projects: LocalProject[]
  activeProjects: LocalProject[]
  tasks: QueueTaskView[]
  runs: ReturnType<typeof listRuns>
  liveRuns: ReturnType<typeof listRuns>
  openDecisions: ReturnType<typeof listInboxActions>
  telegram: {
    ready: boolean
    polling: boolean
    sessions: TelegramSession[]
    configuredChat: boolean
  }
  attention: {
    pending: number
    failed: number
    sent: number
    alerts: ReturnType<typeof listAttentionAlerts>
  }
  scheduler: SchedulerSettings
  modelUsage?: Awaited<ReturnType<typeof modelUsage>>
  modelAuth?: ReturnType<typeof modelAuthStatus>[]
}

type OperationsNextAction = {
  kind: 'resolve-inbox' | 'dispatch-task' | 'review-live-run' | 'clean-queue' | 'idle'
  title: string
  reason: string
  command: string
  taskId?: string
  actionId?: string
  runId?: string
  project?: string
  priority?: string
}

type BridgeRunSnapshot = {
  status?: string
}

const rollingFiveHoursMs = 5 * 60 * 60 * 1000
const rollingWeekMs = 7 * 24 * 60 * 60 * 1000
const usageModelOrder: DispatchModel[] = ['codex', 'spark', 'opus']

const usageProfiles: Record<DispatchModel, {
  label: string
  provider: string
  fiveHourCap: number
  weeklyCap: number
  computeWeight: number
  source: string
}> = {
  opus: {
    label: 'Claude Code',
    provider: 'Anthropic',
    fiveHourCap: usageCap('CLAUDE_CODE', '5H', 500000),
    weeklyCap: usageCap('CLAUDE_CODE', 'WEEK', 3000000),
    computeWeight: usageWeight('CLAUDE_CODE', 1.15),
    source: 'claude.ai local CLI',
  },
  spark: {
    label: 'Codex Spark',
    provider: 'OpenAI',
    fiveHourCap: usageCap('CODEX_SPARK', '5H', 1000000),
    weeklyCap: usageCap('CODEX_SPARK', 'WEEK', 10000000),
    computeWeight: usageWeight('CODEX_SPARK', 0.55),
    source: 'Codex CLI local telemetry',
  },
  codex: {
    label: 'Codex GPT-5.5',
    provider: 'OpenAI',
    fiveHourCap: usageCap('CODEX_55', '5H', 250000),
    weeklyCap: usageCap('CODEX_55', 'WEEK', 1000000),
    computeWeight: usageWeight('CODEX_55', 1.6),
    source: 'Codex CLI reserved/manual',
  },
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

const telegramPromptChoiceModels: Record<string, DispatchModel | 'discard'> = {
  'Queue Spark worktree': 'spark',
  'Queue Codex worktree': 'codex',
  'Queue Claude plan': 'opus',
  Discard: 'discard',
}

function telegramPromptChoicesFor(model: DispatchModel) {
  if (model === 'codex') return ['Queue Codex worktree', 'Queue Claude plan', 'Discard']
  if (model === 'opus') return ['Queue Claude plan', 'Queue Spark worktree', 'Discard']
  return ['Queue Spark worktree', 'Queue Claude plan', 'Discard']
}

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
  const discovered = discoverProjects(undefined, automation)
  const projects = mergeManualProjects(discovered, automation)
  const missingLocalGraphs = discovered.filter((project) => project.localExists && !project.graphReady && !graphEnsureAttempts.has(project.id))
  if (!missingLocalGraphs.length) return projects

  ensureProjectGraphs(missingLocalGraphs).forEach((result, index) => {
    graphEnsureAttempts.add(missingLocalGraphs[index].id)
    if (!result.ok) fastify.log.warn({ project: missingLocalGraphs[index].id, result }, 'project graph generation skipped')
  })
  return mergeManualProjects(discoverProjects(undefined, automation), automation)
}

function mergeManualProjects(discovered: LocalProject[], automation: Map<string, ProjectAutomationState>) {
  const discoveredIds = new Set(discovered.map((project) => project.id))
  return sortProjectsByTaskActivity([...discovered, ...listManualProjects(discoveredIds, automation)].map(applyRuntimeActivity))
}

function listManualProjects(discoveredIds: Set<string>, automation: Map<string, ProjectAutomationState>): LocalProject[] {
  const rows = db
    .prepare(
      `SELECT
        id,
        name,
        path,
        branch,
        lang,
        status,
        label,
        health,
        coverage,
        tokens,
        budget,
        runtime,
        last_event,
        last_ago
      FROM projects
      WHERE path LIKE 'manual:%'
      ORDER BY name ASC`,
    )
    .all() as ManualProjectRow[]

  return rows
    .filter((row) => !discoveredIds.has(row.id))
    .map((row) => manualProjectFromRow(row, automation.get(row.id)))
}

function manualProjectFromRow(row: ManualProjectRow, state?: ProjectAutomationState): LocalProject {
  const counts = taskCounts(row.id)
  const base: LocalProject = {
    id: row.id,
    name: row.name,
    path: row.path,
    branch: row.branch || '-',
    lang: row.lang || 'Personal workflow',
    status: row.status,
    label: row.label,
    health: row.health,
    agentsActive: counts.running,
    openTasks: counts.open,
    queued: counts.queued,
    commits24: 0,
    linesNet: '+0 / -0',
    coverage: row.coverage,
    tokens: row.tokens,
    budget: row.budget || 100000,
    runtime: row.runtime || 'manual',
    nodes: Math.max(32, counts.open * 8 + counts.queued * 4),
    communities: 3,
    lastEvent: row.last_event,
    lastAgo: row.last_ago,
    spark: manualSpark(row.id, counts.open, counts.queued),
    source: 'manual',
    localExists: false,
    graphReady: false,
    active: false,
    autonomous: false,
    cadence: 'paused',
    dirtyFiles: 0,
    behind: 0,
    ...summarizeProjectSkills({ id: row.id }),
  }
  return state?.active ? {
    ...base,
    active: true,
    autonomous: state.autonomous !== false,
    cadence: state.cadence ?? 'slow',
    status: base.status === 'needs-input' || base.status === 'blocked' ? base.status : 'running',
    agentsActive: Math.max(base.agentsActive, state.autonomous === false ? 0 : 1),
    runtime: state.autonomous === false ? base.runtime : 'autonomous slow',
    lastEvent: base.status === 'needs-input' || base.status === 'blocked' ? base.lastEvent : 'manual workflow active',
    lastAgo: base.status === 'needs-input' || base.status === 'blocked' ? base.lastAgo : 'slow',
  } : base
}

function taskCounts(projectId: string) {
  const open = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND status != 'done'").get(projectId) as { count: number }
  const queued = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND status = 'queued'").get(projectId) as { count: number }
  const running = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND status = 'running'").get(projectId) as { count: number }
  return { open: open.count, queued: queued.count, running: running.count }
}

function applyRuntimeActivity(project: LocalProject): LocalProject {
  const counts = taskCounts(project.id)
  const latest = latestRunActivity(project.id)
  const hasRuntimeWork = counts.open > 0 || counts.running > 0
  const status =
    counts.running > 0
      ? 'running'
      : project.active && project.status !== 'needs-input' && project.status !== 'blocked'
        ? 'running'
        : project.status

  return {
    ...project,
    status,
    agentsActive: Math.max(project.agentsActive, counts.running, project.active && project.autonomous ? 1 : 0),
    openTasks: Math.max(project.openTasks, counts.open),
    queued: Math.max(project.queued, counts.queued),
    runtime: project.active && project.autonomous ? 'autonomous slow' : project.runtime,
    lastEvent: latest ? `${modelLabel(latest.model)} ${latest.status} run` : hasRuntimeWork ? `${counts.open} queued/running task${counts.open === 1 ? '' : 's'}` : project.lastEvent,
    lastAgo: latest ? relativeAge(latest.updatedAt) : project.lastAgo,
  }
}

function latestRunActivity(projectId: string) {
  return db
    .prepare(
      `SELECT model, status, COALESCE(completed_at, updated_at, started_at) AS updatedAt
       FROM agent_runs
       WHERE project_id = ?
       ORDER BY datetime(COALESCE(completed_at, updated_at, started_at)) DESC
       LIMIT 1`,
    )
    .get(projectId) as { model: DispatchModel; status: string; updatedAt: string } | undefined
}

function sortProjectsByTaskActivity(projects: LocalProject[]) {
  const activity = new Map(projects.map((project) => [project.id, projectActivity(project.id)]))
  return [...projects].sort((a, b) => {
    const aa = activity.get(a.id) ?? { latest: 0, open: 0, running: 0, queued: 0 }
    const bb = activity.get(b.id) ?? { latest: 0, open: 0, running: 0, queued: 0 }
    const statusRank: Record<LocalProject['status'], number> = { running: 0, 'needs-input': 1, queued: 2, blocked: 3, idle: 4, done: 5 }
    return (
      Number(b.active) - Number(a.active) ||
      statusRank[a.status] - statusRank[b.status] ||
      bb.running - aa.running ||
      bb.latest - aa.latest ||
      bb.open - aa.open ||
      bb.queued - aa.queued ||
      Number(b.localExists) - Number(a.localExists) ||
      a.name.localeCompare(b.name)
    )
  })
}

function projectActivity(projectId: string) {
  const counts = taskCounts(projectId)
  const latest = latestRunActivity(projectId)
  const time = latest?.updatedAt ? Date.parse(latest.updatedAt) : 0
  return { ...counts, latest: Number.isFinite(time) ? time : 0 }
}

function relativeAge(value: string) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return 'recent'
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function manualSpark(id: string, open: number, queued: number) {
  const base = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
  return Array.from({ length: 12 }, (_, index) => Math.max(1, base + open + queued + (index % 4) + Math.floor(index / 4)))
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

function resolveInboxAction(id: string, rawChoice: string) {
  const row = db
    .prepare('SELECT id, task_id, options_json, resolved_at FROM inbox_actions WHERE id = ?')
    .get(id) as { id: string; task_id?: string | null; options_json?: string | null; resolved_at?: string | null } | undefined
  if (!row) return { ok: false, id, choice: rawChoice, error: 'inbox_action_not_found', actions: listInboxActions(), tasks: listQueueTasks(), runs: listRuns(db) }
  if (row.resolved_at) return { ok: false, id, choice: rawChoice, error: 'inbox_action_already_resolved', actions: listInboxActions(), tasks: listQueueTasks(), runs: listRuns(db) }

  const options = parseStringArray(row.options_json)
  const choice = normalizeInboxChoice(rawChoice, options)
  const taskResolution = resolveTelegramPromptTask(row.task_id, choice, options)
  db.prepare("UPDATE inbox_actions SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?").run(choice, id)
  return { ok: true, id, choice, taskResolution, actions: listInboxActions(), tasks: listQueueTasks(), runs: listRuns(db) }
}

function normalizeInboxChoice(rawChoice: string, options: string[]) {
  const choice = rawChoice.trim()
  if (/^\d+$/.test(choice) && options.length) {
    const option = options[Number(choice) - 1]
    if (option) return option
  }
  return choice
}

function resolveTelegramPromptTask(taskId: string | null | undefined, choice: string, options: string[]) {
  if (!taskId || !isTelegramPromptOptions(options)) return null
  const resolution = telegramPromptChoiceModels[choice]
  if (!resolution) return null
  if (resolution === 'discard') {
    db.prepare(
      `UPDATE tasks
       SET status = 'done',
         progress = 1,
         eta = 'discarded',
         stage = 'Telegram request discarded',
         updated_at = CURRENT_TIMESTAMP,
         completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status != 'running'`,
    ).run(taskId)
    return { taskId, status: 'done' }
  }

  db.prepare(
    `UPDATE tasks
     SET status = 'queued',
       model = ?,
       progress = 0,
       eta = 'next window',
       stage = ?,
       updated_at = CURRENT_TIMESTAMP,
       completed_at = NULL
     WHERE id = ? AND status != 'running'`,
  ).run(resolution, telegramApprovalStage(resolution), taskId)
  return { taskId, status: 'queued', model: resolution }
}

function telegramApprovalStage(model: DispatchModel) {
  if (model === 'opus') return 'Telegram approved for Claude plan'
  if (model === 'codex') return 'Telegram approved for Codex worktree'
  return 'Telegram approved for Spark worktree'
}

function telegramPromptHelp(model: DispatchModel) {
  if (model === 'codex') {
    return 'Codex queues the reserved GPT-5.5 worktree lane behind scheduler/cockpit guardrails. Claude queues a plan-only pass. Discard closes the task without dispatch.'
  }
  if (model === 'opus') {
    return 'Claude queues a plan-only pass first. Spark queues an isolated writable worktree. Discard closes the task without dispatch.'
  }
  return 'Spark queues an isolated writable worktree. Claude queues a plan-only pass. Discard closes the task without dispatch.'
}

function telegramSessionDispatchModel(session: TelegramSession): DispatchModel {
  const value = session.model.trim().toLowerCase()
  if (value === 'opus' || value === 'claude' || value === 'claude-code') return 'opus'
  if (value === 'codex' || value === 'gpt-5.5' || value === 'gpt-5.5-codex' || value === 'reserved') return 'codex'
  return 'spark'
}

function isTelegramPromptOptions(options: string[]) {
  return options.length >= 2 && options.includes('Discard') && options.every((option) => Boolean(telegramPromptChoiceModels[option]))
}

function parseStringArray(value?: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
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

function queueTelegramPrompt(input: { text: string; session: TelegramSession; messageId: number }) {
  const prompt = input.text.trim()
  if (!prompt) return { ok: false as const, error: 'prompt_required' }

  const routed = resolveTelegramSessionProject(input.session)
  if (!routed.ok) return routed

  const idStem = `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const taskId = `TG-${idStem}`
  const actionId = `TG-ACTION-${idStem}`
  const sourceRef = `telegram:${input.session.chatId}/${input.session.threadId}/${input.messageId}`
  const title = `Telegram: ${singleLine(prompt).slice(0, 110)}`
  const model = telegramSessionDispatchModel(input.session)
  const choices = telegramPromptChoicesFor(model)
  const lane = inferTelegramLane(input.session.model, input.session.agent)
  const laneWarning = inferLaneMismatchWarning(input.session.model, input.session.agent)

  db.prepare(
    `INSERT INTO tasks
      (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch, source, source_ref, prompt, updated_at)
     VALUES (?, ?, ?, ?, ?, 'needs-input', 'P1', 0.2, 'waiting', 'awaiting Telegram review', 0, '', 'telegram', ?, ?, CURRENT_TIMESTAMP)`,
  ).run(taskId, routed.projectId, title, model, cleanTaskAgent(input.session.agent), sourceRef, prompt)

  db.prepare(
    `INSERT INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, ?, 'question', ?, 'P1', 'high', ?, ?, ?, 0, ?)`,
  ).run(
    actionId,
    routed.projectId,
    taskId,
    model,
    `Review Telegram request for ${routed.projectName}`,
    [
      'Polaris captured your Telegram message and needs your approval before spending model time.',
      `Project: ${routed.projectName}.`,
      lane ? `Lane: ${lane}` : null,
      laneWarning,
      'No agent process has started.',
      '',
      'Request:',
      prompt,
    ].join('\n'),
    JSON.stringify(choices),
    telegramPromptHelp(model),
  )

  return { ok: true as const, taskId, actionId, project: routed.projectId, model, lane, laneWarning }
}

function resolveTelegramSessionProject(session: TelegramSession) {
  const sessionProject = session.project.trim()
  if (!sessionProject) return { ok: false as const, error: 'session_project_missing' }

  const projects = currentProjects()
  const match = projects.find((project) => project.id === sessionProject || project.name === sessionProject)
  if (match) return { ok: true as const, projectId: match.id, projectName: match.name }

  ensureTelegramManualProject(sessionProject)
  return { ok: true as const, projectId: sessionProject, projectName: sessionProject }
}

function buildTelegramIntakeNoSessionMessage(chatId: string, threadId: string, sessions: TelegramSession[]) {
  const topicLabel = `${chatId}/${threadId || 'main'}`
  const examples = [
    'orchestrator: /api/telegram/sessions with model codex and agent orchestrator',
    'personal: /api/telegram/sessions with model spark and agent personal',
  ]
  if (!sessions.length) {
    return [
      `No Telegram project session is bound to this chat/topic (${topicLabel}) yet.`,
      'Create a session first using /use in Telegram or /api/telegram/sessions.',
      'Example: { "chatId": "...", "threadId": "...", "project": "northstar", "model": "codex", "agent": "orchestrator" }',
      ...examples.map((line) => `  ${line}`),
      'No agent process has started.',
    ].join('\n')
  }
  return [
    `No Telegram project session is bound to this chat/topic (${topicLabel}) yet.`,
    'Known routes on this chat:',
    ...sessions.map((session) => `  ${session.threadId}: ${session.project} (${session.model} · ${session.agent})`),
    '',
    'Bind this topic with the lane you want:',
    ...examples.map((line) => `  ${line}`),
    'No agent process has started.',
  ].join('\n')
}

type TelegramIntakeDocument = {
  fileName?: string
  mimeType?: string
  fileSize?: number
  caption?: string
  sourceText?: string
}

function ensureTelegramManualProject(projectId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO projects
      (id, name, path, branch, lang, status, label, health, coverage, tokens, budget, runtime, last_event, last_ago)
     VALUES (?, ?, ?, '-', 'Telegram workflow', 'needs-input', 'personal', 0.55, 0, 0, 100000, 'telegram review-gated', 'Telegram prompt captured', 'now')`,
  ).run(projectId, projectId, `manual:telegram/${projectId}`)
}

function cleanTaskAgent(value: string) {
  return value.trim().replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 64) || 'telegram'
}

function inferTelegramLane(model: string, agent: string) {
  const normalizedModel = cleanSessionToken(model).toLowerCase()
  const normalizedAgent = cleanSessionToken(agent).toLowerCase()
  if (normalizedAgent === 'personal') return 'personal'
  if (normalizedAgent === 'orchestrator') return 'orchestrator'
  if (normalizedModel === 'spark') return 'personal'
  return 'orchestrator'
}

function inferLaneMismatchWarning(model: string, agent: string) {
  const normalizedModel = cleanSessionToken(model).toLowerCase()
  const normalizedAgent = cleanSessionToken(agent).toLowerCase()
  const laneByModel = normalizedModel === 'spark' ? 'personal' : 'orchestrator'
  const laneByAgent = normalizedAgent === 'personal' ? 'personal' : 'orchestrator'
  if (laneByModel === laneByAgent || !normalizedAgent) return null
  return `Lane guard: model ${normalizedModel || 'unknown'} usually maps to ${laneByModel} lane, while agent ${normalizedAgent || 'unknown'} maps to ${laneByAgent} lane.`
}

function cleanSessionToken(value: unknown) {
  return String(value ?? '').trim().replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 64)
}

function singleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

fastify.get('/api/health', async () => getHealthOverview(db))
fastify.get('/api/health/sync/status', async () => getHealthSyncStatus(db))
fastify.post('/api/health/strava/config', async (request) => {
  const body = (request.body ?? {}) as { clientId?: string; clientSecret?: string; redirectUri?: string }
  return configureStrava(db, body)
})
fastify.get('/api/health/strava/connect', async () => buildStravaAuthorizationUrl(db))
fastify.get('/api/health/strava/callback', async (request, reply) => {
  const result = await handleStravaCallback(db, request.query as { code?: string; scope?: string; state?: string; error?: string })
  const title = result.ok ? 'Strava connected' : 'Strava connection failed'
  const detail = result.ok ? 'You can close this tab and return to Northstar.' : `Northstar could not connect Strava: ${result.error}`
  return reply.type('text/html').send(`<!doctype html><html><head><title>${title}</title></head><body style="background:#10131b;color:#f0f1f3;font-family:monospace;padding:32px"><h1>${title}</h1><p>${detail}</p></body></html>`)
})
fastify.post('/api/health/sync/strava', async () => syncHealthSource(db, 'strava'))
fastify.post('/api/health/sync/garmin', async () => syncHealthSource(db, 'garmin'))
fastify.post('/api/health/sync/all', async () => {
  const stravaResult = await syncHealthSource(db, 'strava')
  const garminResult = await syncHealthSource(db, 'garmin')
  const sync = getHealthSyncStatus(db).sync
  return {
    ok: stravaResult.ok || garminResult.ok,
    summary: {
      strava: stravaResult,
      garmin: garminResult,
    },
    sync,
  }
})
fastify.get('/api/operations/overview', async () => buildOperationsOverview())
fastify.get('/api/projects', async () => ({ projects: currentProjects() }))
fastify.get('/api/scheduler', async () => ({ scheduler: getSchedulerSettings(db) }))
fastify.post('/api/scheduler', async (request) => {
  const result = { ok: true, scheduler: updateSchedulerSettings(db, request.body as Partial<SchedulerSettings>) }
  broadcastRealtime('scheduler:updated', { scheduler: result.scheduler })
  return result
})
fastify.get('/api/telegram/status', async () => telegramBridge.status())
fastify.get('/api/attention-alerts', async () => ({ alerts: listAttentionAlerts() }))
fastify.post('/api/attention-alerts/flush', async () => ({ ok: true, flushed: await telegramBridge.flushAttention() }))
fastify.post('/api/telegram/settings', async (request) => {
  const settings = updateTelegramBridgeSettings(db, request.body as Parameters<typeof updateTelegramBridgeSettings>[1])
  const result = { ...telegramBridge.status(), settings }
  broadcastRealtime('telegram:updated', { settings: result.settings, ready: result.ready })
  return result
})
fastify.post('/api/telegram/test', async () => telegramBridge.sendTest())
fastify.post('/api/telegram/poll', async () => telegramBridge.pollOnce())
fastify.get('/api/telegram/commands', async () => ({ commands: telegramCommandNames }))
fastify.get('/api/telegram/sessions', async () => ({ sessions: listTelegramSessions(db) }))
fastify.post('/api/telegram/sessions', async (request) => {
  const body = (request.body ?? {}) as { chatId?: string; threadId?: string; project?: string; model?: string; agent?: string; cwd?: string }
  if (!body.chatId?.trim()) return { ok: false, error: 'chat_id_required' }
  if (!body.project?.trim()) return { ok: false, error: 'project_required' }
  const workspace = deviceFiles.ensureProjectWorkspace({ project: body.project, repoPath: body.cwd })
  if (!workspace.ok) return workspace
  const session = upsertTelegramSession(db, {
    chatId: body.chatId,
    threadId: body.threadId,
    project: workspace.project,
    model: body.model,
    agent: body.agent,
    cwd: workspace.relPath,
  })
  const result = { ok: true, session, workspace, sessions: listTelegramSessions(db) }
  broadcastRealtime('telegram:sessions-updated', result)
  return result
})
fastify.post('/api/telegram/intake', async (request) => {
  const body = (request.body ?? {}) as {
    chatId?: string
    threadId?: string
    text?: string
    messageId?: number
    document?: TelegramIntakeDocument
  }
  const chatId = body.chatId?.trim()
  const threadId = body.threadId?.trim() || 'main'
  if (!chatId) return { ok: false, error: 'chat_id_required' }
  const directText = typeof body.text === 'string' ? body.text.trim() : ''
  const docBody = body.document
  const key = `${chatId}/${threadId}`
  const sessionFind = () => {
    const sessionsForChat = listTelegramSessions(db).filter((item) => item.chatId === chatId)
    const session = sessionsForChat.find((item) => item.threadId === threadId)
    if (!session) {
      const chatSessions = sessionsForChat
      return {
        ok: false,
        error: 'telegram_session_not_found' as const,
        errorMessage: buildTelegramIntakeNoSessionMessage(chatId, threadId, chatSessions),
        sessions: chatSessions,
        sessionCount: chatSessions.length,
      } as const
    }
    const text = deriveIntakeText({ directText, docBody })
    if (!text.ok) {
      return {
        ok: false,
        error: text.error,
        errorMessage: text.message,
        sessions: sessionsForChat,
        sessionCount: sessionsForChat.length,
      } as const
    }

    const result = queueTelegramPrompt({
      text: text.value,
      session,
      messageId: Number.isFinite(body.messageId) ? Number(body.messageId) : Date.now(),
    })
    broadcastRealtime('telegram:prompt-queued', { result, tasks: listQueueTasks(), actions: listInboxActions(), projects: currentProjects() })
    return { ...result, tasks: listQueueTasks(), actions: listInboxActions(), lane: inferTelegramLane(session.model, session.agent), laneWarning: inferLaneMismatchWarning(session.model, session.agent) }
  }

  const previous = telegramIntakeSerializers.get(key) ?? Promise.resolve<void>(undefined)
  const current = previous.catch(() => undefined).then(sessionFind)
  telegramIntakeSerializers.set(key, current.then(() => undefined, () => undefined))
  const result = await current
  return result
})

function deriveIntakeText(input: { directText: string; docBody?: TelegramIntakeDocument }) {
  if (input.directText) return { ok: true as const, value: input.directText }
  if (!input.docBody) return { ok: false as const, error: 'text_required', message: 'text or document payload required for intake' }
  const probe = probeTelegramDocumentIntake({
    fileName: input.docBody.fileName,
    mimeType: input.docBody.mimeType,
    fileSize: input.docBody.fileSize,
    caption: input.docBody.caption,
    sourceText: input.docBody.sourceText,
  })
  if (!probe.ok) return { ok: false as const, error: 'telegram_document_rejected', message: probe.message }
  return { ok: true as const, value: probe.prompt }
}
fastify.get('/api/heartbeat', async () => heartbeat.writeNow())
fastify.get('/api/device-files/status', async () => deviceFiles.status())
fastify.get('/api/device-files/list', async (request) => {
  const query = request.query as { path?: string; limit?: string; includeHidden?: string }
  return deviceFiles.list({
    path: query.path,
    limit: numberFromQuery(query.limit),
    includeHidden: truthyQuery(query.includeHidden),
  })
})
fastify.get('/api/device-files/search', async (request) => {
  const query = request.query as { q?: string; query?: string; limit?: string; maxVisited?: string }
  return deviceFiles.search({
    query: query.q ?? query.query,
    limit: numberFromQuery(query.limit),
    maxVisited: numberFromQuery(query.maxVisited),
  })
})
fastify.get('/api/device-files/preview', async (request) => {
  const query = request.query as { path?: string; maxChars?: string }
  return deviceFiles.preview({
    path: query.path,
    maxChars: numberFromQuery(query.maxChars),
  })
})
fastify.get('/api/device-files/handoffs', async (request) => {
  const query = request.query as { device?: string; targetDevice?: string; limit?: string }
  return deviceFiles.listHandoffs({
    targetDevice: query.device ?? query.targetDevice,
    limit: numberFromQuery(query.limit),
  })
})
fastify.post('/api/device-files/handoffs', async (request) => {
  const body = (request.body ?? {}) as { targetDevice?: string; path?: string; note?: string }
  const result = deviceFiles.createHandoff(body)
  broadcastRealtime('device-files:updated', { result })
  return result
})
fastify.post('/api/device-files/projects/:project/workspace', async (request) => {
  const { project } = request.params as { project: string }
  const body = (request.body ?? {}) as { repoPath?: string; note?: string }
  const result = deviceFiles.ensureProjectWorkspace({ project, repoPath: body.repoPath, note: body.note })
  broadcastRealtime('device-files:updated', { result })
  return result
})
fastify.post('/api/device-files/projects/:project/resources', async (request) => {
  const { project } = request.params as { project: string }
  const body = (request.body ?? {}) as { title?: string; content?: string }
  const result = deviceFiles.saveProjectResource({ project, title: body.title, content: body.content })
  broadcastRealtime('device-files:updated', { result })
  return result
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
  const known = currentProjects().find((project) => project.id === id)
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
  const result = { ok: true, project: updatedProjects.find((item) => item.id === id) ?? project, projects: updatedProjects, seeded, skills, actions: listInboxActions() }
  broadcastRealtime('projects:updated', { projects: result.projects, actions: result.actions })
  return result
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
  const result = resolveInboxAction(id, body.choice ?? '')
  broadcastRealtime('inbox:updated', result)
  return result
})
fastify.post('/api/autonomy/tick', async () => {
  const projects = currentProjects()
  const target = projects.find((project) => project.active && project.autonomous)
  const seeded = target ? seedNextAutonomyQuestion(target) : null
  const result = { ok: true, seeded, projects: currentProjects(), actions: listInboxActions() }
  broadcastRealtime('autonomy:tick', result)
  return result
})
fastify.get('/api/queue', async () => ({
  tasks: listQueueTasks(),
}))
fastify.get('/api/queue/:id', async (request) => queueTaskDetail((request.params as { id: string }).id))
fastify.get('/api/agent-graph', async () => buildAgentGraph(currentProjects(), listQueueTasks(), listRuns(db) as AgentGraphRun[], listInboxActions()))
fastify.post('/api/queue/:id/dispatch', async (request) => {
  const { id } = request.params as { id: string }
  const result = dispatchQueuedTask(id, (request.body ?? {}) as ManualApprovalBody)
  broadcastRealtime('queue:updated', { taskId: id, result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions() })
  return result
})
fastify.post('/api/queue/:id/pause', async (request) => {
  const { id } = request.params as { id: string }
  db.prepare("UPDATE tasks SET status = 'blocked', eta = 'paused', stage = 'paused manually', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'running'").run(id)
  const result = { ok: true, id, status: 'blocked', tasks: listQueueTasks(), runs: listRuns(db) }
  broadcastRealtime('queue:updated', result)
  return result
})
fastify.post('/api/queue/:id/resume', async (request) => {
  const { id } = request.params as { id: string }
  db.prepare("UPDATE tasks SET status = 'queued', eta = 'next window', stage = 'ready for dispatch', updated_at = CURRENT_TIMESTAMP, completed_at = NULL WHERE id = ? AND status != 'running'").run(id)
  const result = { ok: true, id, status: 'queued', tasks: listQueueTasks(), runs: listRuns(db) }
  broadcastRealtime('queue:updated', result)
  return result
})
fastify.post('/api/scheduler/tick', async (request) => {
  const result = await runSchedulerTick((request.body ?? {}) as SchedulerTickBody)
  broadcastRealtime('scheduler:tick', { result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions(), projects: currentProjects() })
  return result
})
fastify.get('/api/graph/:project', async (request) => {
  const { project } = request.params as { project: string }
  const projects = currentProjects()
  if (project === 'all' || project === 'active') return buildProjectGraph(projects, project)
  const row = projects.find((item) => item.id === project)
  if (!row) return buildProjectGraph(projects)
  const graph = row.localExists ? readGraphifyGraph(row.path) : null
  return graph ? graphifyToPayload(row, graph.source, graph.graph) : buildProjectGraph(projects, project)
})
fastify.get('/api/patches/:task', async (request) => ({ patch: getPatch(db, (request.params as { task: string }).task) }))
fastify.post('/api/patches/:task/refresh', async (request) => {
  const result = refreshPatchArtifact(db, currentProjects(), (request.params as { task: string }).task)
  broadcastRealtime('patches:updated', { result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions(), projects: currentProjects() })
  return result
})
fastify.post('/api/patches/:task/approve', async (request) => {
  const result = approvePatch(db, (request.params as { task: string }).task)
  broadcastRealtime('patches:updated', { result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions(), projects: currentProjects() })
  return result
})
fastify.post('/api/patches/:task/request-changes', async (request) => {
  const { task } = request.params as { task: string }
  const body = (request.body ?? {}) as { notes?: string }
  const patch = getPatch(db, task)
  if (!patch) return { ok: false, error: 'patch_not_found' }
  db.prepare(
    `INSERT OR REPLACE INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, ?, 'question', ?, 'P1', 'high', ?, ?, ?, 0, ?)`,
  ).run(
    `RUN-CHANGES-${patch.task}`,
    patch.project,
    patch.task,
    patch.model,
    `Changes requested for ${patch.task}`,
    body.notes?.trim() || 'Kyle requested changes from Patch Review. Add the exact next instruction or dispatch a follow-up agent pass.',
    JSON.stringify(['Dispatch follow-up', 'Leave note only', 'Pause']),
    `Worktree kept at ${patch.worktree}.`,
  )
  const result = { ok: true, task: patch.task, worktreeKept: true, actions: listInboxActions() }
  broadcastRealtime('patches:updated', result)
  return result
})
fastify.get('/api/transcribe/capabilities', async () => ({ whisperAvailable: isWhisperAvailable() }))
fastify.post('/api/transcribe', async (request) => {
  const body = request.body as { audio?: string; mimeType?: string }
  if (!body?.audio || typeof body.audio !== 'string') return { ok: false, reason: 'invalid_payload' }
  if (!isWhisperAvailable()) return { ok: false, reason: 'whisper_missing', fallback: 'webspeech' }
  const result = await transcribeWithWhisper(body.audio, body.mimeType)
  return { ...result, ok: result.ok }
})
fastify.post('/api/dispatch', async (request) => {
  const result = dispatchAgent(db, currentProjects(), (request.body ?? {}) as DispatchRequest)
  broadcastRealtime('runs:updated', { result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions(), projects: currentProjects() })
  return result
})
fastify.get('/api/runs', async () => ({ runs: listRuns(db) }))
fastify.get('/api/runs/:id', async (request) => {
  const { id } = request.params as { id: string }
  return { run: getRun(db, id) }
})
fastify.post('/api/runs/:id/cancel', async (request) => {
  const { id } = request.params as { id: string }
  const result = await cancelRun(db, id)
  broadcastRealtime('runs:updated', { result, tasks: listQueueTasks(), runs: listRuns(db), actions: listInboxActions(), projects: currentProjects() })
  return result
})
fastify.get('/api/usage', async () => ({ usage: db.prepare("SELECT * FROM usage WHERE day = date('now')").get() ?? null }))
fastify.get('/api/agent-auth', async () => ({ models: usageModelOrder.map((model) => modelAuthStatus(model)) }))
fastify.get('/api/model-usage', async () => ({ models: await modelUsage() }))
fastify.post('/api/model-usage/codex-snapshot', async (request) => {
  const body = request.body as Partial<CodexUsageSnapshot>
  if (body?.source !== 'chatgpt_codex_analytics') return { ok: false, error: 'source_must_be_chatgpt_codex_analytics' }
  const snapshot: CodexUsageSnapshot = {
    source: 'chatgpt_codex_analytics',
    provider: 'OpenAI',
    capturedAt: body.capturedAt ?? new Date().toISOString(),
    staleAfterSeconds: body.staleAfterSeconds ?? 15 * 60,
    models: body.models?.filter((item) => item.id === 'codex' || item.id === 'spark'),
    raw: body.raw,
  }
  writeCodexUsageSnapshot(snapshot)
  const models = await modelUsage()
  const result = { ok: true, path: codexUsagePath, models }
  broadcastRealtime('usage:updated', { models })
  return result
})
fastify.get('/ws', { websocket: true }, (connection) => addRealtimeClient(connection as RealtimeSocket))

await fastify.listen({ host: '127.0.0.1', port: Number(process.env.NORTHSTAR_PORT ?? 4317) })

function usageCap(modelKey: string, windowKey: '5H' | 'WEEK', fallback: number) {
  const value = Number(process.env[`NORTHSTAR_USAGE_${modelKey}_${windowKey}_CAP`])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

function usageWeight(modelKey: string, fallback: number) {
  const value = Number(process.env[`NORTHSTAR_USAGE_${modelKey}_COMPUTE_WEIGHT`])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function tokenEstimate(value?: string | null) {
  if (!value) return 0
  return Math.ceil(value.length / 4)
}

function runTokenEstimate(row: RunUsageRow) {
  const streamed = tokenEstimate(row.stdout) + tokenEstimate(row.stderr)
  return tokenEstimate(row.prompt) + Math.max(streamed, tokenEstimate(row.final_text))
}

function rowTime(row: RunUsageRow) {
  const value = row.completed_at || row.updated_at || row.started_at
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : Date.now()
}

async function modelUsage() {
  const now = Date.now()
  const claudeSnapshot = readClaudeUsageSnapshot()
  const codexSnapshot = await readOrRefreshCodexUsageSnapshot()
  const rows = db
    .prepare(
      `SELECT
        model,
        status,
        prompt,
        stdout,
        stderr,
        final_text,
        started_at,
        updated_at,
        completed_at
       FROM agent_runs
       WHERE datetime(COALESCE(completed_at, updated_at, started_at)) >= datetime('now', '-7 days')`,
    )
    .all() as RunUsageRow[]
  const queuedRows = db
    .prepare("SELECT model, COUNT(*) AS count FROM tasks WHERE status = 'queued' GROUP BY model")
    .all() as Array<{ model: DispatchModel; count: number }>
  const queuedByModel = new Map(queuedRows.map((row) => [row.model, row.count]))

  return usageModelOrder.map((model) => {
    const profile = usageProfiles[model]
    const providerSnapshot = usageSnapshotForModel(model, claudeSnapshot, codexSnapshot)
    const hasFreshProviderUsage = isFresh(providerSnapshot)
    const modelRows = rows.filter((row) => row.model === model)
    const rolling5hTokens = modelRows.reduce((sum, row) => rowTime(row) >= now - rollingFiveHoursMs ? sum + runTokenEstimate(row) : sum, 0)
    const weeklyTokens = modelRows.reduce((sum, row) => sum + runTokenEstimate(row), 0)
    const liveRuns = modelRows.filter((row) => row.status === 'running').length
    const fiveHourPct = profile.fiveHourCap ? Math.min(1, rolling5hTokens / profile.fiveHourCap) : 0
    const weekPct = profile.weeklyCap ? Math.min(1, weeklyTokens / profile.weeklyCap) : 0
    const fiveHourUsedPct = hasFreshProviderUsage ? pctNumber(providerSnapshot?.fiveHourUsedPct) : null
    const weeklyUsedPct = hasFreshProviderUsage ? pctNumber(providerSnapshot?.weeklyUsedPct) : null
    const estimateComputePct = Math.min(100, Math.round(Math.max(fiveHourPct, weekPct) * 100 * profile.computeWeight))

    return {
      id: model,
      label: profile.label,
      provider: profile.provider,
      source: hasFreshProviderUsage ? providerSnapshot?.source : profile.source,
      sourceFresh: hasFreshProviderUsage,
      sourceKind: hasFreshProviderUsage ? providerSnapshot?.source : 'local_estimate',
      tokens5h: rolling5hTokens,
      tokens5hCap: profile.fiveHourCap,
      tokensWeek: weeklyTokens,
      tokensWeekCap: profile.weeklyCap,
      fiveHourUsedPct,
      weeklyUsedPct,
      fiveHourResetAt: hasFreshProviderUsage ? providerSnapshot?.fiveHourResetAt ?? null : null,
      weeklyResetAt: hasFreshProviderUsage ? providerSnapshot?.weeklyResetAt ?? null : null,
      computePct: Math.round(Math.max(fiveHourUsedPct ?? estimateComputePct, weeklyUsedPct ?? estimateComputePct)),
      liveRuns,
      queued: queuedByModel.get(model) ?? 0,
      updatedAt: hasFreshProviderUsage && providerSnapshot?.capturedAt ? providerSnapshot.capturedAt : new Date(now).toISOString(),
    }
  })
}

function usageSnapshotForModel(model: DispatchModel, claudeSnapshot: ProviderUsageSnapshot | null, codexSnapshot: CodexUsageSnapshot | null) {
  if (model === 'opus') return claudeSnapshot?.source === 'claude_statusline' ? claudeSnapshot : null
  if (codexSnapshot?.source !== 'chatgpt_codex_analytics' && codexSnapshot?.source !== 'codex_app_server') return null
  return codexSnapshot.models?.find((item) => item.id === model) ?? null
}

function pctNumber(value: unknown) {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return null
  return Math.min(100, Math.max(0, numberValue))
}

function numberFromQuery(value: unknown) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function truthyQuery(value: unknown) {
  return value === '1' || value === 'true' || value === true
}

function addRealtimeClient(connection: RealtimeSocket) {
  realtimeClients.add(connection)
  const cleanup = () => realtimeClients.delete(connection)
  connection.on?.('close', cleanup)
  connection.on?.('error', cleanup)
  connection.addEventListener?.('close', cleanup)
  connection.addEventListener?.('error', cleanup)
  sendRealtime(connection, 'hello', { northstarHome })
}

function broadcastRealtime(type: string, payload: Record<string, unknown>) {
  for (const client of realtimeClients) sendRealtime(client, type, payload)
  void telegramBridge.notify(type, payload)
  if (shouldBroadcastOperations(type)) void broadcastOperationsUpdated(type)
}

function sendRealtime(client: RealtimeSocket, type: string, payload: Record<string, unknown>) {
  if (typeof client.readyState === 'number' && client.readyState !== 1) {
    realtimeClients.delete(client)
    return
  }
  const event: RealtimeEvent = { type, payload, at: new Date().toISOString() }
  try {
    client.send(JSON.stringify(event))
  } catch (error) {
    realtimeClients.delete(client)
    fastify.log.warn({ error, type }, 'realtime send failed')
  }
}

function shouldBroadcastOperations(type: string) {
  return /^(queue|runs|inbox|telegram|scheduler|projects|autonomy|patches|usage|device-files):/.test(type)
}

async function broadcastOperationsUpdated(reason: string) {
  try {
    const overview = await buildOperationsOverview()
    for (const client of realtimeClients) sendRealtime(client, 'operations:updated', { reason, overview })
  } catch (error) {
    fastify.log.warn({ error, reason }, 'operations overview realtime update failed')
  }
}

function queueTaskById(id: string) {
  return (
    db
      .prepare(
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
          branch,
          source,
          source_ref AS sourceRef,
          prompt,
          created_at AS createdAt,
          updated_at AS updatedAt,
          completed_at AS completedAt,
          dispatch_status AS dispatchStatus,
          dispatch_blocker AS dispatchBlocker
         FROM tasks
         WHERE id = ?`,
      )
      .get(id) as QueueRow | undefined
  )
}

function listQueueTasks() {
  const rows = db.prepare(
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
      branch,
      source,
      source_ref AS sourceRef,
      prompt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      completed_at AS completedAt,
      dispatch_status AS dispatchStatus,
      dispatch_blocker AS dispatchBlocker
     FROM tasks
     ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'needs-input' THEN 1 WHEN 'queued' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      id ASC`,
  ).all() as QueueRow[]
  return decorateQueueTasks(rows, currentProjects())
}

function queueTaskDetail(id: string) {
  const task = queueTaskById(id)
  if (!task) return { ok: false as const, error: 'task_not_found' }
  const projects = currentProjects()
  const decorated = decorateQueueTask(task, projects)
  const project = projects.find((item) => item.id === task.project) ?? undefined
  const runs = (listRuns(db) as Array<Record<string, unknown>>).filter((run) => run.taskId === id || run.task_id === id)
  const actions = listInboxActions().filter((action) => action.task === id)
  return { ok: true as const, task: decorated, dispatchability: decorated.dispatchability, project, runs, actions }
}

function decorateQueueTasks(tasks: QueueRow[], projects: LocalProject[]) {
  return tasks.map((task) => decorateQueueTask(task, projects))
}

function decorateQueueTask(task: QueueRow, projects: LocalProject[]): QueueTaskView {
  const dispatchability = queueDispatchability(task, projects)
  const dispatchStatus = dispatchability.status
  const dispatchBlocker = dispatchability.runnable ? '' : dispatchability.reason
  if (task.dispatchStatus !== dispatchStatus || (task.dispatchBlocker ?? '') !== dispatchBlocker) {
    db.prepare('UPDATE tasks SET dispatch_status = ?, dispatch_blocker = ? WHERE id = ?').run(dispatchStatus, dispatchBlocker, task.id)
  }
  return {
    ...task,
    dispatchStatus,
    dispatchBlocker,
    dispatchability,
  }
}

function queueDispatchability(task: QueueRow, projects: LocalProject[]): QueueDispatchability {
  const stale = isTaskStale(task)
  const base = (status: QueueDispatchStatus, reason: string, action: string, runnable = false, schedulerWaiting = false): QueueDispatchability => ({
    status,
    runnable,
    canDispatchNow: runnable,
    reason,
    action,
    stale,
    schedulerWaiting,
  })

  if (task.status === 'running') return base('running', 'A local CLI process is already attached to this task.', 'Watch the live run')
  if (task.status === 'done') return base('done', 'This task is already complete.', 'Review the archived result')
  if (task.status === 'needs-input') return base('needs-input', task.stage || 'This task needs an inbox answer before dispatch.', 'Resolve the inbox item')
  if (task.status === 'blocked') return base('blocked', task.stage || 'This task is blocked.', 'Resume or revise the task')
  const attemptGuard = taskAttemptGuard(task)
  if (!attemptGuard.ok) return base('guarded', attemptGuard.reason, 'Review with Polaris before spending more model time')

  const project = projects.find((item) => item.id === task.project)
  if (!project) return base('missing-project', 'Project is not in the current Northstar inventory.', 'Refresh projects or recreate the task')
  if (project.source === 'manual') {
    return base('manual', `${project.name} is a manual workflow; it can hold plans and decisions, but it has no checkout for a worktree run.`, 'Use Telegram/dashboard planning or link a local checkout')
  }
  if (!project.localExists || project.path.startsWith('github:')) {
    return base('github-only', `${project.name} is GitHub-only or not cloned on this machine.`, 'Clone the repo locally before dispatch')
  }

  const settings = getSchedulerSettings(db)
  if (task.model === 'codex') {
    return base('guarded', 'Codex GPT-5.5 is reserved/manual and cannot be dispatched from Telegram or the default queue button.', 'Use an explicit local cockpit approval flow')
  }
  if (!modelEnabled(settings, task.model)) {
    return base('model-disabled', `${modelLabel(task.model)} is disabled in scheduler settings.`, 'Enable the model lane or choose another model')
  }

  const running = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running'").get() as { count: number }
  if (running.count >= settings.maxParallelRuns) {
    return base('no-free-slot', `All ${settings.maxParallelRuns} configured scheduler slots are busy.`, 'Wait for a run to finish or increase slots')
  }

  if (settings.enabled && !isWithinWindow(settings, new Date())) {
    return base('scheduler-waiting', `Outside the autonomous window ${settings.startTime}-${settings.endTime} ${settings.timezone}; manual dispatch is still allowed.`, 'Run manually or wait for the scheduler window', true, true)
  }

  return base('runnable', 'Local checkout, model lane, tmux, and slot checks are clear for a review-gated worktree run.', 'Run review-gated worktree', true)
}

function taskAttemptGuard(task: Pick<QueueRow, 'id' | 'model' | 'title' | 'project'>) {
  const rows = db
    .prepare('SELECT model, COUNT(*) AS count FROM agent_runs WHERE task_id = ? GROUP BY model')
    .all(task.id) as Array<{ model: DispatchModel; count: number }>
  const byModel = new Map(rows.map((row) => [row.model, Number(row.count)]))
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0)
  const currentModelAttempts = byModel.get(task.model) ?? 0
  if (total >= maxTaskDispatchAttempts) {
    return {
      ok: false as const,
      total,
      currentModelAttempts,
      reason: `Polaris paused this task after ${total} dispatch attempt${total === 1 ? '' : 's'} to prevent a model handoff loop.`,
    }
  }
  if (currentModelAttempts >= maxTaskModelAttempts) {
    return {
      ok: false as const,
      total,
      currentModelAttempts,
      reason: `Polaris paused this task because ${modelLabel(task.model)} has already tried it ${currentModelAttempts} times.`,
    }
  }
  return { ok: true as const, total, currentModelAttempts }
}

function isTaskStale(task: QueueRow) {
  if (task.status === 'done' || task.status === 'running') return false
  const value = task.updatedAt || task.createdAt
  const time = value ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(time)) return false
  return Date.now() - time > 72 * 60 * 60 * 1000
}

function listAttentionAlerts() {
  const rows = db
    .prepare(
      `SELECT
        id,
        event_type AS eventType,
        event_key AS eventKey,
        payload_json AS payloadJson,
        status,
        attempts,
        next_retry_at AS nextRetryAt,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
       FROM attention_alerts
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    .all() as Array<{
      id: string
      eventType: 'task' | 'run'
      eventKey: string
      payloadJson: string
      status: 'pending' | 'sent' | 'failed'
      attempts: number
      nextRetryAt: string | null
      lastError: string | null
      createdAt: string
      updatedAt: string
    }>

  return rows
    .map((row) => {
      try {
        const payload = JSON.parse(row.payloadJson) as AttentionAlert['payload']
        if (!payload || typeof payload !== 'object' || typeof payload.key !== 'string') {
          throw new Error('Invalid payload format')
        }
        return {
          ...row,
          payload,
          payloadJson: undefined,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } as Omit<AttentionAlert, 'createdAt' | 'updatedAt'> & Pick<AttentionAlert, 'createdAt' | 'updatedAt'>
      } catch {
        return {
          ...row,
          payload: {
            eventType: row.eventType,
            key: row.eventKey,
            title: 'Invalid attention payload',
            text: 'Could not parse attention payload JSON',
            priority: 'P2',
            channel: 'northstar',
            project: 'northstar',
            createdAt: row.createdAt,
          },
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          payloadJson: undefined,
        } as Omit<AttentionAlert, 'createdAt' | 'updatedAt'> & Pick<AttentionAlert, 'createdAt' | 'updatedAt'>
      }
    })
    .map((row) => ({
      id: row.id,
      eventType: row.eventType,
      eventKey: row.eventKey,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt: row.nextRetryAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
}

function buildOperationsOverviewSync(): OperationsOverview {
  const projects = currentProjects()
  const tasks = decorateQueueTasks(rawQueueTasks(), projects)
  const runs = listRuns(db)
  const actions = listInboxActions()
  const alerts = listAttentionAlerts()
  const scheduler = getSchedulerSettings(db)
  const telegramStatus = telegramStatusForHeartbeat?.()
  const telegramSessions = listTelegramSessions(db)
  const openTasks = tasks.filter((task) => task.status !== 'done')
  const liveRuns = runs.filter((run) => run.status === 'running')
  const queuePressure = {
    totalOpen: openTasks.length,
    runnable: tasks.filter((task) => task.dispatchability.status === 'runnable').length,
    schedulerWaiting: tasks.filter((task) => task.dispatchability.status === 'scheduler-waiting').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    needsInput: tasks.filter((task) => task.status === 'needs-input').length,
    manual: tasks.filter((task) => task.dispatchability.status === 'manual').length,
    githubOnly: tasks.filter((task) => task.dispatchability.status === 'github-only').length,
    modelDisabled: tasks.filter((task) => task.dispatchability.status === 'model-disabled').length,
    noFreeSlot: tasks.filter((task) => task.dispatchability.status === 'no-free-slot').length,
  }
  const attentionCounts = {
    pending: alerts.filter((alert) => alert.status === 'pending').length,
    failed: alerts.filter((alert) => alert.status === 'failed').length,
    sent: alerts.filter((alert) => alert.status === 'sent').length,
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: {
      activeProjects: projects.filter((project) => project.active).length,
      totalProjects: projects.length,
      openDecisions: actions.length,
      runningTasks: tasks.filter((task) => task.status === 'running').length,
      queuedTasks: tasks.filter((task) => task.status === 'queued').length,
      blockedTasks: tasks.filter((task) => task.status === 'blocked' || task.status === 'needs-input').length,
      liveRuns: liveRuns.length,
      runnableTasks: queuePressure.runnable + queuePressure.schedulerWaiting,
      manualTasks: queuePressure.manual,
      githubOnlyTasks: queuePressure.githubOnly,
      attentionPending: attentionCounts.pending,
      attentionFailed: attentionCounts.failed,
    },
    queuePressure,
    nextAction: chooseNextAction({ tasks, runs, actions, queuePressure }),
    projects,
    activeProjects: projects.filter((project) => project.active),
    tasks,
    runs,
    liveRuns,
    openDecisions: actions,
    telegram: {
      ready: telegramStatus?.ready ?? false,
      polling: telegramStatus?.polling ?? false,
      sessions: telegramSessions,
      configuredChat: telegramStatus?.chatConfigured ?? false,
    },
    attention: { ...attentionCounts, alerts },
    scheduler,
  }
}

async function buildOperationsOverview(): Promise<OperationsOverview> {
  const overview = buildOperationsOverviewSync()
  return {
    ...overview,
    modelUsage: await modelUsage(),
    modelAuth: usageModelOrder.map((model) => modelAuthStatus(model)),
  }
}

function rawQueueTasks() {
  return db.prepare(
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
      branch,
      source,
      source_ref AS sourceRef,
      prompt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      completed_at AS completedAt,
      dispatch_status AS dispatchStatus,
      dispatch_blocker AS dispatchBlocker
     FROM tasks
     ORDER BY
      CASE status WHEN 'running' THEN 0 WHEN 'needs-input' THEN 1 WHEN 'queued' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      id ASC`,
  ).all() as QueueRow[]
}

function chooseNextAction(input: {
  tasks: QueueTaskView[]
  runs: ReturnType<typeof listRuns>
  actions: ReturnType<typeof listInboxActions>
  queuePressure: OperationsOverview['queuePressure']
}): OperationsNextAction {
  const action = [...input.actions].sort((a, b) =>
    priorityWeightForString(a.priority) - priorityWeightForString(b.priority) ||
    urgencyWeight(a.urgency) - urgencyWeight(b.urgency) ||
    a.id.localeCompare(b.id),
  )[0]
  if (action) {
    return {
      kind: 'resolve-inbox',
      title: action.title,
      reason: `${action.priority} ${action.type} needs a decision before the loop can keep moving.`,
      command: `/resolve ${action.id} 1`,
      actionId: action.id,
      taskId: action.task ?? undefined,
      project: action.project,
      priority: action.priority,
    }
  }

  const runnable = input.tasks.find((task) => task.dispatchability.canDispatchNow && task.status === 'queued')
  if (runnable) {
    return {
      kind: 'dispatch-task',
      title: runnable.title,
      reason: runnable.dispatchability.reason,
      command: `/run ${runnable.id}`,
      taskId: runnable.id,
      project: runnable.project,
      priority: runnable.priority,
    }
  }

  const liveRun = input.runs.find((run) => run.status === 'running')
  if (liveRun) {
    const taskId = typeof liveRun.taskId === 'string' ? liveRun.taskId : undefined
    const runId = typeof liveRun.id === 'string' ? liveRun.id : undefined
    const projectId = typeof liveRun.projectId === 'string' ? liveRun.projectId : undefined
    const attachCommand = typeof liveRun.attachCommand === 'string' ? liveRun.attachCommand : undefined
    return {
      kind: 'review-live-run',
      title: `Watch ${taskId ?? runId ?? 'live run'}`,
      reason: 'A tmux-backed agent run is live; inspect the run console or attach from terminal.',
      command: attachCommand ?? `/task ${taskId ?? ''}`.trim(),
      taskId,
      runId,
      project: projectId,
      priority: 'P2',
    }
  }

  if (input.queuePressure.totalOpen > 0) {
    return {
      kind: 'clean-queue',
      title: 'Clean queue pressure',
      reason: 'Open tasks remain, but none are directly runnable on this machine right now.',
      command: '/overview',
      priority: 'P2',
    }
  }

  return {
    kind: 'idle',
    title: 'Northstar loop is clear',
    reason: 'No open queue work or decisions need attention.',
    command: '/overview',
    priority: 'P3',
  }
}

function priorityWeightForString(value?: string) {
  if (value === 'P0') return 0
  if (value === 'P1') return 1
  if (value === 'P2') return 2
  return 3
}

function urgencyWeight(value?: string) {
  if (value === 'high') return 0
  if (value === 'med') return 1
  return 2
}

function runnableProject(projects: LocalProject[], projectId: string) {
  const project = projects.find((item) => item.id === projectId)
  if (!project) return { ok: false as const, error: 'Project is not in the current Northstar inventory.' }
  if (project.source === 'manual') return { ok: false as const, error: `${project.name} is a manual workflow. Northstar can queue planning/review tasks, but local agent dispatch needs a checkout-backed project.` }
  if (!project.localExists || project.path.startsWith('github:')) return { ok: false as const, error: `${project.name} is GitHub-only. Clone it locally before dispatch.` }
  return { ok: true as const, project }
}

function dispatchQueuedTask(id: string, body: ManualApprovalBody = {}) {
  const task = queueTaskById(id)
  if (!task) return { ok: false, error: 'task_not_found' }
  if (task.status === 'running') return { ok: false, error: 'task_already_running', task }
  if (task.status === 'done') return { ok: false, error: 'task_already_done', task }

  const projects = currentProjects()
  const decorated = decorateQueueTask(task, projects)
  if (!decorated.dispatchability.canDispatchNow) {
    const attemptGuard = taskAttemptGuard(task)
    if (!attemptGuard.ok) {
      pauseTaskForAttemptGuard(task, attemptGuard.reason)
      return { ok: false, blocked: true, error: attemptGuard.reason, dispatchability: decorated.dispatchability, task: queueTaskById(id) ?? decorated }
    }
    return { ok: false, error: decorated.dispatchability.reason, dispatchability: decorated.dispatchability, task: decorated }
  }
  const runnable = runnableProject(projects, task.project)
  if (!runnable.ok) {
    db.prepare("UPDATE tasks SET status = 'needs-input', eta = 'waiting', stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(runnable.error, task.id)
    return { ok: false, error: runnable.error, task: queueTaskById(id) ?? task }
  }

  const result = dispatchAgent(db, projects, {
    model: task.model,
    projectContext: task.project,
    prompt: buildTaskPrompt(task, runnable.project),
    taskId: task.id,
    taskTitle: task.title,
    taskPriority: task.priority,
    taskAgent: task.agent,
    taskStage: `${modelLabel(task.model)} running from queue`,
    manualApproval: body.manualApproval === true,
  })
  return { ...result, queueTask: queueTaskById(id) }
}

function runSchedulerTick(body: SchedulerTickBody) {
  const settings = getSchedulerSettings(db)
  const force = body.force === true
  const dryRun = body.dryRun === true
  const withinWindow = isWithinWindow(settings, new Date())
  const running = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running'").get() as { count: number }
  const freeSlots = Math.max(0, settings.maxParallelRuns - running.count)

  if (!settings.enabled && !force) {
    return { ok: true, active: false, reason: 'scheduler_disabled', dryRun, settings, running: running.count, freeSlots, dispatched: [], skipped: [] }
  }
  if (!withinWindow && !force) {
    return { ok: true, active: false, reason: 'outside_schedule_window', dryRun, settings, running: running.count, freeSlots, dispatched: [], skipped: [] }
  }

  const projects = currentProjects()
  const candidates = db
    .prepare(
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
        branch,
        source,
        source_ref AS sourceRef,
        prompt
       FROM tasks
       WHERE status = 'queued'
       ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        id ASC
       LIMIT 50`,
    )
    .all() as QueueRow[]

  const dispatched: unknown[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  let slots = freeSlots
  for (const task of candidates) {
    const decorated = decorateQueueTask(task, projects)
    if (!decorated.dispatchability.runnable) {
      skipped.push({ id: task.id, reason: decorated.dispatchability.reason })
      continue
    }
    if (!modelEnabled(settings, task.model)) {
      skipped.push({ id: task.id, reason: `${task.model}_disabled` })
      continue
    }
    const runnable = runnableProject(projects, task.project)
    if (!runnable.ok) {
      skipped.push({ id: task.id, reason: runnable.error })
      continue
    }
    if (slots <= 0) {
      skipped.push({ id: task.id, reason: 'no_free_slot' })
      continue
    }
    if (dryRun) {
      dispatched.push({ ok: true, dryRun: true, task })
    } else {
      dispatched.push(dispatchQueuedTask(task.id))
    }
    slots -= 1
  }

  return {
    ok: true,
    active: true,
    dryRun,
    forced: force,
    withinWindow,
    settings,
    running: running.count,
    freeSlots,
    dispatched,
    skipped,
  }
}

function pauseTaskForAttemptGuard(task: QueueRow, reason: string) {
  db.prepare(
    `UPDATE tasks
     SET status = 'needs-input',
       eta = 'paused',
       stage = ?,
       updated_at = CURRENT_TIMESTAMP,
       completed_at = NULL
     WHERE id = ? AND status != 'running'`,
  ).run(reason, task.id)

  db.prepare(
    `INSERT OR IGNORE INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, ?, 'blocked', ?, 'P1', 'high', ?, ?, ?, 0, ?)`,
  ).run(
    `LOOP-GUARD-${task.id}`,
    task.project,
    task.id,
    task.model,
    `Polaris paused ${task.title}`,
    [
      `Polaris stopped this before spending more tokens.`,
      `Project: ${task.project}.`,
      reason,
      'Choose whether to add context, leave it paused, or discard it.',
    ].join(' '),
    JSON.stringify(['Add context and retry later', 'Keep paused', 'Discard']),
    'This guardrail prevents the same task from bouncing across models or retrying one model repeatedly. Defaults: 3 total dispatch attempts per task, 2 per model.',
  )
}

function buildTaskPrompt(task: QueueRow, project: LocalProject) {
  return [
    'Northstar queued task dispatch.',
    `Task ID: ${task.id}`,
    `Project: ${project.name} (${project.id})`,
    `Priority: ${task.priority}`,
    `Title: ${task.title}`,
    `Current stage: ${task.stage}`,
    task.source ? `Source: ${task.source}${task.sourceRef ? ` (${task.sourceRef})` : ''}` : null,
    task.prompt ? '' : null,
    task.prompt ? 'Original queued prompt (verbatim):' : null,
    task.prompt ? '---' : null,
    task.prompt || null,
    task.prompt ? '---' : null,
    '',
    'Work contract:',
    '- Stay inside the spawned worktree and current read-only/plan-mode guardrails.',
    '- Produce a concrete result Northstar can show on the queue card.',
    '- If blocked, ask the smallest useful clarifying question and provide 2-3 answer options.',
    '- If implementation is safe later, describe exact files and commands for the next gated patch run.',
  ].filter((line): line is string => line !== null).join('\n')
}

function modelEnabled(settings: SchedulerSettings, model: DispatchModel) {
  if (model === 'spark') return settings.sparkEnabled
  if (model === 'opus') return settings.opusEnabled
  return settings.codexEnabled
}

function isWithinWindow(settings: SchedulerSettings, date: Date) {
  const now = timeMinutes(formatTimeForZone(settings.timezone, date))
  const start = timeMinutes(settings.startTime)
  const end = timeMinutes(settings.endTime)
  if (start === end) return true
  if (start < end) return now >= start && now < end
  return now >= start || now < end
}

function formatTimeForZone(timezone: string, date: Date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const hour = parts.find((part) => part.type === 'hour')?.value ?? '00'
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00'
    return `${hour}:${minute}`
  } catch {
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  }
}

function timeMinutes(value: string) {
  const [hour = '0', minute = '0'] = value.split(':')
  return Number(hour) * 60 + Number(minute)
}

function modelLabel(model: DispatchModel) {
  if (model === 'opus') return 'Claude Code'
  if (model === 'spark') return 'Spark'
  return 'GPT-5.5'
}
