import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'

import { northstarHome } from './paths.js'

type GraphProject = {
  id: string
  name: string
  path: string
}

type RawGraphNode = {
  id: string
  label: string
  path?: string
  community: string
  kind: 'project' | 'directory' | 'file' | 'manifest' | 'dependency'
  degree?: number
  meta?: Record<string, string | number | boolean>
}

type RawGraphEdge = {
  source: string
  target: string
  type: 'contains' | 'imports' | 'depends' | 'declares' | 'uses'
  confidence: 'explicit' | 'inferred'
}

const ignoredDirs = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'graphify-out',
  'node_modules',
  'target',
  'vendor',
])

const sourceExtensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.dart',
  '.go',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.py',
  '.rs',
  '.scss',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
])

const manifestNames = new Set([
  'Cargo.toml',
  'composer.json',
  'go.mod',
  'package.json',
  'pnpm-workspace.yaml',
  'pubspec.yaml',
  'pyproject.toml',
  'requirements.txt',
  'tsconfig.json',
  'vite.config.ts',
])

const documentNames = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
])

export function readGraphifyGraph(projectPath: string) {
  const file = graphPath(projectPath)
  if (!existsSync(file)) return null
  return { source: file, graph: JSON.parse(readFileSync(file, 'utf8')) }
}

export function readGraphStats(projectPath: string) {
  const file = graphPath(projectPath)
  if (!existsSync(file)) return { nodes: 0, communities: 0 }
  try {
    const graph = JSON.parse(readFileSync(file, 'utf8')) as { nodes?: unknown[]; communities?: unknown[] }
    return { nodes: graph.nodes?.length ?? 0, communities: graph.communities?.length ?? 0 }
  } catch {
    return { nodes: 0, communities: 0 }
  }
}

export function ensureProjectGraph(project: GraphProject, options: { force?: boolean } = {}) {
  const root = expandProjectPath(project.path)
  if (!existsSync(root)) return { ok: false, status: 'project_missing' as const, path: root }

  const existingRepoGraph = repoGraphPath(root)
  if (existsSync(existingRepoGraph)) return { ok: true, status: 'existing_repo_graph' as const, path: existingRepoGraph }

  const generatedPath = generatedGraphPath(root)
  if (!options.force && existsSync(generatedPath)) return { ok: true, status: 'existing_generated_graph' as const, path: generatedPath }

  const graph = buildLocalSummaryGraph(project, root)
  mkdirSync(dirname(generatedPath), { recursive: true })
  writeFileSync(generatedPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  return { ok: true, status: 'generated_graph' as const, path: generatedPath, nodes: graph.nodes.length, edges: graph.edges.length }
}

export function ensureProjectGraphs(projects: GraphProject[]) {
  return projects.map((project) => ensureProjectGraph(project))
}

function graphPath(projectPath: string) {
  const root = expandProjectPath(projectPath)
  const repoPath = repoGraphPath(root)
  return existsSync(repoPath) ? repoPath : generatedGraphPath(root)
}

function repoGraphPath(root: string) {
  return join(root, 'graphify-out', 'graph.json')
}

function generatedGraphPath(root: string) {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 12)
  return join(northstarHome, 'graphs', `${basename(root)}-${key}`, 'graphify-out', 'graph.json')
}

function expandProjectPath(projectPath: string) {
  return projectPath.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')
}

function buildLocalSummaryGraph(project: GraphProject, root: string) {
  const files = listProjectFiles(root)
  const nodes = new Map<string, RawGraphNode>()
  const edges: RawGraphEdge[] = []
  const edgeKeys = new Set<string>()
  const dependencyNodeIds = new Map<string, string>()

  addNode(nodes, {
    id: `project:${project.id}`,
    label: project.name,
    path: '.',
    community: 'project',
    kind: 'project',
    meta: { root: root.replace(process.env.HOME ?? '', '~') },
  })

  const directories = new Set<string>()
  for (const file of files) {
    const segments = dirname(file).split(sep).filter((segment) => segment && segment !== '.')
    let current = ''
    for (const segment of segments.slice(0, 4)) {
      current = current ? join(current, segment) : segment
      directories.add(current)
    }
  }

  for (const dir of [...directories].sort().slice(0, 60)) {
    addNode(nodes, {
      id: `dir:${dir}`,
      label: dir,
      path: dir,
      community: communityForPath(dir),
      kind: 'directory',
    })
    addEdge(edges, edgeKeys, parentNodeId(project.id, dir), `dir:${dir}`, 'contains')
  }

  for (const file of files.slice(0, 180)) {
    const name = basename(file)
    const kind = manifestNames.has(name) ? 'manifest' : 'file'
    const fileNodeId = `file:${file}`
    addNode(nodes, {
      id: fileNodeId,
      label: name,
      path: file,
      community: kind === 'manifest' ? 'manifests' : communityForPath(file),
      kind,
      meta: fileMeta(root, file),
    })
    addEdge(edges, edgeKeys, parentNodeId(project.id, file), fileNodeId, 'contains')

    if (kind === 'manifest') addManifestEdges(root, file, fileNodeId, nodes, edges, edgeKeys, dependencyNodeIds)
    else addImportEdges(root, file, fileNodeId, files, nodes, edges, edgeKeys, dependencyNodeIds)
  }

  applyDegrees(nodes, edges)
  return {
    schema: 'northstar.project-summary.v1',
    generatedAt: new Date().toISOString(),
    generator: 'northstar-local-summary',
    project: { id: project.id, name: project.name, path: root.replace(process.env.HOME ?? '', '~') },
    nodes: [...nodes.values()],
    edges,
    communities: [...new Set([...nodes.values()].map((node) => node.community))].sort(),
  }
}

function listProjectFiles(root: string) {
  const gitFiles = git(root, ['ls-files'])
  const files = gitFiles
    ? gitFiles.split('\n').filter(Boolean)
    : walk(root).map((file) => relative(root, file))
  return files
    .filter((file) => isUsefulFile(file))
    .sort((a, b) => scoreFile(a) - scoreFile(b) || a.localeCompare(b))
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...walk(join(dir, entry.name)))
    } else if (entry.isFile()) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

function isUsefulFile(file: string) {
  const parts = file.split('/')
  if (parts.some((part) => ignoredDirs.has(part))) return false
  const name = basename(file)
  const extension = extname(file)
  return manifestNames.has(name) || sourceExtensions.has(extension) || documentNames.has(name)
}

function scoreFile(file: string) {
  const name = basename(file)
  if (manifestNames.has(name)) return 0
  if (documentNames.has(name)) return 1
  if (file.startsWith('src/') || file.startsWith('app/')) return 2
  if (sourceExtensions.has(extname(file))) return 3
  return 4
}

function parentNodeId(projectId: string, path: string) {
  const dir = dirname(path)
  if (!dir || dir === '.') return `project:${projectId}`
  const parts = dir.split(sep).filter(Boolean).slice(0, 4)
  return parts.length ? `dir:${parts.join(sep)}` : `project:${projectId}`
}

function addManifestEdges(
  root: string,
  file: string,
  fileNodeId: string,
  nodes: Map<string, RawGraphNode>,
  edges: RawGraphEdge[],
  edgeKeys: Set<string>,
  dependencyNodeIds: Map<string, string>,
) {
  if (basename(file) !== 'package.json') return
  try {
    const pkg = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 40)) {
      const dependencyId = dependencyNode(dependencyNodeIds, nodes, name)
      addEdge(edges, edgeKeys, fileNodeId, dependencyId, 'depends')
    }
    for (const script of Object.keys(pkg.scripts ?? {}).slice(0, 16)) {
      const id = `script:${script}`
      addNode(nodes, { id, label: script, community: 'scripts', kind: 'dependency', meta: { source: 'package.json' } })
      addEdge(edges, edgeKeys, fileNodeId, id, 'declares')
    }
  } catch {
    return
  }
}

function addImportEdges(
  root: string,
  file: string,
  fileNodeId: string,
  files: string[],
  nodes: Map<string, RawGraphNode>,
  edges: RawGraphEdge[],
  edgeKeys: Set<string>,
  dependencyNodeIds: Map<string, string>,
) {
  if (!['.js', '.jsx', '.mjs', '.ts', '.tsx'].includes(extname(file))) return
  const imports = readImports(root, file)
  for (const specifier of imports.slice(0, 24)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const target = resolveLocalImport(file, specifier, files)
      if (target) addEdge(edges, edgeKeys, fileNodeId, `file:${target}`, 'imports')
      continue
    }
    addEdge(edges, edgeKeys, fileNodeId, dependencyNode(dependencyNodeIds, nodes, packageName(specifier)), 'uses')
  }
}

function readImports(root: string, file: string) {
  try {
    const fullPath = join(root, file)
    if (statSync(fullPath).size > 300_000) return []
    const source = readFileSync(fullPath, 'utf8')
    const imports = new Set<string>()
    const patterns = [
      /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
      /export\s+[^'"]+\s+from\s+['"]([^'"]+)['"]/g,
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) imports.add(match[1])
    }
    return [...imports]
  } catch {
    return []
  }
}

function resolveLocalImport(fromFile: string, specifier: string, files: string[]) {
  const base = join(dirname(fromFile), specifier).replace(/\\/g, '/')
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    join(base, 'index.ts').replace(/\\/g, '/'),
    join(base, 'index.tsx').replace(/\\/g, '/'),
    join(base, 'index.js').replace(/\\/g, '/'),
  ]
  return candidates.find((candidate) => files.includes(candidate))
}

function dependencyNode(dependencyNodeIds: Map<string, string>, nodes: Map<string, RawGraphNode>, name: string) {
  const existing = dependencyNodeIds.get(name)
  if (existing) return existing
  const id = `dep:${name}`
  dependencyNodeIds.set(name, id)
  addNode(nodes, { id, label: name, community: 'dependencies', kind: 'dependency' })
  return id
}

function packageName(specifier: string) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function addNode(nodes: Map<string, RawGraphNode>, node: RawGraphNode) {
  if (!nodes.has(node.id)) nodes.set(node.id, node)
}

function addEdge(edges: RawGraphEdge[], edgeKeys: Set<string>, source: string, target: string, type: RawGraphEdge['type']) {
  if (source === target) return
  const key = `${source}->${target}:${type}`
  if (edgeKeys.has(key)) return
  edgeKeys.add(key)
  edges.push({ source, target, type, confidence: type === 'contains' || type === 'depends' || type === 'declares' ? 'explicit' : 'inferred' })
}

function applyDegrees(nodes: Map<string, RawGraphNode>, edges: RawGraphEdge[]) {
  const degrees = new Map<string, number>()
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1)
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1)
  }
  for (const node of nodes.values()) node.degree = degrees.get(node.id) ?? 1
}

function fileMeta(root: string, file: string): Record<string, string | number | boolean> {
  try {
    const stats = statSync(join(root, file))
    return { bytes: stats.size, extension: extname(file) || 'none' }
  } catch {
    return { extension: extname(file) || 'none' }
  }
}

function communityForPath(path: string) {
  const first = path.split('/')[0]
  if (first === 'app' || first === 'src') return 'source'
  if (first === 'test' || first === 'tests' || first === '__tests__') return 'tests'
  if (first === 'docs' || first === 'prototype') return 'docs'
  if (first === 'scripts' || first === 'tools') return 'tooling'
  return first || 'root'
}

function git(cwd: string, args: string[]) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
