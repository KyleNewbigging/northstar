import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { readGraphStats } from './graphify.js'
import { GithubRepoSummary, loadGithubCatalog, parseGithubRemote } from './github.js'
import { defaultDevRoot } from './paths.js'
import { summarizeProjectSkills, type ProjectSkillSummary } from './projectSkills.js'

export type LocalProject = {
  id: string
  name: string
  path: string
  branch: string
  lang: string
  status: 'running' | 'needs-input' | 'queued' | 'blocked' | 'done' | 'idle'
  label: 'work' | 'personal'
  health: number
  agentsActive: number
  openTasks: number
  queued: number
  commits24: number
  linesNet: string
  coverage: number
  tokens: number
  budget: number
  runtime: string
  nodes: number
  communities: number
  lastEvent: string
  lastAgo: string
  spark: number[]
  source: 'local' | 'github' | 'manual'
  localExists: boolean
  graphReady: boolean
  skillsPath: string
  skillsReady: boolean
  skillsUpdatedAt: string | null
  learnedItems: number
  active: boolean
  autonomous: boolean
  cadence: 'slow' | 'paused'
  remote?: string
  dirtyFiles: number
  behind?: number
  github?: {
    owner: string
    repo: string
    fullName: string
    url: string
    cloneUrl: string
    defaultBranch?: string
    visibility?: 'public' | 'private' | 'internal' | 'unknown'
    archived?: boolean
  }
}

export type ProjectAutomationState = {
  active: boolean
  autonomous: boolean
  cadence?: 'slow' | 'paused'
}

type ProjectWithoutSkills = Omit<LocalProject, keyof ProjectSkillSummary>

export function discoverProjects(root = defaultDevRoot, automation = new Map<string, ProjectAutomationState>()): LocalProject[] {
  const localProjects = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .filter((dir) => existsSync(join(dir, '.git')))
      .map((dir, index) => describeRepo(dir, index))
    : []
  const localGithubKeys = new Set(localProjects.map((project) => project.github?.fullName.toLowerCase()).filter((key): key is string => Boolean(key)))
  const githubOnlyProjects = loadGithubCatalog()
    .filter((repo) => !localGithubKeys.has(repo.fullName.toLowerCase()))
    .map((repo, index) => describeGithubRepo(repo, localProjects.length + index))

  return [...localProjects, ...githubOnlyProjects]
    .map((project) => applyAutomation(project, automation.get(project.id)))
    .sort((a, b) =>
    Number(b.active) - Number(a.active) ||
    Number(b.status === 'needs-input') - Number(a.status === 'needs-input') ||
    Number(b.localExists) - Number(a.localExists) ||
    a.name.localeCompare(b.name)
    )
}

function describeRepo(dir: string, index: number): LocalProject {
  const name = basename(dir)
  const branch = git(dir, ['branch', '--show-current']) || 'main'
  const statusLines = (git(dir, ['status', '--short']) || '').split('\n').filter(Boolean)
  const remote = (git(dir, ['remote', 'get-url', 'origin']) || '').trim()
  const behindMatch = (git(dir, ['status', '--short', '--branch']) || '').match(/behind (\d+)/)
  const behind = behindMatch ? Number(behindMatch[1]) : 0
  const commits24 = Number(git(dir, ['rev-list', '--count', '--since=24 hours ago', 'HEAD']) || '0')
  const graphStats = readGraphStats(dir)
  const lang = detectLanguage(dir)
  const dirtyFiles = statusLines.length
  const needsAttention = dirtyFiles > 0 || behind > 0
  const github = parseGithubRemote(remote)
  const label = inferLabel(name, remote)
  const health = Math.max(0.48, Math.min(0.98, 0.92 - dirtyFiles * 0.035 - behind * 0.015 + (graphStats.nodes > 0 ? 0.04 : 0)))
  const status = needsAttention ? 'needs-input' : graphStats.nodes > 0 ? 'idle' : 'queued'

  const project: ProjectWithoutSkills = {
    id: slug(name),
    name,
    path: dir.replace(process.env.HOME ?? '', '~'),
    branch,
    lang,
    status,
    label,
    health,
    agentsActive: status === 'needs-input' ? 1 : 0,
    openTasks: dirtyFiles + (behind > 0 ? 1 : 0) + (graphStats.nodes === 0 ? 1 : 0),
    queued: graphStats.nodes === 0 ? 1 : 0,
    commits24,
    linesNet: gitDiffSummary(dir),
    coverage: graphStats.nodes > 0 ? 0.76 : 0.42,
    tokens: 42000 + graphStats.nodes * 22 + dirtyFiles * 9000,
    budget: 500000,
    runtime: dirtyFiles ? 'needs review' : '-',
    nodes: graphStats.nodes || 120 + index * 63,
    communities: graphStats.communities || 4 + (index % 5),
    lastEvent: lastEvent(dirtyFiles, behind, graphStats.nodes),
    lastAgo: dirtyFiles ? 'now' : behind ? 'sync' : 'idle',
    spark: makeSpark(name, dirtyFiles, behind),
    source: 'local',
    localExists: true,
    graphReady: graphStats.nodes > 0,
    active: false,
    autonomous: false,
    cadence: 'paused',
    remote,
    dirtyFiles,
    behind,
    github: github ? githubInfo(github) : undefined,
  }
  return { ...project, ...summarizeProjectSkills(project) }
}

function describeGithubRepo(repo: GithubRepoSummary, index: number): LocalProject {
  const graphStats = { nodes: 0, communities: 0 }
  const visibility = repo.visibility === 'unknown' ? 'GitHub' : `GitHub ${repo.visibility}`
  const project: ProjectWithoutSkills = {
    id: slug(repo.fullName),
    name: repo.name,
    path: `github:${repo.fullName}`,
    branch: repo.defaultBranch,
    lang: 'GitHub repo',
    status: repo.archived ? 'idle' : 'queued',
    label: inferLabel(repo.name, repo.url),
    health: repo.archived ? 0.58 : 0.74,
    agentsActive: 0,
    openTasks: repo.archived ? 0 : 1,
    queued: repo.archived ? 0 : 1,
    commits24: 0,
    linesNet: '+0 / -0',
    coverage: 0.24,
    tokens: 26000 + index * 500,
    budget: 500000,
    runtime: repo.archived ? 'archived' : 'not cloned',
    nodes: 80 + index * 19,
    communities: graphStats.communities || 3 + (index % 4),
    lastEvent: repo.archived ? `${visibility} archived` : `${visibility} not cloned locally`,
    lastAgo: 'github',
    spark: makeSpark(repo.fullName, 0, 0),
    source: 'github',
    localExists: false,
    graphReady: false,
    active: false,
    autonomous: false,
    cadence: 'paused',
    remote: repo.cloneUrl,
    dirtyFiles: 0,
    behind: 0,
    github: githubInfo(repo),
  }
  return { ...project, ...summarizeProjectSkills(project) }
}

function applyAutomation(project: LocalProject, state?: ProjectAutomationState): LocalProject {
  if (!state?.active) return { ...project, active: false, autonomous: false, cadence: 'paused' }
  const autonomous = state.autonomous !== false
  return {
    ...project,
    active: true,
    autonomous,
    cadence: state.cadence ?? 'slow',
    status: project.status === 'needs-input' || project.status === 'blocked' ? project.status : 'running',
    agentsActive: Math.max(project.agentsActive, autonomous ? 1 : 0),
    queued: Math.max(project.queued, autonomous ? 1 : 0),
    openTasks: Math.max(project.openTasks, autonomous ? 1 : 0),
    runtime: autonomous ? 'autonomous slow' : project.runtime,
    lastEvent: project.status === 'needs-input' || project.status === 'blocked' ? project.lastEvent : 'autonomous progress enabled',
    lastAgo: project.status === 'needs-input' || project.status === 'blocked' ? project.lastAgo : 'slow',
  }
}

function git(cwd: string, args: string[]) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function detectLanguage(dir: string) {
  if (existsSync(join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
      if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return 'Vue/TypeScript'
      if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'React/TypeScript'
    } catch {
      return 'TypeScript'
    }
    return 'TypeScript'
  }
  if (existsSync(join(dir, 'pubspec.yaml'))) return 'Flutter/Dart'
  if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust'
  if (existsSync(join(dir, 'go.mod'))) return 'Go'
  if (existsSync(join(dir, 'pyproject.toml'))) return 'Python'
  return 'Repo'
}

function inferLabel(name: string, remote: string): 'work' | 'personal' {
  const value = `${name} ${remote}`.toLowerCase()
  return value.includes('zebra') || value.includes('cullenta') || value.includes('wiki') ? 'work' : 'personal'
}

function gitDiffSummary(dir: string) {
  const stat = git(dir, ['diff', '--shortstat'])
  const insertions = Number(stat.match(/(\d+) insertion/)?.[1] ?? 0)
  const deletions = Number(stat.match(/(\d+) deletion/)?.[1] ?? 0)
  return `+${insertions} / -${deletions}`
}

function lastEvent(dirtyFiles: number, behind: number, graphNodes: number) {
  if (dirtyFiles) return `${dirtyFiles} local file${dirtyFiles === 1 ? '' : 's'} changed`
  if (behind) return `behind origin by ${behind}`
  if (!graphNodes) return 'graphify snapshot missing'
  return 'graph snapshot ready'
}

function githubInfo(repo: GithubRepoSummary) {
  return {
    owner: repo.owner,
    repo: repo.name,
    fullName: repo.fullName,
    url: repo.url,
    cloneUrl: repo.cloneUrl,
    defaultBranch: repo.defaultBranch,
    visibility: repo.visibility,
    archived: repo.archived,
  }
}

function makeSpark(name: string, dirtyFiles: number, behind: number) {
  const base = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5
  return Array.from({ length: 12 }, (_, index) => Math.max(1, base + index + dirtyFiles * 2 - behind + (index % 3)))
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
