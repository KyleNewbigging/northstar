import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export type DeviceFileKind = 'directory' | 'file' | 'symlink' | 'other'

export type DeviceFilesStatus = {
  ok: true
  configured: boolean
  rootExists: boolean
  rootPath: string
  rootSource: 'env' | 'auto' | 'default'
  projectsRelPath: string
  currentDevice: string
  handoffsPath: string | null
  env: {
    root: 'NORTHSTAR_DROPBOX_ROOT'
    device: 'NORTHSTAR_DEVICE_ID'
  }
  guidance: string
}

export type DeviceFileEntry = {
  name: string
  relPath: string
  kind: DeviceFileKind
  size: number | null
  modifiedAt: string | null
}

export type DeviceFileError = {
  ok: false
  error: string
  detail: string
  status: DeviceFilesStatus
}

export type DeviceFileListResult =
  | {
      ok: true
      status: DeviceFilesStatus
      relPath: string
      entries: DeviceFileEntry[]
      truncated: boolean
    }
  | DeviceFileError

export type DeviceFileSearchResult =
  | {
      ok: true
      status: DeviceFilesStatus
      query: string
      results: DeviceFileEntry[]
      visited: number
      truncated: boolean
    }
  | DeviceFileError

export type DeviceFilePreviewResult =
  | {
      ok: true
      status: DeviceFilesStatus
      entry: DeviceFileEntry
      preview: string | null
      previewable: boolean
      truncated: boolean
    }
  | DeviceFileError

export type DeviceHandoffResult =
  | {
      ok: true
      status: DeviceFilesStatus
      id: string
      targetDevice: string
      sourceRelPath: string
      handoffRelPath: string
      handoffPath: string
    }
  | DeviceFileError

export type DeviceHandoffEntry = {
  id: string
  relPath: string
  path: string
  targetDevice: string
  modifiedAt: string | null
  summary: string
}

export type DeviceHandoffListResult =
  | {
      ok: true
      status: DeviceFilesStatus
      targetDevice: string
      handoffs: DeviceHandoffEntry[]
    }
  | DeviceFileError

export type ProjectWorkspaceResult =
  | {
      ok: true
      status: DeviceFilesStatus
      project: string
      relPath: string
      path: string
      created: string[]
      files: {
        claude: string
        agents: string
        implementation: string
        dotClaude: string
        resources: string
        handoffs: string
        skills: string
        sessions: string
      }
    }
  | DeviceFileError

export type ProjectResourceResult =
  | {
      ok: true
      status: DeviceFilesStatus
      project: string
      relPath: string
      path: string
    }
  | DeviceFileError

export type DeviceFileActions = {
  status: () => DeviceFilesStatus
  list: (input?: { path?: string; limit?: number; includeHidden?: boolean }) => DeviceFileListResult
  search: (input: { query?: string; limit?: number; maxVisited?: number }) => DeviceFileSearchResult
  preview: (input: { path?: string; maxChars?: number }) => DeviceFilePreviewResult
  createHandoff: (input: { targetDevice?: string; path?: string; note?: string }) => DeviceHandoffResult
  listHandoffs: (input?: { targetDevice?: string; limit?: number }) => DeviceHandoffListResult
  ensureProjectWorkspace: (input: { project?: string; repoPath?: string; note?: string }) => ProjectWorkspaceResult
  saveProjectResource: (input: { project?: string; title?: string; content?: string }) => ProjectResourceResult
}

type RootResolution = {
  rootPath: string
  rootSource: DeviceFilesStatus['rootSource']
}

type RequiredRoot =
  | {
      ok: true
      status: DeviceFilesStatus
      rootRealPath: string
    }
  | DeviceFileError

const textPreviewExtensions = new Set([
  '.csv',
  '.json',
  '.jsonl',
  '.log',
  '.md',
  '.mdx',
  '.qmd',
  '.txt',
  '.tsv',
  '.yaml',
  '.yml',
])

const ignoredSearchNames = new Set(['.DS_Store', '.git', 'node_modules'])

export function createDeviceFileActions(db: DatabaseSync): DeviceFileActions {
  return {
    status: () => getDeviceFilesStatus(),
    list: (input) => listDeviceFiles(input),
    search: (input) => searchDeviceFiles(input),
    preview: (input) => previewDeviceFile(input),
    createHandoff: (input) => createDeviceHandoff(db, input),
    listHandoffs: (input) => listDeviceHandoffs(input),
    ensureProjectWorkspace: (input) => ensureProjectWorkspace(input),
    saveProjectResource: (input) => saveProjectResource(input),
  }
}

export function getDeviceFilesStatus(): DeviceFilesStatus {
  const root = resolveDropboxRoot()
  const rootExists = existsSync(root.rootPath)
  return {
    ok: true,
    configured: rootExists,
    rootExists,
    rootPath: root.rootPath,
    rootSource: root.rootSource,
    projectsRelPath: 'projects',
    currentDevice: currentDeviceId(),
    handoffsPath: rootExists ? join(root.rootPath, '_handoffs') : null,
    env: {
      root: 'NORTHSTAR_DROPBOX_ROOT',
      device: 'NORTHSTAR_DEVICE_ID',
    },
    guidance: rootExists
      ? 'Dropbox local file bridge is ready. Use relative paths inside the Dropbox root.'
      : 'Set NORTHSTAR_DROPBOX_ROOT to the local Dropbox folder on this machine.',
  }
}

export function listDeviceFiles(input: { path?: string; limit?: number; includeHidden?: boolean } = {}): DeviceFileListResult {
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const target = resolveExistingRelPath(root.rootRealPath, input.path)
  if (!target.ok) return fileError(target.error, target.detail, root.status)
  if (target.kind !== 'directory') return fileError('not_a_directory', `${target.relPath || '.'} is not a directory.`, root.status)

  const limit = clampInt(input.limit, 1, 100, 50)
  const allEntries = readdirSync(target.realPath, { withFileTypes: true })
    .filter((entry) => input.includeHidden === true || !entry.name.startsWith('.'))
    .map((entry) => describeEntry(root.rootRealPath, join(target.realPath, entry.name), entry.name))
    .sort(entrySort)

  return {
    ok: true,
    status: root.status,
    relPath: target.relPath,
    entries: allEntries.slice(0, limit),
    truncated: allEntries.length > limit,
  }
}

export function searchDeviceFiles(input: { query?: string; limit?: number; maxVisited?: number }): DeviceFileSearchResult {
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const query = input.query?.trim()
  if (!query) return fileError('query_required', 'Usage: provide a filename or path search query.', root.status)
  if (query.length < 2) return fileError('query_too_short', 'Search queries must be at least 2 characters.', root.status)

  const limit = clampInt(input.limit, 1, 50, 20)
  const maxVisited = clampInt(input.maxVisited, 100, 25_000, 5000)
  const needle = query.toLowerCase()
  const results: DeviceFileEntry[] = []
  const stack: Array<{ path: string; depth: number }> = [{ path: root.rootRealPath, depth: 0 }]
  let visited = 0
  let truncated = false

  while (stack.length && results.length < limit && visited < maxVisited) {
    const current = stack.pop()
    if (!current) break
    visited += 1
    let entries: string[]
    try {
      entries = readdirSync(current.path)
    } catch {
      continue
    }

    for (const name of entries) {
      if (shouldSkipSearchName(name)) continue
      const fullPath = join(current.path, name)
      const relPath = toRelPath(root.rootRealPath, fullPath)
      const entry = describeEntry(root.rootRealPath, fullPath, name)
      if (relPath.toLowerCase().includes(needle)) results.push(entry)
      if (results.length >= limit) break
      if (entry.kind === 'directory' && current.depth < 8) stack.push({ path: fullPath, depth: current.depth + 1 })
    }
  }

  if (stack.length || visited >= maxVisited) truncated = true
  return { ok: true, status: root.status, query, results, visited, truncated }
}

export function previewDeviceFile(input: { path?: string; maxChars?: number }): DeviceFilePreviewResult {
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const target = resolveExistingRelPath(root.rootRealPath, input.path)
  if (!target.ok) return fileError(target.error, target.detail, root.status)
  if (target.kind !== 'file') return fileError('not_a_file', `${target.relPath || '.'} is not a previewable file.`, root.status)

  const entry = describeEntry(root.rootRealPath, target.realPath, basename(target.realPath))
  const maxChars = clampInt(input.maxChars, 200, 12_000, 3000)
  const ext = extname(target.realPath).toLowerCase()
  const previewable = textPreviewExtensions.has(ext) && Number(entry.size ?? 0) <= 512_000
  if (!previewable) return { ok: true, status: root.status, entry, preview: null, previewable: false, truncated: false }

  const text = readFileSync(target.realPath, 'utf8')
  if (text.includes('\u0000')) return { ok: true, status: root.status, entry, preview: null, previewable: false, truncated: false }
  return {
    ok: true,
    status: root.status,
    entry,
    preview: text.slice(0, maxChars),
    previewable: true,
    truncated: text.length > maxChars,
  }
}

export function createDeviceHandoff(db: DatabaseSync, input: { targetDevice?: string; path?: string; note?: string }): DeviceHandoffResult {
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const targetDevice = cleanDeviceId(input.targetDevice)
  if (!targetDevice) return fileError('target_device_required', 'Usage: provide the receiving device name.', root.status)

  const source = resolveExistingRelPath(root.rootRealPath, input.path)
  if (!source.ok) return fileError(source.error, source.detail, root.status)

  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')}-${randomUUID().slice(0, 8)}`
  const handoffDir = join(root.rootRealPath, '_handoffs', targetDevice)
  mkdirSync(handoffDir, { recursive: true })

  const handoffPath = join(handoffDir, `${id}.md`)
  const handoffRelPath = toRelPath(root.rootRealPath, handoffPath)
  const note = input.note?.trim()
  const sourceEntry = describeEntry(root.rootRealPath, source.realPath, basename(source.realPath))
  writeFileSync(handoffPath, buildHandoffMarkdown({
    id,
    fromDevice: root.status.currentDevice,
    targetDevice,
    sourceRelPath: source.relPath,
    sourceEntry,
    note,
  }), { flag: 'wx', mode: 0o600 })

  recordDeviceFileEvent(db, 'handoff_created', root.status.currentDevice, targetDevice, source.relPath, {
    id,
    handoffRelPath,
    note: note ?? '',
  })

  return { ok: true, status: root.status, id, targetDevice, sourceRelPath: source.relPath, handoffRelPath, handoffPath }
}

export function listDeviceHandoffs(input: { targetDevice?: string; limit?: number } = {}): DeviceHandoffListResult {
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const targetDevice = cleanDeviceId(input.targetDevice) || root.status.currentDevice
  const handoffDir = join(root.rootRealPath, '_handoffs', targetDevice)
  const limit = clampInt(input.limit, 1, 50, 20)
  if (!existsSync(handoffDir)) return { ok: true, status: root.status, targetDevice, handoffs: [] }

  const handoffs = readdirSync(handoffDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const path = join(handoffDir, name)
      const stats = safeStat(path)
      return {
        id: name.replace(/\.md$/, ''),
        relPath: toRelPath(root.rootRealPath, path),
        path,
        targetDevice,
        modifiedAt: stats ? stats.mtime.toISOString() : null,
        summary: readHandoffSummary(path),
      }
    })
    .sort((a, b) => Date.parse(b.modifiedAt ?? '') - Date.parse(a.modifiedAt ?? ''))
    .slice(0, limit)

  return { ok: true, status: root.status, targetDevice, handoffs }
}

export function ensureProjectWorkspace(input: { project?: string; repoPath?: string; note?: string }): ProjectWorkspaceResult {
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const project = cleanProjectId(input.project)
  if (!project) return fileError('project_required', 'Usage: provide a project or repo name.', root.status)

  const projectDir = join(root.rootRealPath, 'projects', project)
  const created: string[] = []
  const files = {
    claude: join(projectDir, 'CLAUDE.md'),
    agents: join(projectDir, 'AGENTS.md'),
    implementation: join(projectDir, 'implementation.md'),
    dotClaude: join(projectDir, '.claude'),
    resources: join(projectDir, 'resources'),
    handoffs: join(projectDir, 'handoffs'),
    skills: join(projectDir, 'skills'),
    sessions: join(projectDir, 'sessions'),
  }

  ensureDir(projectDir, root.rootRealPath, created)
  ensureDir(files.dotClaude, root.rootRealPath, created)
  ensureDir(files.resources, root.rootRealPath, created)
  ensureDir(files.handoffs, root.rootRealPath, created)
  ensureDir(files.skills, root.rootRealPath, created)
  ensureDir(files.sessions, root.rootRealPath, created)
  ensureFile(files.claude, projectTemplate('CLAUDE.md', project, input.repoPath, input.note), root.rootRealPath, created)
  ensureFile(files.agents, projectTemplate('AGENTS.md', project, input.repoPath, input.note), root.rootRealPath, created)
  ensureFile(files.implementation, implementationTemplate(project, input.repoPath), root.rootRealPath, created)
  ensureFile(join(files.dotClaude, 'README.md'), dotClaudeTemplate(project), root.rootRealPath, created)

  return {
    ok: true,
    status: root.status,
    project,
    relPath: toRelPath(root.rootRealPath, projectDir),
    path: projectDir,
    created,
    files: {
      claude: toRelPath(root.rootRealPath, files.claude),
      agents: toRelPath(root.rootRealPath, files.agents),
      implementation: toRelPath(root.rootRealPath, files.implementation),
      dotClaude: toRelPath(root.rootRealPath, files.dotClaude),
      resources: toRelPath(root.rootRealPath, files.resources),
      handoffs: toRelPath(root.rootRealPath, files.handoffs),
      skills: toRelPath(root.rootRealPath, files.skills),
      sessions: toRelPath(root.rootRealPath, files.sessions),
    },
  }
}

export function saveProjectResource(input: { project?: string; title?: string; content?: string }): ProjectResourceResult {
  const workspace = ensureProjectWorkspace({ project: input.project })
  if (!workspace.ok) return workspace
  const root = requireDropboxRoot()
  if (!root.ok) return root
  const title = input.title?.trim() || 'resource'
  const content = input.content?.trim()
  if (!content) return fileError('content_required', 'Usage: provide content to save as a project resource.', root.status)

  const filename = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')}-${slug(title)}.md`
  const path = join(root.rootRealPath, workspace.files.resources, filename)
  writeFileSync(path, [
    `# ${title}`,
    '',
    `Project: ${workspace.project}`,
    `Created: ${new Date().toISOString()}`,
    `Device: ${root.status.currentDevice}`,
    '',
    content,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 })

  return {
    ok: true,
    status: root.status,
    project: workspace.project,
    relPath: toRelPath(root.rootRealPath, path),
    path,
  }
}

function resolveDropboxRoot(): RootResolution {
  const envRoot = process.env.NORTHSTAR_DROPBOX_ROOT?.trim()
  if (envRoot) return { rootPath: resolve(expandHome(envRoot)), rootSource: 'env' }

  const candidates = [
    join(homedir(), 'Dropbox'),
    join(homedir(), 'Library', 'CloudStorage', 'Dropbox'),
    join(homedir(), 'Dropbox (Personal)'),
    join(homedir(), 'Dropbox (Business)'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  return found
    ? { rootPath: resolve(found), rootSource: 'auto' }
    : { rootPath: resolve(candidates[0]), rootSource: 'default' }
}

function requireDropboxRoot(): RequiredRoot {
  const status = getDeviceFilesStatus()
  if (!status.rootExists) return fileError('dropbox_root_missing', status.guidance, status)
  const rootRealPath = realpathSync.native(status.rootPath)
  return { ok: true, status, rootRealPath }
}

function resolveExistingRelPath(rootRealPath: string, inputPath?: string) {
  const relPath = normalizeRelPath(inputPath)
  if (!relPath.ok) return relPath
  const fullPath = resolve(rootRealPath, relPath.relPath)
  if (!isInside(rootRealPath, fullPath)) return { ok: false as const, error: 'path_outside_dropbox', detail: 'Path traversal outside the Dropbox root is blocked.' }
  if (!existsSync(fullPath)) return { ok: false as const, error: 'path_not_found', detail: `${relPath.relPath || '.'} was not found in the Dropbox root.` }

  const realPath = realpathSync.native(fullPath)
  if (!isInside(rootRealPath, realPath)) return { ok: false as const, error: 'path_outside_dropbox', detail: 'Symlink targets outside the Dropbox root are blocked.' }
  return { ok: true as const, relPath: relPath.relPath, realPath, kind: kindForPath(realPath) }
}

function normalizeRelPath(inputPath?: string) {
  const raw = String(inputPath ?? '').trim()
  if (!raw || raw === '.' || raw === '/') return { ok: true as const, relPath: '' }
  const slashPath = raw.replace(/\\/g, '/')
  if (slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) {
    return { ok: false as const, error: 'relative_path_required', detail: 'Use a relative path inside the Dropbox root, not an absolute path.' }
  }
  const relPath = posix.normalize(slashPath).replace(/^\.\//, '')
  if (relPath === '..' || relPath.startsWith('../')) {
    return { ok: false as const, error: 'path_outside_dropbox', detail: 'Path traversal outside the Dropbox root is blocked.' }
  }
  return { ok: true as const, relPath: relPath === '.' ? '' : relPath }
}

function describeEntry(rootRealPath: string, fullPath: string, fallbackName: string): DeviceFileEntry {
  const stats = safeStat(fullPath)
  return {
    name: fallbackName,
    relPath: toRelPath(rootRealPath, fullPath),
    kind: kindForPath(fullPath),
    size: stats && stats.isFile() ? stats.size : null,
    modifiedAt: stats ? stats.mtime.toISOString() : null,
  }
}

function kindForPath(path: string): DeviceFileKind {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
    return 'other'
  } catch {
    return 'other'
  }
}

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function entrySort(a: DeviceFileEntry, b: DeviceFileEntry) {
  if (a.kind === 'directory' && b.kind !== 'directory') return -1
  if (a.kind !== 'directory' && b.kind === 'directory') return 1
  return a.name.localeCompare(b.name)
}

function toRelPath(rootRealPath: string, fullPath: string) {
  const rel = relative(rootRealPath, fullPath)
  return rel.split(sep).join('/')
}

function isInside(rootPath: string, targetPath: string) {
  const rel = relative(rootPath, targetPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function shouldSkipSearchName(name: string) {
  return name.startsWith('.') || ignoredSearchNames.has(name)
}

function cleanDeviceId(value?: string) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 64)
}

function cleanProjectId(value?: string) {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()?.replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 96) ?? ''
}

function slug(value: string) {
  return cleanProjectId(value.toLowerCase()) || 'resource'
}

function currentDeviceId() {
  return cleanDeviceId(process.env.NORTHSTAR_DEVICE_ID) || cleanDeviceId(hostname()) || 'northstar-device'
}

function expandHome(path: string) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.min(max, Math.max(min, Math.round(numberValue)))
}

function fileError(error: string, detail: string, status: DeviceFilesStatus): DeviceFileError {
  return { ok: false, error, detail, status }
}

function ensureDir(path: string, rootRealPath: string, created: string[]) {
  if (existsSync(path)) return
  mkdirSync(path, { recursive: true, mode: 0o700 })
  created.push(toRelPath(rootRealPath, path))
}

function ensureFile(path: string, content: string, rootRealPath: string, created: string[]) {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
  created.push(toRelPath(rootRealPath, path))
}

function projectTemplate(kind: 'CLAUDE.md' | 'AGENTS.md', project: string, repoPath?: string, note?: string) {
  const title = kind === 'CLAUDE.md' ? 'Claude Project Memory' : 'Agent Project Guide'
  return [
    `# ${title}: ${project}`,
    '',
    'This Dropbox project folder stores project-adjacent agent memory and resources. It is not the git checkout.',
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
    `- Local checkout: ${repoPath?.trim() || 'machine-specific local clone, not Dropbox'}`,
    '',
    '## Notes',
    '',
    note?.trim() || '- Add durable project context here as it becomes useful.',
    '',
  ].join('\n')
}

function implementationTemplate(project: string, repoPath?: string) {
  return [
    `# ${project} Implementation`,
    '',
    'This is the rolling high-level implementation plan for the project. Agents should keep it useful, compact, and current.',
    '',
    '## Current Direction',
    '',
    '- Record the next meaningful implementation steps here.',
    '- Keep detailed code edits in the local git checkout and patch review flow.',
    '',
    '## Context',
    '',
    `- Repo checkout: ${repoPath?.trim() || 'machine-specific local clone, not Dropbox'}`,
    '- Dropbox folder: this project workspace.',
    '',
    '## Next Steps',
    '',
    '- Decide the next task.',
    '',
  ].join('\n')
}

function dotClaudeTemplate(project: string) {
  return [
    `# .claude Project Folder: ${project}`,
    '',
    'Use this folder only for project-scoped Claude/agent support files that are safe to sync through Dropbox.',
    '',
    'Global Claude/agent roots may contain auth state, logs, rules, and machine-specific data. Northstar should not move or edit those global roots.',
    '',
  ].join('\n')
}

function buildHandoffMarkdown(input: {
  id: string
  fromDevice: string
  targetDevice: string
  sourceRelPath: string
  sourceEntry: DeviceFileEntry
  note?: string
}) {
  return [
    '# Northstar Device Handoff',
    '',
    `- ID: ${input.id}`,
    `- From: ${input.fromDevice}`,
    `- To: ${input.targetDevice}`,
    `- Created: ${new Date().toISOString()}`,
    `- Source: ${input.sourceRelPath || '.'}`,
    `- Kind: ${input.sourceEntry.kind}`,
    input.sourceEntry.size === null ? null : `- Size: ${input.sourceEntry.size} bytes`,
    input.sourceEntry.modifiedAt ? `- Modified: ${input.sourceEntry.modifiedAt}` : null,
    '',
    '## Note',
    '',
    input.note || 'No note provided.',
    '',
    '## Device Workflow',
    '',
    'Open the Source path relative to the Dropbox root on the receiving device. Keep code history in git; use this handoff only for local device-to-device file flow.',
    '',
  ].filter((line): line is string => line !== null).join('\n')
}

function readHandoffSummary(path: string) {
  try {
    const text = readFileSync(path, 'utf8')
    const source = text.match(/^- Source: (.+)$/m)?.[1]
    const note = text.split('## Note')[1]?.split('## Device Workflow')[0]?.trim()
    return [source ? `Source: ${source}` : null, note ? note.split('\n')[0] : null].filter(Boolean).join(' · ') || basename(path)
  } catch {
    return basename(path)
  }
}

function recordDeviceFileEvent(
  db: DatabaseSync,
  eventType: string,
  deviceId: string,
  targetDevice: string | null,
  sourceRelPath: string | null,
  detail: Record<string, unknown>,
) {
  db.prepare(
    `INSERT INTO device_file_events
      (id, event_type, device_id, target_device, source_relpath, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), eventType, deviceId, targetDevice, sourceRelPath, JSON.stringify(detail))
}
