import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { defaultDevRoot } from './paths.js'

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
  remote?: string
  dirtyFiles: number
  behind?: number
}

export function discoverProjects(root = defaultDevRoot): LocalProject[] {
  if (!existsSync(root)) return []

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, '.git')))
    .map((dir, index) => describeRepo(dir, index))
    .sort((a, b) => Number(b.status === 'needs-input') - Number(a.status === 'needs-input') || a.name.localeCompare(b.name))
}

function describeRepo(dir: string, index: number): LocalProject {
  const name = basename(dir)
  const branch = git(dir, ['branch', '--show-current']) || 'main'
  const statusLines = (git(dir, ['status', '--short']) || '').split('\n').filter(Boolean)
  const remote = (git(dir, ['remote', 'get-url', 'origin']) || '').trim()
  const behindMatch = (git(dir, ['status', '--short', '--branch']) || '').match(/behind (\d+)/)
  const behind = behindMatch ? Number(behindMatch[1]) : 0
  const commits24 = Number(git(dir, ['rev-list', '--count', '--since=24 hours ago', 'HEAD']) || '0')
  const graphPath = join(dir, 'graphify-out', 'graph.json')
  const graphStats = readGraphStats(graphPath)
  const lang = detectLanguage(dir)
  const dirtyFiles = statusLines.length
  const needsAttention = dirtyFiles > 0 || behind > 0
  const label = inferLabel(name, remote)
  const health = Math.max(0.48, Math.min(0.98, 0.92 - dirtyFiles * 0.035 - behind * 0.015 + (graphStats.nodes > 0 ? 0.04 : 0)))
  const status = needsAttention ? 'needs-input' : graphStats.nodes > 0 ? 'idle' : 'queued'

  return {
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
    remote,
    dirtyFiles,
    behind,
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

function readGraphStats(path: string) {
  if (!existsSync(path)) return { nodes: 0, communities: 0 }
  try {
    const graph = JSON.parse(readFileSync(path, 'utf8')) as { nodes?: unknown[]; communities?: unknown[] }
    return { nodes: graph.nodes?.length ?? 0, communities: graph.communities?.length ?? 0 }
  } catch {
    return { nodes: 0, communities: 0 }
  }
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

function makeSpark(name: string, dirtyFiles: number, behind: number) {
  const base = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5
  return Array.from({ length: 12 }, (_, index) => Math.max(1, base + index + dirtyFiles * 2 - behind + (index % 3)))
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}
