import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

import { checkNoApiGuardrails, resolveCliExecutable, sanitizedEnv } from './guardrails.js'
import { logRoot, worktreeRoot } from './paths.js'
import { appendProjectLearning, ensureProjectSkillsFile, extractLearningCandidates, readProjectSkills } from './projectSkills.js'
import type { LocalProject } from './projects.js'

export type DispatchModel = 'opus' | 'spark' | 'codex'
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'
type RunStatus = 'running' | 'done' | 'blocked'

type CheckResult = { name: string; state: 'pass' | 'running' | 'fail'; ms: number; detail?: string }
type PatchFile = { path: string; add: number; del: number; status: 'new' | 'mod' | 'del-partial' }
type DiffLine =
  | { t: 'hunk'; s: string }
  | { t: 'ctx'; n1: number; n2: number; s: string }
  | { t: 'del'; n1: number; s: string }
  | { t: 'add'; n2: number; s: string }

type PatchArtifact = {
  summary: string
  additions: number
  deletions: number
  filesChanged: number
  checks: CheckResult[]
  files: PatchFile[]
  diff: DiffLine[]
  rationale: string[]
  risks: Array<{ level: 'low' | 'med' | 'high'; text: string }>
}

type PatchRefreshSource = {
  taskId: string
  runId: string
  projectId: string
  projectName: string
  model: DispatchModel
  basePath: string
  worktree: string
  finalText: string
}

type RunnerCommand = {
  executable: string
  args: string[]
  display: string
  provider: string
  cwd: string
  basePath: string
  mode: 'plan' | 'patch'
  finalTextPath?: string
  stdin?: string
}

type RunningRunRow = {
  id: string
  taskId: string | null
  projectId: string
  model: DispatchModel
  provider: string
  command: string
  cwd: string
  worktreePath: string | null
  transport: 'spawn' | 'tmux' | string
  basePath: string | null
  tmuxSession: string | null
  stdoutLogPath: string | null
  stderrLogPath: string | null
  exitStatusPath: string | null
  finalTextPath: string | null
  pid: number | null
  status: RunStatus
}

type RunListRow = Record<string, unknown> & {
  id: string
  model: DispatchModel
  status: RunStatus
}

type TmuxExecutable =
  | { ok: true; executable: string; version: string }
  | { ok: false; error: string }

type TmuxRunFiles = {
  runDir: string
  wrapperPath: string
  stdinPath: string | null
  stdoutPath: string
  stderrPath: string
  exitStatusPath: string
  finalTextPath: string | null
}

export type DispatchRequest = {
  model?: DispatchModel
  manualApproval?: boolean
  prompt?: string
  projectContext?: string
  taskId?: string
  taskTitle?: string
  taskPriority?: TaskPriority
  taskAgent?: string
  taskStage?: string
}

export type DispatchResult =
  | {
      ok: true
      task: { id: string; projectId: string; model: DispatchModel; status: RunStatus }
      run: { id: string; status: RunStatus; finalText: string; exitCode: number | null; worktreePath: string; transport: 'tmux'; tmuxSession: string; attachCommand: string }
    }
  | { ok: false; blocked?: boolean; code?: string; error: string; guardrails?: ReturnType<typeof checkNoApiGuardrails> }

const maxParallelRuns = Number(process.env.NORTHSTAR_MAX_RUNS ?? 4)
const codexSparkModel = process.env.NORTHSTAR_CODEX_SPARK_MODEL ?? 'gpt-5.3-codex-spark'
const codexReservedModel = process.env.NORTHSTAR_CODEX_RESERVED_MODEL ?? 'gpt-5.5'
const runLogRoot = join(logRoot, 'runs')
export const tmuxReconcileIntervalMs = Number(process.env.NORTHSTAR_TMUX_POLL_MS ?? 5000)

export function listRuns(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT
        id,
        task_id AS taskId,
        (SELECT title FROM tasks WHERE tasks.id = agent_runs.task_id) AS taskTitle,
        (SELECT source FROM tasks WHERE tasks.id = agent_runs.task_id) AS taskSource,
        project_id AS projectId,
        model,
        provider,
        command,
        cwd,
        worktree_path AS worktreePath,
        transport,
        base_path AS basePath,
        tmux_session AS tmuxSession,
        stdout_log_path AS stdoutLogPath,
        stderr_log_path AS stderrLogPath,
        exit_status_path AS exitStatusPath,
        final_text_path AS finalTextPath,
        pid,
        status,
        prompt,
        stdout,
        stderr,
        final_text AS finalText,
        exit_code AS exitCode,
        started_at AS startedAt,
        updated_at AS updatedAt,
        completed_at AS completedAt
      FROM agent_runs
      ORDER BY started_at DESC
      LIMIT 50`,
    )
    .all() as RunListRow[]
  return rows.map(withRunAttachCommand)
}

export function getRun(db: DatabaseSync, id: string) {
  const row =
    db
      .prepare(
        `SELECT
          id,
          task_id AS taskId,
          (SELECT title FROM tasks WHERE tasks.id = agent_runs.task_id) AS taskTitle,
          (SELECT source FROM tasks WHERE tasks.id = agent_runs.task_id) AS taskSource,
          project_id AS projectId,
          model,
          provider,
          command,
          cwd,
          worktree_path AS worktreePath,
          transport,
          base_path AS basePath,
          tmux_session AS tmuxSession,
          stdout_log_path AS stdoutLogPath,
          stderr_log_path AS stderrLogPath,
          exit_status_path AS exitStatusPath,
          final_text_path AS finalTextPath,
          pid,
          status,
          prompt,
          stdout,
          stderr,
          final_text AS finalText,
          exit_code AS exitCode,
          started_at AS startedAt,
          updated_at AS updatedAt,
          completed_at AS completedAt
        FROM agent_runs
        WHERE id = ?`,
      )
      .get(id) as RunListRow | undefined
  return row ? withRunAttachCommand(row) : null
}

export function reconcileStaleRuns(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT
        id,
        task_id AS taskId,
        project_id AS projectId,
        model,
        provider,
        command,
        cwd,
        worktree_path AS worktreePath,
        transport,
        base_path AS basePath,
        tmux_session AS tmuxSession,
        stdout_log_path AS stdoutLogPath,
        stderr_log_path AS stderrLogPath,
        exit_status_path AS exitStatusPath,
        final_text_path AS finalTextPath,
        pid,
        status
       FROM agent_runs
       WHERE status = 'running'`,
    )
    .all() as RunningRunRow[]

  const recovered = []
  const finalized = []
  for (const row of rows) {
    if (row.transport === 'tmux') {
      const result = reconcileTmuxRun(db, row)
      if (result?.status === 'done' || result?.status === 'blocked') finalized.push(result)
      continue
    }

    const pid = normalizePid(row.pid)
    if (pid && isPidAlive(pid)) continue

    const detail = pid ? `stored PID ${pid} is no longer alive` : 'no PID was recorded for this running agent'
    const finalText = [
      `${modelLabel(row.model)} run was recovered as blocked because ${detail}.`,
      'Northstar did not mark this done because the local CLI process is gone and no trustworthy completion signal was received.',
      'Smallest useful next decision: inspect any partial output or retry the task in a fresh worktree if the work is still needed.',
    ].join(' ')
    markRunBlocked(db, row, {
      finalText,
      stderrNote: `[northstar] Stale run recovery: ${detail}; marked blocked instead of leaving Queue running.`,
      stage: `${modelLabel(row.model)} stale process recovered`,
      exitCode: 1,
    })
    recovered.push({ id: row.id, taskId: row.taskId, projectId: row.projectId, pid, status: 'blocked' as const, reason: detail })
  }

  return { ok: true, recovered, finalized }
}

export async function cancelRun(db: DatabaseSync, id: string) {
  const row = db
    .prepare(
      `SELECT
        id,
        task_id AS taskId,
        project_id AS projectId,
        model,
        provider,
        command,
        cwd,
        worktree_path AS worktreePath,
        transport,
        base_path AS basePath,
        tmux_session AS tmuxSession,
        stdout_log_path AS stdoutLogPath,
        stderr_log_path AS stderrLogPath,
        exit_status_path AS exitStatusPath,
        final_text_path AS finalTextPath,
        pid,
        status
       FROM agent_runs
       WHERE id = ?`,
    )
    .get(id) as RunningRunRow | undefined
  if (!row) return { ok: false, error: 'run_not_found' }
  if (row.status !== 'running') return { ok: false, error: 'run_not_running', run: getRun(db, id) }

  if (row.transport === 'tmux') {
    const tmux = resolveTmuxExecutable()
    const aliveBefore = tmux.ok && row.tmuxSession ? isTmuxSessionAlive(tmux.executable, row.tmuxSession) : false
    let interrupted = false
    let killed = false
    if (tmux.ok && row.tmuxSession && aliveBefore) {
      interrupted = sendTmuxInterrupt(tmux.executable, row.tmuxSession)
      await sleep(800)
      if (isTmuxSessionAlive(tmux.executable, row.tmuxSession)) {
        killed = killTmuxSession(tmux.executable, row.tmuxSession)
        await sleep(100)
      } else {
        killed = true
      }
    }
    syncRunLogs(db, row)
    const processDetail = tmux.ok
      ? row.tmuxSession
        ? aliveBefore
          ? `${interrupted ? 'sent Ctrl-C to' : 'could not interrupt'} tmux session ${row.tmuxSession}${killed ? '; session stopped' : '; session may still be alive'}`
          : `tmux session ${row.tmuxSession} was already gone`
        : 'no tmux session was recorded'
      : `tmux is unavailable: ${tmux.error}`
    const finalText = [
      `${modelLabel(row.model)} run was canceled safely by Northstar and marked blocked.`,
      `Process handling: ${processDetail}.`,
      'No commit or push was performed. The isolated worktree and tmux logs are left for inspection.',
    ].join(' ')
    markRunBlocked(db, row, {
      finalText,
      stderrNote: `[northstar] Run canceled by request: ${processDetail}.`,
      stage: `${modelLabel(row.model)} canceled`,
      exitCode: 143,
    })
    return { ok: true, canceled: true, status: 'blocked' as const, transport: 'tmux', tmuxSession: row.tmuxSession, aliveBefore, interrupted, killed, run: getRun(db, id) }
  }

  const pid = normalizePid(row.pid)
  const aliveBefore = Boolean(pid && isPidAlive(pid))
  let signalTarget: number | null = null
  let signaled = false
  let killed = false
  if (pid && aliveBefore) {
    const term = signalRunProcess(pid, 'SIGTERM')
    signalTarget = term.target
    signaled = term.ok
  }

  const processDetail = pid
    ? aliveBefore
      ? signaled
        ? `sent SIGTERM to PID ${pid}${signalTarget && signalTarget < 0 ? ' process group' : ''}`
        : `could not signal PID ${pid}`
      : `stored PID ${pid} was already gone`
    : 'no PID was recorded'
  const finalText = [
    `${modelLabel(row.model)} run was canceled safely by Northstar and marked blocked.`,
    `Process handling: ${processDetail}.`,
    'No commit or push was performed. The isolated worktree, if present, is left for inspection or cleanup.',
  ].join(' ')
  markRunBlocked(db, row, {
    finalText,
    stderrNote: `[northstar] Run canceled by request: ${processDetail}.`,
    stage: `${modelLabel(row.model)} canceled`,
    exitCode: 143,
  })

  if (pid && aliveBefore && signaled) {
    await sleep(800)
    if (isPidAlive(pid)) {
      const kill = signalRunProcess(pid, 'SIGKILL')
      signalTarget = kill.target ?? signalTarget
      await sleep(100)
    }
    killed = !isPidAlive(pid)
  }

  return { ok: true, canceled: true, status: 'blocked' as const, pid, aliveBefore, signaled, killed, run: getRun(db, id) }
}

export function dispatchAgent(db: DatabaseSync, projects: LocalProject[], request: DispatchRequest): DispatchResult {
  const model = request.model ?? 'opus'
  const prompt = request.prompt?.trim()
  if (!prompt) return { ok: false, error: 'Prompt is required before dispatch.' }
  if (model === 'codex' && request.manualApproval !== true) {
    return { ok: false, blocked: true, error: 'Manual approval is required before dispatching reserved Codex GPT-5.5. Retry with manualApproval: true.' }
  }

  const guardrails = checkNoApiGuardrails(model)
  if (!guardrails.ok) return { ok: false, blocked: true, error: 'Strict no-API guardrails blocked dispatch.', guardrails }

  const running = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running'").get() as { count: number }
  if (running.count >= maxParallelRuns) return { ok: false, error: `All ${maxParallelRuns} Northstar agent slots are busy.` }

  const project = pickProject(projects, request.projectContext)
  if (!project) return { ok: false, error: 'No local project is available for dispatch.' }
  if (!project.localExists || project.path.startsWith('github:')) return { ok: false, error: `${project.name} is GitHub-only. Clone it locally before dispatch.` }

  const repoPath = expandHome(project.path)
  if (!existsSync(join(repoPath, '.git'))) return { ok: false, error: `${project.name} is not a local git checkout.` }

  const tmux = resolveTmuxExecutable()
  if (!tmux.ok) return { ok: false, blocked: true, code: 'tmux_unavailable', error: tmux.error }

  ensureProjectSkillsFile(project)

  const taskId = cleanTaskId(request.taskId) || `RUN-${Date.now().toString(36)}`
  const runSlug = `RUN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const runId = randomUUID()
  let worktreePath = ''
  try {
    worktreePath = prepareWorktree(repoPath, project.id, runSlug)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create agent worktree.'
    return { ok: false, error: message }
  }
  const scopeContext = buildScopeContext(projects, request.projectContext, project)
  const command = buildRunnerCommand(model, prompt, project, repoPath, worktreePath, runId, scopeContext)
  const tmuxSession = tmuxSessionName(taskId, runId)
  const runFiles = prepareTmuxRunFiles(runId, command)
  const attachCommand = tmuxAttachCommand(tmuxSession)

  ensureProjectRow(db, project)
  const taskTitle = (request.taskTitle?.trim() || prompt.slice(0, 80)).slice(0, 160)
  const taskPriority = request.taskPriority ?? 'P2'
  const taskAgent = request.taskAgent?.trim() || command.provider
  const taskStage = request.taskStage?.trim() || `${modelLabel(model)} running`
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch, source, source_ref, prompt, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 0.05, 'now', ?, 0, ?, 'cockpit', '', ?, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id,
       title = excluded.title,
       model = excluded.model,
       agent = excluded.agent,
       status = 'running',
       priority = excluded.priority,
       progress = excluded.progress,
       eta = excluded.eta,
       stage = excluded.stage,
       branch = excluded.branch,
       source = excluded.source,
       source_ref = excluded.source_ref,
       prompt = excluded.prompt,
       updated_at = CURRENT_TIMESTAMP,
       completed_at = NULL`,
  ).run(taskId, project.id, taskTitle, model, taskAgent, taskPriority, taskStage, `agent/${runSlug.toLowerCase()}`, prompt)

  db.prepare(
    `INSERT INTO agent_runs
      (id, task_id, project_id, model, provider, command, cwd, worktree_path, transport, base_path, tmux_session, stdout_log_path, stderr_log_path, exit_status_path, final_text_path, status, prompt, stdout, stderr, final_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'tmux', ?, ?, ?, ?, ?, ?, 'running', ?, '', '', '')`,
  ).run(
    runId,
    taskId,
    project.id,
    model,
    command.provider,
    command.display,
    command.cwd,
    worktreePath,
    repoPath,
    tmuxSession,
    runFiles.stdoutPath,
    runFiles.stderrPath,
    runFiles.exitStatusPath,
    runFiles.finalTextPath,
    prompt,
  )

  const started = startTmuxRun(tmux, tmuxSession, command, runFiles)
  if (!started.ok) {
    markRunBlocked(db, { id: runId, taskId }, {
      finalText: `Northstar could not start tmux session ${tmuxSession}.`,
      stderrNote: `[northstar] tmux launch failed: ${started.error}`,
      stage: `${modelLabel(model)} tmux launch failed`,
      exitCode: 1,
    })
    return { ok: false, blocked: true, code: 'tmux_launch_failed', error: started.error }
  }

  return {
    ok: true,
    task: { id: taskId, projectId: project.id, model, status: 'running' },
    run: { id: runId, status: 'running', finalText: '', exitCode: null, worktreePath, transport: 'tmux', tmuxSession, attachCommand },
  }
}

function prepareTmuxRunFiles(runId: string, command: RunnerCommand): TmuxRunFiles {
  const runDir = join(runLogRoot, runId)
  mkdirSync(runDir, { recursive: true })
  const stdinPath = command.stdin ? join(runDir, 'stdin.txt') : null
  const stdoutPath = join(runDir, 'stdout.log')
  const stderrPath = join(runDir, 'stderr.log')
  const exitStatusPath = join(runDir, 'exit.status')
  const wrapperPath = join(runDir, 'run.sh')
  const finalTextPath = command.finalTextPath ?? null

  if (stdinPath) {
    writeFileSync(stdinPath, command.stdin ?? '', { encoding: 'utf8', mode: 0o600 })
  }
  writeFileSync(stdoutPath, '', { encoding: 'utf8', mode: 0o600 })
  writeFileSync(stderrPath, '', { encoding: 'utf8', mode: 0o600 })
  writeFileSync(wrapperPath, buildTmuxWrapper(command, { stdinPath, stdoutPath, stderrPath, exitStatusPath }), { encoding: 'utf8', mode: 0o700 })
  chmodSync(wrapperPath, 0o700)

  return { runDir, wrapperPath, stdinPath, stdoutPath, stderrPath, exitStatusPath, finalTextPath }
}

function buildTmuxWrapper(command: RunnerCommand, files: Pick<TmuxRunFiles, 'stdinPath' | 'stdoutPath' | 'stderrPath' | 'exitStatusPath'>) {
  const envLines = Object.entries(sanitizedEnv())
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')
    .map(([key, value]) => `${key}=${shellQuote(value ?? '')}`)
  const envPrefix = envLines.length ? `env -i \\\n  ${envLines.join(' \\\n  ')} \\\n  ` : 'env -i '
  const args = [command.executable, ...command.args].map(shellQuote).join(' ')
  const stdinRedirect = files.stdinPath ? ` < ${shellQuote(files.stdinPath)}` : ''
  return [
    '#!/bin/bash',
    'umask 077',
    `exec > >(/usr/bin/tee -a ${shellQuote(files.stdoutPath)})`,
    `exec 2> >(/usr/bin/tee -a ${shellQuote(files.stderrPath)} >&2)`,
    `cd ${shellQuote(command.cwd)}`,
    'if [ $? -ne 0 ]; then',
    `  echo "Northstar could not enter worktree: ${escapeShellDouble(command.cwd)}"`,
    `  printf '%s\\n' 127 > ${shellQuote(files.exitStatusPath)}`,
    '  exit 127',
    'fi',
    `${envPrefix}${args}${stdinRedirect}`,
    'code=$?',
    `printf '%s\\n' "$code" > ${shellQuote(files.exitStatusPath)}`,
    'exit "$code"',
    '',
  ].join('\n')
}

function startTmuxRun(tmux: Extract<TmuxExecutable, { ok: true }>, session: string, command: RunnerCommand, files: TmuxRunFiles) {
  const result = spawnSync(tmux.executable, ['new-session', '-d', '-s', session, '-c', command.cwd, '/bin/bash', files.wrapperPath], {
    encoding: 'utf8',
    env: sanitizedEnv(),
  })
  if (result.status === 0) return { ok: true as const }
  const detail = commandOutput(result)
  return { ok: false as const, error: detail || `tmux new-session failed for ${session}` }
}

function startBackgroundRun(
  db: DatabaseSync,
  command: RunnerCommand,
  context: { runId: string; taskId: string; project: LocalProject; model: DispatchModel },
) {
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: sanitizedEnv(),
    detached: process.platform !== 'win32',
    stdio: [command.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let finished = false

  db.prepare('UPDATE agent_runs SET pid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(child.pid ?? null, context.runId)
  if (command.stdin && child.stdin) child.stdin.end(command.stdin)

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString()
    stdout += text
    appendRunOutput(db, context.runId, 'stdout', text)
  })
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString()
    stderr += text
    appendRunOutput(db, context.runId, 'stderr', text)
  })
  child.on('error', (error) => {
    stderr += `${error.message}\n`
    appendRunOutput(db, context.runId, 'stderr', `${error.message}\n`)
    finishRun(db, command, context, 1, stdout, stderr, true)
    finished = true
  })
  child.on('close', (code, signal) => {
    if (finished) return
    finished = true
    if (signal) {
      const note = `[northstar] Agent process exited after ${signal}; marking run blocked.\n`
      stderr += note
      appendRunOutput(db, context.runId, 'stderr', note)
    }
    finishRun(db, command, context, code ?? signalExitCode(signal) ?? 1, stdout, stderr, false)
  })
}

function finishRun(
  db: DatabaseSync,
  command: RunnerCommand,
  context: { runId: string; taskId: string; project: LocalProject; model: DispatchModel },
  exitCode: number,
  stdout: string,
  stderr: string,
  forceBlocked: boolean,
) {
  if (!isRunStillRunning(db, context.runId)) return

  const finalText = parseFinalText(context.model, stdout, stderr, command.finalTextPath)
  const checks = command.mode === 'patch' ? runVerification(command.cwd) : []
  const patch = command.mode === 'patch' ? buildPatchArtifact(command.cwd, finalText, checks) : null
  const hasPatch = Boolean(patch && patch.filesChanged > 0)
  const checksPassed = checks.every((check) => check.state === 'pass')
  const needsInput = requiresHumanInput(finalText, hasPatch)
  const status: RunStatus = !forceBlocked && exitCode === 0 && (!checks.length || checksPassed) && (command.mode === 'plan' || hasPatch) && !needsInput ? 'done' : 'blocked'
  const stage = status === 'done'
    ? hasPatch ? `${modelLabel(context.model)} patch verified` : `${modelLabel(context.model)} complete`
    : needsInput ? `${modelLabel(context.model)} needs input` : `${modelLabel(context.model)} blocked`

  extractLearningCandidates(finalText).forEach((note) => appendProjectLearning(context.project, note, `agent-run:${context.taskId}`))
  if (patch) savePatchArtifact(db, command, context, patch)

  db.prepare(
    `UPDATE agent_runs
     SET status = ?, stdout = ?, stderr = ?, final_text = ?, exit_code = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(status, stdout, stderr, finalText, exitCode, context.runId)
  db.prepare('UPDATE tasks SET status = ?, progress = ?, stage = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, status === 'done' ? 1 : 0.2, stage, context.taskId)

  const inbox = inboxForRun(context.model, context.project.name, context.taskId, status, finalText, stderr, command, patch, checks, needsInput)
  db.prepare(
    `INSERT OR IGNORE INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    inbox.id,
    context.project.id,
    context.taskId,
    inbox.type,
    context.model,
    inbox.priority,
    inbox.urgency,
    inbox.title,
    inbox.ctx,
    JSON.stringify(inbox.options),
    inbox.help,
  )
}

function reconcileTmuxRun(db: DatabaseSync, row: RunningRunRow) {
  syncRunLogs(db, row)

  const exitCode = readExitStatus(row.exitStatusPath)
  if (exitCode !== null) {
    const command = commandFromRunRow(row)
    const project = projectFromRunRow(db, row)
    const stdout = readTextFile(row.stdoutLogPath)
    const stderr = readTextFile(row.stderrLogPath)
    finishRun(db, command, { runId: row.id, taskId: row.taskId ?? row.id, project, model: row.model }, exitCode, stdout, stderr, false)
    return { id: row.id, taskId: row.taskId, projectId: row.projectId, status: getRunStatus(db, row.id) ?? 'done', reason: 'tmux_exit_status' }
  }

  const tmux = resolveTmuxExecutable()
  if (!tmux.ok || !row.tmuxSession) return null
  if (isTmuxSessionAlive(tmux.executable, row.tmuxSession)) return null

  const detail = `tmux session ${row.tmuxSession} is no longer alive and no exit status was recorded`
  markRunBlocked(db, row, {
    finalText: [
      `${modelLabel(row.model)} run was recovered as blocked because ${detail}.`,
      'Northstar kept the isolated worktree and tmux logs for inspection.',
      'Smallest useful next decision: inspect the run logs or retry the task in a fresh worktree if the work is still needed.',
    ].join(' '),
    stderrNote: `[northstar] Tmux recovery: ${detail}.`,
    stage: `${modelLabel(row.model)} tmux session missing`,
    exitCode: 1,
  })
  return { id: row.id, taskId: row.taskId, projectId: row.projectId, status: 'blocked' as const, reason: detail }
}

function syncRunLogs(db: DatabaseSync, row: Pick<RunningRunRow, 'id' | 'stdoutLogPath' | 'stderrLogPath'>) {
  const stdout = readTextFile(row.stdoutLogPath)
  const stderr = readTextFile(row.stderrLogPath)
  if (!stdout && !stderr) return
  db.prepare('UPDATE agent_runs SET stdout = ?, stderr = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').run(stdout, stderr, row.id, 'running')
}

function commandFromRunRow(row: RunningRunRow): RunnerCommand {
  return {
    executable: row.transport === 'tmux' ? 'tmux' : row.provider,
    args: [],
    display: row.command,
    provider: row.provider,
    cwd: row.worktreePath || row.cwd,
    basePath: row.basePath || '',
    mode: row.model === 'opus' ? 'plan' : 'patch',
    finalTextPath: row.finalTextPath ?? undefined,
  }
}

function projectFromRunRow(db: DatabaseSync, row: RunningRunRow): LocalProject {
  const projectRow = db
    .prepare('SELECT id, name, path, branch, lang, status, label, health, coverage, tokens, budget, runtime, last_event, last_ago FROM projects WHERE id = ?')
    .get(row.projectId) as
    | {
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
    | undefined
  const base: LocalProject = {
    id: row.projectId,
    name: projectRow?.name ?? row.projectId,
    path: projectRow?.path ?? row.basePath ?? row.cwd,
    branch: projectRow?.branch ?? '-',
    lang: projectRow?.lang ?? 'unknown',
    status: projectRow?.status ?? 'running',
    label: projectRow?.label ?? 'personal',
    health: projectRow?.health ?? 0,
    agentsActive: 1,
    openTasks: 1,
    queued: 0,
    commits24: 0,
    linesNet: '+0 / -0',
    coverage: projectRow?.coverage ?? 0,
    tokens: projectRow?.tokens ?? 0,
    budget: projectRow?.budget ?? 0,
    runtime: projectRow?.runtime ?? 'tmux',
    nodes: 0,
    communities: 0,
    lastEvent: projectRow?.last_event ?? 'tmux run',
    lastAgo: projectRow?.last_ago ?? 'now',
    spark: [],
    source: 'local',
    localExists: true,
    graphReady: false,
    skillsPath: '',
    skillsReady: false,
    skillsUpdatedAt: null,
    learnedItems: 0,
    active: true,
    autonomous: true,
    cadence: 'slow',
    dirtyFiles: 0,
  }
  return base
}

export function getPatch(db: DatabaseSync, taskId: string) {
  const row = db
    .prepare(
      `SELECT
        task_id,
        run_id,
        project_id,
        branch,
        base,
        worktree,
        summary,
        additions,
        deletions,
        files_changed,
        checks_json,
        files_json,
        diff_json,
        rationale_json,
        risks_json
       FROM patches
       WHERE task_id = CASE WHEN ? = 'latest' THEN task_id ELSE ? END
       ORDER BY datetime(updated_at) DESC
       LIMIT 1`,
    )
    .get(taskId, taskId) as
    | {
        task_id: string
        run_id: string
        project_id: string
        branch: string
        base: string
        worktree: string
        summary: string
        additions: number
        deletions: number
        files_changed: number
        checks_json: string
        files_json: string
        diff_json: string
        rationale_json: string
        risks_json: string
      }
    | undefined
  if (!row) return null
  return {
    task: row.task_id,
    title: row.summary,
    project: row.project_id,
    model: (db.prepare('SELECT model FROM agent_runs WHERE id = ?').get(row.run_id) as { model?: DispatchModel } | undefined)?.model ?? 'spark',
    branch: row.branch,
    base: row.base,
    worktree: row.worktree,
    summary: row.summary,
    additions: row.additions,
    deletions: row.deletions,
    filesChanged: row.files_changed,
    checks: parseJson<CheckResult[]>(row.checks_json, []),
    files: parseJson<PatchFile[]>(row.files_json, []),
    diff: parseJson<DiffLine[]>(row.diff_json, []),
    rationale: parseJson<string[]>(row.rationale_json, []),
    risks: parseJson<Array<{ level: 'low' | 'med' | 'high'; text: string }>>(row.risks_json, []),
  }
}

export function approvePatch(db: DatabaseSync, taskId: string) {
  const row = db
    .prepare('SELECT task_id, base_path, worktree FROM patches WHERE task_id = CASE WHEN ? = ? THEN task_id ELSE ? END ORDER BY datetime(updated_at) DESC LIMIT 1')
    .get(taskId, 'latest', taskId) as { task_id: string; base_path: string; worktree: string } | undefined
  if (!row) return { ok: false, error: 'patch_not_found' }

  const changedFiles = readChangedFilePaths(row.worktree)
  const baseDirty = new Set(gitLines(row.base_path, ['status', '--short']).map((line) => line.slice(3).trim()).filter(Boolean))
  const conflicts = changedFiles.filter((file) => baseDirty.has(file))
  if (conflicts.length) return { ok: false, error: `Base checkout has local changes in ${conflicts.slice(0, 5).join(', ')}.` }

  const diff = buildApplyDiff(row.worktree)
  if (!diff.trim()) return { ok: false, error: 'No diff is available to apply.' }

  const check = spawnSync('git', ['apply', '--check', '-'], { cwd: row.base_path, input: diff, encoding: 'utf8', env: sanitizedEnv(), maxBuffer: 10 * 1024 * 1024 })
  if (check.status !== 0) return { ok: false, error: `${check.stderr}${check.stdout}`.trim() || 'Patch does not apply cleanly.' }

  const applied = spawnSync('git', ['apply', '-'], { cwd: row.base_path, input: diff, encoding: 'utf8', env: sanitizedEnv(), maxBuffer: 10 * 1024 * 1024 })
  if (applied.status !== 0) return { ok: false, error: `${applied.stderr}${applied.stdout}`.trim() || 'Patch apply failed.' }

  db.prepare("UPDATE inbox_actions SET resolved_at = CURRENT_TIMESTAMP, resolution = 'approved-local-apply' WHERE task_id = ? AND type = 'review' AND resolved_at IS NULL").run(row.task_id)
  return { ok: true, task: row.task_id, applied: changedFiles.length, committed: false, pushed: false }
}

export function refreshPatchArtifact(db: DatabaseSync, projects: LocalProject[], taskId: string) {
  const source = findPatchRefreshSource(db, projects, taskId)
  if (!source) return { ok: false as const, error: 'patch_source_not_found' }
  if (!source.basePath || !existsSync(source.basePath)) return { ok: false as const, error: 'base_path_unavailable' }
  if (!source.worktree || !existsSync(source.worktree)) return { ok: false as const, error: 'worktree_missing' }
  if (gitText(source.worktree, ['rev-parse', '--is-inside-work-tree']) !== 'true') return { ok: false as const, error: 'worktree_not_git' }
  if (!readChangedFilePaths(source.worktree).length) return { ok: false as const, error: 'no_diff', patch: getPatch(db, source.taskId) }

  const command: RunnerCommand = {
    executable: 'northstar',
    args: [],
    display: 'northstar refresh patch artifact',
    provider: 'northstar',
    cwd: source.worktree,
    basePath: source.basePath,
    mode: 'patch',
  }
  const finalText = source.finalText || `Northstar refreshed local patch artifact for ${source.taskId}.`
  const checks = runVerification(source.worktree)
  const patch = buildPatchArtifact(source.worktree, finalText, checks)
  if (!patch.filesChanged) return { ok: false as const, error: 'no_diff', patch: getPatch(db, source.taskId) }

  savePatchArtifact(db, command, { runId: source.runId, taskId: source.taskId, project: { id: source.projectId }, model: source.model }, patch)
  upsertPatchReviewInbox(db, source, command, patch, checks)
  return { ok: true as const, task: source.taskId, patch: getPatch(db, source.taskId), checks, filesChanged: patch.filesChanged }
}

function savePatchArtifact(
  db: DatabaseSync,
  command: RunnerCommand,
  context: { runId: string; taskId: string; project: Pick<LocalProject, 'id'>; model: DispatchModel },
  patch: PatchArtifact,
) {
  const branch = gitText(command.cwd, ['branch', '--show-current']) || `agent/${context.taskId.toLowerCase()}`
  const base = gitText(command.cwd, ['rev-parse', '--short', 'HEAD']) || 'HEAD'
  db.prepare(
    `INSERT INTO patches
      (task_id, run_id, project_id, base_path, branch, base, worktree, summary, additions, deletions, files_changed, checks_json, files_json, diff_json, rationale_json, risks_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(task_id) DO UPDATE SET
       run_id = excluded.run_id,
       project_id = excluded.project_id,
       base_path = excluded.base_path,
       branch = excluded.branch,
       base = excluded.base,
       worktree = excluded.worktree,
       summary = excluded.summary,
       additions = excluded.additions,
       deletions = excluded.deletions,
       files_changed = excluded.files_changed,
       checks_json = excluded.checks_json,
       files_json = excluded.files_json,
       diff_json = excluded.diff_json,
       rationale_json = excluded.rationale_json,
       risks_json = excluded.risks_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    context.taskId,
    context.runId,
    context.project.id,
    command.basePath,
    branch,
    base,
    command.cwd,
    patch.summary,
    patch.additions,
    patch.deletions,
    patch.filesChanged,
    JSON.stringify(patch.checks),
    JSON.stringify(patch.files),
    JSON.stringify(patch.diff),
    JSON.stringify(patch.rationale),
    JSON.stringify(patch.risks),
  )
}

function findPatchRefreshSource(db: DatabaseSync, projects: LocalProject[], taskId: string): PatchRefreshSource | null {
  const patchRow = (taskId === 'latest'
    ? db
        .prepare(
          `SELECT
            p.task_id AS taskId,
            p.run_id AS runId,
            p.project_id AS projectId,
            p.base_path AS basePath,
            p.worktree,
            COALESCE(ar.model, 'spark') AS model,
            COALESCE(ar.final_text, p.summary, '') AS finalText
           FROM patches p
           LEFT JOIN agent_runs ar ON ar.id = p.run_id
           ORDER BY datetime(p.updated_at) DESC
           LIMIT 1`,
        )
        .get()
    : db
        .prepare(
          `SELECT
            p.task_id AS taskId,
            p.run_id AS runId,
            p.project_id AS projectId,
            p.base_path AS basePath,
            p.worktree,
            COALESCE(ar.model, 'spark') AS model,
            COALESCE(ar.final_text, p.summary, '') AS finalText
           FROM patches p
           LEFT JOIN agent_runs ar ON ar.id = p.run_id
           WHERE p.task_id = ?
           ORDER BY datetime(p.updated_at) DESC
           LIMIT 1`,
        )
        .get(taskId)) as
    | {
        taskId: string
        runId: string
        projectId: string
        basePath: string
        worktree: string
        model: DispatchModel
        finalText: string
      }
    | undefined

  if (patchRow) return hydratePatchRefreshSource(projects, patchRow)

  const runRow = (taskId === 'latest'
    ? db
        .prepare(
          `SELECT
            id AS runId,
            task_id AS taskId,
            project_id AS projectId,
            model,
            COALESCE(NULLIF(base_path, ''), '') AS basePath,
            COALESCE(NULLIF(worktree_path, ''), NULLIF(cwd, ''), '') AS worktree,
            COALESCE(final_text, stdout, stderr, '') AS finalText
           FROM agent_runs
           WHERE task_id IS NOT NULL
             AND COALESCE(NULLIF(worktree_path, ''), NULLIF(cwd, ''), '') != ''
           ORDER BY datetime(updated_at) DESC
           LIMIT 1`,
        )
        .get()
    : db
        .prepare(
          `SELECT
            id AS runId,
            task_id AS taskId,
            project_id AS projectId,
            model,
            COALESCE(NULLIF(base_path, ''), '') AS basePath,
            COALESCE(NULLIF(worktree_path, ''), NULLIF(cwd, ''), '') AS worktree,
            COALESCE(final_text, stdout, stderr, '') AS finalText
           FROM agent_runs
           WHERE task_id = ?
             AND COALESCE(NULLIF(worktree_path, ''), NULLIF(cwd, ''), '') != ''
           ORDER BY datetime(updated_at) DESC
           LIMIT 1`,
        )
        .get(taskId)) as
    | {
        runId: string
        taskId: string
        projectId: string
        model: DispatchModel
        basePath: string
        worktree: string
        finalText: string
      }
    | undefined

  return runRow ? hydratePatchRefreshSource(projects, runRow) : null
}

function hydratePatchRefreshSource(
  projects: LocalProject[],
  row: {
    taskId: string
    runId: string
    projectId: string
    basePath: string
    worktree: string
    model: DispatchModel
    finalText: string
  },
): PatchRefreshSource {
  const project = projects.find((item) => item.id === row.projectId)
  const projectBase = project?.localExists && project.path && !project.path.startsWith('github:') ? project.path : ''
  return {
    taskId: row.taskId,
    runId: row.runId || `REFRESH-${row.taskId}`,
    projectId: row.projectId,
    projectName: project?.name ?? row.projectId,
    model: row.model ?? 'spark',
    basePath: row.basePath || projectBase,
    worktree: row.worktree,
    finalText: row.finalText,
  }
}

function upsertPatchReviewInbox(
  db: DatabaseSync,
  source: PatchRefreshSource,
  command: RunnerCommand,
  patch: PatchArtifact,
  checks: CheckResult[],
) {
  const failed = checks.some((check) => check.state === 'fail')
  const inbox = inboxForRun(source.model, source.projectName, source.taskId, failed ? 'blocked' : 'done', source.finalText, '', command, patch, checks, false)
  db.prepare(
    `INSERT INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       model = excluded.model,
       priority = excluded.priority,
       urgency = excluded.urgency,
       title = excluded.title,
       ctx = excluded.ctx,
       options_json = excluded.options_json,
       recommend = excluded.recommend,
       help = excluded.help,
       resolved_at = NULL,
       resolution = NULL`,
  ).run(
    inbox.id,
    source.projectId,
    source.taskId,
    inbox.type,
    source.model,
    inbox.priority,
    inbox.urgency,
    inbox.title,
    inbox.ctx,
    JSON.stringify(inbox.options),
    inbox.help,
  )
}

function runVerification(worktreePath: string): CheckResult[] {
  const packagePath = join(worktreePath, 'package.json')
  if (!existsSync(packagePath)) return [runCommandCheck(worktreePath, 'git diff', 'git', ['diff', '--check'])]

  const pkg = readPackageJson(packagePath)
  const scripts = pkg?.scripts ?? {}
  const checks: CheckResult[] = []
  if (!existsSync(join(worktreePath, 'node_modules'))) {
    checks.push(runCommandCheck(worktreePath, existsSync(join(worktreePath, 'package-lock.json')) ? 'npm ci' : 'npm install', 'npm', [existsSync(join(worktreePath, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts'], 180000))
  }
  if (scripts.build) checks.push(runCommandCheck(worktreePath, 'npm run build', 'npm', ['run', 'build'], 240000))
  if (scripts.test && !String(scripts.test).includes('no test specified')) checks.push(runCommandCheck(worktreePath, 'npm test', 'npm', ['test'], 180000))
  if (scripts.lint) checks.push(runCommandCheck(worktreePath, 'npm run lint', 'npm', ['run', 'lint'], 180000))
  checks.push(runCommandCheck(worktreePath, 'git diff --check', 'git', ['diff', '--check']))
  return checks
}

function runCommandCheck(cwd: string, name: string, executable: string, args: string[], timeout = 120000): CheckResult {
  const started = Date.now()
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: sanitizedEnv(), timeout, maxBuffer: 1024 * 1024 })
  const output = `${result.stderr}${result.stdout}`.trim().replace(/\s+/g, ' ')
  const detail = result.error?.message || output.slice(0, 180) || (result.status === 0 ? 'passed' : 'failed')
  return { name, state: result.status === 0 ? 'pass' : 'fail', ms: Date.now() - started, detail }
}

function buildPatchArtifact(worktreePath: string, finalText: string, checks: CheckResult[]): PatchArtifact {
  const files = readPatchFiles(worktreePath)
  const additions = files.reduce((sum, file) => sum + file.add, 0)
  const deletions = files.reduce((sum, file) => sum + file.del, 0)
  const diffText = buildPreviewDiff(worktreePath)
  const rationale = finalText
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((line) => line.length > 12 && !line.toLowerCase().startsWith('learning candidate:'))
    .slice(0, 5)
  return {
    summary: firstSentence(finalText) || `${files.length} file${files.length === 1 ? '' : 's'} changed by agent run`,
    additions,
    deletions,
    filesChanged: files.length,
    checks,
    files,
    diff: parseUnifiedDiff(diffText),
    rationale: rationale.length ? rationale : ['Agent completed the requested local worktree pass.'],
    risks: riskFromChecks(checks, files.length),
  }
}

function readPatchFiles(worktreePath: string): PatchFile[] {
  const statusByPath = new Map(gitLines(worktreePath, ['diff', '--name-status', 'HEAD']).map((line) => {
    const [status, ...pathParts] = line.split('\t')
    return [pathParts.join('\t'), status] as const
  }))
  const tracked = gitLines(worktreePath, ['diff', '--numstat', 'HEAD']).map((line) => {
    const [add, del, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    const status = statusByPath.get(path)
    const patchStatus: PatchFile['status'] = status?.startsWith('A') ? 'new' : status?.startsWith('D') ? 'del-partial' : 'mod'
    return {
      path,
      add: Number(add) || 0,
      del: Number(del) || 0,
      status: patchStatus,
    }
  })
  const trackedPaths = new Set(tracked.map((file) => file.path))
  const untracked = readUntrackedFiles(worktreePath)
    .filter((path) => !trackedPaths.has(path))
    .map((path) => ({ path, add: countFileLines(join(worktreePath, path)), del: 0, status: 'new' as const }))
  return [...tracked, ...untracked]
}

function readChangedFilePaths(worktreePath: string) {
  return Array.from(new Set([...gitLines(worktreePath, ['diff', '--name-only', 'HEAD']), ...readUntrackedFiles(worktreePath)]))
}

function readUntrackedFiles(worktreePath: string) {
  return gitLines(worktreePath, ['ls-files', '--others', '--exclude-standard'])
}

function buildPreviewDiff(worktreePath: string) {
  return [
    gitText(worktreePath, ['diff', '--unified=3', '--no-ext-diff', 'HEAD'], 1024 * 1024),
    ...readUntrackedFiles(worktreePath).map((path) => gitTextWithStatuses(worktreePath, ['diff', '--no-index', '--unified=3', '--no-ext-diff', '--', '/dev/null', path], [0, 1], 256 * 1024)),
  ].filter(Boolean).join('\n')
}

function buildApplyDiff(worktreePath: string) {
  const diff = [
    gitText(worktreePath, ['diff', '--binary', 'HEAD'], 10 * 1024 * 1024),
    ...readUntrackedFiles(worktreePath).map((path) => gitTextWithStatuses(worktreePath, ['diff', '--binary', '--no-index', '--', '/dev/null', path], [0, 1], 2 * 1024 * 1024)),
  ].filter(Boolean).join('\n')
  return diff ? `${diff}\n` : ''
}

function countFileLines(path: string) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length ? text.split('\n').length : 0
  } catch {
    return 0
  }
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
      oldLine = Number(match?.[1] ?? 0)
      newLine = Number(match?.[2] ?? 0)
      lines.push({ t: 'hunk', s: match?.[3]?.trim() || line.replace(/^@@|@@$/g, '').trim() })
      continue
    }
    if (line.startsWith('+')) {
      lines.push({ t: 'add', n2: newLine++, s: line.slice(1) })
    } else if (line.startsWith('-')) {
      lines.push({ t: 'del', n1: oldLine++, s: line.slice(1) })
    } else if (line.length) {
      lines.push({ t: 'ctx', n1: oldLine++, n2: newLine++, s: line.startsWith(' ') ? line.slice(1) : line })
    }
    if (lines.length >= 700) break
  }
  return lines
}

function inboxForRun(
  model: DispatchModel,
  projectName: string,
  taskId: string,
  status: RunStatus,
  finalText: string,
  stderr: string,
  command: RunnerCommand,
  patch: PatchArtifact | null,
  checks: CheckResult[],
  needsInput: boolean,
) {
  const failed = checks.filter((check) => check.state === 'fail')
  if (patch && patch.filesChanged > 0) {
    return {
      id: `RUN-REVIEW-${taskId}`,
      type: 'review' as const,
      priority: failed.length ? 'P1' as const : 'P2' as const,
      urgency: failed.length ? 'high' as const : 'med' as const,
      title: `${modelLabel(model)} patch ${failed.length ? 'needs attention' : 'ready'} for ${projectName}`,
      ctx: [
        `What changed: ${patch.summary}`,
        `Why: ${teachingWhy(finalText)}`,
        `Learn: ${teachingLesson(patch, failed.length > 0)}`,
        `Verify: ${failed.length ? `Failed checks: ${failed.map((check) => check.name).join(', ')}.` : 'Verification passed.'} ${patch.filesChanged} files changed, +${patch.additions}/-${patch.deletions}.`,
      ].join(' '),
      options: failed.length ? ['Open patch review', 'Ask agent to fix checks', 'Pause'] : reviewOptions(model, status),
      help: reviewHelp(model, command.cwd),
    }
  }
  return {
    id: `RUN-QUESTION-${taskId}`,
    type: needsInput ? 'question' as const : 'blocked' as const,
    priority: 'P1' as const,
    urgency: 'high' as const,
    title: `${modelLabel(model)} needs direction for ${projectName}`,
    ctx: [
      `What happened: ${firstSentence(finalText) || firstSentence(stderr) || 'The agent did not produce a patch.'}`,
      'Why it stopped: Northstar needs a human decision before continuing safely.',
      'Learn: this is the point where project intent matters more than code execution.',
    ].join(' '),
    options: ['Answer clarification', 'Retry with more context', 'Pause'],
    help: command.mode === 'plan' ? reviewHelp(model, command.cwd) : `No reviewable diff was produced in ${command.cwd}.`,
  }
}

function teachingWhy(finalText: string) {
  const lines = finalText.split('\n').map((line) => line.trim()).filter(Boolean)
  const whyLine = lines.find((line) => /^why[:\s-]/i.test(line) || /because|so that|chosen|approach/i.test(line))
  return (whyLine ?? firstSentence(finalText) ?? 'The agent chose the smallest scoped change it could verify locally.').replace(/^why[:\s-]*/i, '').slice(0, 260)
}

function teachingLesson(patch: PatchArtifact, hasFailedChecks: boolean) {
  if (hasFailedChecks) return 'Read the failed checks first; they usually explain whether the issue is implementation, environment, or missing context.'
  if (patch.filesChanged <= 3) return 'Small patches are easier to trust: inspect the changed files, then connect each diff to the stated goal.'
  return 'Larger patches need review by system boundary: scan files by feature area before approving the whole change.'
}

function requiresHumanInput(finalText: string, hasPatch: boolean) {
  if (hasPatch) return false
  const text = finalText.toLowerCase()
  return /need(s)? (clarification|direction|input|approval)|question for kyle|blocked|cannot proceed|please clarify/.test(text)
}

function riskFromChecks(checks: CheckResult[], filesChanged: number) {
  const failed = checks.filter((check) => check.state === 'fail')
  if (failed.length) return failed.map((check) => ({ level: 'high' as const, text: `${check.name} failed: ${check.detail ?? 'see run output'}` })).slice(0, 4)
  if (filesChanged > 12) return [{ level: 'med' as const, text: 'Large patch surface; review changed files before applying locally.' }]
  return [{ level: 'low' as const, text: 'Verification completed without failing checks.' }]
}

function firstSentence(value: string) {
  return value.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0]?.slice(0, 220) ?? ''
}

function readPackageJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> }
  } catch {
    return null
  }
}

function gitLines(cwd: string, args: string[]) {
  return gitText(cwd, args).split('\n').map((line) => line.trim()).filter(Boolean)
}

function gitText(cwd: string, args: string[], maxBuffer = 1024 * 1024) {
  return gitTextWithStatuses(cwd, args, [0], maxBuffer)
}

function gitTextWithStatuses(cwd: string, args: string[], okStatuses: number[], maxBuffer = 1024 * 1024) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: sanitizedEnv(), maxBuffer })
  return okStatuses.includes(result.status ?? -1) ? result.stdout.trim() : ''
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function withRunAttachCommand<T extends Record<string, unknown>>(row: T) {
  const tmuxSession = typeof row.tmuxSession === 'string' && row.tmuxSession ? row.tmuxSession : ''
  return {
    ...row,
    attachCommand: tmuxSession ? tmuxAttachCommand(tmuxSession) : null,
  }
}

function resolveTmuxExecutable(): TmuxExecutable {
  const configured = process.env.NORTHSTAR_TMUX_BIN?.trim()
  if (configured) {
    const result = spawnSync(configured, ['-V'], { encoding: 'utf8', env: sanitizedEnv() })
    if (result.status === 0) return { ok: true, executable: configured, version: commandOutput(result) }
    return {
      ok: false,
      error: `tmux_unavailable: NORTHSTAR_TMUX_BIN is set to ${configured}, but Northstar could not execute it. Install tmux with \`brew install tmux\` or set NORTHSTAR_TMUX_BIN to a working binary.`,
    }
  }

  const found = spawnSync('/bin/sh', ['-lc', 'command -v tmux'], { encoding: 'utf8', env: sanitizedEnv() })
  const executable = found.status === 0 ? found.stdout.trim().split('\n')[0] : ''
  if (!executable) {
    return {
      ok: false,
      error: 'tmux_unavailable: tmux is required for agent dispatch. Install it with `brew install tmux` or set NORTHSTAR_TMUX_BIN to a working tmux binary.',
    }
  }

  const version = spawnSync(executable, ['-V'], { encoding: 'utf8', env: sanitizedEnv() })
  if (version.status !== 0) {
    return {
      ok: false,
      error: `tmux_unavailable: ${executable} exists but did not run successfully. Install tmux with \`brew install tmux\` or set NORTHSTAR_TMUX_BIN.`,
    }
  }
  return { ok: true, executable, version: commandOutput(version) }
}

function isTmuxSessionAlive(tmuxExecutable: string, session: string) {
  const result = spawnSync(tmuxExecutable, ['has-session', '-t', session], { encoding: 'utf8', env: sanitizedEnv() })
  return result.status === 0
}

function sendTmuxInterrupt(tmuxExecutable: string, session: string) {
  const result = spawnSync(tmuxExecutable, ['send-keys', '-t', session, 'C-c'], { encoding: 'utf8', env: sanitizedEnv() })
  return result.status === 0
}

function killTmuxSession(tmuxExecutable: string, session: string) {
  const result = spawnSync(tmuxExecutable, ['kill-session', '-t', session], { encoding: 'utf8', env: sanitizedEnv() })
  return result.status === 0
}

function tmuxSessionName(taskId: string, runId: string) {
  return `northstar-${safeFileStem(taskId)}-${runId.slice(0, 8)}`.slice(0, 96)
}

function tmuxAttachCommand(session: string) {
  const executable = process.env.NORTHSTAR_TMUX_BIN?.trim() || 'tmux'
  return `${shellQuote(executable)} attach -t ${shellQuote(session)}`
}

function readExitStatus(path?: string | null) {
  if (!path || !existsSync(path)) return null
  const value = Number(readTextFile(path).trim().split('\n')[0])
  return Number.isInteger(value) ? value : null
}

function readTextFile(path?: string | null) {
  if (!path || !existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function getRunStatus(db: DatabaseSync, runId: string) {
  return (db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status?: RunStatus } | undefined)?.status
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`.trim()
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function escapeShellDouble(value: string) {
  return value.replace(/["\\$`]/g, (char) => `\\${char}`)
}

function appendRunOutput(db: DatabaseSync, runId: string, column: 'stdout' | 'stderr', text: string) {
  db.prepare(`UPDATE agent_runs SET ${column} = COALESCE(${column}, '') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(text, runId)
}

function markRunBlocked(
  db: DatabaseSync,
  row: Pick<RunningRunRow, 'id' | 'taskId'>,
  detail: { finalText: string; stderrNote: string; stage: string; exitCode: number },
) {
  db.prepare(
    `UPDATE agent_runs
     SET status = 'blocked',
       stderr = CASE
         WHEN length(trim(COALESCE(stderr, ''))) = 0 THEN ?
         ELSE COALESCE(stderr, '') || char(10) || ?
       END,
       final_text = CASE
         WHEN length(trim(COALESCE(final_text, ''))) = 0 THEN ?
         ELSE COALESCE(final_text, '') || char(10) || char(10) || ?
       END,
       exit_code = COALESCE(exit_code, ?),
       updated_at = CURRENT_TIMESTAMP,
       completed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'running'`,
  ).run(detail.stderrNote, detail.stderrNote, detail.finalText, detail.finalText, detail.exitCode, row.id)

  if (row.taskId) {
    db.prepare(
      `UPDATE tasks
       SET status = 'blocked', progress = 0.2, eta = 'paused', stage = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status != 'done'`,
    ).run(detail.stage, row.taskId)
  }
}

function isRunStillRunning(db: DatabaseSync, runId: string) {
  const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status?: RunStatus } | undefined
  return row?.status === 'running'
}

function normalizePid(pid: number | null) {
  const value = Number(pid)
  return Number.isInteger(value) && value > 0 ? value : null
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeErrno(error, 'EPERM')
  }
}

function signalRunProcess(pid: number, signal: NodeJS.Signals) {
  const targets = process.platform === 'win32' ? [pid] : [-pid, pid]
  for (const target of targets) {
    try {
      process.kill(target, signal)
      return { ok: true, target }
    } catch (error) {
      if (!isNodeErrno(error, 'ESRCH')) continue
    }
  }
  return { ok: false, target: null }
}

function signalExitCode(signal: NodeJS.Signals | null) {
  if (!signal) return null
  const signalNumbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
    SIGKILL: 9,
  }
  return 128 + (signalNumbers[signal] ?? 1)
}

function isNodeErrno(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function prepareWorktree(repoPath: string, projectId: string, taskId: string) {
  const projectRoot = join(worktreeRoot, safeFileStem(projectId))
  mkdirSync(projectRoot, { recursive: true })
  const worktreePath = join(projectRoot, taskId)
  const branch = `agent/${taskId.toLowerCase()}`
  const result = spawnSync('git', ['worktree', 'add', '-f', '-b', branch, worktreePath, 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf8',
    env: sanitizedEnv(),
  })
  if (result.status !== 0) {
    const detail = `${result.stderr}${result.stdout}`.trim()
    throw new Error(detail || `Unable to create worktree ${worktreePath}`)
  }
  return worktreePath
}

function buildRunnerCommand(model: DispatchModel, prompt: string, project: LocalProject, basePath: string, worktreePath: string, runId: string, scopeContext: string): RunnerCommand {
  if (model === 'opus') return buildClaudeCommand(prompt, project, basePath, worktreePath, scopeContext)
  return buildCodexCommand(model, prompt, project, basePath, worktreePath, runId, scopeContext)
}

function buildClaudeCommand(prompt: string, project: LocalProject, basePath: string, worktreePath: string, scopeContext: string): RunnerCommand {
  const fullPrompt = buildPromptEnvelope(prompt, project, 'Use plan mode only. Do not edit files. Do not run destructive commands.', scopeContext)
  const args = [
    '--print',
    '--output-format',
    'json',
    '--model',
    'opus',
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    fullPrompt,
  ]
  return {
    executable: resolveCliExecutable('claude') ?? 'claude',
    args,
    display: `claude ${args.slice(0, -1).join(' ')} <prompt>`,
    provider: 'claude-cli',
    cwd: worktreePath,
    basePath,
    mode: 'plan',
  }
}

function buildCodexCommand(model: Exclude<DispatchModel, 'opus'>, prompt: string, project: LocalProject, basePath: string, worktreePath: string, runId: string, scopeContext: string): RunnerCommand {
  const codexModel = model === 'spark' ? codexSparkModel : codexReservedModel
  const finalTextPath = join(logRoot, `${runId}.final.txt`)
  const policy =
    model === 'spark'
      ? 'Edit files inside this isolated git worktree. Do as much useful implementation work as you can without asking Kyle unless blocked by missing product intent, credentials, or a risky architectural decision. Run relevant checks when possible and keep output concise.'
      : 'Edit files inside this isolated git worktree. This is the reserved GPT-5.5 lane for high-value manual work. Do as much useful implementation work as possible, avoid destructive commands, and ask only for clarifications that genuinely block progress.'
  const fullPrompt = buildPromptEnvelope(prompt, project, policy, scopeContext)
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--model',
    codexModel,
    '--sandbox',
    'workspace-write',
    '--cd',
    worktreePath,
    '--output-last-message',
    finalTextPath,
  ]
  return {
    executable: resolveCliExecutable('codex') ?? 'codex',
    args,
    display: `codex --ask-for-approval never exec --json --model ${codexModel} --sandbox workspace-write --cd ${worktreePath} --output-last-message ${finalTextPath} <stdin>`,
    provider: 'codex-cli',
    cwd: worktreePath,
    basePath,
    mode: 'patch',
    finalTextPath,
    stdin: fullPrompt,
  }
}

function buildPromptEnvelope(prompt: string, project: LocalProject, policy: string, scopeContext: string) {
  const skills = readProjectSkills(project)
  return [
    `You are running inside Northstar for project ${project.name}.`,
    `Project skills file: ${project.skillsPath}`,
    policy,
    scopeContext,
    'Northstar will independently inspect the git diff and run local verification after you exit. Leave the worktree with your best complete patch, or clearly state the one question that blocks progress.',
    'Use the project skills below as durable local context. If you discover a durable project-specific lesson, include a line starting with "Learning candidate:" in the final plan; Northstar will review and store it in the project skills file.',
    'Return concise output that Northstar can turn into an inbox teaching summary: what you did, why you chose that approach, what Kyle can learn from it, verification status, blockers, and the smallest useful next question if you need more context.',
    skills ? `\nCurrent project skills:\n${skills}` : '',
    '',
    prompt,
  ].join('\n')
}

function parseFinalText(model: DispatchModel, stdout: string, stderr: string, finalTextPath?: string) {
  if (model === 'opus') return parseClaudeJsonResult(stdout) || stdout.trim() || stderr.trim()
  return readFinalTextFile(finalTextPath) || parseCodexJsonlResult(stdout) || stdout.trim() || stderr.trim()
}

function parseClaudeJsonResult(stdout: string) {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>
    const result = value.result ?? value.response ?? value.text
    return typeof result === 'string' ? result.trim() : ''
  } catch {
    return ''
  }
}

function parseCodexJsonlResult(stdout: string) {
  const messages: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      collectStrings(JSON.parse(line), messages)
    } catch {
      continue
    }
  }
  return messages.at(-1)?.trim() ?? ''
}

function collectStrings(value: unknown, messages: string[]) {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const item = typeof record.item === 'object' && record.item ? (record.item as Record<string, unknown>) : record
  const type = item.type
  const role = item.role
  for (const key of ['text', 'content', 'message', 'final_response', 'last_message']) {
    const text = item[key]
    if (typeof text === 'string' && (role === 'assistant' || type === 'agent_message' || type === 'message' || key !== 'content')) messages.push(text)
  }
}

function readFinalTextFile(path?: string) {
  if (!path || !existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function reviewOptions(model: DispatchModel, status: RunStatus) {
  if (status !== 'done') return ['Open run log', 'Fix auth or model issue', 'Discard']
  if (model === 'opus') return ['Accept as next plan', 'Ask Claude for more detail', 'Discard']
  if (model === 'spark') return ['Accept Spark plan', 'Escalate to GPT-5.5', 'Discard']
  return ['Accept GPT-5.5 plan', 'Convert to queued patch', 'Discard']
}

function reviewHelp(model: DispatchModel, cwd: string) {
  if (model === 'opus') return `Claude Code ran in plan mode inside ${cwd}. No files were changed by this dispatch.`
  return `${modelLabel(model)} ran through Codex CLI in an isolated writable worktree at ${cwd}. No commit or push was performed.`
}

function modelLabel(model: DispatchModel) {
  if (model === 'opus') return 'Claude'
  if (model === 'spark') return 'Spark'
  return 'GPT-5.5'
}

function pickProject(projects: LocalProject[], projectContext?: string) {
  if (projectContext && projectContext !== 'active' && projectContext !== 'all') return projects.find((project) => project.id === projectContext)
  if (projectContext === 'all') return projects.find((project) => project.id === 'northstar' && project.localExists) ?? projects.find((project) => project.localExists)
  return projects.find((project) => project.active && project.localExists) ?? projects.find((project) => project.id === 'northstar') ?? projects.find((project) => project.localExists)
}

function buildScopeContext(projects: LocalProject[], projectContext: string | undefined, dispatchProject: LocalProject) {
  if (projectContext === 'all') {
    const projectLines = projects.slice(0, 60).map(formatProjectScopeLine)
    const omitted = projects.length > projectLines.length ? `\n- ...${projects.length - projectLines.length} more projects omitted from this prompt.` : ''
    return [
      'Command scope: all known projects, including GitHub-linked projects. Use this as a broad search and activation-advice context.',
      `Dispatch worktree: ${dispatchProject.name}. Do not assume this is the only target project.`,
      'Known project inventory:',
      `${projectLines.join('\n')}${omitted}`,
    ].join('\n')
  }

  if (projectContext === 'active' || !projectContext) {
    const activeProjects = projects.filter((project) => project.active)
    if (!activeProjects.length) return `Command scope: active projects. No active projects are currently marked, so dispatch is running from ${dispatchProject.name}.`
    return ['Command scope: active projects.', ...activeProjects.map(formatProjectScopeLine)].join('\n')
  }

  return `Command scope: selected project ${dispatchProject.name} (${dispatchProject.id}).`
}

function formatProjectScopeLine(project: LocalProject) {
  const source = project.github ? `github:${project.github.fullName}` : project.localExists ? `local:${project.path}` : 'github-only'
  const state = project.active ? 'active' : 'inactive'
  return `- ${project.name} (${project.id}) ${state}; ${source}; status:${project.status}; branch:${project.branch}`
}

function ensureProjectRow(db: DatabaseSync, project: LocalProject) {
  db.prepare(
    `INSERT INTO projects
      (id, name, path, branch, lang, status, label, health, coverage, tokens, budget, runtime, last_event, last_ago)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       path = excluded.path,
       branch = excluded.branch,
       lang = excluded.lang,
       status = excluded.status,
       label = excluded.label,
       health = excluded.health,
       coverage = excluded.coverage,
       tokens = excluded.tokens,
       budget = excluded.budget,
       runtime = excluded.runtime,
       last_event = excluded.last_event,
       last_ago = excluded.last_ago`,
  ).run(
    project.id,
    project.name,
    project.path,
    project.branch,
    project.lang,
    project.status,
    project.label,
    project.health,
    project.coverage,
    project.tokens,
    project.budget,
    project.runtime,
    project.lastEvent,
    project.lastAgo,
  )
}

function expandHome(path: string) {
  if (path === '~') return process.env.HOME ?? path
  if (path.startsWith('~/')) return join(process.env.HOME ?? '', path.slice(2))
  return path
}

function safeFileStem(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/(^-|-$)/g, '') || 'project'
}

function cleanTaskId(value?: string) {
  const trimmed = value?.trim()
  if (!trimmed) return ''
  return trimmed.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 120)
}
