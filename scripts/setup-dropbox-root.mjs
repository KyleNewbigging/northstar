import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const explicitRoot = process.env.NORTHSTAR_DROPBOX_ROOT?.trim()
const repoPath = process.env.NORTHSTAR_REPO_PATH?.trim() || process.cwd()
const project = cleanProjectName(process.env.NORTHSTAR_PROJECT || 'northstar')
const device = cleanDeviceName(process.env.NORTHSTAR_DEVICE_ID || hostname() || 'macbook')
const extraDevice = cleanDeviceName(process.env.NORTHSTAR_OTHER_DEVICE || 'apartment-pc')

const candidates = [
  explicitRoot,
  join(homedir(), 'Dropbox'),
  join(homedir(), 'Library', 'CloudStorage', 'Dropbox'),
  join(homedir(), 'Dropbox (Personal)'),
  join(homedir(), 'Dropbox (Business)'),
].filter(Boolean)

const root = candidates.find((candidate) => existsSync(candidate))

if (!root) {
  console.error([
    'Dropbox root not found yet.',
    '',
    'Finish Dropbox Desktop sign-in, then run one of:',
    '  npm run setup:dropbox',
    '  NORTHSTAR_DROPBOX_ROOT="$HOME/Library/CloudStorage/Dropbox" npm run setup:dropbox',
    '  NORTHSTAR_DROPBOX_ROOT="$HOME/Dropbox" npm run setup:dropbox',
  ].join('\n'))
  process.exitCode = 1
} else {
  const rootPath = resolve(root)
  const projectRoot = join(rootPath, 'projects', project)
  const created = []

  ensureDir(join(rootPath, '_handoffs', device), created)
  ensureDir(join(rootPath, '_handoffs', extraDevice), created)
  ensureDir(projectRoot, created)
  ensureDir(join(projectRoot, '.claude'), created)
  ensureDir(join(projectRoot, 'handoffs'), created)
  ensureDir(join(projectRoot, 'resources'), created)
  ensureDir(join(projectRoot, 'sessions'), created)
  ensureDir(join(projectRoot, 'skills'), created)

  ensureFile(join(projectRoot, 'CLAUDE.md'), claudeTemplate(project, repoPath), created)
  ensureFile(join(projectRoot, 'AGENTS.md'), agentsTemplate(project, repoPath), created)
  ensureFile(join(projectRoot, 'agent-profile.md'), agentProfileTemplate(project, repoPath), created)
  ensureFile(join(projectRoot, 'implementation.md'), implementationTemplate(project, repoPath), created)
  ensureFile(join(projectRoot, '.claude', 'README.md'), dotClaudeTemplate(project), created)

  if (!existsSync(join(rootPath, 'heartbeat.md'))) {
    writeFileSync(join(rootPath, 'heartbeat.md'), heartbeatTemplate(device), { mode: 0o600 })
    created.push('heartbeat.md')
  }

  console.log(JSON.stringify({
    ok: true,
    root: rootPath,
    project,
    projectRoot,
    created,
    next: [
      `NORTHSTAR_DROPBOX_ROOT="${rootPath}" NORTHSTAR_DEVICE_ID=${device} npm run dev:server`,
      `curl -s http://127.0.0.1:4317/api/device-files/status`,
    ],
  }, null, 2))
}

function ensureDir(path, created) {
  if (existsSync(path)) return
  mkdirSync(path, { recursive: true, mode: 0o700 })
  created.push(relativeToRoot(path))
}

function ensureFile(path, content, created) {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
  created.push(relativeToRoot(path))
}

function relativeToRoot(path) {
  return path.replace(`${resolve(root)}/`, '')
}

function cleanProjectName(value) {
  return String(value).trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()?.replace(/\.git$/, '').replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 96) || 'northstar'
}

function cleanDeviceName(value) {
  return String(value).trim().replace(/[^0-9A-Za-z_.-]/g, '-').replace(/-+/g, '-').slice(0, 64) || 'device'
}

function claudeTemplate(project, repoPath) {
  return [
    `# Claude Project Memory: ${project}`,
    '',
    'This Dropbox project folder stores project-adjacent Claude/agent memory and resources. It is not the git checkout.',
    '',
    '## Boundaries',
    '',
    '- Keep code history, branches, worktrees, patches, commits, pushes, and PRs in git/GitHub.',
    '- Keep session handoffs, implementation notes, reusable resources, skills, and agent-facing context here.',
    '- Do not copy large repo artifacts into this folder unless they are explicit supporting resources.',
    '- Do not touch global Claude/agent roots that store rules, auth state, or JSON logs.',
    '',
    '## Repo',
    '',
    `- Name: ${project}`,
    `- Local checkout: ${repoPath}`,
    '',
    '## Northstar Project Agent',
    '',
    `- Agent identity: ${project} project agent.`,
    '- Source order: repo AGENTS.md, this CLAUDE.md, implementation.md, handoffs/resources/sessions, then generated skills mirrors.',
    '- Use this file for durable project memory: product constraints, user preferences, recurring commands, and known traps.',
    '- Keep implementation edits in the local git checkout or isolated Northstar worktree; keep Dropbox for support files and handoffs.',
    '- For coding work, prefer `/use PROJECT codex orchestrator`; use `spark personal` for quick planning and `opus` as plan-only unless Northstar changes that contract.',
    '- When blocked, ask the smallest useful question and offer two or three concrete options.',
    '',
  ].join('\n')
}

function agentsTemplate(project, repoPath) {
  return [
    `# Agent Project Guide: ${project}`,
    '',
    'Use this Dropbox folder for project-scoped agent instructions, handoffs, skills, and resources.',
    '',
    `- Local checkout: ${repoPath}`,
    '- Repo sync remains GitHub.',
    '- Session/support sync uses this Dropbox root.',
    '',
    '## Northstar Agent Contract',
    '',
    '- One run means one queued task, one isolated worktree, and one local CLI process.',
    '- Inspect current state before acting: git status, live queue state, project-local instructions, and the newest concise handoff when available.',
    '- Merge duplicate continuation requests instead of creating more queue noise; repeated identical scan files are a loop signal.',
    '- Agents may create patches, notes, and questions; they do not push or commit without explicit user approval.',
    '- Final summaries should teach: what changed, why that approach was chosen, what the user can learn, verification status, blockers, and the smallest next decision.',
    '',
  ].join('\n')
}

function agentProfileTemplate(project, repoPath) {
  return [
    `# Project Agent Profile: ${project}`,
    '',
    'This file names the default agent identity for the Dropbox project workspace. Keep it short enough for future agents to scan quickly.',
    '',
    '## Identity',
    '',
    `- Project: ${project}`,
    `- Local checkout: ${repoPath}`,
    '- Default lane: codex orchestrator for implementation, spark personal for short planning, opus for plan-only review.',
    '',
    '## Responsibilities',
    '',
    '- Keep project-specific memory close to this workspace.',
    '- Preserve boundaries between git-owned source code and Dropbox-owned support artifacts.',
    '- Turn Telegram requests into concrete queue work, patch artifacts, handoffs, or concise questions.',
    '- Explain results in a way that helps the operator decide the next action.',
    '',
    '## Review Gates',
    '',
    '- Risky operations stay gated: patch apply, commits, pushes, deletes, and reserved model dispatch.',
    '- Private runtime data belongs under ~/.northstar, not in this Dropbox folder or the repo.',
    '',
  ].join('\n')
}

function implementationTemplate(project, repoPath) {
  return [
    `# ${project} Implementation`,
    '',
    'This is the rolling high-level implementation plan for the project. Keep it useful, compact, and current.',
    '',
    '## Context',
    '',
    `- Repo checkout: ${repoPath}`,
    '- Dropbox folder: this project workspace.',
    '',
    '## Northstar Orchestration Notes',
    '',
    '- Keep the top three next implementation decisions current enough for Telegram and future agents to resume without replaying old threads.',
    '- Prefer updating existing handoffs or notes when queue state has not materially changed.',
    '- Record durable lessons as `Learning candidate:` lines in agent final summaries so Northstar can review them for the project skills file.',
    '',
    '## Next Steps',
    '',
    '- Decide the next task.',
    '',
  ].join('\n')
}

function dotClaudeTemplate(project) {
  return [
    `# .claude Project Folder: ${project}`,
    '',
    'Use this folder only for project-scoped Claude/agent support files that are safe to sync through Dropbox.',
    '',
    'Global Claude/agent roots may contain auth state, logs, rules, and machine-specific data. Northstar should not move or edit those global roots.',
    '',
  ].join('\n')
}

function heartbeatTemplate(device) {
  return [
    '# Northstar Heartbeat',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Device: ${device}`,
    'Status: Dropbox root initialized. Start Northstar to keep this file live.',
    '',
  ].join('\n')
}
