export type Status = 'running' | 'needs-input' | 'queued' | 'blocked' | 'done' | 'idle'
export type Label = 'work' | 'personal'
export type ModelId = 'opus' | 'codex' | 'spark'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export type Project = {
  id: string
  name: string
  path: string
  branch: string
  lang: string
  status: Status
  label: Label
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
}

export type ModelInfo = {
  id: ModelId
  label: string
  vendor: string
  tier: string
  auth: string
  reserved?: boolean
}

export type QueueTask = {
  id: string
  title: string
  project: string
  model: ModelId
  agent: string
  status: Status
  progress: number
  priority: Priority
  eta: string
  stage: string
  files: number
  branch: string
}

export type InboxAction = {
  id: string
  type: 'question' | 'review' | 'blocked' | 'suggest'
  project: string
  task: string | null
  model: ModelId
  priority: Priority
  ago: string
  urgency: 'high' | 'med' | 'low'
  title: string
  ctx: string
  options?: string[]
  recommend?: number
  help?: string
  add?: number
  del?: number
  files?: number
}

export type GraphNode = {
  id: string
  c: number
  x: number
  y: number
  deg: number
  kind: 'god' | 'file' | 'fn'
  agent?: boolean
  hot?: boolean
}

export type GraphEdge = [string, string, 'ext' | 'inf' | 'amb']

export type Patch = {
  task: string
  title: string
  project: string
  model: ModelId
  branch: string
  base: string
  worktree: string
  summary: string
  additions: number
  deletions: number
  filesChanged: number
  checks: Array<{ name: string; state: 'pass' | 'running' | 'fail'; ms: number; detail?: string }>
  files: Array<{ path: string; add: number; del: number; status: 'new' | 'mod' | 'del-partial' }>
  diff: Array<
    | { t: 'hunk'; s: string }
    | { t: 'ctx'; n1: number; n2: number; s: string }
    | { t: 'del'; n1: number; s: string }
    | { t: 'add'; n2: number; s: string }
  >
  rationale: string[]
  risks: Array<{ level: 'low' | 'med' | 'high'; text: string }>
}
