import type { GraphEdge, GraphNode, HealthProfile, InboxAction, ModelInfo, Patch, Project, QueueTask } from '../types'

export const models: ModelInfo[] = [
  { id: 'opus', label: 'Claude Code', vendor: 'Anthropic', tier: 'planning/review', auth: 'claude.ai subscription' },
  { id: 'spark', label: 'Codex Spark', vendor: 'OpenAI', tier: 'background', auth: 'ChatGPT Pro subscription' },
  { id: 'codex', label: 'Codex GPT-5.5', vendor: 'OpenAI', tier: 'primary worktree', auth: 'ChatGPT subscription', reserved: false },
]

export const fallbackProjects: Project[] = [
  {
    id: 'northstar',
    name: 'northstar',
    path: '~/dev/northstar',
    branch: 'main',
    lang: 'TypeScript',
    status: 'needs-input',
    label: 'personal',
    health: 0.78,
    agentsActive: 1,
    openTasks: 8,
    queued: 3,
    commits24: 1,
    linesNet: '+3,120 / -1,240',
    coverage: 0.62,
    tokens: 188000,
    budget: 600000,
    runtime: 'live',
    nodes: 512,
    communities: 6,
    lastEvent: 'rebuild cockpit from prototype',
    lastAgo: 'now',
    spark: [2, 4, 5, 8, 7, 9, 11, 10, 12, 13, 15, 14],
  },
]

export const queue: QueueTask[] = [
  { id: 'T-1001', title: 'Stabilize Northstar rebuild and project ingestion', project: 'northstar', model: 'opus', agent: 'builder', status: 'running', progress: 0.72, priority: 'P0', eta: '~8m', stage: 'wiring local repos', files: 9, branch: 'agent/northstar-rebuild' },
  { id: 'T-1002', title: 'Read graphify-out/graph.json when present', project: 'northstar', model: 'spark', agent: 'mapper', status: 'queued', progress: 0, priority: 'P1', eta: 'queued', stage: 'waiting for stable API', files: 0, branch: '-' },
  { id: 'T-1003', title: 'Implement real worktree patch review flow', project: 'northstar', model: 'codex', agent: 'builder', status: 'needs-input', progress: 0.24, priority: 'P1', eta: 'blocked', stage: 'needs merge strategy', files: 4, branch: 'agent/worktree-review' },
]

export const healthProfile: HealthProfile = {
  source: 'garmin',
  connected: false,
  lastSync: 'Garmin import not connected',
  weight: 182,
  maintenanceCalories: 2640,
  goalId: 'triathlon-base',
  metrics: [
    { date: 'May 27', restingHr: 54, sleepHours: 6.7, activeCalories: 680, trainingMinutes: 42, readiness: 0.72 },
    { date: 'May 28', restingHr: 52, sleepHours: 7.4, activeCalories: 910, trainingMinutes: 58, readiness: 0.81 },
    { date: 'May 29', restingHr: 55, sleepHours: 6.2, activeCalories: 520, trainingMinutes: 32, readiness: 0.64 },
    { date: 'May 30', restingHr: 51, sleepHours: 7.8, activeCalories: 1040, trainingMinutes: 74, readiness: 0.84 },
    { date: 'May 31', restingHr: 53, sleepHours: 7.1, activeCalories: 780, trainingMinutes: 45, readiness: 0.76 },
    { date: 'Jun 1', restingHr: 50, sleepHours: 8.0, activeCalories: 1120, trainingMinutes: 82, readiness: 0.88 },
    { date: 'Jun 2', restingHr: 52, sleepHours: 7.0, activeCalories: 740, trainingMinutes: 48, readiness: 0.78 },
    { date: 'Jun 3', restingHr: 49, sleepHours: 7.6, activeCalories: 980, trainingMinutes: 67, readiness: 0.86 },
    { date: 'Jun 4', restingHr: 51, sleepHours: 6.9, activeCalories: 830, trainingMinutes: 54, readiness: 0.77 },
    { date: 'Jun 5', restingHr: 50, sleepHours: 7.7, activeCalories: 1210, trainingMinutes: 88, readiness: 0.87 },
    { date: 'Jun 6', restingHr: 53, sleepHours: 6.5, activeCalories: 600, trainingMinutes: 35, readiness: 0.69 },
    { date: 'Jun 7', restingHr: 48, sleepHours: 8.2, activeCalories: 940, trainingMinutes: 62, readiness: 0.9 },
  ],
  goals: [
    { id: 'triathlon-base', label: 'Triathlon base', focus: 'swim · bike · run durability', weeklyTrainingHours: 7, maintenanceCalories: 2640, targetWeight: 178 },
    { id: 'marathon-build', label: 'Marathon build', focus: 'aerobic volume and long-run economy', weeklyTrainingHours: 6, maintenanceCalories: 2580, targetWeight: 176 },
    { id: 'frisbee-prep', label: 'Frisbee prep', focus: 'repeat sprint, agility, shoulder resilience', weeklyTrainingHours: 5, maintenanceCalories: 2720, targetWeight: 180 },
    { id: 'general-health', label: 'General health', focus: 'sleep consistency and steady movement', weeklyTrainingHours: 4, maintenanceCalories: 2480, targetWeight: 182 },
  ],
  weeklyPlan: [
    { day: 'Mon', focus: 'Zone 2 run + mobility', duration: 45, intensity: 'easy' },
    { day: 'Tue', focus: 'Strength + strides', duration: 55, intensity: 'moderate' },
    { day: 'Wed', focus: 'Bike intervals', duration: 60, intensity: 'hard' },
    { day: 'Thu', focus: 'Swim technique', duration: 40, intensity: 'easy' },
    { day: 'Fri', focus: 'Recovery walk + core', duration: 30, intensity: 'recovery' },
    { day: 'Sat', focus: 'Long aerobic session', duration: 90, intensity: 'moderate' },
    { day: 'Sun', focus: 'Optional sport play', duration: 60, intensity: 'moderate' },
  ],
}

export const actions: InboxAction[] = [
  { id: 'A-01', type: 'question', project: 'northstar', task: 'T-1003', model: 'codex', priority: 'P1', ago: 'now', urgency: 'high', title: 'Should approve locally squash or preserve branch history?', ctx: 'Patch Review can prepare either a squash merge or preserve the agent branch. No push happens in v1.', options: ['Squash into base', 'Preserve branch commits', 'Ask per patch'], recommend: 0, help: 'Squash keeps autonomous work reviewable and avoids noisy agent history while the workflow is still settling.' },
  { id: 'A-02', type: 'suggest', project: 'northstar', task: null, model: 'spark', priority: 'P2', ago: '4m', urgency: 'med', title: 'Generate graphify snapshots for each local repo overnight', ctx: 'Seven git repos were found under ~/dev. Incremental graph snapshots would make status answers cheaper.', options: ['Queue graphify run', 'Not yet'], recommend: 0, help: 'This is the fastest route to token savings: Northstar can answer from graph digest first, then ask for code only when needed.' },
  { id: 'A-03', type: 'review', project: 'northstar', task: 'T-1001', model: 'opus', priority: 'P1', ago: '2m', urgency: 'med', title: 'Patch ready - dashboard reads local project inventory', ctx: 'Local project discovery feeds the dashboard with git status, language, branch, and remote metadata.', add: 420, del: 80, files: 7 },
]

export const communities = [
  { id: 0, name: 'shell/ui', color: 'var(--c2)' },
  { id: 1, name: 'project-ingest', color: 'var(--c1)' },
  { id: 2, name: 'agent-queue', color: 'var(--c4)' },
  { id: 3, name: 'graphify', color: 'var(--c5)' },
  { id: 4, name: 'guardrails', color: 'var(--c6)' },
  { id: 5, name: 'patch-review', color: 'var(--c3)' },
]

export const graphNodes: GraphNode[] = [
  { id: 'Northstar', c: 0, x: 500, y: 120, deg: 12, kind: 'god' },
  { id: 'Dashboard', c: 0, x: 340, y: 240, deg: 8, kind: 'god' },
  { id: 'ProjectIngest', c: 1, x: 620, y: 250, deg: 9, kind: 'god', agent: true, hot: true },
  { id: 'GitScanner', c: 1, x: 740, y: 330, deg: 6, kind: 'fn', agent: true },
  { id: 'Queue', c: 2, x: 430, y: 430, deg: 7, kind: 'file' },
  { id: 'GraphifyReader', c: 3, x: 700, y: 500, deg: 5, kind: 'fn' },
  { id: 'NoApiGuard', c: 4, x: 230, y: 380, deg: 5, kind: 'file' },
  { id: 'PatchReview', c: 5, x: 520, y: 560, deg: 4, kind: 'file' },
]

export const graphEdges: GraphEdge[] = [
  ['Northstar', 'Dashboard', 'ext'],
  ['Northstar', 'ProjectIngest', 'ext'],
  ['ProjectIngest', 'GitScanner', 'ext'],
  ['ProjectIngest', 'Dashboard', 'inf'],
  ['ProjectIngest', 'GraphifyReader', 'inf'],
  ['Queue', 'NoApiGuard', 'ext'],
  ['Queue', 'PatchReview', 'ext'],
  ['GraphifyReader', 'Dashboard', 'amb'],
]

export const patch: Patch = {
  task: 'T-1001',
  title: 'Dashboard reads local project inventory',
  project: 'northstar',
  model: 'opus',
  branch: 'agent/northstar-rebuild',
  base: 'main',
  worktree: '~/.northstar/worktrees/northstar/T-1001',
  summary: 'Adds local repo discovery so Northstar starts with the projects already under ~/dev instead of only prototype mock data.',
  additions: 420,
  deletions: 80,
  filesChanged: 7,
  checks: [
    { name: 'typecheck', state: 'pass', ms: 3100 },
    { name: 'build:web', state: 'running', ms: 0, detail: 'pending' },
  ],
  files: [
    { path: 'app/server/src/projects.ts', add: 188, del: 0, status: 'new' },
    { path: 'app/web/src/api/client.ts', add: 42, del: 0, status: 'new' },
    { path: 'app/web/src/App.tsx', add: 120, del: 24, status: 'mod' },
  ],
  diff: [
    { t: 'hunk', s: 'app/server/src/projects.ts' },
    { t: 'ctx', n1: 1, n2: 1, s: 'export function discoverProjects() {' },
    { t: 'del', n1: 2, s: '  return prototypeProjects;' },
    { t: 'add', n2: 2, s: '  return scanGitRepos("~/dev");' },
    { t: 'ctx', n1: 3, n2: 3, s: '}' },
  ],
  rationale: [
    'Northstar should start from the real projects already on disk.',
    'The dashboard can now show status from git branch, dirty file count, remote, and detected language.',
    'This keeps graphify and agent scheduling scoped to known local repos.',
  ],
  risks: [{ level: 'low', text: 'Repo labels are inferred until the user classifies projects as work or personal.' }],
}
