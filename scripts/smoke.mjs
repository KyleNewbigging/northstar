import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

let baseUrl = process.env.NORTHSTAR_API_URL ?? 'http://127.0.0.1:4317'

let server = null

async function main() {
  const alreadyRunning = await canReachServer()
  if (alreadyRunning && !(await serverSupportsCurrentCode())) {
    if (process.env.NORTHSTAR_API_URL) throw new Error('The configured NORTHSTAR_API_URL is reachable but does not expose the current smoke-test API shape.')
    baseUrl = 'http://127.0.0.1:14317'
    server = spawn('npm', ['run', 'server'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NORTHSTAR_PORT: '14317', NORTHSTAR_TELEGRAM_POLL: '0' },
    })
    await waitForServer()
  } else if (!alreadyRunning) {
    server = spawn('npm', ['run', 'server'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForServer()
  }

  const health = await getJson('/api/health')
  const projects = await getJson('/api/projects')
  const github = await getJson('/api/github/repositories')
  const telegram = await getJson('/api/telegram/status')
  const telegramCommands = await getJson('/api/telegram/commands')
  const telegramSessions = await getJson('/api/telegram/sessions')
  const heartbeat = await getJson('/api/heartbeat')
  const deviceFiles = await getJson('/api/device-files/status')
  const runs = await getJson('/api/runs')
  const allGraph = await getJson('/api/graph/all')
  const focusId = projects.projects?.find((project) => project.id === 'northstar')?.id ?? projects.projects?.[0]?.id
  const focusedGraph = await getJson(`/api/graph/${focusId}`)
  const operations = await runOperationsOverviewSmoke()
  const schedulerDryRun = await runSchedulerDryRunSmoke()
  const codexEnabled = await runCodexEnabledSmoke()
  const taskLoopGuard = await runTaskLoopGuardSmoke()
  const taskSchema = runTaskLifecycleSchemaSmoke()
  const freshSchema = runFreshTaskSchemaSmoke()
  const telegramIntake = await runTelegramIntakeSmoke()
  const telegramQuietNotifications = await runTelegramQuietNotificationSmoke()
  const telegramNaturalReplies = runTelegramNaturalReplySmoke()
  const telegramAutoRoute = await runTelegramAutoRouteIntakeSmoke()
  const telegramDocIntake = await runTelegramDocumentIntakeSmoke()
  const attentionAlerts = await runAttentionAlertSmoke()
  const garminImport = await runGarminImportSmoke()
  const skillsMirror = runProjectSkillsMirrorSmoke()
  const workspaceTemplate = runProjectWorkspaceTemplateSmoke()

  assert(health.ok === true, 'health endpoint failed')
  assert(Array.isArray(projects.projects) && projects.projects.length > 0, 'no projects discovered')
  assert(projects.projects.some((project) => project.localExists !== false), 'no local projects discovered')
  assert(projects.projects.some((project) => project.github), 'no GitHub-linked projects discovered')
  assert(Array.isArray(github.repositories), 'GitHub catalog endpoint failed')
  assert(telegram.ok === true && typeof telegram.tokenConfigured === 'boolean', 'Telegram bridge status endpoint failed')
  const expectedMode = String(process.env.NORTHSTAR_TELEGRAM_BRIDGE_IMPL || '').trim().toLowerCase() === 'grammy' ? 'grammy' : 'poll'
  if (telegram.mode) {
    assert(telegram.mode === expectedMode, `Telegram bridge mode expected ${expectedMode} got ${telegram.mode}`)
  }
  assert(Array.isArray(telegramSessions.sessions), 'Telegram sessions endpoint failed')
  assert(['/overview', '/next', '/task', '/run'].every((command) => telegramCommands.commands?.includes(command)), 'Telegram command surface is missing orchestrator commands')
  assert(heartbeat.ok === true && typeof heartbeat.content === 'string' && heartbeat.content.includes('Northstar Heartbeat'), 'heartbeat endpoint failed')
  assert(deviceFiles.ok === true && typeof deviceFiles.currentDevice === 'string' && typeof deviceFiles.rootPath === 'string', 'device file bridge status endpoint failed')
  assert(deviceFiles.projectsRelPath === 'projects', 'Dropbox project status shape is invalid')
  assert(Array.isArray(runs.runs), 'runs endpoint failed')
  assert(runs.runs.every((run) => run.attachCommand == null || typeof run.attachCommand === 'string'), 'run attach metadata is invalid')
  assert(Array.isArray(allGraph.nodes) && allGraph.nodes.length > 0, 'all-project graph has no nodes')
  assert(Array.isArray(focusedGraph.nodes) && focusedGraph.nodes.length > 0, 'focused graph has no nodes')
  assert(typeof focusedGraph.sourceKind === 'string', 'focused graph should expose sourceKind provenance')

  const summary = {
    projects: projects.projects.length,
    local: projects.projects.filter((project) => project.localExists !== false).length,
    githubLinked: projects.projects.filter((project) => project.github).length,
    githubCatalog: github.repositories.length,
    telegram: { ready: telegram.ready, tokenConfigured: telegram.tokenConfigured, commands: telegramCommands.commands.length },
    telegramSessions: telegramSessions.sessions.length,
    heartbeat: { path: heartbeat.path, mirrored: Boolean(heartbeat.mirrorPath) },
    deviceFiles: { configured: deviceFiles.configured, device: deviceFiles.currentDevice, projects: deviceFiles.projectsRelPath },
    runs: { count: runs.runs.length, tmux: runs.runs.filter((run) => run.transport === 'tmux').length },
    operations,
    schedulerDryRun,
    codexEnabled,
    taskLoopGuard,
    taskSchema,
    freshSchema,
    telegramIntake,
    telegramQuietNotifications,
    telegramNaturalReplies,
    telegramAutoRoute,
    telegramDocIntake,
    attentionAlerts,
    garminImport,
    skillsMirror,
    workspaceTemplate,
    graph: { nodes: allGraph.nodes.length, edges: allGraph.edges.length },
    focusedGraph: { project: focusId, nodes: focusedGraph.nodes.length, edges: focusedGraph.edges.length },
  }
  console.log(JSON.stringify(summary, null, 2))
}

async function canReachServer() {
  try {
    await getJson('/api/health')
    return true
  } catch {
    return false
  }
}

async function serverSupportsCurrentCode() {
  try {
    const queue = await getJson('/api/queue')
    const tasks = Array.isArray(queue.tasks) ? queue.tasks : []
    if (tasks.length && !('source' in tasks[0])) return false
    if (tasks.length && !('dispatchability' in tasks[0])) return false
    const overview = await getJson('/api/operations/overview')
    if (overview?.ok !== true || !overview.summary || !overview.queuePressure) return false
    const telegramStatus = await getJson('/api/telegram/status')
    if (!telegramStatus?.settings || !('notifyImportant' in telegramStatus.settings) || !('notifyDigest' in telegramStatus.settings)) return false
    const response = await fetch(`${baseUrl}/api/telegram/intake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return response.status !== 404
  } catch {
    return false
  }
}

async function waitForServer() {
  const started = Date.now()
  while (Date.now() - started < 12000) {
    if (await canReachServer()) return
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error('Northstar API did not start within 12 seconds.')
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

async function waitForServerAt(url, timeoutMs = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch {
      // continue retrying
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  throw new Error(`Northstar API at ${url} did not start within ${Math.round(timeoutMs / 1000)} seconds.`)
}

async function getJsonAt(base, path) {
  const response = await fetch(`${base}${path}`)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

async function postJsonAt(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

function waitForExit(processHandle) {
  return new Promise((resolve) => {
    if (processHandle.exitCode !== null) return resolve(processHandle.exitCode)
    processHandle.once('exit', () => resolve())
  })
}

function startMockAttentionWebhook() {
  const calls = []
  let shouldFail = true
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = body ? JSON.parse(body) : null
      } catch {
        parsed = body
      }
      const status = shouldFail ? 500 : 200
      shouldFail = false
      calls.push({
        status,
        payload: parsed,
        text: body,
        statusText: status >= 400 ? 'failed' : 'ok',
        ts: new Date().toISOString(),
      })
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: status < 400 }))
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string' || !address.port) {
        reject(new Error('Mock webhook server did not expose a port'))
        return
      }
      resolve({
        server,
        calls,
        url: `http://127.0.0.1:${address.port}/webhook`,
      })
    })
  })
}

async function runOperationsOverviewSmoke() {
  const overview = await getJson('/api/operations/overview')
  assert(overview.ok === true, 'operations overview endpoint failed')
  assert(typeof overview.generatedAt === 'string', 'operations overview missing generatedAt')
  assert(overview.summary && typeof overview.summary.totalProjects === 'number', 'operations overview missing summary')
  assert(overview.queuePressure && typeof overview.queuePressure.totalOpen === 'number', 'operations overview missing queuePressure')
  assert(Array.isArray(overview.projects), 'operations overview missing projects')
  assert(Array.isArray(overview.tasks), 'operations overview missing tasks')
  assert(Array.isArray(overview.runs), 'operations overview missing runs')
  assert(Array.isArray(overview.openDecisions), 'operations overview missing decisions')
  assert(overview.telegram && Array.isArray(overview.telegram.sessions), 'operations overview missing Telegram session status')
  assert(overview.attention && typeof overview.attention.pending === 'number', 'operations overview missing attention status')
  assert(overview.nextAction && typeof overview.nextAction.title === 'string', 'operations overview missing next action')

  const firstTask = overview.tasks[0]
  let detailSummary = null
  if (firstTask) {
    assert(firstTask.dispatchability && typeof firstTask.dispatchability.reason === 'string', 'overview task missing dispatchability')
    assert(typeof firstTask.createdAt === 'string' || firstTask.createdAt == null, 'overview task createdAt has invalid shape')
    const detail = await getJson(`/api/queue/${encodeURIComponent(firstTask.id)}`)
    assert(detail.ok === true, 'queue detail endpoint failed')
    assert(detail.task?.id === firstTask.id, 'queue detail returned the wrong task')
    assert(detail.dispatchability && typeof detail.dispatchability.status === 'string', 'queue detail missing dispatchability')
    detailSummary = { id: firstTask.id, dispatch: detail.dispatchability.status }
  }

  return {
    ok: true,
    totalOpen: overview.queuePressure.totalOpen,
    next: overview.nextAction.kind,
    detail: detailSummary,
  }
}

async function runSchedulerDryRunSmoke() {
  const result = await postJson('/api/scheduler/tick', { dryRun: true, force: true })
  assert(result.ok === true, 'scheduler dry-run tick failed')
  assert(result.dryRun === true, 'scheduler dry-run response did not preserve dryRun=true')
  assert(Array.isArray(result.dispatched), 'scheduler dry-run missing dispatched list')
  assert(Array.isArray(result.skipped), 'scheduler dry-run missing skipped list')
  return { ok: true, dispatched: result.dispatched.length, skipped: result.skipped.length }
}

async function runCodexEnabledSmoke() {
  const taskId = `SMOKE-CODEX-ENABLED-${Date.now().toString(36)}`
  try {
    withDb((db) => {
      insertLoopGuardTask(db, taskId, 'codex', 'Smoke Codex enabled dispatchability')
    })
    const detail = await getJson(`/api/queue/${encodeURIComponent(taskId)}`)
    const status = detail.dispatchability?.status
    assert(status !== 'guarded', 'Codex dispatchability should not be guarded by reserved/manual policy')
    assert(status !== 'model-disabled', 'Codex scheduler lane should be enabled')
    return { ok: true, dispatchability: status }
  } finally {
    cleanupLoopGuardSmoke([taskId])
  }
}

async function runTaskLoopGuardSmoke() {
  const stamp = Date.now().toString(36).toUpperCase()
  const totalTaskId = `SMOKE-LOOP-TOTAL-${stamp}`
  const modelTaskId = `SMOKE-LOOP-MODEL-${stamp}`
  const createdTaskIds = [totalTaskId, modelTaskId]

  try {
    withDb((db) => {
      insertLoopGuardTask(db, totalTaskId, 'spark', 'Smoke loop guard total attempts')
      insertLoopGuardRun(db, totalTaskId, 'spark', 1)
      insertLoopGuardRun(db, totalTaskId, 'opus', 2)
      insertLoopGuardRun(db, totalTaskId, 'spark', 3)

      insertLoopGuardTask(db, modelTaskId, 'spark', 'Smoke loop guard per model attempts')
      insertLoopGuardRun(db, modelTaskId, 'spark', 1)
      insertLoopGuardRun(db, modelTaskId, 'spark', 2)
    })

    const queue = await getJson('/api/queue')
    const totalTask = queue.tasks.find((task) => task.id === totalTaskId)
    const modelTask = queue.tasks.find((task) => task.id === modelTaskId)
    assert(totalTask?.dispatchability?.status === 'scheduler-waiting', 'total-attempt loop monitor should put dispatchability into cooldown')
    assert(String(totalTask.dispatchability.reason).includes('3 dispatch attempts'), 'total-attempt monitor reason should explain three attempts')
    assert(String(totalTask.dispatchability.reason).includes('Estimated retry usage'), 'total-attempt monitor should include estimated usage percentages')
    assert(modelTask?.dispatchability?.status === 'scheduler-waiting', 'per-model loop monitor should put dispatchability into cooldown')
    assert(String(modelTask.dispatchability.reason).includes('already tried this task 2 times'), 'per-model monitor reason should explain two model attempts')

    const dispatch = await postJson(`/api/queue/${encodeURIComponent(totalTaskId)}/dispatch`, {})
    assert(dispatch.ok === false && dispatch.dispatchability?.status === 'scheduler-waiting', 'cooling task dispatch should return scheduler-waiting')
    const detail = await getJson(`/api/queue/${encodeURIComponent(totalTaskId)}`)
    assert(detail.task?.status === 'queued', 'loop monitor cooldown should leave task queued for retry')
    assert(!(detail.actions ?? []).some((action) => action.id === `LOOP-GUARD-${totalTaskId}`), 'loop monitor cooldown should not create a blocking inbox action')

    return { ok: true, totalCooling: true, modelCooling: true }
  } finally {
    cleanupLoopGuardSmoke(createdTaskIds)
  }
}

function insertLoopGuardTask(db, id, model, title) {
  db.prepare(
    `INSERT INTO tasks
      (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch, source, source_ref, prompt, updated_at)
     VALUES (?, 'northstar', ?, ?, 'smoke-loop-guard', 'queued', 'P2', 0, 'queued', 'loop guard smoke', 0, '', 'smoke', ?, ?, CURRENT_TIMESTAMP)`,
  ).run(id, title, model, `smoke:${id}`, title)
}

function insertLoopGuardRun(db, taskId, model, index) {
  db.prepare(
    `INSERT INTO agent_runs
      (id, task_id, project_id, model, provider, command, cwd, status, prompt, stdout, stderr, final_text, exit_code, completed_at, updated_at)
     VALUES (?, ?, 'northstar', ?, 'smoke', 'smoke-loop-guard', ?, 'blocked', 'smoke', '', '', 'smoke blocked run', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(`${taskId}-RUN-${index}`, taskId, model, process.cwd())
}

function cleanupLoopGuardSmoke(taskIds) {
  withDb((db) => {
    for (const taskId of taskIds) {
      db.prepare('DELETE FROM inbox_actions WHERE task_id = ? OR id = ?').run(taskId, `LOOP-GUARD-${taskId}`)
      db.prepare('DELETE FROM agent_runs WHERE task_id = ?').run(taskId)
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    }
  })
}

function runTaskLifecycleSchemaSmoke() {
  const dbPath = northstarDatabasePath()
  return withDbAt(dbPath, (db) => {
    const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name))
    for (const column of ['created_at', 'updated_at', 'completed_at', 'dispatch_status', 'dispatch_blocker']) {
      assert(columns.has(column), `live tasks table missing ${column}`)
    }
    return { ok: true, columns: 5 }
  })
}

function runFreshTaskSchemaSmoke() {
  const schema = readFileSync(join(process.cwd(), 'app/server/src/schema.ts'), 'utf8')
  for (const column of ['created_at', 'updated_at', 'completed_at', 'dispatch_status', 'dispatch_blocker']) {
    assert(schema.includes(column), `fresh schema missing ${column}`)
  }
  for (const column of ['notify_important', 'notify_lifecycle_debug', 'notify_run_telemetry_debug', 'notify_digest', 'debug_until']) {
    assert(schema.includes(column), `fresh telegram settings schema missing ${column}`)
  }
  return { ok: true, columns: 10 }
}

async function runTelegramIntakeSmoke() {
  const stamp = Date.now().toString(36)
  const chatId = `smoke-${stamp}`
  const threadId = 'main'
  const created = []
  const telegramSettings = await muteTelegramInboxNotificationsForSmoke()

  try {
    upsertSmokeTelegramSession(chatId, threadId, 'spark', 'telegram-smoke')
    const spark = await assertTelegramPromptFlow({
      chatId,
      threadId,
      messageId: 1001,
      text: `Smoke Spark worktree request ${stamp}`,
      expectedStatus: 'queued',
      expectedModel: 'codex',
    })
    const claude = await assertTelegramPromptFlow({
      chatId,
      threadId,
      messageId: 1002,
      text: `Smoke Claude plan request ${stamp}`,
      expectedStatus: 'queued',
      expectedModel: 'codex',
    })

    upsertSmokeTelegramSession(chatId, threadId, 'codex', 'orchestrator-smoke')
    const codex = await assertTelegramPromptFlow({
      chatId,
      threadId,
      messageId: 1003,
      text: `Smoke Codex orchestrator request ${stamp}`,
      expectedStatus: 'queued',
      expectedModel: 'codex',
    })
    const laneWarning = await assertTelegramPromptFlow({
      chatId,
      threadId,
      messageId: 1005,
      text: `Smoke lane mismatch request ${stamp}`,
      expectedStatus: 'queued',
      expectedModel: 'codex',
      expectedLane: 'orchestrator',
      expectedLaneWarning: 'model spark usually maps to personal lane, while agent orchestrator maps to orchestrator lane',
      preUpsert: { model: 'spark', agent: 'orchestrator' },
    })
    created.push(...spark.created, ...claude.created, ...codex.created, ...laneWarning.created)
    return { ok: true, prompts: 4, model: 'codex', routePrompts: 0 }
  } finally {
    cleanupSmokeTelegramRows(chatId, created)
    await restoreTelegramInboxNotificationsAfterSmoke(telegramSettings)
  }
}

async function runTelegramQuietNotificationSmoke() {
  const stamp = Date.now().toString(36)
  const chatId = `quiet-smoke-${stamp}`
  const threadId = 'main'
  const settings = await muteTelegramInboxNotificationsForSmoke()
  const created = []

  try {
    await postJson('/api/telegram/settings', {
      notifyInbox: false,
      notifyImportant: true,
      notifyLifecycleDebug: false,
      notifyRunTelemetryDebug: false,
      notifyDigest: false,
    })
    upsertSmokeTelegramSession(chatId, threadId, 'spark', 'telegram-smoke')
    const flow = await assertTelegramPromptFlow({
      chatId,
      threadId,
      messageId: 2001,
      text: `Quiet notification smoke ${stamp}`,
      expectedStatus: 'queued',
      expectedModel: 'codex',
    })
    created.push(...flow.created)
    const taskId = flow.created[0]?.taskId
    const lifecycleRows = taskId ? withDb((db) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM telegram_delivery_log WHERE event_type = 'lifecycle_update' AND event_key LIKE ?").get(`task:${taskId}:%`)
      return Number(row?.count ?? 0)
    }) : 0
    assert(lifecycleRows === 0, 'Quiet Telegram mode sent lifecycle_update messages for a resolved Telegram task')

    const debugOn = await postJson('/api/telegram/settings', {
      notifyLifecycleDebug: true,
      notifyRunTelemetryDebug: true,
      debugUntil: new Date(Date.now() + 60_000).toISOString(),
    })
    assert(debugOn.settings.notifyLifecycleDebug === true, 'debug lifecycle setting did not enable')
    assert(debugOn.settings.notifyRunTelemetryDebug === true, 'debug telemetry setting did not enable')
    assert(typeof debugOn.settings.debugUntil === 'string', 'debug expiry was not recorded')

    const debugOff = await postJson('/api/telegram/settings', {
      notifyLifecycleDebug: false,
      notifyRunTelemetryDebug: false,
      debugUntil: null,
    })
    assert(debugOff.settings.notifyLifecycleDebug === false, 'debug lifecycle setting did not disable')
    assert(debugOff.settings.notifyRunTelemetryDebug === false, 'debug telemetry setting did not disable')
    assert(debugOff.settings.debugUntil === null, 'debug expiry did not clear')

    return { ok: true, lifecycleRows, debugToggle: true }
  } finally {
    cleanupSmokeTelegramRows(chatId, created)
    await restoreTelegramInboxNotificationsAfterSmoke(settings)
  }
}

async function runTelegramAutoRouteIntakeSmoke() {
  const stamp = Date.now().toString(36)
  const chatId = `autoroute-${stamp}`
  const threadId = 'main'
  const routed = await postJson('/api/telegram/intake', {
    chatId,
    threadId,
    text: `Can you work on the Zebra dashboard Telegram workflow? ${stamp}`,
    messageId: 99,
  })
  assert(routed.ok === true, `Telegram auto-route intake should succeed: ${routed.error}`)
  assert(routed.sessionCreated === true, 'Telegram auto-route should create a session for a new chat/topic')
  assert(routed.session?.project === 'zebra-dashboard', `Telegram auto-route project expected zebra-dashboard but got ${routed.session?.project}`)
  assert(routed.session?.agent === 'orchestrator', `Telegram auto-route agent expected orchestrator but got ${routed.session?.agent}`)
  assert(routed.session?.model === 'codex', `Telegram auto-route model expected codex but got ${routed.session?.model}`)
  assert(routed.project === 'zebra-dashboard', `Telegram auto-route task project expected zebra-dashboard but got ${routed.project}`)
  cleanupSmokeTelegramRows(chatId, [{ taskId: routed.taskId }])
  return { ok: true, project: routed.project, lane: routed.lane, sessionCreated: routed.sessionCreated }
}

function runTelegramNaturalReplySmoke() {
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'app/server/src/telegram.ts')).href)});
    const actions = [
      {
        id: 'SMOKE-ACTION-1',
        type: 'question',
        project: 'northstar',
        task: 'SMOKE-TASK-1',
        model: 'codex',
        priority: 'P1',
        urgency: 'high',
        title: 'Smoke natural reply',
        ctx: 'Choose a path.',
        options: ['Do the recommended thing', 'Use the second path', 'Discard'],
        recommend: 0,
      },
    ];
    const yes = mod.parseNaturalLanguageResolution('yes', actions);
    const second = mod.parseNaturalLanguageResolution('second option', actions);
    const discard = mod.parseNaturalLanguageResolution('discard', actions);
    const longPrompt = mod.parseNaturalLanguageResolution('yes and also can you build a completely separate new dashboard feature for me right now please', actions);
    const zebraRoute = mod.inferNaturalTelegramRoute('Please handle this for Zebra dashboard');
    const defaultRoute = mod.inferNaturalTelegramRoute('Can you take a look at this workflow?');
    if (!yes?.ok || yes.choice !== '1') throw new Error('yes should choose the recommended first option');
    if (!second?.ok || second.choice !== '2') throw new Error('second option should choose option 2');
    if (!discard?.ok || discard.choice !== '3') throw new Error('discard should choose the discard option');
    if (longPrompt !== null) throw new Error('long prompts should not be swallowed as inbox resolutions');
    if (zebraRoute.project !== 'zebra-dashboard' || zebraRoute.agent !== 'orchestrator') throw new Error('Zebra route should default to orchestrator');
    if (defaultRoute.project !== 'northstar' || defaultRoute.agent !== 'orchestrator') throw new Error('default route should be Northstar orchestrator');
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  })
  assert(result.status === 0, `Telegram natural reply smoke failed: ${result.stderr || result.stdout}`)
  return { ok: true, yes: 'recommended', second: true, discard: true }
}

async function runTelegramDocumentIntakeSmoke() {
  const stamp = Date.now().toString(36)
  const chatId = `doc-${stamp}`
  const threadId = 'main'
  upsertSmokeTelegramSession(chatId, threadId, 'spark', 'telegram-smoke')
  const created = []
  const maxBytes = Number(process.env.NORTHSTAR_TELEGRAM_MAX_DOCUMENT_BYTES ?? '20000000')
  const maxPromptChars = Number(process.env.NORTHSTAR_TELEGRAM_MAX_DOCUMENT_PROMPT_CHARS ?? '150000')

  try {
    const unsupported = await postJson('/api/telegram/intake', {
      chatId,
      threadId,
      messageId: 201,
      document: {
        fileName: 'image.png',
        mimeType: 'image/png',
        fileSize: 1000,
        sourceText: 'not a supported attachment',
      },
    })
    assert(unsupported.ok === false, 'Unsupported Telegram document should be rejected')
    assert(
      unsupported.error === 'telegram_document_rejected',
      `Expected telegram_document_rejected, got ${unsupported.error}`,
    )
    assert(
      String(unsupported.errorMessage ?? '').toLowerCase().includes('unsupported document type'),
      'Unsupported document rejection message was not specific',
    )

    const oversizedFile = await postJson('/api/telegram/intake', {
      chatId,
      threadId,
      messageId: 202,
      document: {
        fileName: 'big.txt',
        mimeType: 'text/plain',
        fileSize: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes + 1 : 21_000_000,
        sourceText: 'small valid body',
      },
    })
    assert(oversizedFile.ok === false, 'Oversized Telegram document file should be rejected')
    assert(oversizedFile.error === 'telegram_document_rejected', `Expected telegram_document_rejected, got ${oversizedFile.error}`)
    assert(
      String(oversizedFile.errorMessage ?? '').toLowerCase().includes('too large'),
      'Oversized Telegram document rejection message should mention size',
    )

    const oversizedPrompt = 'x'.repeat((Number.isFinite(maxPromptChars) ? maxPromptChars : 150_000) + 1)
    const hugePrompt = await postJson('/api/telegram/intake', {
      chatId,
      threadId,
      messageId: 203,
      document: {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        fileSize: 3000,
        sourceText: oversizedPrompt,
      },
    })
    assert(hugePrompt.ok === false, 'Oversized Telegram prompt body should be rejected')
    assert(hugePrompt.error === 'telegram_document_rejected', `Expected telegram_document_rejected, got ${hugePrompt.error}`)
    assert(
      String(hugePrompt.errorMessage ?? '').toLowerCase().includes('too long'),
      'Oversized prompt rejection should mention prompt length',
    )

    const noReadable = await postJson('/api/telegram/intake', {
      chatId,
      threadId,
      messageId: 204,
      document: {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        fileSize: 3000,
        caption: '',
      },
    })
    assert(noReadable.ok === false, 'Document with no readable text should be rejected')
    assert(noReadable.error === 'telegram_document_rejected', `Expected telegram_document_rejected, got ${noReadable.error}`)
    assert(
      String(noReadable.errorMessage ?? '').toLowerCase().includes('readable text'),
      'No-readable-text rejection should explain missing prompt content',
    )

    const valid = await postJson('/api/telegram/intake', {
      chatId,
      threadId,
      messageId: 205,
      document: {
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        fileSize: 2500,
        caption: 'caption-',
        sourceText: 'Document content from smoke.',
      },
    })
    assert(valid.ok === true, `Valid Telegram document intake failed: ${valid.error ?? 'unknown error'}`)
    created.push({ taskId: valid.taskId, actionId: valid.actionId })
    const queued = await getJson('/api/queue')
    const createdTask = queued.tasks.find((item) => item.id === valid.taskId)
    assert(createdTask?.source === 'telegram', 'valid doc intake task source was not telegram')
    const expectedSource = 'caption-\n\nDocument content from smoke.'
    assert(
      createdTask?.prompt === expectedSource,
      `Expected stored prompt '${expectedSource}', got '${createdTask?.prompt}'`,
    )

    assert(createdTask?.status === 'queued', 'Valid document intake should queue automatically')
    assert(createdTask?.model === 'codex', 'Valid document intake should use the Codex automation lane')
  } finally {
    cleanupSmokeTelegramRows(chatId, created)
  }

  return { ok: true, status: 'document safeguards verified' }
}

async function runAttentionAlertSmoke() {
  const stamp = Date.now().toString(36)
  const validKey = `smoke-task-${stamp}`
  const invalidKey = `smoke-bad-${stamp}`
  const webhookConfigured = Boolean((process.env.NORTHSTAR_ATTENTION_WEBHOOK_URL ?? '').trim() || (process.env.NORTHSTAR_PUSHCUT_WEBHOOK_URL ?? '').trim())
  withDb(cleanupSmokeAttentionRows)
  const webhookReplay = await runAttentionAlertWebhookReplaySmoke(stamp)
  let summary = null

  withDb((db) => {
    db.prepare(
      `INSERT INTO attention_alerts (id, event_type, event_key, payload_json, status, attempts)
       VALUES (?, 'task', ?, ?, 'pending', 0)
       ON CONFLICT(event_type, event_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         status = excluded.status,
         attempts = excluded.attempts,
         next_retry_at = NULL,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(`smoke-valid-${stamp}`, validKey, JSON.stringify({
      eventType: 'task',
      key: validKey,
      title: 'Smoke attention alert',
      text: 'Smoke attention queue visibility',
      priority: 'P2',
      channel: 'northstar-smoke',
      project: 'northstar',
    }))

    db.prepare(
      `INSERT INTO attention_alerts (id, event_type, event_key, payload_json, status, attempts)
       VALUES (?, 'task', ?, 'not-json', 'pending', 0)
       ON CONFLICT(event_type, event_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         status = excluded.status,
         attempts = excluded.attempts,
         next_retry_at = NULL,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(`smoke-bad-${stamp}`, invalidKey)
  })

  try {
    const response = await getJson('/api/attention-alerts')
    assert(Array.isArray(response.alerts), 'attention-alerts endpoint failed')
    const validAlert = response.alerts.find((item) => item.eventKey === validKey)
    assert(validAlert?.eventType === 'task', 'attention valid row missing from alert list')
    assert(validAlert?.payload?.title === 'Smoke attention alert', 'attention alert payload was not surfaced correctly')

    const invalidAlert = response.alerts.find((item) => item.eventKey === invalidKey)
    assert(Boolean(invalidAlert), 'attention bad payload row missing from alert list')
    assert(invalidAlert?.payload?.title === 'Invalid attention payload', 'invalid attention payload should surface fallback title')

    if (!webhookConfigured) {
      const flush = await postJson('/api/attention-alerts/flush', {})
      assert(flush.ok === true, 'attention-alerts flush endpoint failed')
    }

    summary = { ok: true, webhookReplay }
  } finally {
    withDb(cleanupSmokeAttentionRows)
  }

  const residue = withDb((db) => smokeAttentionResidueCount(db))
  assert(residue === 0, `attention smoke left ${residue} smoke rows in the live DB`)
  return summary
}

async function runAttentionAlertWebhookReplaySmoke(stamp) {
  const homeRoot = mkdtempSync(join(tmpdir(), 'northstar-attn-webhook-smoke-'))
  const sourceDb = northstarDatabasePath()
  const serverDb = join(homeRoot, 'northstar.sqlite')
  if (existsSync(sourceDb)) {
    copyFileSync(sourceDb, serverDb)
  }

  const webhook = await startMockAttentionWebhook()
  const serverPort = '14318'
  const serverUrl = `http://127.0.0.1:${serverPort}`
  const validKey = `smoke-task-webhook-${stamp}`
  const invalidKey = `smoke-bad-webhook-${stamp}`
  const env = {
    ...process.env,
    NORTHSTAR_HOME: homeRoot,
    NORTHSTAR_PORT: serverPort,
    NORTHSTAR_TELEGRAM_POLL: '0',
    NORTHSTAR_ATTENTION_WEBHOOK_URL: `${webhook.url}`,
    NORTHSTAR_ATTENTION_RETRY_MAX: '2',
    NORTHSTAR_ATTENTION_FLUSH_INTERVAL_MS: '120000',
  }
  const processHandle = spawn(process.execPath, ['--import', 'tsx', 'app/server/src/index.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })

  try {
    await waitForServerAt(serverUrl)

    withDbAt(serverDb, (db) => {
      db.prepare("UPDATE attention_alerts SET status = 'sent', last_error = NULL, attempts = 0, next_retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status IN ('pending', 'failed')").run()
      db.prepare(
        `INSERT INTO attention_alerts (id, event_type, event_key, payload_json, status, attempts)
         VALUES (?, 'task', ?, ?, 'pending', 0)
         ON CONFLICT(event_type, event_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           status = excluded.status,
           attempts = excluded.attempts,
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(`smoke-valid-replay-${stamp}`, validKey, JSON.stringify({
        eventType: 'task',
        key: validKey,
        title: 'Replay smoke attention alert',
        text: 'Replay attention queue visibility',
        priority: 'P2',
        channel: 'northstar-smoke',
        source: 'smoke',
        project: 'northstar',
      }))

      db.prepare(
        `INSERT INTO attention_alerts (id, event_type, event_key, payload_json, status, attempts)
         VALUES (?, 'task', ?, 'not-json', 'pending', 0)
         ON CONFLICT(event_type, event_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           status = excluded.status,
           attempts = excluded.attempts,
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(`smoke-bad-replay-${stamp}`, invalidKey)
    })

    const baseline = await getJsonAt(serverUrl, '/api/attention-alerts')
    assert(Array.isArray(baseline.alerts), 'attention alert endpoint failed in webhook replay smoke')
    assert(baseline.alerts.some((item) => item.eventKey === validKey), 'valid replay alert missing from webhook smoke server endpoint')

    const firstFlush = await postJsonAt(serverUrl, '/api/attention-alerts/flush', {})
    assert(firstFlush.ok === true, 'webhook replay attention flush failed')

    const firstSnapshot = await getJsonAt(serverUrl, '/api/attention-alerts')
    const firstFailRow = firstSnapshot.alerts.find((item) => item.eventKey === validKey)
    assert(firstFailRow?.status === 'failed', 'attention valid row should be marked failed on first flush attempt')
    assert(firstFailRow?.attempts === 1, `expected replay alert attempts=1 after fail, got ${firstFailRow?.attempts}`)
    assert(typeof firstFailRow?.nextRetryAt === 'string' && firstFailRow.nextRetryAt.length > 0, 'failed replay alert missing nextRetryAt')
    assert((firstFailRow.lastError ?? '').toLowerCase().includes('webhook'), 'replay lastError should include webhook failure detail')

    withDbAt(serverDb, (db) => {
      db.prepare('UPDATE attention_alerts SET next_retry_at = NULL WHERE event_type = ? AND event_key = ?').run('task', validKey)
    })

    const secondFlush = await postJsonAt(serverUrl, '/api/attention-alerts/flush', {})
    assert(secondFlush.ok === true, 'second webhook replay flush failed')

    const secondSnapshot = await getJsonAt(serverUrl, '/api/attention-alerts')
    const sentRow = secondSnapshot.alerts.find((item) => item.eventKey === validKey)
    assert(sentRow?.status === 'sent', 'attention valid row should be sent on replay')
    assert(sentRow?.attempts === 2, `expected replay alert attempts=2 after success, got ${sentRow?.attempts}`)
    assert(Array.isArray(webhook.calls) && webhook.calls.length >= 2, 'mock webhook should receive at least two calls (fail then success)')
    return {
      ok: true,
      callCount: webhook.calls.length,
      finalStatus: sentRow?.status,
      finalAttempts: sentRow?.attempts,
      firstCallStatus: webhook.calls[0]?.status,
      secondCallStatus: webhook.calls[1]?.status,
    }
  } finally {
    processHandle.kill('SIGTERM')
    await closeServer(webhook.server)
    await waitForExit(processHandle)
    withDbAt(serverDb, (db) => {
      db.prepare('DELETE FROM attention_alerts WHERE event_type = ? AND event_key IN (?, ?)').run('task', validKey, invalidKey)
    })
    rmSync(homeRoot, { recursive: true, force: true })
  }
}

async function runGarminImportSmoke() {
  const homeRoot = mkdtempSync(join(tmpdir(), 'northstar-garmin-smoke-'))
  const importRoot = join(homeRoot, 'garmin-import')
  const serverPort = String(14319 + Math.floor(Math.random() * 600))
  const serverUrl = `http://127.0.0.1:${serverPort}`
  const processHandle = spawn(process.execPath, ['--import', 'tsx', 'app/server/src/index.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NORTHSTAR_HOME: homeRoot,
      NORTHSTAR_GARMIN_IMPORT_DIR: importRoot,
      NORTHSTAR_PORT: serverPort,
      NORTHSTAR_TELEGRAM_POLL: '0',
    },
  })

  try {
    await waitForServerAt(serverUrl)
    rmSync(importRoot, { recursive: true, force: true })

    const missing = await postJsonAt(serverUrl, '/api/health/sync/garmin', {})
    assert(missing.ok === false, 'missing Garmin import directory should not sync')
    assert(missing.error === 'garmin_import_directory_missing', `expected missing import directory error, got ${missing.error}`)
    assert(typeof missing.importRoot === 'string' && missing.importRoot === importRoot, 'missing Garmin response should include import root')

    const fixtureDir = join(importRoot, '2026-06-18')
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(join(fixtureDir, 'daily-summaries.json'), JSON.stringify({
      dailySummaries: [
        {
          calendarDate: '2026-06-17',
          restingHeartRateInBeatsPerMinute: 51,
          activeKilocalories: 720,
          moderateIntensityMinutes: 20,
          vigorousIntensityMinutes: 10,
          trainingReadinessScore: 86,
        },
        {
          calendarDate: '2026-06-18',
          restingHeartRate: 53,
          activeCalories: 680,
        },
      ],
      sleepSummaries: [
        {
          calendarDate: '2026-06-17',
          sleepTimeSeconds: 27900,
          sleepScore: 88,
        },
        {
          calendarDate: '2026-06-18',
          deepSleepSeconds: 5400,
          lightSleepSeconds: 16200,
          remSleepSeconds: 4200,
        },
      ],
      partialRecords: [
        { calendarDate: '2026-06-19', note: 'missing numeric health fields should be ignored' },
      ],
    }, null, 2))
    writeFileSync(join(fixtureDir, 'activities.json'), JSON.stringify({
      activities: [
        {
          activityId: 'garmin-smoke-run-1',
          activityName: 'Smoke Run',
          activityType: { typeKey: 'running' },
          startTimeGMT: '2026-06-17 11:30:00',
          duration: 2700,
          distance: 9000,
          calories: 640,
          averageHR: 142,
          maxHR: 178,
        },
        {
          activityId: 'garmin-smoke-partial',
          activityName: 'Missing start should be skipped',
          calories: 10,
        },
      ],
    }, null, 2))

    const first = await postJsonAt(serverUrl, '/api/health/sync/garmin', {})
    assert(first.ok === true, `first Garmin import failed: ${first.error ?? first.detail ?? 'unknown'}`)
    assert(first.imported?.dailyMetrics === 2, `expected 2 Garmin daily metrics, got ${first.imported?.dailyMetrics}`)
    assert(first.imported?.activities === 1, `expected 1 Garmin activity, got ${first.imported?.activities}`)
    assert(first.latestDate === '2026-06-18', `expected latestDate 2026-06-18, got ${first.latestDate}`)

    const dbPath = northstarDatabasePath(homeRoot)
    const firstCounts = garminHealthCounts(dbPath)
    assert(firstCounts.daily === 2, `expected 2 stored Garmin daily rows, got ${firstCounts.daily}`)
    assert(firstCounts.activities === 1, `expected 1 stored Garmin activity row, got ${firstCounts.activities}`)
    assert(firstCounts.sleepRows === 2, `expected sleep data on 2 Garmin rows, got ${firstCounts.sleepRows}`)
    assert(firstCounts.readinessRows === 2, `expected readiness/direct-or-proxy on 2 Garmin rows, got ${firstCounts.readinessRows}`)

    const second = await postJsonAt(serverUrl, '/api/health/sync/garmin', {})
    assert(second.ok === true, `second Garmin import failed: ${second.error ?? second.detail ?? 'unknown'}`)
    const secondCounts = garminHealthCounts(dbPath)
    assert(JSON.stringify(secondCounts) === JSON.stringify(firstCounts), 'Garmin import should be idempotent on repeat sync')

    const all = await postJsonAt(serverUrl, '/api/health/sync/all', {})
    assert(all.ok === true, 'sync-all should succeed when Garmin succeeds and Strava needs setup')
    assert(all.summary?.garmin?.ok === true, 'sync-all should include Garmin success')
    assert(all.summary?.strava?.ok === false, 'sync-all should preserve Strava setup failure')

    return {
      ok: true,
      missingError: missing.error,
      daily: firstCounts.daily,
      activities: firstCounts.activities,
      latestDate: first.latestDate,
      syncAllOk: all.ok,
    }
  } finally {
    processHandle.kill('SIGTERM')
    await waitForExit(processHandle)
    rmSync(homeRoot, { recursive: true, force: true })
  }
}

async function muteTelegramInboxNotificationsForSmoke() {
  try {
    const status = await getJson('/api/telegram/status')
    const settings = status?.settings
    if (settings) {
      await postJson('/api/telegram/settings', {
        notifyInbox: false,
        notifyImportant: false,
        notifyDigest: false,
        notifyLifecycleDebug: false,
        notifyRunTelemetryDebug: false,
        debugUntil: null,
      })
    }
    return settings
      ? {
        notifyInbox: Boolean(settings.notifyInbox),
        notifyImportant: Boolean(settings.notifyImportant),
        notifyDigest: Boolean(settings.notifyDigest),
        notifyLifecycleDebug: Boolean(settings.notifyLifecycleDebug),
        notifyRunTelemetryDebug: Boolean(settings.notifyRunTelemetryDebug),
        debugUntil: settings.debugUntil ?? null,
      }
      : null
  } catch {
    return null
  }
}

async function restoreTelegramInboxNotificationsAfterSmoke(settings) {
  if (!settings) return
  try {
    await postJson('/api/telegram/settings', settings)
  } catch {
    // Smoke should not fail if restore races a test-owned server shutdown.
  }
}

async function assertTelegramPromptFlow(input) {
  if (input?.preUpsert) {
    upsertSmokeTelegramSession(input.chatId, input.threadId || 'main', input.preUpsert.model, input.preUpsert.agent)
  }
  const created = []
  const intake = await postJson('/api/telegram/intake', {
    chatId: input.chatId,
    threadId: input.threadId,
    text: input.text,
    messageId: input.messageId,
    autoDispatch: false,
  })
  assert(intake.ok === true, `Telegram intake failed: ${intake.error ?? 'unknown error'}`)
  created.push({ taskId: intake.taskId, actionId: intake.actionId })

  const queueBefore = await getJson('/api/queue')
  const task = queueBefore.tasks.find((item) => item.id === intake.taskId)
  assert(task?.status === input.expectedStatus, `Telegram task status expected ${input.expectedStatus}, got ${task?.status}`)
  assert(task.source === 'telegram', 'Telegram task source was not returned by /api/queue')
  assert(task.sourceRef === `telegram:${input.chatId}/${input.threadId}/${input.messageId}`, 'Telegram task sourceRef is incorrect')
  assert(task.prompt === input.text, 'Telegram task prompt was not stored verbatim')
  assert(task?.model === input.expectedModel, `Telegram task model expected ${input.expectedModel}, got ${task?.model}`)
  assert(intake.actionId === null || typeof intake.actionId === 'undefined', 'Telegram intake should not create a route-choice Inbox action')
  if (input.expectedLane) {
    assert((intake.lane ?? '').toLowerCase() === input.expectedLane.toLowerCase(), `Telegram intake lane expected ${input.expectedLane}, got ${intake.lane}`)
    assert(intake.laneWarning?.toLowerCase().includes((input.expectedLaneWarning ?? '').toLowerCase()), `Telegram lane warning missing expected text`)
  }
  return { created }
}

function upsertSmokeTelegramSession(chatId, threadId, model = 'spark', agent = 'telegram-smoke') {
  withDb((db) => {
    db.prepare(
      `INSERT INTO telegram_sessions
        (chat_id, thread_id, project, model, agent, cwd, session_key, updated_at)
       VALUES (?, ?, 'northstar', ?, ?, 'projects/northstar', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(chat_id, thread_id) DO UPDATE SET
         project = excluded.project,
         model = excluded.model,
         agent = excluded.agent,
         cwd = excluded.cwd,
         session_key = excluded.session_key,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(chatId, threadId, model, agent, `${chatId}:${threadId}:northstar`)
  })
}

function cleanupSmokeTelegramRows(chatId, created) {
  withDb((db) => {
    const sourceLike = `telegram:${chatId}/%`
    db.prepare('DELETE FROM inbox_actions WHERE task_id IN (SELECT id FROM tasks WHERE source_ref LIKE ?)').run(sourceLike)
    db.prepare('DELETE FROM tasks WHERE source_ref LIKE ?').run(sourceLike)
    for (const item of created) {
      if (item.actionId) {
        db.prepare('DELETE FROM telegram_delivery_log WHERE event_key = ?').run(item.actionId)
        db.prepare('DELETE FROM inbox_actions WHERE id = ?').run(item.actionId)
      }
      if (item.taskId) db.prepare('DELETE FROM tasks WHERE id = ?').run(item.taskId)
    }
    db.prepare('DELETE FROM telegram_sessions WHERE chat_id = ?').run(chatId)
  })
}

function withDbAt(dbPath, fn) {
  const db = new DatabaseSync(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function withDb(fn) {
  return withDbAt(northstarDatabasePath(), fn)
}

function garminHealthCounts(dbPath) {
  return withDbAt(dbPath, (db) => {
    const daily = db.prepare("SELECT COUNT(*) AS count FROM health_daily_metrics WHERE source = 'garmin'").get()
    const activities = db.prepare("SELECT COUNT(*) AS count FROM health_activities WHERE source = 'garmin'").get()
    const sleepRows = db.prepare("SELECT COUNT(*) AS count FROM health_daily_metrics WHERE source = 'garmin' AND sleep_hours IS NOT NULL").get()
    const readinessRows = db.prepare("SELECT COUNT(*) AS count FROM health_daily_metrics WHERE source = 'garmin' AND readiness IS NOT NULL").get()
    return {
      daily: Number(daily?.count ?? 0),
      activities: Number(activities?.count ?? 0),
      sleepRows: Number(sleepRows?.count ?? 0),
      readinessRows: Number(readinessRows?.count ?? 0),
    }
  })
}

function cleanupSmokeAttentionRows(db) {
  db.prepare("DELETE FROM attention_alerts WHERE event_type = 'task' AND (event_key LIKE 'smoke-%' OR event_key LIKE 'test-smoke-%')").run()
}

function smokeAttentionResidueCount(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM attention_alerts WHERE event_type = 'task' AND (event_key LIKE 'smoke-%' OR event_key LIKE 'test-smoke-%')").get()
  return Number(row?.count ?? 0)
}

function northstarDatabasePath(homePath = process.env.NORTHSTAR_HOME ?? join(homedir(), '.northstar')) {
  return join(homePath, 'northstar.sqlite')
}

function runProjectSkillsMirrorSmoke() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'northstar-skills-smoke-'))
  const script = `
    import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
    import { join } from 'node:path';

    const tempRoot = ${JSON.stringify(tempRoot)};
    process.env.NORTHSTAR_HOME = join(tempRoot, 'home');
    process.env.NORTHSTAR_DROPBOX_ROOT = join(tempRoot, 'missing-dropbox');

    const mod = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'app/server/src/projectSkills.ts')).href)});
    const project = { id: 'mirror-smoke', name: 'Mirror Smoke', path: 'manual:mirror-smoke', localExists: false };
    mod.ensureProjectSkillsFile(project);
    const absentMirror = join(tempRoot, 'missing-dropbox', 'projects', 'mirror-smoke', 'skills', 'northstar-skills.md');
    if (existsSync(absentMirror)) throw new Error('Dropbox-absent mirror should not be written');

    const dropbox = join(tempRoot, 'dropbox');
    mkdirSync(dropbox, { recursive: true });
    process.env.NORTHSTAR_DROPBOX_ROOT = dropbox;
    mod.appendProjectLearning(project, 'Mirror smoke note', 'smoke');
    const mirror = join(dropbox, 'projects', 'mirror-smoke', 'skills', 'northstar-skills.md');
    if (!existsSync(mirror)) throw new Error('Dropbox-present mirror was not written');
    const content = readFileSync(mirror, 'utf8');
    if (!content.includes('Generated by Northstar') || !content.includes('Do not edit this Dropbox copy') || !content.includes('Mirror smoke note')) {
      throw new Error('Dropbox mirror content is incomplete');
    }
    rmSync(tempRoot, { recursive: true, force: true });
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  })
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true })
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(`project skills mirror smoke failed: ${detail}`)
  }
  return { ok: true }
}

function runProjectWorkspaceTemplateSmoke() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'northstar-workspace-smoke-'))
  const script = `
    import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';

    const tempRoot = ${JSON.stringify(tempRoot)};
    const dropbox = join(tempRoot, 'dropbox');
    mkdirSync(dropbox, { recursive: true });
    process.env.NORTHSTAR_DROPBOX_ROOT = dropbox;

    const mod = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'app/server/src/deviceFiles.ts')).href)});
    const fresh = mod.ensureProjectWorkspace({ project: 'workspace-smoke', repoPath: '/tmp/workspace-smoke' });
    if (!fresh.ok) throw new Error(fresh.error);
    const profile = join(dropbox, fresh.files.agentProfile);
    const claude = join(dropbox, fresh.files.claude);
    const agents = join(dropbox, fresh.files.agents);
    const implementation = join(dropbox, fresh.files.implementation);
    if (!existsSync(profile)) throw new Error('agent-profile.md was not created');
    if (!readFileSync(profile, 'utf8').includes('Default lane: codex orchestrator')) throw new Error('agent profile routing guidance is missing');
    if (!readFileSync(claude, 'utf8').includes('<!-- northstar:project-agent:start -->')) throw new Error('CLAUDE.md managed section is missing');
    if (!readFileSync(agents, 'utf8').includes('One run means one queued task')) throw new Error('AGENTS.md agent contract is missing');
    if (!readFileSync(implementation, 'utf8').includes('Northstar Orchestration Notes')) throw new Error('implementation orchestration notes are missing');

    const legacyDir = join(dropbox, 'projects', 'legacy-smoke');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'CLAUDE.md'), '# Custom Claude\\n\\nKeep this note.\\n');
    writeFileSync(join(legacyDir, 'AGENTS.md'), '# Custom Agents\\n\\nKeep this contract.\\n');
    writeFileSync(join(legacyDir, 'implementation.md'), '# Custom Plan\\n\\nKeep this plan.\\n');
    const legacy = mod.ensureProjectWorkspace({ project: 'legacy-smoke', repoPath: '/tmp/legacy-smoke' });
    if (!legacy.ok) throw new Error(legacy.error);
    const legacyClaude = readFileSync(join(dropbox, legacy.files.claude), 'utf8');
    if (!legacyClaude.includes('Keep this note.') || !legacyClaude.includes('Northstar Project Agent')) {
      throw new Error('legacy CLAUDE.md was not preserved and refined');
    }
    rmSync(tempRoot, { recursive: true, force: true });
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  })
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true })
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(`project workspace template smoke failed: ${detail}`)
  }
  return { ok: true }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    server?.kill('SIGTERM')
  })
