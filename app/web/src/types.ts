export type Status = 'running' | 'needs-input' | 'queued' | 'blocked' | 'done' | 'idle'
export type Label = 'work' | 'personal'
export type ModelId = 'opus' | 'codex' | 'spark'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export type ProjectSource = 'local' | 'github' | 'manual'

export type GithubProjectInfo = {
  owner: string
  repo: string
  fullName: string
  url: string
  cloneUrl: string
  defaultBranch?: string
  visibility?: 'public' | 'private' | 'internal' | 'unknown'
  archived?: boolean
}

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
  source?: ProjectSource
  localExists?: boolean
  graphReady?: boolean
  skillsPath?: string
  skillsReady?: boolean
  skillsUpdatedAt?: string | null
  learnedItems?: number
  active?: boolean
  autonomous?: boolean
  cadence?: 'slow' | 'paused'
  remote?: string
  dirtyFiles?: number
  behind?: number
  github?: GithubProjectInfo
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

export type GraphEdge = [string, string, 'ext' | 'inf' | 'amb']

export type GraphCommunity = {
  id: number
  name: string
  color: string
}

export type GraphPayload = {
  source: string
  projectId: string
  missing?: boolean
  generated?: boolean
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities: GraphCommunity[]
}

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

export type SchedulerSettings = {
  id: 'default'
  enabled: boolean
  timezone: string
  startTime: string
  endTime: string
  weekdayReservePct: number
  maxParallelRuns: number
  sparkEnabled: boolean
  opusEnabled: boolean
  codexEnabled: boolean
  updatedAt: string
}

export type ProjectOnboarding = {
  projectId: string
  profile: string
  goals: string[]
  queue: Array<{ id: string; title: string; model: ModelId; priority: Priority; stage: string }>
  skills: string[]
  updatedAt: string
}
