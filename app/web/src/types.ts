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

export type ModelUsage = {
  id: ModelId
  label: string
  provider: string
  source: string
  sourceKind?: 'claude_statusline' | 'chatgpt_codex_analytics' | 'codex_app_server' | 'local_estimate'
  sourceFresh?: boolean
  tokens5h: number
  tokens5hCap: number
  tokensWeek: number
  tokensWeekCap: number
  fiveHourUsedPct?: number | null
  weeklyUsedPct?: number | null
  fiveHourResetAt?: string | null
  weeklyResetAt?: string | null
  computePct: number
  liveRuns: number
  queued: number
  updatedAt: string
}

export type ModelAuthStatus = {
  model: ModelId
  ok: boolean
  blockers: string[]
  checkCommand: string
  loginCommand: string
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
  source?: string
  sourceRef?: string
  prompt?: string
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  dispatchStatus?: QueueDispatchStatus | string | null
  dispatchBlocker?: string | null
  dispatchability?: QueueDispatchability
  lane: 'dev' | 'personal' | 'telegram-intent'
}

export type QueueDispatchStatus =
  | 'runnable'
  | 'scheduler-waiting'
  | 'running'
  | 'done'
  | 'needs-input'
  | 'blocked'
  | 'manual'
  | 'github-only'
  | 'missing-project'
  | 'model-disabled'
  | 'no-free-slot'
  | 'guarded'

export type QueueDispatchability = {
  status: QueueDispatchStatus | string
  runnable: boolean
  canDispatchNow: boolean
  reason: string
  action: string
  stale: boolean
  schedulerWaiting: boolean
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
  sourceKind?: 'graphify' | 'generated' | 'generated-summary'
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

export type HealthDailyMetric = {
  date: string
  restingHr: number
  sleepHours: number
  activeCalories: number
  trainingMinutes: number
  readiness: number
}

export type HealthGoal = {
  id: string
  label: string
  focus: string
  weeklyTrainingHours: number
  maintenanceCalories: number
  targetWeight: number
}

export type HealthWorkoutPlanDay = {
  day: string
  focus: string
  duration: number
  intensity: 'easy' | 'moderate' | 'hard' | 'recovery'
}

export type HealthSyncStatus = {
  source: 'garmin' | 'strava'
  connected: boolean
  authState: string
  lastSyncStartedAt: string | null
  lastSuccessAt: string | null
  cursor: string | null
  lastError: string | null
  retryAt: string | null
  updatedAt: string
  configured: boolean
}

export type HealthActivity = {
  id: string
  source: 'garmin' | 'strava'
  source_activity_id: string
  started_at: string
  name: string
  type: string
  duration_sec: number
  distance_m?: number | null
  calories?: number | null
  avg_hr?: number | null
  max_hr?: number | null
}

export type OperationsOverview = {
  ok: true
  generatedAt: string
  summary: {
    activeProjects: number
    totalProjects: number
    openDecisions: number
    runningTasks: number
    queuedTasks: number
    blockedTasks: number
    liveRuns: number
    runnableTasks: number
    manualTasks: number
    githubOnlyTasks: number
    attentionPending: number
    attentionFailed: number
  }
  queuePressure: {
    totalOpen: number
    runnable: number
    schedulerWaiting: number
    blocked: number
    needsInput: number
    manual: number
    githubOnly: number
    modelDisabled: number
    noFreeSlot: number
  }
  nextAction: {
    kind: 'resolve-inbox' | 'dispatch-task' | 'review-live-run' | 'clean-queue' | 'idle'
    title: string
    reason: string
    command: string
    taskId?: string
    actionId?: string
    runId?: string
    project?: string
    priority?: string
  } | null
  projects: Project[]
  activeProjects: Project[]
  tasks: QueueTask[]
  runs: unknown[]
  liveRuns: unknown[]
  openDecisions: InboxAction[]
  telegram: {
    ready: boolean
    polling: boolean
    sessions: unknown[]
    configuredChat: boolean
  }
  attention: {
    pending: number
    failed: number
    sent: number
  }
  modelUsage?: ModelUsage[]
  modelAuth?: ModelAuthStatus[]
}

export type HealthProfile = {
  source: 'garmin' | 'strava'
  connected: boolean
  lastSync: string
  weight: number
  maintenanceCalories: number
  goalId: string
  metrics: HealthDailyMetric[]
  goals: HealthGoal[]
  weeklyPlan: HealthWorkoutPlanDay[]
}
