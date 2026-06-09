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
}

export function buildProjectGraph(projects: LocalProject[], projectId = 'all'): GraphPayload {
  const focus = projectId === 'all' ? null : projects.find((project) => project.id === projectId)
  if (focus) return buildFocusedProjectGraph(focus)

  const communities: GraphCommunity[] = [
    { id: 0, name: 'northstar', color: 'var(--star)' },
    { id: 1, name: 'local repos', color: 'var(--c1)' },
    { id: 2, name: 'github', color: 'var(--c4)' },
    { id: 3, name: 'graphify', color: 'var(--c5)' },
    { id: 4, name: 'needs-input', color: 'var(--cyan)' },
  ]
  const nodes: GraphNode[] = [
    { id: 'Northstar', label: 'Northstar', c: 0, x: 500, y: 105, deg: projects.length, kind: 'god', hot: true, meta: { projects: projects.length } },
    { id: 'LocalRepos', label: 'local repos', c: 1, x: 315, y: 260, deg: projects.filter((p) => p.localExists).length, kind: 'god' },
    { id: 'GitHub', label: 'GitHub', c: 2, x: 685, y: 260, deg: projects.filter((p) => p.github).length, kind: 'god' },
    { id: 'Graphify', label: 'graphify', c: 3, x: 500, y: 560, deg: projects.filter((p) => p.graphReady).length, kind: 'god' },
    { id: 'NeedsInput', label: 'needs input', c: 4, x: 500, y: 335, deg: projects.filter((p) => p.status === 'needs-input').length, kind: 'fn', agent: true },
  ]
  const edges: GraphEdge[] = [
    ['Northstar', 'LocalRepos', 'ext'],
    ['Northstar', 'GitHub', 'ext'],
    ['Northstar', 'Graphify', 'inf'],
    ['Northstar', 'NeedsInput', 'ext'],
  ]

  const projectNodes = projects.slice(0, 42)
  projectNodes.forEach((project, index) => {
    const local = project.localExists
    const githubOnly = !local && project.github
    const c = project.status === 'needs-input' ? 4 : githubOnly ? 2 : 1
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
        source: project.localExists ? 'local' : 'github',
        status: project.status,
        graph: project.graphReady ? 'ready' : 'missing',
        github: project.github?.fullName ?? 'unlinked',
      },
    })
    edges.push([local ? 'LocalRepos' : 'GitHub', id, local ? 'ext' : 'inf'])
    if (project.github && local) edges.push(['GitHub', id, 'inf'])
    if (project.graphReady) edges.push(['Graphify', id, 'ext'])
    if (project.status === 'needs-input') edges.push(['NeedsInput', id, 'amb'])
  })

  return { source: 'generated-project-inventory', projectId: 'all', generated: true, nodes, edges, communities }
}

export function graphifyToPayload(project: LocalProject, source: string, graph: RawGraph): GraphPayload {
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : Array.isArray(graph.links) ? graph.links : []
  if (rawNodes.length === 0) return buildFocusedProjectGraph(project)

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
  const communities = [...communityNames.entries()].map(([name, id]) => ({ id, name, color: palette[id % palette.length] }))

  return {
    source,
    projectId: project.id,
    generated: false,
    nodes,
    edges,
    communities: communities.length ? communities : [{ id: 0, name: 'source', color: 'var(--c1)' }],
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
    { id: 'local', label: project.localExists ? 'local checkout' : 'not cloned', c: 1, x: 280, y: 310, deg: 3, kind: 'file', project: project.id, meta: { path: project.path } },
    { id: 'github', label: project.github?.fullName ?? 'GitHub unlinked', c: 2, x: 720, y: 310, deg: 3, kind: 'file', project: project.id, meta: { url: project.github?.url ?? project.remote ?? 'none', visibility: project.github?.visibility ?? 'unknown' } },
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
  return { source: project.graphReady ? 'graphify-ready-project-summary' : 'generated-project-summary', projectId: project.id, generated: true, missing: !project.graphReady, nodes, edges, communities }
}

function layout(index: number, total: number, radius: number) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
  return {
    x: Math.round(500 + Math.cos(angle) * radius),
    y: Math.round(350 + Math.sin(angle) * radius * 0.78),
  }
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
