import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { checkNoApiGuardrails, sanitizedEnv } from './guardrails.js'
import { logRoot, worktreeRoot } from './paths.js'
import { appendProjectLearning, ensureProjectSkillsFile, extractLearningCandidates, readProjectSkills } from './projectSkills.js'
import type { LocalProject } from './projects.js'

type DispatchModel = 'opus' | 'spark' | 'codex'
type RunStatus = 'running' | 'done' | 'blocked'

type RunnerCommand = {
  executable: string
  args: string[]
  display: string
  provider: string
  cwd: string
  finalTextPath?: string
  stdin?: string
}

export type DispatchRequest = {
  model?: DispatchModel
  prompt?: string
  projectContext?: string
}

export type DispatchResult =
  | {
      ok: true
      task: { id: string; projectId: string; model: DispatchModel; status: RunStatus }
      run: { id: string; status: RunStatus; finalText: string; exitCode: number | null; worktreePath: string }
    }
  | { ok: false; blocked?: boolean; error: string; guardrails?: ReturnType<typeof checkNoApiGuardrails> }

const maxParallelRuns = Number(process.env.NORTHSTAR_MAX_RUNS ?? 4)
const codexSparkModel = process.env.NORTHSTAR_CODEX_SPARK_MODEL ?? 'gpt-5.3-codex-spark'
const codexReservedModel = process.env.NORTHSTAR_CODEX_RESERVED_MODEL ?? 'gpt-5.5'

export function listRuns(db: DatabaseSync) {
  return db
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
    .all()
}

export function getRun(db: DatabaseSync, id: string) {
  return (
    db
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
      .get(id) ?? null
  )
}

export function dispatchAgent(db: DatabaseSync, projects: LocalProject[], request: DispatchRequest): DispatchResult {
  const model = request.model ?? 'opus'
  const prompt = request.prompt?.trim()
  if (!prompt) return { ok: false, error: 'Prompt is required before dispatch.' }

  const guardrails = checkNoApiGuardrails()
  if (!guardrails.ok) return { ok: false, blocked: true, error: 'Strict no-API guardrails blocked dispatch.', guardrails }

  const running = db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE status = 'running'").get() as { count: number }
  if (running.count >= maxParallelRuns) return { ok: false, error: `All ${maxParallelRuns} Northstar agent slots are busy.` }

  const project = pickProject(projects, request.projectContext)
  if (!project) return { ok: false, error: 'No local project is available for dispatch.' }
  if (!project.localExists || project.path.startsWith('github:')) return { ok: false, error: `${project.name} is GitHub-only. Clone it locally before dispatch.` }

  const repoPath = expandHome(project.path)
  if (!existsSync(join(repoPath, '.git'))) return { ok: false, error: `${project.name} is not a local git checkout.` }

  ensureProjectSkillsFile(project)

  const taskId = `RUN-${Date.now().toString(36)}`
  const runId = randomUUID()
  let worktreePath = ''
  try {
    worktreePath = prepareWorktree(repoPath, project.id, taskId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create agent worktree.'
    return { ok: false, error: message }
  }
  const command = buildRunnerCommand(model, prompt, project, worktreePath, runId)

  ensureProjectRow(db, project)
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch)
     VALUES (?, ?, ?, ?, ?, 'running', 'P2', 0.05, 'now', ?, 0, ?)`,
  ).run(taskId, project.id, prompt.slice(0, 80), model, command.provider, `${modelLabel(model)} running`, `agent/${taskId.toLowerCase()}`)

  db.prepare(
    `INSERT INTO agent_runs (id, task_id, project_id, model, provider, command, cwd, worktree_path, status, prompt, stdout, stderr, final_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, '', '', '')`,
  ).run(runId, taskId, project.id, model, command.provider, command.display, command.cwd, worktreePath, prompt)

  startBackgroundRun(db, command, { runId, taskId, project, model })

  return {
    ok: true,
    task: { id: taskId, projectId: project.id, model, status: 'running' },
    run: { id: runId, status: 'running', finalText: '', exitCode: null, worktreePath },
  }
}

function startBackgroundRun(
  db: DatabaseSync,
  command: RunnerCommand,
  context: { runId: string; taskId: string; project: LocalProject; model: DispatchModel },
) {
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: sanitizedEnv(),
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
  child.on('close', (code) => {
    if (finished) return
    finished = true
    finishRun(db, command, context, code ?? 0, stdout, stderr, false)
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
  const finalText = parseFinalText(context.model, stdout, stderr, command.finalTextPath)
  const status: RunStatus = !forceBlocked && exitCode === 0 ? 'done' : 'blocked'
  const stage = status === 'done' ? `${modelLabel(context.model)} complete` : `${modelLabel(context.model)} blocked`

  extractLearningCandidates(finalText).forEach((note) => appendProjectLearning(context.project, note, `agent-run:${context.taskId}`))

  db.prepare(
    `UPDATE agent_runs
     SET status = ?, stdout = ?, stderr = ?, final_text = ?, exit_code = ?, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(status, stdout, stderr, finalText, exitCode, context.runId)
  db.prepare('UPDATE tasks SET status = ?, progress = ?, stage = ? WHERE id = ?').run(status, status === 'done' ? 1 : 0.2, stage, context.taskId)

  db.prepare(
    `INSERT OR IGNORE INTO inbox_actions
      (id, project_id, task_id, type, model, priority, urgency, title, ctx, options_json, recommend, help)
     VALUES (?, ?, ?, 'review', ?, 'P2', ?, ?, ?, ?, 0, ?)`,
  ).run(
    `RUN-REVIEW-${context.taskId}`,
    context.project.id,
    context.taskId,
    context.model,
    status === 'done' ? 'med' : 'high',
    `${modelLabel(context.model)} ${status === 'done' ? 'run ready' : 'run needs attention'} for ${context.project.name}`,
    finalText.slice(0, 1200) || stderr.slice(0, 1200) || 'The CLI process finished without visible output.',
    JSON.stringify(reviewOptions(context.model, status)),
    reviewHelp(context.model, command.cwd),
  )
}

function appendRunOutput(db: DatabaseSync, runId: string, column: 'stdout' | 'stderr', text: string) {
  db.prepare(`UPDATE agent_runs SET ${column} = COALESCE(${column}, '') || ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(text, runId)
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

function buildRunnerCommand(model: DispatchModel, prompt: string, project: LocalProject, worktreePath: string, runId: string): RunnerCommand {
  if (model === 'opus') return buildClaudeCommand(prompt, project, worktreePath)
  return buildCodexCommand(model, prompt, project, worktreePath, runId)
}

function buildClaudeCommand(prompt: string, project: LocalProject, worktreePath: string): RunnerCommand {
  const fullPrompt = buildPromptEnvelope(prompt, project, 'Use plan mode only. Do not edit files. Do not run destructive commands.')
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
    executable: 'claude',
    args,
    display: `claude ${args.slice(0, -1).join(' ')} <prompt>`,
    provider: 'claude-cli',
    cwd: worktreePath,
  }
}

function buildCodexCommand(model: Exclude<DispatchModel, 'opus'>, prompt: string, project: LocalProject, worktreePath: string, runId: string): RunnerCommand {
  const codexModel = model === 'spark' ? codexSparkModel : codexReservedModel
  const finalTextPath = join(logRoot, `${runId}.final.txt`)
  const policy =
    model === 'spark'
      ? 'Use read-only mode. Be fast and concrete. Do not modify files; return the next safest implementation plan, blockers, and any question needed from Kyle.'
      : 'Use read-only mode. This is the reserved GPT-5.5 lane for high-value manual work. Do not modify files; return a careful plan, risks, and exact next steps.'
  const fullPrompt = buildPromptEnvelope(prompt, project, policy)
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--model',
    codexModel,
    '--sandbox',
    'read-only',
    '--cd',
    worktreePath,
    '--output-last-message',
    finalTextPath,
  ]
  return {
    executable: 'codex',
    args,
    display: `codex --ask-for-approval never exec --json --model ${codexModel} --sandbox read-only --cd ${worktreePath} --output-last-message ${finalTextPath} <stdin>`,
    provider: 'codex-cli',
    cwd: worktreePath,
    finalTextPath,
    stdin: fullPrompt,
  }
}

function buildPromptEnvelope(prompt: string, project: LocalProject, policy: string) {
  const skills = readProjectSkills(project)
  return [
    `You are running inside Northstar for project ${project.name}.`,
    `Project skills file: ${project.skillsPath}`,
    policy,
    'Use the project skills below as durable local context. If you discover a durable project-specific lesson, include a line starting with "Learning candidate:" in the final plan; Northstar will review and store it in the project skills file.',
    'Return concise output that Northstar can show in a queue card: result, blockers, and the next question if you need more context.',
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
  return `${modelLabel(model)} ran through Codex CLI in read-only mode inside ${cwd}. No files were changed by this dispatch.`
}

function modelLabel(model: DispatchModel) {
  if (model === 'opus') return 'Claude'
  if (model === 'spark') return 'Spark'
  return 'GPT-5.5'
}

function pickProject(projects: LocalProject[], projectContext?: string) {
  if (projectContext && projectContext !== 'active') return projects.find((project) => project.id === projectContext)
  return projects.find((project) => project.active && project.localExists) ?? projects.find((project) => project.id === 'northstar') ?? projects.find((project) => project.localExists)
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
