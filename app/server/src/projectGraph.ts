import type { LocalProject } from './projects.js'

const palette = ['var(--c2)', 'var(--c1)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c3)', 'var(--cyan)', 'var(--star)']

type GraphCommunity = {
  id: number
  name: string
  color: string
}

type GraphNode = {
  id: string
  label?: string
  c: number
  x: number
  y: number
  deg: number
  kind: 'god' | 'file' | 'fn'
  agent?: boolean
  hot?: boolean
  project?: string
  meta?: Record<string, string | number | boolean>
}

type GraphEdge = [string, string, 'ext' | 'inf' | 'amb']

type GraphPayload = {
  source: string
  sourceKind?: 'graphify' | 'generated' | 'generated-summary'
  projectId: string
  missing?: boolean
  generated?: boolean
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities: GraphCommunity[]
}

type RawGraph = {
  nodes?: unknown[]
  edges?: unknown[]
  links?: unknown[]
  communities?: unknown[]
  schema?: unknown
}

type RawGraphNode = {
  id: string
  label: string
  path: string
  community: string
  kind: string
  degree: number
  bytes: number
}

export function buildProjectGraph(projects: LocalProject[], projectId = 'all'): GraphPayload {
  const focus = projectId === 'all' || projectId === 'active' ? null : projects.find((project) => project.id === projectId)
  if (focus) return buildFocusedProjectGraph(focus)
  const scopedProjects = projectId === 'active' ? projects.filter((project) => project.active) : projects

  const communities: GraphCommunity[] = [
    { id: 0, name: 'northstar', color: 'var(--star)' },
    { id: 1, name: 'local repos', color: 'var(--c1)' },
    { id: 2, name: 'github', color: 'var(--c4)' },
    { id: 3, name: 'graphify', color: 'var(--c5)' },
    { id: 4, name: 'needs-input', color: 'var(--cyan)' },
    { id: 5, name: 'manual workflows', color: 'var(--c3)' },
  ]
  const nodes: GraphNode[] = [
    { id: 'Northstar', label: 'Northstar', c: 0, x: 500, y: 340, deg: scopedProjects.length + 5, kind: 'god', hot: true, meta: { projects: scopedProjects.length, scope: projectId } },
    { id: 'LocalRepos', label: 'local repos', c: 1, x: 275, y: 215, deg: scopedProjects.filter((p) => p.localExists).length, kind: 'god' },
    { id: 'GitHub', label: 'GitHub', c: 2, x: 725, y: 215, deg: scopedProjects.filter((p) => p.github).length, kind: 'god' },
    { id: 'Graphify', label: 'graphify', c: 3, x: 500, y: 570, deg: scopedProjects.filter((p) => p.graphReady).length, kind: 'god' },
    { id: 'NeedsInput', label: 'needs input', c: 4, x: 725, y: 455, deg: scopedProjects.filter((p) => p.status === 'needs-input').length, kind: 'fn', agent: true },
    { id: 'ManualWorkflows', label: 'manual workflows', c: 5, x: 275, y: 455, deg: scopedProjects.filter((p) => p.source === 'manual').length, kind: 'god' },
  ]
  const edges: GraphEdge[] = [
    ['Northstar', 'LocalRepos', 'ext'],
    ['Northstar', 'GitHub', 'ext'],
    ['Northstar', 'Graphify', 'inf'],
    ['Northstar', 'NeedsInput', 'ext'],
    ['Northstar', 'ManualWorkflows', 'ext'],
  ]

  const projectNodes = scopedProjects.slice(0, 42)
  projectNodes.forEach((project, index) => {
    const local = project.localExists
    const manual = project.source === 'manual'
    const githubOnly = !local && project.github
    const c = project.status === 'needs-input' ? 4 : manual ? 5 : githubOnly ? 2 : 1
    const pos = layout(index, projectNodes.length, local ? 248 : 310)
    const id = `project:${project.id}`
    nodes.push({
      id,
      label: project.name,
      c,
      x: pos.x,
      y: pos.y,
      deg: project.openTasks + project.queued + 1,
      kind: project.graphReady ? 'god' : 'file',
      agent: project.agentsActive > 0,
      hot: project.status === 'needs-input',
      project: project.id,
      meta: {
        branch: project.branch,
        source: project.source,
        status: project.status,
        graph: project.graphReady ? 'ready' : 'missing',
        github: project.github?.fullName ?? 'unlinked',
      },
    })
    edges.push([manual ? 'ManualWorkflows' : local ? 'LocalRepos' : 'GitHub', id, local || manual ? 'ext' : 'inf'])
    if (project.github && local) edges.push(['GitHub', id, 'inf'])
    if (project.graphReady) edges.push(['Graphify', id, 'ext'])
    if (project.status === 'needs-input') edges.push(['NeedsInput', id, 'amb'])
  })

  return { source: projectId === 'active' ? 'generated-active-project-inventory' : 'generated-project-inventory', sourceKind: 'generated', projectId, generated: true, nodes, edges, communities }
}

export function graphifyToPayload(project: LocalProject, source: string, graph: RawGraph): GraphPayload {
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : Array.isArray(graph.links) ? graph.links : []
  if (rawNodes.length === 0) return buildFocusedProjectGraph(project)
  if (rawNodes.length > 80 || String(graph.schema ?? '').startsWith('northstar.project-summary')) {
    return summarizeGraphifyPayload(project, source, rawNodes, rawEdges)
  }

  const communityNames = new Map<string, number>()
  const nodes: GraphNode[] = rawNodes.slice(0, 220).map((item, index) => {
    const value = item as Record<string, unknown>
    const label = String(value.label ?? value.name ?? value.path ?? value.id ?? `node-${index + 1}`)
    const id = String(value.id ?? value.key ?? label)
    const communityName = String(value.community ?? value.group ?? value.kind ?? value.type ?? 'source')
    const c = communityIndex(communityNames, communityName)
    const pos = layout(index, Math.min(rawNodes.length, 220), 250 + (index % 4) * 18)
    return {
      id,
      label: shortLabel(label),
      c,
      x: pos.x,
      y: pos.y,
      deg: Number(value.degree ?? value.deg ?? 1),
      kind: index === 0 ? 'god' : String(value.kind ?? value.type).includes('function') ? 'fn' : 'file',
      project: project.id,
      meta: {
        path: String(value.path ?? value.file ?? label),
        community: communityName,
      },
    }
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = rawEdges
    .slice(0, 420)
    .map((item) => normalizeEdge(item))
    .filter((edge): edge is GraphEdge => Boolean(edge && nodeIds.has(edge[0]) && nodeIds.has(edge[1])))
  const communities = [...communityNames.entries()].map(([name, id]) => ({ id, name, color: name === 'project' ? 'var(--star)' : palette[id % palette.length] }))

  return {
    source,
    sourceKind: source.includes('/.northstar/graphs/') ? 'generated-summary' : 'graphify',
    projectId: project.id,
    generated: false,
    nodes,
    edges,
    communities: communities.length ? communities : [{ id: 0, name: 'source', color: 'var(--c1)' }],
  }
}

function summarizeGraphifyPayload(project: LocalProject, source: string, rawItems: unknown[], rawEdges: unknown[]): GraphPayload {
  const rawNodes = rawItems.map(normalizeRawNode)
  const rawById = new Map(rawNodes.map((node) => [node.id, node]))
  const sections = new Map<string, {
    id: string
    label: string
    community: string
    files: number
    directories: number
    manifests: number
    dependencies: number
    scripts: number
    bytes: number
    degree: number
  }>()
  const rawToSummary = new Map<string, string>()
  const rootId = `project:${project.id}`

  for (const node of rawNodes) {
    const bucket = summaryBucket(project, node)
    rawToSummary.set(node.id, bucket.id)
    if (bucket.id === rootId) continue

    const existing = sections.get(bucket.id) ?? {
      id: bucket.id,
      label: bucket.label,
      community: bucket.community,
      files: 0,
      directories: 0,
      manifests: 0,
      dependencies: 0,
      scripts: 0,
      bytes: 0,
      degree: 0,
    }
    if (node.kind === 'directory') existing.directories += 1
    else if (node.kind === 'manifest') existing.manifests += 1
    else if (node.kind === 'dependency' && node.id.startsWith('script:')) existing.scripts += 1
    else if (node.kind === 'dependency') existing.dependencies += 1
    else existing.files += 1
    existing.bytes += node.bytes
    existing.degree += Math.max(1, node.degree)
    sections.set(bucket.id, existing)
  }

  const orderedSections = [...sections.values()]
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, 34)
  const included = new Set([rootId, ...orderedSections.map((section) => section.id)])
  const communityNames = new Map<string, number>()
  const rootCommunity = communityIndex(communityNames, 'project')
  const nodes: GraphNode[] = [{
    id: rootId,
    label: project.name,
    c: rootCommunity,
    x: 500,
    y: 340,
    deg: orderedSections.length + 6,
    kind: 'god',
    hot: project.status === 'needs-input',
    project: project.id,
    meta: {
      status: project.status,
      branch: project.branch,
      summarized: rawNodes.length,
    },
  }]

  orderedSections.forEach((section, index) => {
    const pos = layout(index, orderedSections.length, 250)
    const c = communityIndex(communityNames, section.community)
    nodes.push({
      id: section.id,
      label: section.label,
      c,
      x: pos.x,
      y: pos.y,
      deg: Math.max(2, Math.round(Math.log2(section.degree + 1) * 3)),
      kind: section.community === 'dependencies' || section.community === 'scripts' ? 'fn' : 'god',
      project: project.id,
      meta: {
        files: section.files,
        directories: section.directories,
        manifests: section.manifests,
        dependencies: section.dependencies,
        scripts: section.scripts,
        bytes: section.bytes,
      },
    })
  })

  const edgeMap = new Map<string, GraphEdge>()
  for (const section of orderedSections) addSummaryEdge(edgeMap, rootId, section.id, 'ext')
  for (const edgeItem of rawEdges) {
    const edge = normalizeEdge(edgeItem)
    if (!edge) continue
    const a = rawToSummary.get(edge[0]) ?? summaryBucket(project, rawById.get(edge[0]) ?? normalizeRawNode(edge[0])).id
    const b = rawToSummary.get(edge[1]) ?? summaryBucket(project, rawById.get(edge[1]) ?? normalizeRawNode(edge[1])).id
    if (!included.has(a) || !included.has(b)) continue
    addSummaryEdge(edgeMap, a, b, edge[2])
  }
  const communities = [...communityNames.entries()].map(([name, id]) => ({ id, name, color: name === 'project' ? 'var(--star)' : palette[id % palette.length] }))

  return {
    source,
    sourceKind: source.includes('/.northstar/graphs/') ? 'generated-summary' : 'graphify',
    projectId: project.id,
    generated: false,
    nodes,
    edges: [...edgeMap.values()],
    communities: communities.length ? communities : [{ id: 0, name: 'project', color: 'var(--star)' }],
  }
}

function buildFocusedProjectGraph(project: LocalProject): GraphPayload {
  const communities: GraphCommunity[] = [
    { id: 0, name: 'project', color: 'var(--star)' },
    { id: 1, name: 'local', color: 'var(--c1)' },
    { id: 2, name: 'github', color: 'var(--c4)' },
    { id: 3, name: 'graphify', color: 'var(--c5)' },
    { id: 4, name: 'agent queue', color: 'var(--cyan)' },
  ]
  const rootId = `project:${project.id}`
  const nodes: GraphNode[] = [
    { id: rootId, label: project.name, c: 0, x: 500, y: 145, deg: 8, kind: 'god', hot: project.status === 'needs-input', project: project.id, meta: { status: project.status, branch: project.branch } },
    { id: 'local', label: project.source === 'manual' ? 'manual project' : project.localExists ? 'local checkout' : 'not cloned', c: 1, x: 280, y: 310, deg: 3, kind: 'file', project: project.id, meta: { path: project.path } },
    { id: 'github', label: project.source === 'manual' ? 'external data links' : project.github?.fullName ?? 'GitHub unlinked', c: 2, x: 720, y: 310, deg: 3, kind: 'file', project: project.id, meta: { url: project.github?.url ?? project.remote ?? 'none', visibility: project.github?.visibility ?? 'unknown' } },
    { id: 'graphify', label: project.graphReady ? 'graph ready' : 'graph missing', c: 3, x: 390, y: 525, deg: 2, kind: 'fn', project: project.id, meta: { nodes: project.nodes, communities: project.communities } },
    { id: 'queue', label: project.status === 'needs-input' ? 'needs your answer' : 'queued agent work', c: 4, x: 610, y: 525, deg: project.openTasks, kind: 'fn', agent: project.agentsActive > 0, project: project.id, meta: { openTasks: project.openTasks, queued: project.queued } },
  ]
  const edges: GraphEdge[] = [
    [rootId, 'local', project.localExists ? 'ext' : 'amb'],
    [rootId, 'github', project.github ? 'ext' : 'amb'],
    [rootId, 'graphify', project.graphReady ? 'ext' : 'inf'],
    [rootId, 'queue', project.status === 'needs-input' ? 'ext' : 'inf'],
    ['github', 'local', project.behind ? 'amb' : 'inf'],
    ['graphify', 'queue', project.graphReady ? 'inf' : 'amb'],
  ]
  return { source: project.graphReady ? 'graphify-ready-project-summary' : 'generated-project-summary', sourceKind: project.graphReady ? 'generated-summary' : 'generated', projectId: project.id, generated: true, missing: !project.graphReady, nodes, edges, communities }
}

function layout(index: number, total: number, radius: number) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
  return {
    x: Math.round(500 + Math.cos(angle) * radius),
    y: Math.round(350 + Math.sin(angle) * radius * 0.78),
  }
}

function normalizeRawNode(item: unknown): RawGraphNode {
  if (!item || typeof item !== 'object') {
    const id = String(item ?? 'node')
    return { id, label: shortLabel(id), path: id, community: 'source', kind: 'file', degree: 1, bytes: 0 }
  }
  const value = item as Record<string, unknown>
  const meta = typeof value.meta === 'object' && value.meta ? value.meta as Record<string, unknown> : {}
  const path = String(value.path ?? value.file ?? meta.path ?? value.name ?? value.label ?? value.id ?? 'node')
  const id = String(value.id ?? value.key ?? path)
  const kind = String(value.kind ?? value.type ?? inferRawKind(path, id))
  return {
    id,
    label: shortLabel(String(value.label ?? value.name ?? path)),
    path,
    community: String(value.community ?? value.group ?? sourceCommunity(path.split('/').filter(Boolean)[0] ?? 'source', path)),
    kind,
    degree: Math.max(1, numberValue(value.degree ?? value.deg ?? value.edges ?? 1)),
    bytes: numberValue(meta.bytes ?? value.bytes ?? value.size),
  }
}

function summaryBucket(project: LocalProject, node: RawGraphNode) {
  const id = node.id.toLowerCase()
  const path = node.path.replace(/\\/g, '/')
  if (id === project.id || id === `project:${project.id}` || node.kind === 'project' || path === '.' || path === project.name) {
    return { id: `project:${project.id}`, label: project.name, community: 'project' }
  }
  if (node.kind === 'dependency' || id.startsWith('dep:') || node.community === 'dependencies' || node.community === 'scripts') {
    return id.startsWith('script:') || path.startsWith('script:')
      ? { id: 'summary:scripts', label: 'scripts', community: 'scripts' }
      : { id: 'summary:dependencies', label: 'dependencies', community: 'dependencies' }
  }
  if (node.kind === 'manifest' || node.community === 'manifests') return { id: 'summary:manifests', label: 'manifests', community: 'manifests' }

  const label = sectionLabel(path)
  return { id: `summary:${safeSummaryId(label)}`, label: compactLabel(label), community: sectionCommunity(label, node.community || sourceCommunity(label, path)) }
}

function addSummaryEdge(edgeMap: Map<string, GraphEdge>, a: string, b: string, kind: GraphEdge[2]) {
  if (a === b) return
  const key = [a, b].sort().join(':')
  const existing = edgeMap.get(key)
  edgeMap.set(key, [a, b, existing ? strongestEdgeKind(existing[2], kind) : kind])
}

function strongestEdgeKind(a: GraphEdge[2], b: GraphEdge[2]) {
  if (a === 'ext' || b === 'ext') return 'ext'
  if (a === 'inf' || b === 'inf') return 'inf'
  return 'amb'
}

function sectionLabel(path: string) {
  const parts = path.split('/').filter(Boolean)
  if (!parts.length || path === '.') return 'repo root'
  if (parts.length === 1) return parts[0].includes('.') ? 'repo root' : parts[0]
  if (parts[0] === 'app' && parts[1]) return `app/${parts[1]}`
  if (parts[0] === 'src' && parts[1]) return `src/${parts[1]}`
  if (parts[0] === 'packages' && parts[1]) return `packages/${parts[1]}`
  if (parts[0] === 'apps' && parts[1]) return `apps/${parts[1]}`
  if (parts[0] === 'prototype') return parts[1] && !parts[1].includes('.') ? `prototype/${parts[1]}` : 'prototype'
  return parts[0]
}

function sectionCommunity(label: string, fallback: string) {
  if (label.startsWith('app/') || label.startsWith('src/') || label.startsWith('packages/') || label.startsWith('apps/')) return 'source'
  if (label === 'test' || label === 'tests' || label.includes('__tests__')) return 'tests'
  if (label === 'docs' || label.startsWith('prototype') || label.endsWith('.md')) return 'docs'
  if (label === 'scripts' || label === 'tools') return 'tooling'
  return fallback || 'source'
}

function inferRawKind(path: string, id: string) {
  const value = `${path} ${id}`.toLowerCase()
  if (value.startsWith('script:')) return 'dependency'
  if (/(^|\/)(package\.json|tsconfig\.json|vite\.config|pyproject\.toml|cargo\.toml|go\.mod)$/.test(value)) return 'manifest'
  if (!path.includes('.') && !path.startsWith('script:')) return 'directory'
  return 'file'
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function safeSummaryId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'source'
}

function sourceCommunity(head: string, path: string) {
  const value = `${head}/${path}`.toLowerCase()
  if (value.includes('test') || value.includes('spec')) return 'tests'
  if (value.includes('style') || value.includes('css')) return 'styles'
  if (value.includes('server') || value.includes('api')) return 'server'
  if (value.includes('web') || value.includes('app') || value.includes('src')) return 'source'
  return 'project files'
}

function normalizeEdge(item: unknown): GraphEdge | null {
  if (Array.isArray(item) && item.length >= 2) return [String(item[0]), String(item[1]), edgeKind(item[2])]
  if (!item || typeof item !== 'object') return null
  const value = item as Record<string, unknown>
  const source = value.source ?? value.from ?? value.a
  const target = value.target ?? value.to ?? value.b
  if (!source || !target) return null
  return [String(source), String(target), edgeKind(value.confidence ?? value.kind ?? value.type)]
}

function edgeKind(value: unknown): 'ext' | 'inf' | 'amb' {
  if (value === 'ext' || value === 'explicit' || value === 'direct') return 'ext'
  if (value === 'amb' || value === 'ambiguous') return 'amb'
  return 'inf'
}

function communityIndex(communities: Map<string, number>, name: string) {
  const existing = communities.get(name)
  if (existing !== undefined) return existing
  const next = communities.size
  communities.set(name, next)
  return next
}

function shortLabel(value: string) {
  const segment = value.split('/').pop() ?? value
  return segment.length > 28 ? `${segment.slice(0, 25)}...` : segment
}

function compactLabel(value: string) {
  return value.length > 28 ? `${value.slice(0, 25)}...` : value
}
