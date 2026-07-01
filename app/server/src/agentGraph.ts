import type { LocalProject } from './projects.js'

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

type AgentGraphPayload = {
  source: string
  projectId: string
  generated: boolean
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities: GraphCommunity[]
}

export type AgentGraphTask = {
  id: string
  title: string
  project: string
  model: string
  agent: string
  status: string
  priority: string
  progress: number
  stage: string
  source?: string
  sourceRef?: string
}

export type AgentGraphRun = {
  id: string
  taskId?: string
  projectId?: string
  model: string
  provider?: string
  status: string
  updatedAt?: string
}

export type AgentGraphAction = {
  id: string
  project: string
  task: string | null
  type: string
  model: string
  priority: string
  urgency: string
  title: string
}

const communities: GraphCommunity[] = [
  { id: 0, name: 'manager', color: 'var(--star)' },
  { id: 1, name: 'specialists', color: 'var(--c1)' },
  { id: 2, name: 'projects', color: 'var(--c4)' },
  { id: 3, name: 'work queue', color: 'var(--cyan)' },
  { id: 4, name: 'questions', color: 'var(--c6)' },
]

const agentRoles = [
  { id: 'agent:manager', label: 'Manager', x: 500, y: 120, meta: 'routes work, asks you for decisions' },
  { id: 'agent:personal', label: 'Personal', x: 235, y: 180, meta: 'personal assistant lane and safe Telegram conversation' },
  { id: 'agent:corporate', label: 'Corporate', x: 765, y: 180, meta: 'Zebra/codebase orchestration and agent registry' },
  { id: 'agent:frontend', label: 'Frontend', x: 230, y: 340, meta: 'dashboard, queue, cockpit UI' },
  { id: 'agent:backend', label: 'Backend', x: 770, y: 340, meta: 'SQLite, scheduler, local dispatch' },
  { id: 'agent:design', label: 'Design', x: 280, y: 530, meta: 'visual system and interaction review' },
  { id: 'agent:graph', label: 'Graph', x: 500, y: 610, meta: 'project graph and agent communication topology' },
  { id: 'agent:protocols', label: 'Protocols', x: 720, y: 530, meta: 'communication contracts, handoffs, and audit trails' },
  { id: 'agent:marketing', label: 'Marketing', x: 500, y: 430, meta: 'positioning, notes, outward-facing copy' },
] as const

export function buildAgentGraph(
  projects: LocalProject[],
  tasks: AgentGraphTask[],
  runs: AgentGraphRun[],
  actions: AgentGraphAction[],
): AgentGraphPayload {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const activeAgents = new Set(tasks.filter((task) => task.status === 'running' || task.status === 'needs-input').map((task) => agentRoleId(task.agent, task.title, task.stage)))

  agentRoles.forEach((agent, index) => {
    nodes.push({
      id: agent.id,
      label: agent.label,
      c: index === 0 ? 0 : 1,
      x: agent.x,
      y: agent.y,
      deg: index === 0 ? agentRoles.length + tasks.length : tasks.filter((task) => agentRoleId(task.agent, task.title, task.stage) === agent.id).length + 1,
      kind: index === 0 ? 'god' : 'fn',
      agent: true,
      hot: agent.id === 'agent:manager' || activeAgents.has(agent.id),
      meta: { role: agent.meta },
    })
    if (index > 0) edges.push(['agent:manager', agent.id, 'ext'])
  })

  projects.slice(0, 16).forEach((project, index) => {
    const pos = ring(index, Math.min(projects.length, 16), 225, 0.72, 500, 350)
    const id = `project:${project.id}`
    nodes.push({
      id,
      label: project.name,
      c: 2,
      x: pos.x,
      y: pos.y,
      deg: project.openTasks + project.queued + project.agentsActive,
      kind: project.active ? 'god' : 'file',
      agent: project.agentsActive > 0,
      hot: project.active || project.status === 'running',
      project: project.id,
      meta: {
        status: project.status,
        active: project.active,
        openTasks: project.openTasks,
        queued: project.queued,
      },
    })
    edges.push(['agent:manager', id, project.active ? 'ext' : 'inf'])
    edges.push([projectLaneRole(project), id, project.active ? 'ext' : 'inf'])
  })

  tasks.slice(0, 24).forEach((task, index) => {
    const role = agentRoleId(task.agent, task.title, task.stage)
    const pos = taskPosition(role, index)
    const id = `task:${task.id}`
    nodes.push({
      id,
      label: task.id,
      c: 3,
      x: pos.x,
      y: pos.y,
      deg: task.status === 'running' ? 5 : 2,
      kind: 'file',
      hot: task.status === 'running' || task.status === 'needs-input',
      project: task.project,
      meta: {
        title: task.title,
        status: task.status,
        priority: task.priority,
        stage: task.stage,
        progress: Math.round(task.progress * 100),
        source: task.source ?? 'queue',
      },
    })
    edges.push([role, id, task.status === 'running' ? 'ext' : 'inf'])
    edges.push([id, `project:${task.project}`, task.status === 'needs-input' ? 'amb' : 'inf'])
  })

  runs.filter((run) => run.status === 'running').slice(0, 12).forEach((run, index) => {
    const role = modelRoleId(run.model)
    const pos = ring(index, Math.max(1, Math.min(runs.length, 12)), 95, 0.62, 500, 350)
    const id = `run:${run.id}`
    nodes.push({
      id,
      label: `run ${run.id.slice(0, 4)}`,
      c: 3,
      x: pos.x,
      y: pos.y,
      deg: 4,
      kind: 'fn',
      agent: true,
      hot: true,
      project: run.projectId,
      meta: {
        task: run.taskId ?? 'manual',
        model: run.model,
        provider: run.provider ?? 'cli',
        updated: run.updatedAt ?? 'now',
      },
    })
    edges.push([role, id, 'ext'])
    if (run.projectId) edges.push([id, `project:${run.projectId}`, 'inf'])
  })

  actions.slice(0, 10).forEach((action, index) => {
    const pos = ring(index, Math.max(1, Math.min(actions.length, 10)), 150, 0.5, 500, 350)
    const id = `question:${action.id}`
    nodes.push({
      id,
      label: action.type,
      c: 4,
      x: pos.x,
      y: pos.y,
      deg: action.urgency === 'high' ? 4 : 2,
      kind: 'fn',
      hot: action.urgency === 'high',
      project: action.project,
      meta: {
        title: action.title,
        priority: action.priority,
        urgency: action.urgency,
        model: action.model,
      },
    })
    edges.push(['agent:manager', id, 'amb'])
    edges.push([id, `project:${action.project}`, 'amb'])
    if (action.task) edges.push([id, `task:${action.task}`, 'amb'])
  })

  return { source: 'generated-agent-communication-mesh', projectId: 'agents', generated: true, nodes, edges: existingEdges(nodes, edges), communities }
}

function agentRoleId(agent: string, title = '', stage = '') {
  const text = `${agent} ${title} ${stage}`.toLowerCase()
  if (text.includes('personal') || text.includes('life admin')) return 'agent:personal'
  if (text.includes('zebra') || text.includes('corporate') || text.includes('orchestrat') || text.includes('domain registry')) return 'agent:corporate'
  if (text.includes('protocol') || text.includes('handoff') || text.includes('telegram') || text.includes('session') || text.includes('audit')) return 'agent:protocols'
  if (text.includes('front') || text.includes('ui') || text.includes('ux')) return 'agent:frontend'
  if (text.includes('back') || text.includes('server') || text.includes('sqlite') || text.includes('guard')) return 'agent:backend'
  if (text.includes('design') || text.includes('visual') || text.includes('cockpit')) return 'agent:design'
  if (text.includes('graph') || text.includes('map') || text.includes('mapper')) return 'agent:graph'
  if (text.includes('marketing') || text.includes('content') || text.includes('release') || text.includes('position')) return 'agent:marketing'
  if (text.includes('manager') || text.includes('onboarding')) return 'agent:manager'
  return 'agent:backend'
}

function projectLaneRole(project: LocalProject) {
  const text = `${project.id} ${project.name} ${project.github?.fullName ?? ''}`.toLowerCase()
  if (project.label === 'work' || text.includes('zebra') || text.includes('corporate')) return 'agent:corporate'
  return 'agent:personal'
}

function modelRoleId(model: string) {
  if (model === 'opus') return 'agent:manager'
  if (model === 'spark') return 'agent:graph'
  return 'agent:backend'
}

function taskPosition(role: string, index: number) {
  const anchor = agentRoles.find((agent) => agent.id === role) ?? agentRoles[0]
  const offset = 44 + (index % 4) * 26
  const side = index % 2 === 0 ? -1 : 1
  return { x: Math.max(80, Math.min(920, anchor.x + side * offset)), y: Math.max(100, Math.min(625, anchor.y + 54 + (index % 3) * 26)) }
}

function ring(index: number, total: number, radius: number, yScale: number, cx: number, cy: number) {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
  return {
    x: Math.round(cx + Math.cos(angle) * radius),
    y: Math.round(cy + Math.sin(angle) * radius * yScale),
  }
}

function existingEdges(nodes: GraphNode[], edges: GraphEdge[]) {
  const ids = new Set(nodes.map((node) => node.id))
  const seen = new Set<string>()
  return edges.filter(([a, b, kind]) => {
    const key = `${a}:${b}:${kind}`
    if (!ids.has(a) || !ids.has(b) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
