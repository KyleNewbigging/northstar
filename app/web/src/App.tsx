import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bike,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Dumbbell,
  Flame,
  GitBranch,
  GitPullRequest,
  HeartPulse,
  Inbox as InboxIcon,
  Layers,
  Mic,
  Moon,
  Network,
  Pause,
  Play,
  Search,
  Settings,
  Sparkles,
  Scale,
  Square,
  Target,
  Terminal,
  X,
  Zap,
} from 'lucide-react'

import { actions as seedActions, communities, fallbackProjects, graphEdges, graphNodes, healthProfile, models, patch as seedPatch, queue as seedQueue } from './data/seed'
import type { GraphPayload, HealthActivity, HealthDailyMetric, HealthProfile, HealthSyncStatus, InboxAction, ModelAuthStatus, ModelId, ModelUsage, OperationsOverview, Patch, Project, ProjectOnboarding, QueueTask, SchedulerSettings, Status } from './types'

type View = 'dashboard' | 'health' | 'inbox' | 'queue' | 'schedule' | 'graph' | 'review' | 'settings'

type DispatchResponse =
  | { ok: true; task: { id: string; projectId: string; model: ModelId; status: string }; run: { id: string; status: string; finalText: string; exitCode: number | null; worktreePath?: string; transport?: string; tmuxSession?: string; attachCommand?: string } }
  | { ok: false; blocked?: boolean; code?: string; error: string; guardrails?: { blockers?: string[] } }

type AgentRun = {
  id: string
  taskId?: string
  task_id?: string
  projectId?: string
  project_id?: string
  status: string
  model: ModelId
  prompt?: string | null
  finalText?: string | null
  final_text?: string | null
  stdout?: string | null
  stderr?: string | null
  command?: string | null
  cwd?: string | null
  provider?: string | null
  transport?: string | null
  tmuxSession?: string | null
  tmux_session?: string | null
  attachCommand?: string | null
  attach_command?: string | null
  stdoutLogPath?: string | null
  stderrLogPath?: string | null
  exitStatusPath?: string | null
  finalTextPath?: string | null
  exitCode?: number | null
  exit_code?: number | null
  worktreePath?: string | null
  worktree_path?: string | null
  startedAt?: string | null
  started_at?: string | null
  updatedAt?: string | null
  updated_at?: string | null
}

type ProjectWork = {
  id: string
  taskId?: string
  project: string
  title: string
  model: ModelId
  status: Status
  progress: number
  stage: string
  eta: string
  branch: string
  source: 'queue' | 'run' | 'decision'
  detail?: string
  worktree?: string
  updatedAt?: string | null
}

const modelColor: Record<ModelId, string> = { opus: 'var(--c1)', codex: 'var(--c4)', spark: 'var(--cyan)' }
const priorityColor = { P0: 'var(--err)', P1: 'var(--star)', P2: 'var(--cyan)', P3: 'var(--ink-3)' }
const priorityRank: Record<InboxAction['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
const urgencyRank: Record<InboxAction['urgency'], number> = { high: 0, med: 1, low: 2 }
const statusDot: Record<Status, string> = {
  running: 'dot-run',
  'needs-input': 'dot-queue',
  queued: 'dot-queue',
  blocked: 'dot-block',
  done: 'dot-done',
  idle: 'dot-idle',
}

const seedGraphPayload: GraphPayload = {
  source: 'prototype-seed',
  projectId: 'all',
  generated: true,
  nodes: graphNodes,
  edges: graphEdges,
  communities,
}

function graphNodeRadius(node: { kind: 'god' | 'file' | 'fn'; deg: number }) {
  const base = node.kind === 'god' ? 12 : node.kind === 'file' ? 8 : 6.5
  return base + Math.min(12, Math.max(1, node.deg) * 0.42)
}

function graphSourceLabel(graph: GraphPayload) {
  if (graph.sourceKind === 'graphify') return 'project graphify output'
  if (graph.sourceKind === 'generated-summary') return 'Northstar generated summary'
  if (graph.missing) return 'graphify missing; fallback graph'
  if (graph.generated) return 'Northstar generated graph'
  return 'graph source'
}

function initialGraphSelection(graph: GraphPayload) {
  return graph.nodes.find((node) => node.id === 'Northstar')?.id
    ?? graph.nodes.find((node) => node.id === `project:${graph.projectId}`)?.id
    ?? graph.nodes[0]?.id
    ?? ''
}

const fallbackModelUsage: ModelUsage[] = [
  { id: 'codex', label: 'Codex GPT-5.5', provider: 'OpenAI', source: 'local fallback', sourceKind: 'local_estimate', sourceFresh: false, tokens5h: 0, tokens5hCap: 250000, tokensWeek: 0, tokensWeekCap: 1000000, computePct: 0, liveRuns: 0, queued: 0, updatedAt: '' },
  { id: 'spark', label: 'Codex Spark', provider: 'OpenAI', source: 'local fallback', sourceKind: 'local_estimate', sourceFresh: false, tokens5h: 0, tokens5hCap: 1000000, tokensWeek: 0, tokensWeekCap: 10000000, computePct: 0, liveRuns: 0, queued: 0, updatedAt: '' },
  { id: 'opus', label: 'Claude Code', provider: 'Anthropic', source: 'local fallback', sourceKind: 'local_estimate', sourceFresh: false, tokens5h: 0, tokens5hCap: 500000, tokensWeek: 0, tokensWeekCap: 3000000, computePct: 0, liveRuns: 0, queued: 0, updatedAt: '' },
]

const configuredApiUrl = (import.meta as ImportMeta & { env?: { VITE_NORTHSTAR_API_URL?: string } }).env?.VITE_NORTHSTAR_API_URL?.replace(/\/$/, '')

function apiUrls(path: string) {
  return configuredApiUrl ? [path, `${configuredApiUrl}${path}`] : [path]
}

function realtimeUrl(path: string) {
  if (configuredApiUrl) return `${configuredApiUrl.replace(/^http/, 'ws')}${path}`
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${path}`
}

async function apiJson<T>(path: string): Promise<T | null> {
  for (const url of apiUrls(path)) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      return (await res.json()) as T
    } catch {
      // Try the next local API shape before falling back to seeded UI data.
    }
  }
  return null
}

async function apiSend<T>(path: string, init: RequestInit): Promise<T | null> {
  for (const url of apiUrls(path)) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) continue
      return (await res.json()) as T
    } catch {
      // Try the next local API shape before falling back to optimistic UI state.
    }
  }
  return null
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

function fmtNum(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value)
}

function fmtTokens(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`
  return fmtNum(value)
}

function fmtUsagePct(value?: number | null) {
  return typeof value === 'number' ? `${Math.round(value)}%` : null
}

function fmtReset(value?: string | null) {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function projectName(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.name ?? id
}

function projectContextLabel(projects: Project[], id: string) {
  if (id === 'active') return 'active-projects'
  if (id === 'all') return 'all-projects'
  return projectName(projects, id)
}

function runOutput(run: AgentRun) {
  return run.finalText || run.final_text || run.stdout || run.stderr || ''
}

function runWorktree(run: AgentRun) {
  return run.worktreePath || run.worktree_path || run.id
}

function runCommand(run: AgentRun) {
  return run.command || `${modelLabel(run.model)} command pending`
}

function runAttachCommand(run: AgentRun) {
  return run.attachCommand || run.attach_command || ''
}

function runCwd(run: AgentRun) {
  return run.cwd || runWorktree(run)
}

function runProjectId(run: AgentRun) {
  return run.projectId || run.project_id || 'northstar'
}

function runTaskId(run: AgentRun) {
  return run.taskId || run.task_id || run.id
}

function toStatus(status: string): Status {
  if (status === 'running' || status === 'needs-input' || status === 'queued' || status === 'blocked' || status === 'done' || status === 'idle') return status
  return status === 'complete' ? 'done' : 'queued'
}

function progressForRun(run: AgentRun) {
  if (run.status === 'done') return 1
  if (run.status === 'blocked') return 0.2
  const output = runOutput(run)
  return output ? 0.48 : 0.12
}

function workFromTask(task: QueueTask): ProjectWork {
  return {
    id: `task-${task.id}`,
    taskId: task.id,
    project: task.project,
    title: task.title,
    model: task.model,
    status: task.status,
    progress: task.progress,
    stage: task.stage,
    eta: task.eta,
    branch: task.branch,
    source: 'queue',
    detail: `${task.agent} · ${task.files} files`,
  }
}

function workFromRun(run: AgentRun): ProjectWork {
  const taskId = runTaskId(run)
  const detail = (runOutput(run) || run.prompt || 'Waiting for CLI output...').replace(/\s+/g, ' ').slice(0, 180)
  return {
    id: `run-${run.id}`,
    taskId,
    project: runProjectId(run),
    title: run.prompt?.slice(0, 90) || `CLI run ${taskId}`,
    model: run.model,
    status: toStatus(run.status),
    progress: progressForRun(run),
    stage: run.status === 'running' ? `${modelLabel(run.model)} running` : `${modelLabel(run.model)} ${run.status}`,
    eta: run.status === 'running' ? 'live' : 'finished',
    branch: runWorktree(run),
    source: 'run',
    detail,
    worktree: runWorktree(run),
    updatedAt: run.updatedAt || run.updated_at,
  }
}

function mergeProjectWork(queueTasks: QueueTask[], runs: AgentRun[], decisions: ProjectWork[]) {
  const byKey = new Map<string, ProjectWork>()
  ;[...queueTasks.map(workFromTask), ...runs.map(workFromRun), ...decisions].forEach((item) => {
    const key = item.taskId ? `${item.project}:${item.taskId}` : item.id
    const previous = byKey.get(key)
    if (!previous || item.source === 'run' || (previous.source === 'decision' && item.source === 'queue')) byKey.set(key, item)
  })
  return [...byKey.values()].sort((a, b) => {
    const rank: Record<Status, number> = { running: 0, 'needs-input': 1, queued: 2, blocked: 3, done: 4, idle: 5 }
    return rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)
  })
}

function StatusTag({ status }: { status: Status }) {
  return (
    <span className="tag">
      <i className={`dot ${statusDot[status]}${status === 'running' ? ' live' : ''}`} />
      {status.replace('-', ' ').toUpperCase()}
    </span>
  )
}

function ModelChip({ id, small = false }: { id: ModelId; small?: boolean }) {
  const model = models.find((item) => item.id === id)
  return (
    <span className="tag mono">
      <i className="dot" style={{ background: modelColor[id] }} />
      {small ? id.toUpperCase() : model?.label ?? id}
    </span>
  )
}

function InboxTypeIcon({ type }: { type: InboxAction['type'] }) {
  if (type === 'review') return <GitPullRequest size={15} />
  if (type === 'suggest') return <Sparkles size={15} />
  if (type === 'blocked') return <AlertTriangle size={15} />
  return <InboxIcon size={15} />
}

type VoiceEngine = 'whisper' | 'web-speech'
type VoiceState = 'idle' | 'listening-whisper' | 'listening-webspeech' | 'transcribing'

const voiceMeterBars = 18
const idleVoiceLevels = Array.from({ length: voiceMeterBars }, () => 0)
const preferredMicrophoneStorageKey = 'northstar.preferredBuiltInMicrophone'
const localMicConstraints: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

function scoreAudioInput(device: MediaDeviceInfo) {
  const label = device.label.toLowerCase()
  if (!label) return 0

  let score = 0
  if (/\bdefault\b/.test(label)) score += 5
  if (label.includes('built-in') || label.includes('built in') || label.includes('internal')) score += 100
  if (label.includes('macbook') || label.includes('mac microphone') || label.includes('studio display')) score += 80
  if (label.includes('iphone') || label.includes('ipad') || label.includes('continuity')) score -= 120
  if (label.includes('airpods') || label.includes('bluetooth') || label.includes('headset')) score -= 60
  return score
}

function readPreferredMicrophone() {
  try {
    return window.localStorage.getItem(preferredMicrophoneStorageKey)
  } catch {
    return null
  }
}

function rememberPreferredMicrophone(deviceId: string) {
  try {
    window.localStorage.setItem(preferredMicrophoneStorageKey, deviceId)
  } catch {
    // Persistence is helpful but not required for voice capture.
  }
}

function forgetPreferredMicrophone() {
  try {
    window.localStorage.removeItem(preferredMicrophoneStorageKey)
  } catch {
    // Nothing to clean up when localStorage is blocked.
  }
}

async function findPreferredMicrophoneDeviceId() {
  if (!navigator.mediaDevices?.enumerateDevices) return null

  const devices = await navigator.mediaDevices.enumerateDevices()
  const audioInputs = devices.filter((device) => device.kind === 'audioinput')
  const savedDeviceId = readPreferredMicrophone()
  const savedDevice = audioInputs.find((device) => device.deviceId === savedDeviceId)
  if (savedDevice && scoreAudioInput(savedDevice) >= 0) return savedDevice.deviceId

  const bestDevice = audioInputs
    .map((device) => ({ device, score: scoreAudioInput(device) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)[0]?.device

  if (!bestDevice) return null
  rememberPreferredMicrophone(bestDevice.deviceId)
  return bestDevice.deviceId
}

async function getPreferredMicrophoneStream() {
  const deviceId = await findPreferredMicrophoneDeviceId()

  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...localMicConstraints, deviceId: { exact: deviceId } },
      })
    } catch {
      forgetPreferredMicrophone()
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: localMicConstraints })
  const preferredDeviceId = await findPreferredMicrophoneDeviceId()
  if (!preferredDeviceId) return stream

  const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId
  if (activeDeviceId === preferredDeviceId) return stream

  stream.getTracks().forEach((track) => track.stop())
  return navigator.mediaDevices.getUserMedia({
    audio: { ...localMicConstraints, deviceId: { exact: preferredDeviceId } },
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Unable to read audio capture.'))
        return
      }
      const comma = reader.result.indexOf(',')
      resolve(reader.result.slice(comma + 1))
    }
    reader.onerror = () => reject(new Error('Unable to encode audio capture.'))
    reader.readAsDataURL(blob)
  })
}

async function transcribeWithWhisperServer(blob: Blob): Promise<string> {
  const audio = await blobToBase64(blob)
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio, mimeType: blob.type || 'audio/webm' }),
  })
  const payload = (await response.json().catch(() => null)) as
    | { ok: true; text: string }
    | { ok: false; reason?: string; fallback?: string }
    | null
  if (!payload) {
    throw new Error('Whisper unavailable (transcription service error)')
  }
  if (!response.ok || payload.ok === false) {
    const fallback = payload.ok === false ? payload.fallback : undefined
    const reason = payload.ok === false ? payload.reason ?? 'transcription service error' : `HTTP ${response.status}`
    throw new Error(`Whisper unavailable (${reason})${fallback ? '; fallback available' : ''}`)
  }
  return payload.text
}

function Sparkline({ data, width = 96, height = 24, color = 'var(--star)' }: { data: number[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width
      const y = height - ((value - min) / range) * (height - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function Ring({ value }: { value: number }) {
  const size = 36
  const stroke = 3
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const color = value > 0.8 ? 'var(--ok)' : value > 0.6 ? 'var(--star)' : 'var(--err)'
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={18} cy={18} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={stroke} />
      <circle cx={18} cy={18} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={c * (1 - value)} strokeLinecap="round" />
    </svg>
  )
}

function Rail({ view, setView, actionsOpen }: { view: View; setView: (view: View) => void; actionsOpen: number }) {
  const nav: Array<[View, React.ReactNode, string]> = [
    ['dashboard', <Boxes size={18} />, 'Dashboard'],
    ['health', <HeartPulse size={18} />, 'Health'],
    ['inbox', <InboxIcon size={18} />, 'Inbox'],
    ['queue', <Layers size={18} />, 'Agent Queue'],
    ['schedule', <Clock size={18} />, 'Schedule'],
    ['graph', <Network size={18} />, 'Graph Cockpit'],
    ['review', <GitPullRequest size={18} />, 'Patch Review'],
  ]
  return (
    <nav className="rail">
      <div className="rail-logo" title="Northstar">
        <Sparkles size={20} style={{ color: 'var(--star)' }} />
      </div>
      <div className="rail-nav">
        {nav.map(([id, icon, label]) => (
          <button key={id} className={`rail-btn${view === id ? ' on' : ''}`} title={label} aria-label={label} onClick={() => setView(id)}>
            {icon}
            {id === 'inbox' ? <span className="rail-badge">{actionsOpen}</span> : null}
            <span className="rail-tip">{label}</span>
          </button>
        ))}
      </div>
      <button className={`rail-btn${view === 'settings' ? ' on' : ''}`} title="Settings" aria-label="Settings" style={{ marginTop: 'auto' }} onClick={() => setView('settings')}>
        <Settings size={18} />
        <span className="rail-tip">Settings</span>
      </button>
    </nav>
  )
}

function ModelUsageCell({
  usage,
  auth,
  recheckAuth,
}: {
  usage: ModelUsage
  auth?: ModelAuthStatus
  recheckAuth: (status: ModelAuthStatus) => void
}) {
  const hasProviderUsage = usage.sourceFresh && (typeof usage.fiveHourUsedPct === 'number' || typeof usage.weeklyUsedPct === 'number')
  const authBlocked = auth ? !auth.ok : false
  const fivePct = typeof usage.fiveHourUsedPct === 'number'
    ? Math.min(1, usage.fiveHourUsedPct / 100)
    : usage.tokens5hCap ? Math.min(1, usage.tokens5h / usage.tokens5hCap) : 0
  const weekPct = typeof usage.weeklyUsedPct === 'number'
    ? Math.min(1, usage.weeklyUsedPct / 100)
    : usage.tokensWeekCap ? Math.min(1, usage.tokensWeek / usage.tokensWeekCap) : 0
  const fiveLabel = fmtUsagePct(usage.fiveHourUsedPct) ?? `${fmtTokens(usage.tokens5h)} / ${fmtTokens(usage.tokens5hCap)}`
  const weekLabel = fmtUsagePct(usage.weeklyUsedPct) ?? `${fmtTokens(usage.tokensWeek)} / ${fmtTokens(usage.tokensWeekCap)}`
  const fiveReset = fmtReset(usage.fiveHourResetAt)
  const weekReset = fmtReset(usage.weeklyResetAt)
  return (
    <div className={`model-usage${authBlocked ? ' warn' : ''}`} title={`${usage.source} · ${usage.provider}${authBlocked ? ` · ${auth?.blockers[0]}` : ''}`}>
      <div className="row gap6">
        <i className="dot" style={{ background: modelColor[usage.id] }} />
        <span className="mono model-usage-name">{usage.label}</span>
        <span className="grow" />
        {authBlocked && auth ? (
          <button type="button" className="auth-warn" title={`${auth.blockers[0]} Click to recheck ${auth.checkCommand}.`} onClick={() => recheckAuth(auth)}>
            <AlertTriangle size={11} />
          </button>
        ) : null}
        <span className={`tnum model-compute${hasProviderUsage ? ' real' : ''}`}>{usage.computePct}%</span>
      </div>
      <div className="usage-bars">
        <span className="eyebrow">5H</span>
        <div className="meter"><i style={{ width: pct(fivePct) }} /></div>
        <span className="tnum">{fiveLabel}{fiveReset ? ` >${fiveReset}` : ''}</span>
        <span className="eyebrow">WK</span>
        <div className="meter cool"><i style={{ width: pct(weekPct) }} /></div>
        <span className="tnum">{weekLabel}{weekReset ? ` >${weekReset}` : ''}</span>
      </div>
      <div className="usage-live">
        <span>{hasProviderUsage ? 'live source' : 'estimate'}</span>
        <span>{usage.liveRuns} live</span>
        <span>{usage.queued} queued</span>
      </div>
    </div>
  )
}

function HUD({
  view,
  projects,
  modelUsage,
  modelAuth,
  refreshModelAuth,
}: {
  view: View
  projects: Project[]
  modelUsage: ModelUsage[]
  modelAuth: ModelAuthStatus[]
  refreshModelAuth: () => Promise<ModelAuthStatus[]>
}) {
  const [clock, setClock] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-GB'))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  const title: Record<View, [string, string]> = {
    dashboard: ['FLIGHT DECK', `${projects.length} projects · local inventory`],
    health: ['HEALTH', 'Garmin-first body telemetry and goals'],
    inbox: ['MISSION INBOX', 'what needs you - across all projects'],
    queue: ['AGENT QUEUE', 'what to work on next'],
    schedule: ['SCHEDULE', 'overnight usage and onboarding'],
    graph: ['GRAPH COCKPIT', 'graphify-oriented knowledge graph'],
    review: ['PATCH REVIEW', 'worktree patch preview'],
    settings: ['SETTINGS', 'local guardrails and model routing'],
  }
  const [h, sub] = title[view]
  const authByModel = new Map(modelAuth.map((item) => [item.model, item]))
  const recheckAuth = async (status: ModelAuthStatus) => {
    const next = await refreshModelAuth()
    const updated = next.find((item) => item.model === status.model) ?? status
    setAuthNotice(
      updated.ok
        ? `${models.find((item) => item.id === updated.model)?.label ?? updated.model} auth OK via ${updated.checkCommand}.`
        : `${models.find((item) => item.id === updated.model)?.label ?? updated.model}: ${updated.blockers[0] ?? 'authentication is not ready'} Run ${updated.loginCommand}, then click the warning again.`,
    )
  }
  return (
    <header className="hud">
      <div className="row gap10">
        <span className="eyebrow" style={{ color: 'var(--star)' }}>NORTHSTAR</span>
        <span style={{ color: 'var(--line)' }}>/</span>
        <div className="col" style={{ lineHeight: 1.15 }}>
          <span className="mono" style={{ fontSize: 12, letterSpacing: '.06em' }}>{h}</span>
          <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{sub}</span>
        </div>
      </div>
      <div className="hud-usage">
        {modelUsage.map((usage) => <ModelUsageCell key={usage.id} usage={usage} auth={authByModel.get(usage.id)} recheckAuth={recheckAuth} />)}
        {authNotice ? <div className="auth-notice mono">{authNotice}</div> : null}
        <div className="row gap6"><Zap size={14} style={{ color: 'var(--star)' }} /><span className="tnum">{projects.filter((p) => p.status === 'needs-input').length}</span></div>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{clock}</span>
      </div>
    </header>
  )
}

function CommandBar({
  model,
  setModel,
  projects,
  projectContext,
  setProjectContext,
  setProjectActive,
  afterDispatch,
}: {
  model: ModelId
  setModel: (model: ModelId) => void
  projects: Project[]
  projectContext: string
  setProjectContext: (context: string) => void
  setProjectActive: (id: string, active: boolean) => void
  afterDispatch: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [open, setOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'ok' | 'warn'>('ok')
  const [dispatching, setDispatching] = useState(false)
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>('whisper')
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recognitionRef = useRef<any>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const activeEngineRef = useRef<VoiceEngine | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const meterAudioContextRef = useRef<AudioContext | null>(null)
  const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const webSpeechMeterStreamRef = useRef<MediaStream | null>(null)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const [voiceLevels, setVoiceLevels] = useState<number[]>(idleVoiceLevels)

  useEffect(() => {
    const hasSpeechApi = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
    const checkVoiceBackend = async () => {
      try {
        const response = await fetch('/api/transcribe/capabilities')
        const payload = (await response.json().catch(() => ({ whisperAvailable: false }))) as {
          whisperAvailable?: boolean
        }
        if (payload.whisperAvailable) setVoiceEngine('whisper')
        else if (hasSpeechApi) setVoiceEngine('web-speech')
        else setError('No speech input backend detected. Use keyboard input.')
      } catch {
        if (hasSpeechApi) setVoiceEngine('web-speech')
        else setError('No speech input backend detected. Use keyboard input.')
      }
    }

    void checkVoiceBackend()
  }, [])

  const stopVoiceMeter = () => {
    if (meterFrameRef.current !== null) window.cancelAnimationFrame(meterFrameRef.current)
    meterFrameRef.current = null
    meterSourceRef.current?.disconnect()
    meterSourceRef.current = null
    void meterAudioContextRef.current?.close().catch(() => {})
    meterAudioContextRef.current = null
    setVoiceLevels(idleVoiceLevels)
  }

  const stopWebSpeechMeterStream = () => {
    webSpeechMeterStreamRef.current?.getTracks().forEach((track) => track.stop())
    webSpeechMeterStreamRef.current = null
  }

  const startVoiceMeter = (stream: MediaStream) => {
    stopVoiceMeter()
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) return

    const audioContext = new AudioContextCtor()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72

    const source = audioContext.createMediaStreamSource(stream)
    source.connect(analyser)
    meterAudioContextRef.current = audioContext
    meterSourceRef.current = source

    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      const slice = Math.max(1, Math.floor(data.length / voiceMeterBars))
      const levels = Array.from({ length: voiceMeterBars }, (_, index) => {
        let sum = 0
        const start = index * slice
        const end = Math.min(data.length, start + slice)
        for (let i = start; i < end; i += 1) {
          const centered = (data[i] - 128) / 128
          sum += centered * centered
        }
        const rms = Math.sqrt(sum / Math.max(1, end - start))
        return Math.min(1, rms * 5.2)
      })
      setVoiceLevels(levels)
      meterFrameRef.current = window.requestAnimationFrame(tick)
    }

    meterFrameRef.current = window.requestAnimationFrame(tick)
  }

  useEffect(() => () => {
    stopVoiceMeter()
    stopWebSpeechMeterStream()
  }, [])

  useEffect(() => {
    if (!projectOpen) return

    const closeIfOutside = (event: PointerEvent | FocusEvent) => {
      const target = event.target
      if (target instanceof Node && projectMenuRef.current?.contains(target)) return
      setProjectOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectOpen(false)
    }

    document.addEventListener('pointerdown', closeIfOutside, true)
    document.addEventListener('focusin', closeIfOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true)
      document.removeEventListener('focusin', closeIfOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [projectOpen])

  const stopRecognition = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
  }

  const stopMediaRecorder = () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    mediaRecorderRef.current = null
  }

  const startWebSpeechCapture = async () => {
    const recognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!recognitionCtor) {
      setError('Browser speech API unavailable; use local Whisper or type directly.')
      setVoiceEngine('whisper')
      return
    }

    if (navigator.mediaDevices) {
      try {
        const meterStream = await getPreferredMicrophoneStream()
        webSpeechMeterStreamRef.current = meterStream
        startVoiceMeter(meterStream)
      } catch {
        stopVoiceMeter()
        stopWebSpeechMeterStream()
      }
    }

    const recognition = new recognitionCtor()
    recognitionRef.current = recognition
    activeEngineRef.current = 'web-speech'
    setError('')
    setRecording(true)
    setVoiceState('listening-webspeech')
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results).map((result: any) => result[0]?.transcript).join(' ').trim()
      if (transcript) setText(transcript)
    }

    recognition.onend = () => {
      stopVoiceMeter()
      stopWebSpeechMeterStream()
      setRecording(false)
      setVoiceState('idle')
      activeEngineRef.current = null
      setTimeout(() => {
        recognitionRef.current = null
      }, 0)
    }

    recognition.onerror = (event: any) => {
      stopVoiceMeter()
      stopWebSpeechMeterStream()
      setError(`Speech recognition failed: ${event?.error ?? 'unknown'}`)
      recognition.stop()
    }

    recognition.start()
  }

  const startWhisperCapture = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone capture unavailable in this context.')
      return
    }

    try {
      const stream = await getPreferredMicrophoneStream()
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      activeEngineRef.current = 'whisper'
      audioChunksRef.current = []
      startVoiceMeter(stream)
      setError('')
      setRecording(true)
      setVoiceState('listening-whisper')

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) audioChunksRef.current.push(event.data)
      }

      recorder.onstop = async () => {
        try {
          const chunks = audioChunksRef.current
          audioChunksRef.current = []
          stream.getTracks().forEach((track) => track.stop())
          mediaRecorderRef.current = null
          if (chunks.length === 0) {
            setError('No voice captured. Try again or use keyboard input.')
            return
          }
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType })
          setVoiceState('transcribing')
          const transcript = await transcribeWithWhisperServer(blob)
          setText(transcript.trim())
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unable to transcribe local capture.'
          setError(`${message} Falling back to browser speech on next click.`)
        } finally {
          stopVoiceMeter()
          setVoiceState('idle')
          setRecording(false)
          activeEngineRef.current = null
        }
      }

      recorder.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to access microphone.'
      setError(`${message} Check that the built-in MacBook microphone is allowed for this browser.`)
    }
  }

  const stopRecording = () => {
    if (activeEngineRef.current === 'whisper') stopMediaRecorder()
    else stopRecognition()
  }

  const toggleRecording = () => {
    if (voiceState === 'transcribing') return
    if (recording) {
      setError('')
      stopRecording()
      return
    }
    if (voiceEngine === 'whisper') {
      void startWhisperCapture()
      return
    }
    void startWebSpeechCapture()
  }

  const dispatchPrompt = async () => {
    const prompt = text.trim()
    if (!prompt) {
      setMessageTone('warn')
      setMessage('Type or speak a command before dispatch.')
      return
    }
    setError('')
    setMessageTone('ok')
    setMessage(`Dispatching ${models.find((item) => item.id === model)?.label ?? model}...`)
    setDispatching(true)
    const response = await apiSend<DispatchResponse>('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, projectContext }),
    })
    setDispatching(false)

    if (!response) {
      setMessageTone('warn')
      setMessage('Dispatch failed: local API is not reachable.')
      return
    }
    if (!response.ok) {
      setMessageTone('warn')
      setMessage(response.guardrails?.blockers?.[0] ?? response.error)
      return
    }

    setMessageTone('ok')
    setText('')
    setMessage(`${modelLabel(response.task.model)} running in ${response.run.worktreePath ?? 'worktree'}...`)
    void pollRun(response.run.id, response.task.model)
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return

      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(false)
        setProjectOpen(false)
        inputRef.current?.focus()
        inputRef.current?.select()
        return
      }

      if (event.key.toLowerCase() === 'j') {
        event.preventDefault()
        toggleRecording()
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        void dispatchPrompt()
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })

  const pollRun = async (runId: string, runModel: ModelId) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      const data = await apiJson<{ run?: AgentRun | null }>(`/api/runs/${runId}`)
      const run = data?.run
      if (!run) continue
      if (run.status === 'running') {
        const streamed = run.stdout || run.stderr || ''
        setMessage(`${modelLabel(runModel)} running${streamed ? `: ${streamed.replace(/\s+/g, ' ').slice(-96)}` : '...'}`)
        continue
      }
      const text = runOutput(run)
      setMessageTone(run.status === 'done' ? 'ok' : 'warn')
      setMessage(`${modelLabel(runModel)} ${run.status}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
      await afterDispatch()
      return
    }
    setMessageTone('warn')
    setMessage(`${modelLabel(runModel)} is still running. Check Agent Queue or /api/runs/${runId}.`)
  }

  const commandHint = voiceState === 'listening-webspeech'
    ? `Web Speech mode: ${model.toUpperCase()}`
    : voiceState === 'listening-whisper'
      ? 'Local Whisper capture running'
      : voiceState === 'transcribing'
        ? 'Transcribing locally'
        : voiceEngine === 'whisper'
          ? 'Local Whisper ready'
          : 'Browser speech ready'

  return (
    <div className="cmdbar">
      <div className={`cmd-shell${recording ? ' rec' : ''}`}>
        <button
          type="button"
          aria-label={recording ? 'Stop voice input' : 'Start voice input'}
          disabled={voiceState === 'transcribing'}
          className={`cmd-mic${recording ? ' on' : ''}`}
          onClick={toggleRecording}
          title={recording ? 'Stop dictation and transcribe' : voiceState === 'transcribing' ? 'Transcribing voice input' : 'Talk to Northstar'}
        >
          {recording ? <Square size={14} fill="currentColor" /> : <Mic size={17} />}
          {voiceState !== 'idle' ? <span className="mic-rings"><i></i><i></i><i></i></span> : null}
        </button>
        {recording ? (
          <div className="voice-meter on" aria-hidden="true" title="Voice input level">
            {voiceLevels.map((level, index) => (
              <i key={index} style={{ '--level': level } as React.CSSProperties} />
            ))}
          </div>
        ) : null}
        <div className="cmd-context" ref={projectMenuRef}>
          <button
            type="button"
            className="cmd-ctx"
            aria-label="Project context selector"
            aria-expanded={projectOpen}
            aria-haspopup="menu"
            onClick={() => setProjectOpen((value) => !value)}
          >
            <i className={`dot ${projectContext === 'all' || projects.some((project) => project.active) ? 'dot-run live' : 'dot-idle'}`} />
            <span className="mono">{projectContextLabel(projects, projectContext)}</span>
            <ChevronDown size={12} />
          </button>
          {projectOpen ? (
            <div className="project-menu fade-in" role="menu">
              <div className="eyebrow project-menu-hd">ACTIVE CONTEXT</div>
              <button
                type="button"
                className={`project-menu-all${projectContext === 'active' ? ' on' : ''}`}
                onClick={() => {
                  setProjectContext('active')
                  setProjectOpen(false)
                }}
              >
                <i className="dot dot-run" />
                <span className="mono grow">All active projects</span>
                <span className="chip-n">{projects.filter((project) => project.active).length}</span>
              </button>
              <button
                type="button"
                className={`project-menu-all${projectContext === 'all' ? ' on' : ''}`}
                onClick={() => {
                  setProjectContext('all')
                  setProjectOpen(false)
                }}
              >
                <Search size={13} />
                <span className="mono grow">All projects</span>
                <span className="chip-n">{projects.length}</span>
              </button>
              <div className="eyebrow project-menu-hd">PROJECT AUTONOMY</div>
              <div className="project-menu-list">
                {projects.map((project) => (
                  <div key={project.id} className={`project-opt${projectContext === project.id ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="project-pick"
                      disabled={!project.active}
                      onClick={() => {
                        setProjectContext(project.id)
                        setProjectOpen(false)
                      }}
                    >
                      <i className={`dot ${project.active ? 'dot-run live' : 'dot-idle'}`} />
                      <span className="mono grow">{project.name}</span>
                      <span className="project-state">{project.active ? 'active' : 'disabled'}</span>
                    </button>
                    <button
                      type="button"
                      className={`project-toggle${project.active ? ' on' : ''}`}
                      onClick={() => setProjectActive(project.id, !project.active)}
                    >
                      {project.active ? 'Disable' : 'Activate'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <input
          ref={inputRef}
          className="cmd-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            voiceState === 'listening-whisper' || voiceState === 'listening-webspeech'
              ? 'Listening…'
              : voiceState === 'transcribing'
                ? 'Transcribing…'
                : 'Direct an agent - ask status, queue graphify, or draft a patch'
          }
        />
        <div className="cmd-model" style={{ position: 'relative' }}>
          <button type="button" className="model-btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}><i className="dot" style={{ background: modelColor[model] }} /><span className="mono">{models.find((m) => m.id === model)?.label}</span><ChevronDown size={12} /></button>
          {open ? <div className="model-menu fade-in" role="menu">{models.map((m) => <button type="button" role="menuitemradio" aria-checked={m.id === model} key={m.id} className={`model-opt${m.id === model ? ' on' : ''}`} onClick={() => { setModel(m.id); setOpen(false) }}><i className="dot" style={{ background: modelColor[m.id] }} /><div className="col grow" style={{ alignItems: 'flex-start' }}><span className="mono">{m.label}</span><span style={{ fontSize: 10, color: 'var(--ink-3)' }}>{m.vendor} · {m.tier}</span></div>{m.id === model ? <Check size={14} /> : null}</button>)}</div> : null}
        </div>
        <button type="button" className="btn btn-primary" disabled={dispatching} onClick={dispatchPrompt}><ArrowRight size={15} /> {dispatching ? 'Running' : 'Dispatch'}</button>
      </div>
      <div className="cmd-hint">
        <span><span className="kbd">CMD K</span> command palette · <span className="kbd">CMD J</span> dictation</span>
        <span style={{ color: error ? 'var(--err)' : message ? (messageTone === 'ok' ? 'var(--ok)' : 'var(--star)') : 'var(--ink-4)' }}>{error || message || commandHint}</span>
        <span><span className="kbd">@</span> files · <span className="kbd">#</span> tasks</span>
      </div>
    </div>
  )
}

function modelLabel(model: ModelId) {
  if (model === 'opus') return 'Claude Code'
  if (model === 'spark') return 'Spark'
  return 'GPT-5.5'
}

function queueSourceLabel(task: QueueTask) {
  if (task.source !== 'telegram') return task.source
  const lane = task.model === 'codex' ? 'Codex' : modelLabel(task.model)
  return `Telegram -> ${lane} ${task.agent}`
}

function taskAgeLabel(value: string) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return 'age ?'
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
  if (minutes < 60) return `${minutes}m old`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h old`
  return `${Math.round(hours / 24)}d old`
}

function Dashboard({
  projects,
  overview,
  openInbox,
  openGraph,
  setProjectActive,
}: {
  projects: Project[]
  overview: OperationsOverview | null
  openInbox: (id: string) => void
  openGraph: () => void
  setProjectActive: (id: string, active: boolean) => void
}) {
  const [projectMode, setProjectMode] = useState<'active' | 'inactive' | 'all'>('active')
  const [projectLayout, setProjectLayout] = useState<'cards' | 'list' | 'mosaic'>('cards')
  const activeProjects = projects.filter((project) => project.active)
  const inactiveProjects = projects.filter((project) => !project.active)
  const visibleProjects = projectMode === 'active' ? activeProjects : projectMode === 'inactive' ? inactiveProjects : projects
  const local = projects.filter((p) => p.localExists !== false).length
  const github = projects.filter((p) => p.github).length
  const graphReady = projects.filter((p) => p.graphReady).length
  const activeGraphReady = activeProjects.filter((p) => p.graphReady).length
  const projectModeLabel = projectMode === 'active' ? 'ACTIVE PROJECTS' : projectMode === 'inactive' ? 'INACTIVE PROJECTS' : 'ALL PROJECTS'
  const summary = overview?.summary
  const pressure = overview?.queuePressure
  const next = overview?.nextAction
  return (
    <div className="screen">
      <div className="ops-overview panel brackets">
        <div className="ops-next">
          <span className="eyebrow" style={{ color: 'var(--star)' }}>NEXT CONTROL ACTION</span>
          <span className="ops-next-title">{next?.title ?? 'Load operations overview'}</span>
          <span className="ops-next-reason">{next?.reason ?? 'Northstar is waiting for the local operations snapshot.'}</span>
          <span className="mono ops-command">{next?.command ?? '/overview'}</span>
        </div>
        <div className="ops-metrics">
          <div><span className="tnum">{summary?.liveRuns ?? 0}</span><span>live runs</span></div>
          <div><span className="tnum">{summary?.openDecisions ?? 0}</span><span>decisions</span></div>
          <div><span className="tnum">{summary?.runnableTasks ?? 0}</span><span>runnable</span></div>
          <div><span className="tnum">{pressure?.manual ?? 0}</span><span>manual</span></div>
          <div><span className="tnum">{pressure?.githubOnly ?? 0}</span><span>github-only</span></div>
        </div>
        <div className="ops-telegram">
          <span className="tag mono"><i className={`dot ${overview?.telegram.ready ? 'dot-run live' : 'dot-idle'}`} />Telegram {overview?.telegram.ready ? 'ready' : 'offline'}</span>
          <span className="mono">{overview?.telegram.sessions?.length ?? 0} routes</span>
        </div>
      </div>
      <div className="dash-stats">
        <Stat label="PROJECTS TRACKED" value={summary?.totalProjects ?? projects.length} sub={`${local} local · ${github} GitHub linked`} icon={<Boxes size={14} />} onClick={() => setProjectMode('all')} />
        <Stat label="ACTIVE PROJECTS" value={summary?.activeProjects ?? activeProjects.length} sub={`${activeGraphReady} graph ready · slow-lane context`} accent="var(--star)" icon={<Zap size={14} />} onClick={() => setProjectMode('active')} />
        <Stat label="QUEUE OPEN" value={pressure?.totalOpen ?? projects.reduce((sum, project) => sum + project.openTasks, 0)} sub={`${pressure?.schedulerWaiting ?? 0} scheduler-waiting · ${pressure?.blocked ?? 0} blocked`} icon={<Layers size={14} />} onClick={() => setProjectMode('all')} />
        <Stat label="GRAPH READY" value={graphReady} sub={`${Math.max(0, projects.length - graphReady)} missing graphify snapshots`} accent="var(--cyan)" icon={<Network size={14} />} onClick={openGraph} />
      </div>
      <div className="dash-body">
        <div className="dash-main scroll">
          <div className="row gap10 dash-project-head">
            <span className="eyebrow">{projectModeLabel}</span>
            <span className="tnum" style={{ fontSize: 11, color: 'var(--ink-4)' }}>{visibleProjects.length} visible · {projects.length} tracked</span>
            <span className="grow" />
            <div className="dash-layout-toggle" aria-label="Dashboard layout">
              {(['cards', 'list', 'mosaic'] as const).map((layout) => (
                <button key={layout} type="button" className={`chip${projectLayout === layout ? ' on' : ''}`} onClick={() => setProjectLayout(layout)}>
                  {layout}
                </button>
              ))}
            </div>
            {projectMode !== 'active' ? <button type="button" className="dash-link" onClick={() => setProjectMode('active')}>Show active</button> : null}
            {inactiveProjects.length ? <button type="button" className="dash-link" onClick={() => setProjectMode('inactive')}>Show inactive</button> : null}
          </div>
          {visibleProjects.length ? (
            projectLayout === 'list' ? (
              <div className="panel brackets dash-list">
                {visibleProjects.map((p) => <ProjectRow key={p.id} project={p} onClick={() => openInbox(p.id)} />)}
              </div>
            ) : projectLayout === 'mosaic' ? (
              <div className="dash-mosaic">
                {visibleProjects.map((p, index) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    onClick={() => openInbox(p.id)}
                    setProjectActive={setProjectActive}
                    className={index === 0 ? 'mos-hero' : index % 5 === 2 ? 'mos-tall' : undefined}
                  />
                ))}
              </div>
            ) : (
              <div className="dash-cards">{visibleProjects.map((p) => <ProjectCard key={p.id} project={p} onClick={() => openInbox(p.id)} setProjectActive={setProjectActive} />)}</div>
            )
          ) : (
            <div className="panel brackets dash-empty">
              <Check size={22} style={{ color: 'var(--ok)' }} />
              <span className="mono">No {projectMode} projects.</span>
              <button type="button" className="btn btn-sm" onClick={() => setProjectMode(projectMode === 'active' ? 'inactive' : 'active')}>
                {projectMode === 'active' ? 'Review inactive projects' : 'Back to active projects'}
              </button>
            </div>
          )}
        </div>
        <div className="dash-side"><Telemetry projects={visibleProjects.length ? visibleProjects : projects} /></div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, icon, accent, onClick }: { label: string; value: string | number; sub: string; icon: React.ReactNode; accent?: string; onClick?: () => void }) {
  const content = <><div className="row gap8" style={{ justifyContent: 'space-between' }}><span className="eyebrow">{label}</span><span style={{ color: accent ?? 'var(--ink-3)' }}>{icon}</span></div><span className="tnum" style={{ display: 'block', marginTop: 8, fontSize: 30, lineHeight: 1, color: accent ?? 'var(--ink)' }}>{value}</span><div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6 }}>{sub}</div></>
  if (onClick) return <button type="button" className="panel brackets stat-tile stat-action" onClick={onClick}>{content}</button>
  return <div className="panel brackets stat-tile">{content}</div>
}

function ProjectCard({ project, onClick, setProjectActive, className }: { project: Project; onClick: () => void; setProjectActive: (id: string, active: boolean) => void; className?: string }) {
  const sourceLabel = project.source === 'manual' ? 'manual workflow' : project.localExists === false ? 'github-only' : project.github ? 'local + github' : 'local'
  const sourceDetail = project.source === 'manual' ? project.path.replace(/^manual:/, '') : project.github?.fullName ?? 'no GitHub remote'
  const visibility = project.github?.visibility && project.github.visibility !== 'unknown' ? project.github.visibility : null
  return (
    <div
      className={`panel brackets proj-card${project.active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClick()
      }}
    >
      <div className="row gap10" style={{ justifyContent: 'space-between' }}><div className="row gap8 grow"><Ring value={project.health} /><div className="col grow" style={{ minWidth: 0 }}><span className="mono proj-name">{project.name}</span><span className="row gap6" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}><GitBranch size={11} />{project.branch}<span className={`lbl lbl-${project.label}`}>{project.label}</span></span></div></div><StatusTag status={project.status} /></div>
      <div className="proj-source">
        <span className="tag mono"><i className={`dot ${project.localExists === false ? 'dot-queue' : 'dot-run'}`} />{sourceLabel}</span>
        <span className="proj-gh mono">{sourceDetail}</span>
        <span className={`tag mono skill-tag${project.skillsReady ? ' on' : ''}`} title={project.skillsPath ?? 'Project skills file'}>
          <Sparkles size={11} />
          {project.skillsReady ? `${project.learnedItems ?? 0} learned` : 'skills blank'}
        </span>
        {visibility ? <span className="chip tiny">{visibility}</span> : null}
      </div>
      <div className="proj-meta"><div className="pm"><span className="eyebrow">LANG</span><span className="mono">{project.lang}</span></div><div className="pm"><span className="eyebrow">NODES</span><span className="tnum">{fmtNum(project.nodes)}</span></div><div className="pm"><span className="eyebrow">GRAPH</span><span className="tnum">{project.graphReady ? 'ready' : 'missing'}</span></div><div className="pm"><span className="eyebrow">RUNTIME</span><span className="tnum">{project.runtime}</span></div></div>
      <div className="row gap8" style={{ margin: '2px 0 4px' }}><Sparkline data={project.spark} width={120} color={project.status === 'blocked' ? 'var(--err)' : 'var(--star)'} /><span className="grow" /><div className="col" style={{ alignItems: 'flex-end' }}><span className="tnum" style={{ fontSize: 11 }}>{project.linesNet}</span><span className="eyebrow" style={{ fontSize: 9 }}>WORKTREE</span></div></div>
      <div className="proj-foot"><div className="row gap8"><span className="tag"><i className={`dot ${project.agentsActive ? 'dot-run live' : 'dot-idle'}`} />{project.agentsActive ? `${project.agentsActive} AGENT` : 'IDLE'}</span><span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{project.openTasks} open · {project.queued} queued</span></div><button type="button" className={`btn btn-sm project-active-btn${project.active ? ' on' : ''}`} onClick={(event) => { event.stopPropagation(); setProjectActive(project.id, !project.active) }}>{project.active ? 'Disable' : 'Activate'}</button></div>
      <span className="proj-event mono">{project.lastEvent}<span style={{ color: 'var(--ink-4)' }}> · {project.lastAgo}</span></span>
      <div className="meter" style={{ marginTop: 2 }}><i style={{ width: pct(Math.min(1, project.tokens / project.budget)) }} /></div>
    </div>
  )
}

function ProjectRow({ project, onClick }: { project: Project; onClick: () => void }) {
  return (
    <button type="button" className="proj-row" onClick={onClick}>
      <Ring value={project.health} />
      <div className="col grow" style={{ minWidth: 0 }}>
        <div className="row gap8">
          <span className="mono proj-name">{project.name}</span>
          <span className={`lbl lbl-${project.label}`}>{project.label}</span>
        </div>
        <span className="mono proj-row-path">{project.branch} · {project.path}</span>
      </div>
      <span className="tag mono">{project.lang}</span>
      <span className="tag mono">{project.graphReady ? 'graph ready' : 'graph missing'}</span>
      <span className="tnum proj-row-stat">{project.openTasks} open</span>
      <span className="tnum proj-row-stat">{project.queued} queued</span>
      <StatusTag status={project.status} />
    </button>
  )
}

function Telemetry({ projects }: { projects: Project[] }) {
  return <div className="panel brackets col" style={{ overflow: 'hidden' }}><div className="panel-hd"><Zap size={14} style={{ color: 'var(--star)' }} /><h3>Telemetry Stream</h3><span className="grow" /><i className="dot dot-run live" /></div><div className="scroll grow" style={{ padding: '6px 4px' }}>{projects.slice(0, 8).map((p) => <div key={p.id} className="feed-row"><span className="tnum feed-time">{p.lastAgo}</span><AlertTriangle size={13} style={{ color: p.status === 'needs-input' ? 'var(--cyan)' : 'var(--star)', flex: 'none' }} /><div className="col grow"><span style={{ fontSize: 12 }}>{p.lastEvent}</span><span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{p.name} · {p.lang}</span></div></div>)}</div></div>
}

function avg(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function metricTrend(metrics: HealthDailyMetric[], key: keyof Pick<HealthDailyMetric, 'restingHr' | 'sleepHours' | 'activeCalories' | 'trainingMinutes' | 'readiness'>) {
  const midpoint = Math.max(1, Math.floor(metrics.length / 2))
  return avg(metrics.slice(midpoint).map((metric) => metric[key])) - avg(metrics.slice(0, midpoint).map((metric) => metric[key]))
}

function intensityClass(intensity: string) {
  if (intensity === 'hard') return 'hard'
  if (intensity === 'moderate') return 'mod'
  if (intensity === 'easy') return 'easy'
  return 'recovery'
}

type GarminSyncResponse = {
  ok?: boolean
  source?: 'garmin'
  imported?: { dailyMetrics?: number; activities?: number }
  skipped?: number
  warnings?: string[]
  latestDate?: string | null
  importRoot?: string
  error?: string
  detail?: string
}

function garminSyncMessage(response: GarminSyncResponse | null) {
  if (!response) return 'Garmin sync failed. Check that the Northstar API is running.'
  const daily = response.imported?.dailyMetrics ?? 0
  const activities = response.imported?.activities ?? 0
  const latest = response.latestDate ? ` through ${response.latestDate}` : ''
  const warning = response.warnings?.[0] ? ` Warning: ${response.warnings[0]}` : ''
  if (response.ok) return `Garmin import complete: ${daily} daily metrics, ${activities} activities${latest}.${warning}`

  const root = response.importRoot ? ` Put the extracted Garmin export JSON under ${response.importRoot}.` : ''
  const detail = response.detail ? ` ${response.detail}` : ''
  if (response.error === 'garmin_import_directory_missing') return `Garmin import folder is missing.${root}${detail}`
  if (response.error === 'garmin_export_files_missing') return `No Garmin JSON export files found.${root}`
  if (response.error === 'garmin_export_no_importable_records') return `Garmin files were readable, but no dashboard metrics or activities were recognized.${warning || detail}`
  return `Garmin import failed: ${response.error ?? 'unknown error'}.${detail || warning}`
}

function garminSyncSummary(response?: GarminSyncResponse) {
  if (!response) return 'garmin unavailable'
  if (response.ok) return `garmin ${response.imported?.dailyMetrics ?? 0} daily/${response.imported?.activities ?? 0} activities`
  if (response.error === 'garmin_export_files_missing' || response.error === 'garmin_import_directory_missing') return 'garmin waiting for export files'
  return `garmin ${response.error ?? 'failed'}`
}

function HealthStat({
  label,
  value,
  unit,
  trend,
  icon,
  data,
  goodDown = false,
}: {
  label: string
  value: string | number
  unit: string
  trend: number
  icon: React.ReactNode
  data: number[]
  goodDown?: boolean
}) {
  const direction = Math.abs(trend) < 0.1 ? 'flat' : trend > 0 ? 'up' : 'down'
  const positive = direction === 'flat' || (goodDown ? trend < 0 : trend > 0)
  return (
    <div className="panel brackets health-stat">
      <div className="row gap8">
        <span className="health-stat-icon">{icon}</span>
        <span className="eyebrow grow">{label}</span>
        <span className={`health-trend ${positive ? 'good' : 'watch'}`}>{direction === 'flat' ? 'steady' : `${trend > 0 ? '+' : ''}${trend.toFixed(trend > 10 ? 0 : 1)}`}</span>
      </div>
      <div className="row gap10 health-stat-main">
        <span className="tnum">{value}</span>
        <span className="mono">{unit}</span>
        <span className="grow" />
        <Sparkline data={data} width={104} height={28} color={positive ? 'var(--star)' : 'var(--err)'} />
      </div>
    </div>
  )
}

function Health() {
  const [profile, setProfile] = useState<HealthProfile>(healthProfile)
  const [syncSources, setSyncSources] = useState<HealthSyncStatus[]>([])
  const [activities, setActivities] = useState<HealthActivity[]>([])
  const [goalId, setGoalId] = useState(profile.goalId)
  const [weight, setWeight] = useState(profile.weight)
  const [weeklyHours, setWeeklyHours] = useState(profile.goals.find((goal) => goal.id === profile.goalId)?.weeklyTrainingHours ?? 6)
  const [stravaClientId, setStravaClientId] = useState('')
  const [stravaClientSecret, setStravaClientSecret] = useState('')
  const [syncMessage, setSyncMessage] = useState('')
  const [syncing, setSyncing] = useState<null | 'strava' | 'garmin' | 'all'>(null)
  const selectedGoal = profile.goals.find((goal) => goal.id === goalId) ?? profile.goals[0]
  const metrics = profile.metrics
  const latest = metrics[metrics.length - 1]
  const stravaStatus = syncSources.find((source) => source.source === 'strava')
  const garminStatus = syncSources.find((source) => source.source === 'garmin')
  const restingHrAvg = Math.round(avg(metrics.map((metric) => metric.restingHr)))
  const sleepAvg = avg(metrics.map((metric) => metric.sleepHours))
  const activeCaloriesAvg = Math.round(avg(metrics.map((metric) => metric.activeCalories)))
  const readinessAvg = avg(metrics.map((metric) => metric.readiness))
  const maintenance = Math.round(selectedGoal.maintenanceCalories + (weeklyHours - selectedGoal.weeklyTrainingHours) * 45 + (weight - selectedGoal.targetWeight) * 7)
  const weeklyMinutes = profile.weeklyPlan.reduce((sum, day) => sum + day.duration, 0)
  const durationScale = weeklyMinutes ? Math.max(0.55, Math.min(1.55, (weeklyHours * 60) / weeklyMinutes)) : 1
  const plannedMinutes = Math.round(profile.weeklyPlan.reduce((sum, day) => sum + day.duration * durationScale, 0))

  const loadHealth = async () => {
    const data = await apiJson<{ profile?: HealthProfile; sync?: HealthSyncStatus[]; activities?: HealthActivity[] }>('/api/health')
    if (data?.profile) {
      setProfile(data.profile)
      setGoalId(data.profile.goalId)
      setWeight(data.profile.weight)
      const nextGoal = data.profile.goals.find((goal) => goal.id === data.profile?.goalId)
      if (nextGoal) setWeeklyHours(nextGoal.weeklyTrainingHours)
    }
    if (data?.sync) setSyncSources(data.sync)
    if (data?.activities) setActivities(data.activities)
  }

  useEffect(() => {
    void loadHealth()
  }, [])

  const updateGoal = (nextGoalId: string) => {
    const nextGoal = profile.goals.find((goal) => goal.id === nextGoalId)
    setGoalId(nextGoalId)
    if (nextGoal) {
      setWeeklyHours(nextGoal.weeklyTrainingHours)
      setWeight(nextGoal.targetWeight)
    }
  }

  const saveStravaConfig = async () => {
    if (!stravaClientId.trim() || !stravaClientSecret.trim()) {
      setSyncMessage('Strava client id and secret are required.')
      return
    }
    const response = await apiSend<{ ok?: boolean; authUrl?: { authorizationUrl?: string }; error?: string }>('/api/health/strava/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: stravaClientId.trim(), clientSecret: stravaClientSecret.trim() }),
    })
    if (response?.ok) {
      setSyncMessage('Strava app saved locally. Open Strava auth next.')
      setStravaClientSecret('')
      await loadHealth()
      return
    }
    setSyncMessage(response?.error ?? 'Unable to save Strava app config.')
  }

  const openStravaAuth = async () => {
    const response = await apiJson<{ ok?: boolean; authorizationUrl?: string; error?: string }>('/api/health/strava/connect')
    if (response?.authorizationUrl) {
      window.open(response.authorizationUrl, '_blank', 'noopener,noreferrer')
      setSyncMessage('Finish Strava authorization in the new tab, then press Sync Strava.')
      return
    }
    setSyncMessage(response?.error ?? 'Strava app config is missing.')
  }

  const syncStrava = async () => {
    if (stravaStatus?.authState === 'missing_config' || !stravaStatus?.configured) {
      setSyncMessage('Save a Strava app client id and secret first.')
      return
    }
    if (stravaStatus.authState === 'needs_auth') {
      await openStravaAuth()
      return
    }
    setSyncing('strava')
    const response = await apiSend<{ ok?: boolean; imported?: number; seen?: number; error?: string }>('/api/health/sync/strava', { method: 'POST' })
    setSyncing(null)
    if (response?.ok) {
      setSyncMessage(`Strava sync complete: ${response.imported ?? 0} activities stored.`)
      await loadHealth()
      return
    }
    setSyncMessage(response?.error === 'strava_needs_auth' ? 'Open Strava auth, then sync again.' : response?.error ?? 'Strava sync failed.')
    await loadHealth()
  }

  const pullGarmin = async () => {
    setSyncing('garmin')
    const response = await apiSend<GarminSyncResponse>('/api/health/sync/garmin', { method: 'POST' })
    setSyncing(null)
    setSyncMessage(garminSyncMessage(response))
    await loadHealth()
  }

  const syncAll = async () => {
    setSyncing('all')
    const response = await apiSend<{ ok?: boolean; summary?: { strava: { ok?: boolean; error?: string }; garmin: GarminSyncResponse } }>(
      '/api/health/sync/all',
      { method: 'POST' },
    )
    setSyncing(null)
    if (response?.ok) {
      const garminMsg = garminSyncSummary(response.summary?.garmin)
      const stravaMsg = response.summary?.strava?.ok ? 'strava synced' : response.summary?.strava?.error ?? 'strava needs setup'
      setSyncMessage(`Health pull complete: ${stravaMsg}, ${garminMsg}`)
    } else {
      setSyncMessage(response?.summary?.strava?.error === 'strava_needs_auth' ? 'Open Strava auth, then sync all again.' : response?.summary?.strava?.error || garminSyncMessage(response?.summary?.garmin ?? null))
    }
    await loadHealth()
  }

  return (
    <div className="screen health-screen">
      <div className="health-hero panel brackets">
        <div className="col grow">
          <div className="row gap8">
            <HeartPulse size={16} style={{ color: 'var(--star)' }} />
            <span className="eyebrow">BODY TELEMETRY</span>
            <span className={`tag mono${garminStatus?.connected ? '' : ' dim'}`}><i className={`dot ${garminStatus?.connected ? 'dot-run live' : 'dot-idle'}`} />Garmin {garminStatus?.authState ?? 'pending'}</span>
            <span className={`tag mono${stravaStatus?.connected ? '' : ' dim'}`}><Bike size={11} />Strava {stravaStatus?.authState ?? 'pending'}</span>
          </div>
          <h2 className="health-title">Health cockpit</h2>
          <p>Resting heart rate, sleep, active calories, weight, maintenance fuel, and weekly training intent in one local-first view.</p>
        </div>
        <div className="health-sync">
          <span className="eyebrow">SOURCE SYNC</span>
          <span className="mono">{syncMessage || profile.lastSync}</span>
          {stravaStatus?.authState === 'missing_config' || !stravaStatus?.configured ? (
            <div className="health-config">
              <input aria-label="Strava client ID" value={stravaClientId} onChange={(event) => setStravaClientId(event.target.value)} placeholder="Strava client id" />
              <input aria-label="Strava client secret" value={stravaClientSecret} onChange={(event) => setStravaClientSecret(event.target.value)} placeholder="Strava client secret" type="password" />
              <button type="button" className="btn btn-sm" onClick={saveStravaConfig}>Save Strava app</button>
            </div>
          ) : null}
          <div className="row gap6 health-sync-actions">
            <button type="button" className="btn btn-primary" onClick={syncAll} disabled={syncing === 'all'}>{syncing === 'all' ? 'Pulling' : 'Pull health'}</button>
            <button type="button" className="btn btn-primary" onClick={syncStrava} disabled={syncing === 'strava'}>{syncing === 'strava' ? 'Syncing' : stravaStatus?.authState === 'needs_auth' ? 'Connect Strava' : 'Sync Strava'}</button>
            <button type="button" className="btn" onClick={pullGarmin} disabled={syncing === 'garmin'}>{syncing === 'garmin' ? 'Pulling' : 'Pull Garmin'}</button>
          </div>
        </div>
      </div>

      <div className="health-stats">
        <HealthStat label="RESTING HR" value={restingHrAvg} unit="bpm avg" trend={metricTrend(metrics, 'restingHr')} icon={<HeartPulse size={14} />} data={metrics.map((metric) => metric.restingHr)} goodDown />
        <HealthStat label="SLEEP" value={sleepAvg.toFixed(1)} unit="hr avg" trend={metricTrend(metrics, 'sleepHours')} icon={<Moon size={14} />} data={metrics.map((metric) => metric.sleepHours)} />
        <HealthStat label="ACTIVE CALORIES" value={activeCaloriesAvg} unit="daily avg" trend={metricTrend(metrics, 'activeCalories')} icon={<Flame size={14} />} data={metrics.map((metric) => metric.activeCalories)} />
        <HealthStat label="READINESS" value={Math.round(readinessAvg * 100)} unit="% avg" trend={metricTrend(metrics, 'readiness') * 100} icon={<Activity size={14} />} data={metrics.map((metric) => metric.readiness)} />
      </div>

      <div className="health-grid">
        <div className="panel brackets col health-goals">
          <div className="panel-hd">
            <Target size={14} style={{ color: 'var(--star)' }} />
            <h3>Goals + Fuel</h3>
            <span className="grow" />
            <span className="tag mono">{selectedGoal.label}</span>
          </div>
          <div className="health-form">
            <label className="field-row">
              <span>Goal</span>
              <select value={goalId} onChange={(event) => updateGoal(event.target.value)}>
                {profile.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.label}</option>)}
              </select>
              <b>{weeklyHours}h/wk</b>
            </label>
            <label className="field-row">
              <span>Weight</span>
              <input type="number" min="90" max="320" value={weight} onChange={(event) => setWeight(Number(event.target.value))} />
              <b>lb</b>
            </label>
            <label className="field-row">
              <span>Training load</span>
              <input type="range" min="2" max="12" step="0.5" value={weeklyHours} onChange={(event) => setWeeklyHours(Number(event.target.value))} />
              <b>{weeklyHours}h</b>
            </label>
          </div>
          <div className="health-fuel">
            <div>
              <span className="eyebrow">MAINTENANCE</span>
              <span className="tnum">{maintenance}</span>
              <span>kcal/day</span>
            </div>
            <div>
              <span className="eyebrow">TARGET</span>
              <span className="tnum">{selectedGoal.targetWeight}</span>
              <span>lb</span>
            </div>
            <div>
              <span className="eyebrow">FOCUS</span>
              <p>{selectedGoal.focus}</p>
            </div>
          </div>
        </div>

        <div className="panel brackets col health-plan">
          <div className="panel-hd">
            <CalendarDays size={14} />
            <h3>Weekly Plan</h3>
            <span className="grow" />
            <span className="tag mono">{plannedMinutes} min</span>
          </div>
          <div className="health-plan-list">
            {profile.weeklyPlan.map((item) => {
              const duration = Math.round(item.duration * durationScale)
              return (
                <div key={item.day} className="health-day">
                  <span className={`health-intensity ${intensityClass(item.intensity)}`} />
                  <span className="mono health-day-name">{item.day}</span>
                  <div className="col grow">
                    <span>{item.focus}</span>
                    <span className="mono">{item.intensity}</span>
                  </div>
                  <span className="tnum">{duration}m</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="panel brackets col health-recovery">
          <div className="panel-hd">
            <Dumbbell size={14} />
            <h3>Recovery Readout</h3>
            <span className="grow" />
            <span className="tag mono">{latest.date}</span>
          </div>
          <div className="health-recovery-body">
            <div className="health-readiness">
              <Ring value={latest.readiness} />
              <div className="col">
                <span className="tnum">{Math.round(latest.readiness * 100)}%</span>
                <span className="mono">readiness</span>
              </div>
            </div>
            <div className="health-signal-row"><Moon size={13} /><span>Sleep debt</span><span className="grow" /><b>{Math.max(0, 7.5 - latest.sleepHours).toFixed(1)}h</b></div>
            <div className="health-signal-row"><HeartPulse size={13} /><span>Resting HR</span><span className="grow" /><b>{latest.restingHr} bpm</b></div>
            <div className="health-signal-row"><Flame size={13} /><span>Active burn</span><span className="grow" /><b>{latest.activeCalories} kcal</b></div>
          </div>
        </div>

        <div className="panel brackets col health-weight">
          <div className="panel-hd">
            <Scale size={14} />
            <h3>Trackers + Imports</h3>
            <span className="grow" />
            <span className="tag mono">{activities.length} acts</span>
          </div>
          <div className="health-manual">
            <div><span className="eyebrow">WEIGHT</span><span className="tnum">{weight}</span><span>lb</span></div>
            <div><span className="eyebrow">ACTIVE AVG</span><span className="tnum">{activeCaloriesAvg}</span><span>kcal</span></div>
            <div><span className="eyebrow">TRAINING</span><span className="tnum">{Math.round(avg(metrics.map((metric) => metric.trainingMinutes)))}</span><span>min/day</span></div>
          </div>
          <div className="health-activities">
            {activities.slice(0, 3).map((activity) => (
              <div key={activity.id} className="health-activity-row">
                <span className="mono">{activity.type}</span>
                <span className="grow">{activity.name}</span>
                <span className="tnum">{Math.round(activity.duration_sec / 60)}m</span>
              </div>
            ))}
            {!activities.length ? <div className="health-activity-empty">No imported activities yet.</div> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function WorkCard({ item, compact = false }: { item: ProjectWork; compact?: boolean }) {
  const sourceLabel = item.source === 'run' ? 'CLI RUN' : item.source === 'decision' ? 'INBOX DECISION' : 'QUEUE TASK'
  const sourceDetail =
    item.source === 'run'
      ? 'Spawned local CLI process; command and output are visible in Queue.'
      : item.source === 'decision'
        ? 'Decision recorded; dispatch a queue task to spawn a local CLI process.'
        : 'Queued for local dispatch; use Run or Dispatch to start the CLI.'
  return (
    <div className={`work-card${compact ? ' compact' : ''}`}>
      <div className="row gap8">
        <i className={`dot ${statusDot[item.status]}${item.status === 'running' ? ' live' : ''}`} />
        <span className="mono work-id">{item.taskId ?? item.id}</span>
        <span className="grow" />
        <ModelChip id={item.model} small />
      </div>
      <div className="work-source mono" title={sourceDetail}>
        <Terminal size={11} />
        <span>{sourceLabel}</span>
      </div>
      <div className="work-title">{item.title}</div>
      <div className="row gap8 work-meta">
        <span>{item.stage}</span>
        <span className="grow" />
        <span className="mono">{item.eta}</span>
      </div>
      <div className="meter"><i style={{ width: pct(Math.min(1, Math.max(0, item.progress))) }} /></div>
      {item.detail ? <p>{item.detail}</p> : null}
      <p className="work-source-detail">{sourceDetail}</p>
      {item.worktree || item.branch ? <div className="work-path mono">{item.worktree ?? item.branch}</div> : null}
    </div>
  )
}

function ProjectOperations({
  projects,
  projectFilter,
  selectedProjectId,
  setSelectedProjectId,
  workItems,
}: {
  projects: Project[]
  projectFilter: string | null
  selectedProjectId: string | null
  setSelectedProjectId: (id: string) => void
  workItems: ProjectWork[]
}) {
  const visibleProjects = projectFilter ? projects.filter((project) => project.id === projectFilter) : projects
  const visibleWork = workItems.filter((item) => !projectFilter || item.project === projectFilter)
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? visibleProjects[0] ?? projects[0]
  const projectWork = selectedProject ? visibleWork.filter((item) => item.project === selectedProject.id) : visibleWork
  const projectActiveWork = projectWork.filter((item) => item.status === 'running' || item.status === 'queued' || item.status === 'needs-input')
  const runningCount = visibleWork.filter((item) => item.status === 'running').length

  return (
    <div className="project-ops col">
      <div className="panel-hd">
        <Zap size={14} style={{ color: 'var(--star)' }} />
        <h3>Project Operations</h3>
        <span className="grow" />
        <span className="tag mono"><i className="dot dot-run live" />{runningCount} live</span>
      </div>
      <div className="ops-projects">
        {visibleProjects.map((project) => {
          const count = visibleWork.filter((item) => item.project === project.id && item.status !== 'done').length
          return (
            <button
              type="button"
              key={project.id}
              className={`ops-project${selectedProject?.id === project.id ? ' on' : ''}`}
              onClick={() => setSelectedProjectId(project.id)}
            >
              <i className={`dot ${project.agentsActive ? 'dot-run live' : statusDot[project.status]}`} />
              <span className="mono grow">{project.name}</span>
              <span className="chip-n">{count}</span>
            </button>
          )
        })}
      </div>
      {selectedProject ? (
        <div className="ops-summary">
          <div className="row gap8">
            <Ring value={selectedProject.health} />
            <div className="col grow" style={{ minWidth: 0 }}>
              <span className="mono proj-name">{selectedProject.name}</span>
              <span className="ops-sub">{selectedProject.branch} · {selectedProject.lang} · {selectedProject.runtime}</span>
            </div>
            <StatusTag status={selectedProject.status} />
          </div>
          <div className="proj-meta ops-meta">
            <div className="pm"><span className="eyebrow">ACTIVE</span><span className="tnum">{selectedProject.agentsActive}</span></div>
            <div className="pm"><span className="eyebrow">OPEN</span><span className="tnum">{selectedProject.openTasks}</span></div>
            <div className="pm"><span className="eyebrow">QUEUE</span><span className="tnum">{selectedProject.queued}</span></div>
            <div className="pm"><span className="eyebrow">GRAPH</span><span className="tnum">{selectedProject.graphReady ? 'ready' : 'miss'}</span></div>
          </div>
        </div>
      ) : null}
      <div className="ops-section-hd">
        <span className="eyebrow">WORK IN FLIGHT</span>
        <span className="tnum">{projectActiveWork.length}</span>
      </div>
      <div className="ops-work scroll">
        {projectWork.length ? (
          projectWork.map((item) => <WorkCard key={item.id} item={item} compact />)
        ) : (
          <div className="ops-empty">
            <Check size={20} style={{ color: 'var(--ok)' }} />
            <span>No active work for this project.</span>
          </div>
        )}
      </div>
    </div>
  )
}

function inboxDecisionBriefing(action: InboxAction, projectLabel: string) {
  const recommended = typeof action.recommend === 'number' ? action.options?.[action.recommend] : null
  const happened =
    action.type === 'review'
      ? `A local agent has produced a patch artifact for ${projectLabel} and is waiting for review.`
      : action.type === 'blocked'
        ? `${projectLabel} is paused because the current task needs a blocker cleared.`
        : action.type === 'suggest'
          ? `Northstar found a possible next move for ${projectLabel}, but it should stay user-gated.`
          : `${projectLabel} needs an answer before the queue should keep moving.`
  const why =
    action.type === 'review'
      ? 'Patch apply, commits, and pushes stay local and explicit, so review is the safe handoff point.'
      : recommended
        ? `The highlighted answer is the lowest-friction way to keep the loop moving: ${recommended}.`
        : action.help ?? 'This is a control decision, so Northstar is asking before spending more agent attention.'
  const next =
    action.type === 'review'
      ? 'Open the full review, approve locally, or request another pass.'
      : 'Pick an option or type the smallest useful instruction; resolving this does not apply patches or push code.'

  return [
    { label: 'What happened', text: happened },
    { label: 'Why recommended', text: why },
    { label: 'Smallest next decision', text: next },
  ]
}

function Inbox({
  projects,
  projectFilter,
  actions,
  setActions,
  clearProjectFilter,
  openReview,
  workItems,
  onDecision,
}: {
  projects: Project[]
  projectFilter: string | null
  actions: InboxAction[]
  setActions: (items: InboxAction[]) => void
  clearProjectFilter: () => void
  openReview: (taskId?: string | null) => void
  workItems: ProjectWork[]
  onDecision: (item: InboxAction, choice: string) => void
}) {
  type InboxTypeFilter = 'all' | InboxAction['type']
  type InboxLabelFilter = 'all' | Project['label']
  const [typeFilter, setTypeFilter] = useState<InboxTypeFilter>('all')
  const [labelFilter, setLabelFilter] = useState<InboxLabelFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(projectFilter)
  const [customChoice, setCustomChoice] = useState('')
  const [detailMessage, setDetailMessage] = useState('')
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const projectScoped = actions.filter((action) => !projectFilter || action.project === projectFilter)
  const typeScoped = typeFilter === 'all' ? projectScoped : projectScoped.filter((action) => action.type === typeFilter)
  const labelScoped = labelFilter === 'all' ? projectScoped : projectScoped.filter((action) => projectById.get(action.project)?.label === labelFilter)
  const filtered = labelScoped
    .filter((action) => typeFilter === 'all' || action.type === typeFilter)
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || urgencyRank[a.urgency] - urgencyRank[b.urgency] || a.title.localeCompare(b.title))
  const typeFilters: Array<{ id: InboxTypeFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'question', label: 'Questions' },
    { id: 'review', label: 'Reviews' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'suggest', label: 'Suggestions' },
  ]
  const labelFilters: Array<{ id: InboxLabelFilter; label: string }> = [
    { id: 'all', label: 'All scopes' },
    { id: 'work', label: 'Work' },
    { id: 'personal', label: 'Personal' },
  ]
  const typeCounts = new Map<InboxTypeFilter, number>([
    ['all', labelScoped.length],
    ['question', labelScoped.filter((action) => action.type === 'question').length],
    ['review', labelScoped.filter((action) => action.type === 'review').length],
    ['blocked', labelScoped.filter((action) => action.type === 'blocked').length],
    ['suggest', labelScoped.filter((action) => action.type === 'suggest').length],
  ])
  const labelCounts = new Map<InboxLabelFilter, number>([
    ['all', typeScoped.length],
    ['work', typeScoped.filter((action) => projectById.get(action.project)?.label === 'work').length],
    ['personal', typeScoped.filter((action) => projectById.get(action.project)?.label === 'personal').length],
  ])
  const selected = filtered.find((a) => a.id === selectedId) ?? filtered[0]
  const selectedProject = selected ? projectById.get(selected.project) : null
  const selectedProjectLabel = selected ? projectName(projects, selected.project) : 'this project'
  const decisionBriefing = selected ? inboxDecisionBriefing(selected, selectedProjectLabel) : []
  const customChoiceReady = customChoice.trim().length > 0
  const filtersActive = Boolean(projectFilter) || typeFilter !== 'all' || labelFilter !== 'all'
  const clearFilters = () => {
    setTypeFilter('all')
    setLabelFilter('all')
    clearProjectFilter()
  }
  useEffect(() => {
    setCustomChoice('')
    setDetailMessage('')
  }, [selected?.id])
  useEffect(() => {
    if (!filtered.length) {
      if (selectedId) setSelectedId(null)
      return
    }
    if (!selectedId || !filtered.some((action) => action.id === selectedId)) setSelectedId(filtered[0].id)
  }, [filtered, selectedId])
  useEffect(() => {
    if (selected?.project) setSelectedProjectId(selected.project)
    else if (projectFilter) setSelectedProjectId(projectFilter)
    else if (!selectedProjectId && projects[0]) setSelectedProjectId(projects[0].id)
  }, [projectFilter, projects, selected?.project, selectedProjectId])
  const resolve = (item: InboxAction, choice: string) => {
    const nextVisible = filtered.filter((action) => action.id !== item.id)
    setActions(actions.filter((a) => a.id !== item.id))
    setSelectedId(nextVisible[0]?.id ?? null)
    setSelectedProjectId(item.project)
    onDecision(item, choice)
    void apiSend(`/api/inbox/${item.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    })
  }
  const resolveCustom = () => {
    if (!selected || !customChoiceReady) return
    resolve(selected, customChoice.trim())
  }
  const requestReviewChanges = async (item: InboxAction) => {
    if (!item.task) {
      setDetailMessage('This review is missing a task id, so Northstar cannot attach change notes yet.')
      return
    }
    setDetailMessage('Recording change request...')
    const data = await apiSend<{ ok?: boolean; error?: string }>(`/api/patches/${item.task}/request-changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Needs another local pass from Mission Inbox before approval.' }),
    })
    if (data?.ok) {
      setDetailMessage('Change request queued.')
      resolve(item, 'changes requested')
      return
    }
    setDetailMessage(data?.error ?? 'No patch artifact exists for this review yet.')
  }

  return (
    <div className="screen inbox-screen">
      <div className="ib-banner">
        <Zap size={15} style={{ color: 'var(--star)' }} />
        <span className="mono"><b>{projects.filter((p) => p.active).length} active projects</b> making slow progress</span>
        <span className="mono" style={{ color: 'var(--ink-3)' }}>· {filtered.length} clarifications queued</span>
        <span className="mono" style={{ color: 'var(--ink-3)' }}>· {workItems.filter((item) => item.status === 'running').length} runs visible</span>
        <span className="grow" />
        <span className="chip on">{projectFilter ? projectName(projects, projectFilter) : 'All projects'}</span>
      </div>
      <div className="inbox-grid">
        <div className="panel brackets col" style={{ overflow: 'hidden' }}>
          <div className="ib-typebar">
            {typeFilters.map((filter) => (
              <button key={filter.id} type="button" className={`ib-tab${typeFilter === filter.id ? ' on' : ''}`} onClick={() => setTypeFilter(filter.id)}>
                {filter.label} <span className="chip-n">{typeCounts.get(filter.id) ?? 0}</span>
              </button>
            ))}
            <span className="ib-filter-spacer" />
            {labelFilters.map((filter) => (
              <button key={filter.id} type="button" className={`ib-tab scope${labelFilter === filter.id ? ' on' : ''}`} onClick={() => setLabelFilter(filter.id)}>
                {filter.label} <span className="chip-n">{labelCounts.get(filter.id) ?? 0}</span>
              </button>
            ))}
            {filtersActive ? <button type="button" className="ib-tab clear" onClick={clearFilters}>Clear</button> : null}
          </div>
          <div className="scroll grow">
            {filtered.map((a, i) => (
              <button key={a.id} className={`ib-row${selected?.id === a.id ? ' active' : ''}`} onClick={() => { setSelectedId(a.id); setSelectedProjectId(a.project) }}>
                <span className="ib-prio" style={{ background: priorityColor[a.priority] }} />
                <span className={`ib-ticon ib-${a.type}`}><InboxTypeIcon type={a.type} /></span>
                <div className="col grow">
                  <div className="row gap8">
                    {i === 0 ? <span className="ib-next">NEXT</span> : null}
                    <span className="ib-title grow">{a.title}</span>
                  </div>
                  <div className="row gap8">
                    <span className="mono ib-proj">{projectName(projects, a.project)}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{a.type}</span>
                    <span className="grow" />
                    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{a.ago}</span>
                  </div>
                </div>
              </button>
            ))}
            {filtered.length === 0 ? (
              <div className="ib-listempty">
                <Check size={20} style={{ color: 'var(--ok)' }} />
                <span>{filtersActive ? 'No pending decisions match these filters.' : 'No pending decisions.'}</span>
                {filtersActive ? <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button> : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="panel brackets" style={{ overflow: 'auto' }}>
          {selected ? (
            <div className="ib-detail">
              <div className="ib-detail-hd">
                <span className="tag"><InboxTypeIcon type={selected.type} />{selected.type.toUpperCase()}</span>
                <span className="tag mono">{selected.priority}</span>
                {selectedProject ? <span className={`lbl lbl-${selectedProject.label}`}>{selectedProject.label}</span> : null}
                <span className="mono ib-proj">{projectName(projects, selected.project)}</span>
              </div>
              <h2 className="ib-detail-title">{selected.title}</h2>
              <p className="ib-ctx">{selected.ctx}</p>
              <div className="ib-brief">
                {decisionBriefing.map((item) => (
                  <div key={item.label} className="ib-brief-item">
                    <span className="eyebrow">{item.label}</span>
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
              {selected.type === 'review' ? (
                <>
                  <div className="ib-reviewstats">
                    <div className="rs"><span className="eyebrow">FILES</span><span className="tnum">{selected.files ?? 0}</span></div>
                    <div className="rs"><span className="eyebrow">ADD</span><span className="tnum">+{selected.add ?? 0}</span></div>
                    <div className="rs"><span className="eyebrow">DEL</span><span className="tnum">-{selected.del ?? 0}</span></div>
                  </div>
                  <div className="row gap8 ib-review-actions">
                    <button type="button" className="btn btn-primary" onClick={() => openReview(selected.task)}>Open full review</button>
                    <button type="button" className="btn" onClick={() => resolve(selected, 'approved')}>Approve locally</button>
                    <button type="button" className="btn" onClick={() => void requestReviewChanges(selected)}>Request changes</button>
                  </div>
                </>
              ) : (
                <div className="ib-opts">
                  {(selected.options ?? ['Acknowledge']).map((o, i) => (
                    <button key={o} type="button" className={`ib-opt${selected.recommend === i ? ' rec' : ''}`} onClick={() => resolve(selected, o)}>
                      <span className="ib-optdot" />
                      <span className="grow" style={{ textAlign: 'left' }}>{o}</span>
                      {selected.recommend === i ? <span className="ib-rec">recommended</span> : null}
                    </button>
                  ))}
                  <form
                    className="ib-custom"
                    onSubmit={(event) => {
                      event.preventDefault()
                      resolveCustom()
                    }}
                  >
                    <span className="ib-custom-dot" />
                    <input
                      aria-label="Custom inbox response"
                      value={customChoice}
                      onChange={(event) => setCustomChoice(event.target.value)}
                      placeholder="Type a different prompt..."
                    />
                    <button type="submit" className="ib-custom-send" disabled={!customChoiceReady} aria-label="Send custom response">
                      <ArrowRight size={15} />
                    </button>
                  </form>
                </div>
              )}
              {detailMessage ? <div className="ib-detail-message mono">{detailMessage}</div> : null}
              {selected.help ? (
                <div className="ib-help">
                  <div className="row gap8"><ModelChip id={selected.model} small /><span className="eyebrow">Need help deciding?</span></div>
                  <p>{selected.help}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="ib-empty">
              <Check size={26} style={{ color: 'var(--ok)' }} />
              <span>{filtersActive ? 'Filtered inbox is clear.' : 'Inbox zero.'}</span>
              <span style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>{filtersActive ? 'Clear filters to scan all project decisions.' : 'Project work is still visible at right.'}</span>
              {filtersActive ? <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button> : null}
            </div>
          )}
        </div>
        <div className="panel brackets" style={{ overflow: 'hidden' }}>
          <ProjectOperations
            projects={projects}
            projectFilter={projectFilter}
            selectedProjectId={selectedProjectId}
            setSelectedProjectId={setSelectedProjectId}
            workItems={workItems}
          />
        </div>
      </div>
    </div>
  )
}

function Queue({ projects, overview, openReview }: { projects: Project[]; overview: OperationsOverview | null; openReview: (taskId?: string | null) => void }) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [queueTasks, setQueueTasks] = useState<QueueTask[]>([])
  const [working, setWorking] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [queueFilter, setQueueFilter] = useState<'all' | 'runnable' | 'blocked' | 'manual' | 'github-only' | 'scheduler' | 'stale'>('all')

  const loadRuns = async () => {
    const data = await apiJson<{ runs?: AgentRun[] }>('/api/runs')
    if (data?.runs) setRuns(data.runs)
  }

  const loadQueue = async () => {
    const data = await apiJson<{ tasks?: QueueTask[] }>('/api/queue')
    if (data?.tasks) setQueueTasks(data.tasks)
  }

  const refresh = async () => {
    await Promise.all([loadRuns(), loadQueue()])
  }

  useEffect(() => {
    let alive = true
    const guardedRefresh = async () => {
      const [runsData, queueData] = await Promise.all([
        apiJson<{ runs?: AgentRun[] }>('/api/runs'),
        apiJson<{ tasks?: QueueTask[] }>('/api/queue'),
      ])
      if (!alive) return
      if (runsData?.runs) setRuns(runsData.runs)
      if (queueData?.tasks) setQueueTasks(queueData.tasks)
    }
    void guardedRefresh()
    const id = window.setInterval(() => {
      void guardedRefresh()
    }, 2500)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const tasks = queueTasks.length ? queueTasks : overview?.tasks?.length ? overview.tasks : seedQueue
  const visibleTasks = tasks.filter((task) => queueFilter === 'all'
    || (queueFilter === 'runnable' && task.dispatchability?.canDispatchNow)
    || (queueFilter === 'blocked' && (task.status === 'blocked' || task.status === 'needs-input' || task.dispatchability?.status === 'model-disabled' || task.dispatchability?.status === 'no-free-slot' || task.dispatchability?.status === 'guarded'))
    || (queueFilter === 'manual' && task.dispatchability?.status === 'manual')
    || (queueFilter === 'github-only' && task.dispatchability?.status === 'github-only')
    || (queueFilter === 'scheduler' && task.dispatchability?.schedulerWaiting)
    || (queueFilter === 'stale' && task.dispatchability?.stale))
  const firstRunnable = tasks.find((task) => task.status === 'queued' && task.dispatchability?.canDispatchNow)
  const liveTasks = tasks.filter((task) => task.status === 'running' || task.status === 'needs-input')
  const liveRuns = runs.filter((run) => run.status === 'running')
  const runningTasks = tasks.filter((task) => task.status === 'running')
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? liveRuns[0] ?? runs[0] ?? null
  const agentNames = ['manager', 'frontend', 'backend', 'design', 'graph', 'marketing']
  const agentLanes = agentNames.map((agent) => {
    const agentTasks = tasks.filter((task) => task.agent.toLowerCase() === agent || task.title.toLowerCase().includes(agent))
    const active = agentTasks.some((task) => task.status === 'running' || task.status === 'needs-input')
    return { agent, active, count: agentTasks.length }
  })
  const queueFilters: Array<{ id: typeof queueFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: tasks.length },
    { id: 'runnable', label: 'Runnable', count: tasks.filter((task) => task.dispatchability?.canDispatchNow).length },
    { id: 'blocked', label: 'Blocked', count: tasks.filter((task) => task.status === 'blocked' || task.status === 'needs-input').length },
    { id: 'manual', label: 'Manual', count: tasks.filter((task) => task.dispatchability?.status === 'manual').length },
    { id: 'github-only', label: 'GitHub-only', count: tasks.filter((task) => task.dispatchability?.status === 'github-only').length },
    { id: 'scheduler', label: 'Scheduler', count: tasks.filter((task) => task.dispatchability?.schedulerWaiting).length },
    { id: 'stale', label: 'Stale', count: tasks.filter((task) => task.dispatchability?.stale).length },
  ]

  const runTask = async (task: QueueTask) => {
    if (task.dispatchability && !task.dispatchability.canDispatchNow) {
      setMessage(task.dispatchability.reason)
      return
    }
    setWorking((current) => ({ ...current, [task.id]: true }))
    const data = await apiSend<{ ok?: boolean; error?: string; run?: { id: string } }>(`/api/queue/${task.id}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setWorking((current) => ({ ...current, [task.id]: false }))
    setMessage(data?.ok ? `Dispatched ${task.id}` : data?.error ?? `Dispatch failed for ${task.id}`)
    await refresh()
  }

  const togglePause = async (task: QueueTask) => {
    const paused = task.status === 'blocked' && task.stage === 'paused manually'
    setWorking((current) => ({ ...current, [task.id]: true }))
    const data = await apiSend<{ ok?: boolean; status?: string; error?: string }>(`/api/queue/${task.id}/${paused ? 'resume' : 'pause'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setWorking((current) => ({ ...current, [task.id]: false }))
    setMessage(data?.ok ? `${paused ? 'Resumed' : 'Paused'} ${task.id}` : data?.error ?? `Queue update failed for ${task.id}`)
    await refresh()
  }

  return (
    <div className="screen queue-screen">
      <div className="queue-grid">
        <div className="col" style={{ minHeight: 0, gap: 12 }}>
          <div className="panel brackets next-up">
            <span className="eyebrow" style={{ color: 'var(--star)' }}>WHAT TO WORK ON NEXT</span>
            <div className="row gap12" style={{ marginTop: 8 }}>
              <div className="col grow">
                <span className="q-title">{overview?.nextAction?.title ?? firstRunnable?.title ?? 'Queue is waiting for a cleanup decision'}</span>
                <span style={{ color: 'var(--ink-3)' }}>{overview?.nextAction?.reason ?? (firstRunnable ? `${projectName(projects, firstRunnable.project)} · ${firstRunnable.dispatchability?.reason ?? firstRunnable.stage}` : 'Open /overview or resolve blocked tasks before dispatch.')}</span>
              </div>
              <button className="btn btn-primary" disabled={!firstRunnable || working[firstRunnable.id]} onClick={() => firstRunnable && void runTask(firstRunnable)}>
                <Play size={13} /> Dispatch
              </button>
            </div>
          </div>

          <div className="row gap6 q-filters">
            {queueFilters.map(({ id, label, count }) => (
              <button key={id} type="button" className={`chip${queueFilter === id ? ' on' : ''}`} onClick={() => setQueueFilter(id)}>
                {label}<span className="chip-n">{count}</span>
              </button>
            ))}
            <span className="grow" />
            <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>{message || 'worktrees · strict no-API'}</span>
          </div>

          <div className="panel brackets grow col" style={{ overflow: 'hidden' }}>
            <div className="panel-hd">
              <Layers size={14} />
              <h3>Execution Queue</h3>
              <span className="grow" />
              <span className="tag mono"><i className="dot dot-run live" />{runningTasks.length} running</span>
            </div>
            <div className="scroll grow">
              {visibleTasks.map((q) => {
                const paused = q.status === 'blocked' && q.stage === 'paused manually'
                const runnable = q.dispatchability?.canDispatchNow ?? (q.status !== 'running' && q.status !== 'done')
                return (
                  <div key={q.id} className={`q-item${q.dispatchability?.stale ? ' stale' : ''}`}>
                    <div className="q-prio" style={{ background: priorityColor[q.priority] }} />
                    <div className="col grow" style={{ minWidth: 0 }}>
                      <div className="row gap10">
                        <span className="mono q-id">{q.id}</span>
                        <span className="q-title grow">{q.title}</span>
                        <StatusTag status={q.status} />
                      </div>
                      <div className="row gap10 q-item-meta">
                        <span className="q-tag mono">{projectName(projects, q.project)}</span>
                        {q.source && q.source !== 'cockpit' ? <span className="q-tag mono" title={q.sourceRef || q.source}>{queueSourceLabel(q)}</span> : null}
                        <ModelChip id={q.model} small />
                        <span className="q-tag mono">{q.agent}</span>
                        {q.dispatchability ? <span className={`q-tag mono dispatch-${q.dispatchability.status}`}>{q.dispatchability.status}</span> : null}
                        {q.updatedAt ? <span className="q-tag mono">{taskAgeLabel(q.updatedAt)}</span> : null}
                        <span className="grow" />
                        <span className="mono q-stage">{q.stage}</span>
                      </div>
                      {q.dispatchability ? <div className="q-dispatch">{q.dispatchability.reason}</div> : null}
                      <div className="meter" style={{ marginTop: 8 }}><i style={{ width: pct(q.progress) }} /></div>
                    </div>
                    <div className="q-actions">
                      <button className="btn btn-sm" disabled={!runnable || working[q.id]} title={q.dispatchability?.action ?? 'Run'} onClick={() => void runTask(q)}><Play size={12} /> Run</button>
                      <button className="btn btn-sm" onClick={() => openReview(q.id)}>Review</button>
                      <button className="btn btn-sm btn-ghost" disabled={q.status === 'running' || working[q.id]} title={paused ? 'Resume task' : 'Pause task'} onClick={() => void togglePause(q)}>{paused ? <Play size={12} /> : <Pause size={12} />}</button>
                    </div>
                  </div>
                )
              })}
              {!visibleTasks.length ? <div className="inbox-empty">No tasks match this queue filter.</div> : null}
            </div>
          </div>
        </div>

        <div className="queue-side col">
          <div className="panel brackets col live-panel">
            <div className="panel-hd">
              <Zap size={14} style={{ color: 'var(--star)' }} />
              <h3>Live + Running</h3>
              <span className="grow" />
              <span className="tag mono">{liveRuns.length} process</span>
            </div>
            <div className="live-summary">
              <div><span className="tnum">{liveTasks.length}</span><span>live tasks</span></div>
              <div><span className="tnum">{liveRuns.length}</span><span>spawned CLIs</span></div>
              <div><span className="tnum">{agentLanes.filter((lane) => lane.active).length}</span><span>active lanes</span></div>
            </div>
            <div className="scroll grow" style={{ padding: 12 }}>
              {liveRuns.length ? liveRuns.map((run) => (
                <button type="button" key={run.id} className={`inbox-card terminal-run${selectedRun?.id === run.id ? ' on' : ''}`} onClick={() => setSelectedRunId(run.id)}>
                  <div className="row gap8">
                    <span className="u-dot u-med" />
                    <span className="mono">{modelLabel(run.model)}</span>
                    <span className="grow" />
                    <span className="tag mono">{run.status}</span>
                  </div>
                  <p className="inbox-q">{(runOutput(run) || 'Waiting for CLI output...').replace(/\s+/g, ' ').slice(0, 180)}</p>
                  <p className="inbox-ctx">{runWorktree(run)}</p>
                </button>
              )) : liveTasks.map((task) => (
                <div key={task.id} className="inbox-card">
                  <div className="row gap8">
                    <span className={`u-dot u-${task.status === 'needs-input' ? 'high' : 'med'}`} />
                    <span className="mono">{task.agent}</span>
                    <span className="grow" />
                    <StatusTag status={task.status} />
                  </div>
                  <p className="inbox-q">{task.title}</p>
                  <p className="inbox-ctx">{projectName(projects, task.project)} · {task.stage}</p>
                </div>
              ))}
              {!liveRuns.length && !liveTasks.length ? <div className="inbox-empty">No live work right now.</div> : null}
            </div>
          </div>

          <div className="panel brackets terminal-panel col">
            <div className="panel-hd">
              <Terminal size={14} />
              <h3>Run Console</h3>
              <span className="grow" />
              <span className="tag mono">{selectedRun ? selectedRun.status : 'idle'}</span>
            </div>
            {selectedRun ? (
              <div className="terminal-body">
                <div className="terminal-meta">
                  <span className="mono">{modelLabel(selectedRun.model)}</span>
                  <span>{selectedRun.transport ?? selectedRun.provider ?? 'cli'}</span>
                  <span>{runTaskId(selectedRun)}</span>
                </div>
                <div className="terminal-path mono">{runCwd(selectedRun)}</div>
                <pre className="terminal-output">{`${runAttachCommand(selectedRun) ? `$ ${runAttachCommand(selectedRun)}\n` : ''}$ ${runCommand(selectedRun)}\n\n${runOutput(selectedRun) || selectedRun.stdout || selectedRun.stderr || 'Waiting for CLI output...'}`}</pre>
              </div>
            ) : (
              <div className="terminal-empty">Dispatch an agent to see its CLI command and live output.</div>
            )}
          </div>

          <div className="panel brackets agent-roster">
            <div className="panel-hd"><Network size={14} /><h3>Agent Roster</h3></div>
            <div className="agent-lanes">
              {agentLanes.map((lane) => (
                <div key={lane.agent} className={`agent-lane${lane.active ? ' on' : ''}`}>
                  <i className={`dot ${lane.active ? 'dot-run live' : 'dot-idle'}`} />
                  <span className="mono grow">{lane.agent}</span>
                  <span className="chip-n">{lane.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const fallbackScheduler: SchedulerSettings = {
  id: 'default',
  enabled: true,
  timezone: 'America/Toronto',
  startTime: '22:30',
  endTime: '06:30',
  weekdayReservePct: 35,
  maxParallelRuns: 2,
  sparkEnabled: true,
  opusEnabled: true,
  codexEnabled: false,
  updatedAt: '',
}

function Schedule() {
  const [scheduler, setScheduler] = useState<SchedulerSettings>(fallbackScheduler)
  const [onboarding, setOnboarding] = useState<ProjectOnboarding[]>([])
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [ticking, setTicking] = useState(false)

  const loadSchedule = async () => {
    const [schedulerData, onboardingData] = await Promise.all([
      apiJson<{ scheduler?: SchedulerSettings }>('/api/scheduler'),
      apiJson<{ onboarding?: ProjectOnboarding[] }>('/api/onboarding'),
    ])
    if (schedulerData?.scheduler) setScheduler(schedulerData.scheduler)
    if (onboardingData?.onboarding) setOnboarding(onboardingData.onboarding)
  }

  useEffect(() => {
    void loadSchedule()
  }, [])

  const save = async () => {
    setSaving(true)
    const data = await apiSend<{ scheduler?: SchedulerSettings }>('/api/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduler),
    })
    setSaving(false)
    if (data?.scheduler) {
      setScheduler(data.scheduler)
      setMessage('Schedule saved')
    } else {
      setMessage('Schedule save failed')
    }
  }

  const seed = async () => {
    setSeeding(true)
    const data = await apiSend<{ ok?: boolean; seeded?: number; profiles?: Record<string, number> }>('/api/onboarding/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setSeeding(false)
    await loadSchedule()
    if (data?.ok) setMessage(`Onboarded ${data.seeded ?? 0} projects`)
    else setMessage('Onboarding failed')
  }

  const runTick = async () => {
    setTicking(true)
    const data = await apiSend<{ ok?: boolean; reason?: string; dispatched?: unknown[]; skipped?: unknown[] }>('/api/scheduler/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
    setTicking(false)
    if (data?.ok) {
      setMessage(data.reason ?? `Tick dispatched ${data.dispatched?.length ?? 0}; skipped ${data.skipped?.length ?? 0}`)
    } else {
      setMessage('Scheduler tick failed')
    }
  }

  const setBoolean = (key: keyof Pick<SchedulerSettings, 'enabled' | 'sparkEnabled' | 'opusEnabled' | 'codexEnabled'>, value: boolean) => {
    setScheduler((current) => ({ ...current, [key]: value }))
  }

  return (
    <div className="screen schedule-screen">
      <div className="schedule-grid">
        <div className="panel brackets col schedule-main">
          <div className="panel-hd"><Clock size={14} /><h3>Nightly Window</h3><span className="grow" /><span className={`tag mono${scheduler.enabled ? '' : ' dim'}`}>{scheduler.enabled ? 'enabled' : 'paused'}</span></div>
          <div className="schedule-form">
            <label className="field-row"><span>Enabled</span><input type="checkbox" checked={scheduler.enabled} onChange={(event) => setBoolean('enabled', event.target.checked)} /></label>
            <label className="field-row"><span>Timezone</span><input value={scheduler.timezone} onChange={(event) => setScheduler({ ...scheduler, timezone: event.target.value })} /></label>
            <label className="field-row"><span>Start</span><input type="time" value={scheduler.startTime} onChange={(event) => setScheduler({ ...scheduler, startTime: event.target.value })} /></label>
            <label className="field-row"><span>End</span><input type="time" value={scheduler.endTime} onChange={(event) => setScheduler({ ...scheduler, endTime: event.target.value })} /></label>
            <label className="field-row"><span>Weekday reserve</span><input type="range" min="0" max="90" value={scheduler.weekdayReservePct} onChange={(event) => setScheduler({ ...scheduler, weekdayReservePct: Number(event.target.value) })} /><b>{scheduler.weekdayReservePct}%</b></label>
            <label className="field-row"><span>Parallel runs</span><input type="number" min="1" max="6" value={scheduler.maxParallelRuns} onChange={(event) => setScheduler({ ...scheduler, maxParallelRuns: Number(event.target.value) })} /></label>
            <div className="model-toggles">
              <button type="button" className={`toggle-pill${scheduler.sparkEnabled ? ' on' : ''}`} onClick={() => setBoolean('sparkEnabled', !scheduler.sparkEnabled)}><ModelChip id="spark" small />Background</button>
              <button type="button" className={`toggle-pill${scheduler.opusEnabled ? ' on' : ''}`} onClick={() => setBoolean('opusEnabled', !scheduler.opusEnabled)}><ModelChip id="opus" small />Planning</button>
              <button type="button" className={`toggle-pill${scheduler.codexEnabled ? ' on' : ''}`} onClick={() => setBoolean('codexEnabled', !scheduler.codexEnabled)}><ModelChip id="codex" small />Reserved</button>
            </div>
          </div>
          <div className="row gap8 schedule-actions"><button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving' : 'Save schedule'}</button><button className="btn" onClick={seed} disabled={seeding}>{seeding ? 'Indexing' : 'Seed onboarding'}</button><button className="btn" onClick={runTick} disabled={ticking}><Play size={13} />{ticking ? 'Ticking' : 'Run tick'}</button><span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>{message || scheduler.updatedAt}</span></div>
        </div>
        <div className="panel brackets col schedule-side">
          <div className="panel-hd"><Sparkles size={14} style={{ color: 'var(--star)' }} /><h3>Project Onboarding</h3><span className="grow" /><span className="tag">{onboarding.length} indexed</span></div>
          <div className="scroll grow">{onboarding.length ? onboarding.map((item) => <div key={item.projectId} className="onboard-row"><div className="row gap8"><span className="mono q-id">{item.projectId}</span><span className="tag mono">{item.profile}</span></div><p>{item.goals[0]}</p><div className="row gap6">{item.queue.slice(0, 3).map((task) => <span className="chip tiny" key={task.id}>{task.priority} {task.model}</span>)}</div></div>) : <div className="inbox-empty">No project profiles indexed yet.</div>}</div>
        </div>
      </div>
    </div>
  )
}

function Graph({ projects, openReview }: { projects: Project[]; openReview: (taskId?: string | null) => void }) {
  const [mode, setMode] = useState<'projects' | 'agents'>('projects')
  const [projectId, setProjectId] = useState('active')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [graph, setGraph] = useState<GraphPayload>(seedGraphPayload)
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading')

  useEffect(() => {
    let alive = true
    const loadGraph = async () => {
      setStatus('loading')
      const data = await apiJson<GraphPayload>(mode === 'agents' ? '/api/agent-graph' : `/api/graph/${projectId}`)
      if (!alive) return
      if (data?.nodes?.length) {
        setGraph(data)
        setSelected(initialGraphSelection(data))
        setStatus('ready')
      } else {
        setGraph(seedGraphPayload)
        setSelected(initialGraphSelection(seedGraphPayload))
        setStatus('fallback')
      }
    }

    void loadGraph()
    const id = window.setInterval(() => {
      if (mode === 'agents') void loadGraph()
    }, 3000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [mode, projectId])

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const selectedNode = selected ? nodeById.get(selected) : graph.nodes[0]
  const matches = query.trim()
    ? graph.nodes.filter((node) => `${node.label ?? node.id} ${node.meta ? Object.values(node.meta).join(' ') : ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
    : []
  const activeProjects = projects.filter((project) => project.active)
  const options = [
    { id: 'active', name: 'Active projects', localExists: true } as Pick<Project, 'id' | 'name' | 'localExists'>,
    { id: 'all', name: 'All projects', localExists: true } as Pick<Project, 'id' | 'name' | 'localExists'>,
    ...activeProjects,
  ]

  return (
    <div className="screen graph-screen" style={{ padding: 0 }}>
      <div className="graph-wrap">
        <div className="graph-toolbar">
          <div className="g-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === 'agents' ? 'query agents, tasks, questions...' : 'query nodes - "github", "graph"...'} />
            {matches.length ? (
              <div className="g-results">
                {matches.map((node) => (
                  <button key={node.id} type="button" className="g-result" onClick={() => { setSelected(node.id); setQuery('') }}>
                    <span className="g-swatch sm" style={{ background: graph.communities[node.c]?.color ?? 'var(--star)' }} />
                    <span className="mono">{node.label ?? node.id}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="graph-mode">
            <button type="button" className={`chip${mode === 'projects' ? ' on' : ''}`} onClick={() => setMode('projects')}><Network size={12} /> Projects</button>
            <button type="button" className={`chip${mode === 'agents' ? ' on' : ''}`} onClick={() => setMode('agents')}><Zap size={12} /> Agents</button>
          </div>
          <button className="chip on"><Zap size={12} /> {status === 'loading' ? 'loading graph' : mode === 'agents' ? 'agent mesh' : graph.generated ? 'generated graph' : 'graphify graph'}</button>
          <span className="grow" />
          <div className="g-stats"><span><b>{graph.nodes.length}</b> nodes</span><span><b>{graph.edges.length}</b> edges</span><span><b>{graph.communities.length}</b> communities</span></div>
        </div>
        {mode === 'projects' ? <div className="graph-project-strip">
          {options.map((project) => (
            <button key={project.id} type="button" className={`graph-project-chip${projectId === project.id ? ' on' : ''}`} onClick={() => setProjectId(project.id)}>
              <i className={`dot ${project.localExists === false ? 'dot-queue' : 'dot-run'}`} />
              <span className="mono">{project.name}</span>
            </button>
          ))}
        </div> : null}
        <svg className="graph-svg" viewBox="0 0 1000 680">
          {graph.edges.map(([a, b, conf]) => {
            const na = nodeById.get(a)
            const nb = nodeById.get(b)
            if (!na || !nb) return null
            return <line key={`${a}-${b}`} className={mode === 'agents' && conf === 'ext' ? 'g-flow' : undefined} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke={selected === a || selected === b ? 'var(--star)' : 'var(--ink-3)'} strokeDasharray={conf === 'ext' ? 'none' : conf === 'inf' ? '4 4' : '1.5 5'} opacity={selected === a || selected === b ? .8 : mode === 'agents' ? .34 : .25} />
          })}
          {graph.nodes.map((node) => {
            const radius = graphNodeRadius(node)
            return (
              <g key={node.id} transform={`translate(${node.x} ${node.y})`} onClick={() => setSelected(node.id)} className="g-node">
                {node.hot ? <circle r={radius + 10} fill="none" stroke="var(--star)" className="g-agent hot" /> : null}
                {selected === node.id ? <circle r={radius + 5} fill="none" stroke="var(--star)" strokeWidth="1.4" opacity=".9" /> : null}
                <circle r={radius} fill={graph.communities[node.c]?.color ?? 'var(--star)'} stroke="var(--bg)" strokeWidth="2" />
                {node.agent ? <circle r={Math.max(4, radius * 0.38)} fill="var(--star)" /> : null}
                <text y={radius + 14} textAnchor="middle" className="g-label" style={{ fill: selected === node.id ? 'var(--star)' : 'var(--ink-2)' }}>{node.label ?? node.id}</text>
              </g>
            )
          })}
        </svg>
        <div className="graph-legend"><span className="eyebrow">COMMUNITIES</span>{graph.communities.map((community) => <div key={community.id} className="legend-row"><span className="g-swatch sm" style={{ background: community.color }} /><span className="mono grow">{community.name}</span></div>)}<div className="legend-conf"><span><i className="cline" /> explicit</span><span><i className="cline inf" /> inferred</span><span><i className="cline amb" /> needs context</span></div></div>
        {selectedNode ? (
          <div className="g-inspector">
            <div className="row gap8"><span className="eyebrow">NODE INSPECTOR</span><span className="grow" /><button className="btn btn-ghost btn-sm" onClick={() => setSelected('')}><X size={13} /></button></div>
            <div className="row gap8" style={{ marginTop: 10 }}><span className="g-swatch" style={{ background: graph.communities[selectedNode.c]?.color }} /><span className="mono" style={{ fontSize: 15 }}>{selectedNode.label ?? selectedNode.id}</span></div>
            <div className="g-path">{graph.source}{graph.missing ? ' · graphify missing' : ''}</div>
            <div className={`graph-source-kind ${graph.sourceKind ?? (graph.generated ? 'generated' : 'graphify')}`}>
              {graphSourceLabel(graph)}
            </div>
            <div className="g-agentbox"><span className="eyebrow" style={{ color: 'var(--star)' }}>{selectedNode.agent ? 'AGENT ACTIVE' : mode === 'agents' ? 'WORKFLOW NODE' : 'CONTEXT NODE'}</span><p>{selectedNode.project ? 'Linked to project work and queue routing.' : mode === 'agents' ? 'Part of the manager-to-specialist communication loop.' : 'This node groups project context for dashboard routing.'}</p><button className="btn btn-primary btn-sm" onClick={() => openReview(null)}>Review patch</button></div>
            {selectedNode.meta ? <div className="g-meta">{Object.entries(selectedNode.meta).map(([key, value]) => <div key={key} className="g-nb"><span className="mono">{key}</span><span className="grow" /><span>{String(value)}</span></div>)}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Review({ taskId, back }: { taskId: string | null; back: () => void }) {
  const [patch, setPatch] = useState<Patch | null>(seedPatch)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty'>('loading')
  const [message, setMessage] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let alive = true
    const loadPatch = async () => {
      setStatus('loading')
      const data = await apiJson<{ patch?: Patch | null }>(`/api/patches/${taskId ?? 'latest'}`)
      if (!alive) return
      if (data?.patch) {
        setPatch(data.patch)
        setStatus('ready')
      } else {
        setPatch(null)
        setStatus('empty')
      }
    }
    void loadPatch()
    return () => {
      alive = false
    }
  }, [taskId])

  const refreshPatch = async () => {
    const target = patch?.task ?? taskId ?? 'latest'
    setRefreshing(true)
    setMessage('Refreshing local artifact...')
    const data = await apiSend<{ ok?: boolean; error?: string; patch?: Patch | null; filesChanged?: number }>(`/api/patches/${target}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    setRefreshing(false)
    if (data?.ok && data.patch) {
      setPatch(data.patch)
      setStatus('ready')
      setMessage(`Refreshed ${data.filesChanged ?? data.patch.filesChanged} files and reran checks`)
      return
    }
    if (data?.patch) {
      setPatch(data.patch)
      setStatus('ready')
    }
    const errors: Record<string, string> = {
      patch_source_not_found: 'No saved run or patch worktree is available yet.',
      base_path_unavailable: 'Base checkout is unavailable for this project.',
      worktree_missing: 'Review worktree is missing on disk.',
      worktree_not_git: 'Review worktree is not a git checkout.',
      no_diff: 'No local diff is available to review.',
    }
    setMessage(errors[data?.error ?? ''] ?? data?.error ?? 'Refresh failed')
  }

  const approve = async () => {
    if (!patch) return
    setMessage('Applying patch...')
    const data = await apiSend<{ ok?: boolean; error?: string; applied?: number }>(`/api/patches/${patch.task}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    setMessage(data?.ok ? `Applied ${data.applied ?? patch.filesChanged} files locally` : data?.error ?? 'Apply failed')
  }

  const requestChanges = async () => {
    if (!patch) return
    setMessage('Recording change request...')
    const data = await apiSend<{ ok?: boolean; error?: string }>(`/api/patches/${patch.task}/request-changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Needs another local pass from Patch Review.' }),
    })
    setMessage(data?.ok ? 'Change request added to Inbox' : data?.error ?? 'Request failed')
  }

  if (status === 'loading') return <div className="screen review-screen"><div className="panel brackets ib-empty"><span className="mono">Loading patch review...</span></div></div>
  if (!patch) return <div className="screen review-screen"><div className="panel brackets ib-empty"><Check size={26} style={{ color: 'var(--ok)' }} /><span>No patch artifact yet.</span><span style={{ fontSize: 11.5, color: 'var(--ink-4)', maxWidth: 420, textAlign: 'center' }}>Dispatch or open a queued review task first. Northstar keeps worktrees local and will show the diff here once a patch artifact exists.</span>{message ? <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{message}</span> : null}<div className="rv-empty-actions"><button className="btn btn-sm" onClick={back}>Queue</button><button className="btn btn-primary btn-sm" disabled={refreshing} onClick={refreshPatch}>{refreshing ? 'Scanning' : 'Scan latest run'}</button></div></div></div>

  return <div className="screen review-screen"><div className="rv-head"><button className="btn btn-ghost btn-sm" onClick={back}>Queue</button><div className="col rv-headcol"><div className="row gap8"><span className="mono q-id">{patch.task}</span><span className="rv-title grow">{patch.title}</span></div><div className="row gap8" style={{ color: 'var(--ink-3)', fontSize: 11 }}><span>{patch.project}</span><span>{patch.branch} to {patch.base}</span><span>{patch.worktree}</span></div></div><span className="grow" /><span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>{message}</span><ModelChip id={patch.model} /><button className="btn" disabled={refreshing} onClick={refreshPatch}>{refreshing ? 'Refreshing' : 'Refresh artifact'}</button><button className="btn" onClick={requestChanges}>Request changes</button><button className="btn btn-primary" onClick={approve}>Approve locally</button></div><div className="rv-bar">{patch.checks.map((c) => <span key={c.name} className={`check-pill ${c.state}`}><Check size={12} style={{ color: c.state === 'pass' ? 'var(--ok)' : c.state === 'running' ? 'var(--star)' : 'var(--err)' }} />{c.name} {c.detail}<span className="mono check-ms">{Math.round(c.ms)}ms</span></span>)}<span className="grow" /><span className="mono rv-stat"><b style={{ color: 'var(--ok)' }}>+{patch.additions}</b> / <b style={{ color: 'var(--err)' }}>-{patch.deletions}</b></span></div><div className="rv-body"><div className="panel brackets col"><div className="panel-hd"><Layers size={13} /><h3>Changed Files</h3></div>{patch.files.map((f) => <button key={f.path} className="file-row"><span className="file-badge">{f.status}</span><span className="mono file-path grow">{f.path}</span><span style={{ color: 'var(--ok)' }}>+{f.add}</span><span style={{ color: 'var(--err)' }}>-{f.del}</span></button>)}</div><div className="panel brackets col"><div className="panel-hd"><GitPullRequest size={13} /><h3>Diff Preview</h3></div><div className="diff-unified">{patch.diff.map((l, i) => l.t === 'hunk' ? <div key={i} className="diff-hunk">@@ {l.s} @@</div> : <div key={i} className={`dline ${l.t}`}><span className="gut">{'n1' in l ? l.n1 : ''}</span><span className="gut">{'n2' in l ? l.n2 : ''}</span><span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '}</span><code>{l.s}</code></div>)}</div></div><div className="panel brackets col"><div className="panel-hd"><Sparkles size={13} /><h3>Agent Rationale</h3></div><div style={{ padding: 14 }}><p className="rat-summary">{patch.summary}</p><ol className="rat-list">{patch.rationale.map((r) => <li key={r}>{r}</li>)}</ol>{patch.risks?.length ? <div className="ib-help" style={{ marginTop: 14 }}><AlertTriangle size={14} /><p>{patch.risks.map((risk) => risk.text).join(' ')}</p></div> : null}</div></div></div></div>
}

function SettingsView() {
  return <div className="screen"><div className="screen-grid" style={{ gridTemplateColumns: '1fr 1fr' }}><div className="panel brackets col"><div className="panel-hd"><Settings size={14} /><h3>Guardrails</h3></div><div style={{ padding: 16 }} className="col gap10"><p>Strict no-API mode blocks dispatch when API key env vars are present.</p><p>Codex uses ChatGPT login. Claude uses claude.ai login. Spark means Codex Spark, not an Ollama endpoint.</p><p>Runtime data lives in ~/.northstar. Each project has a private skills file under ~/.northstar/skills, and learned notes are fed back into plan-mode dispatch.</p><p>Worktrees stay isolated and no push happens in v1.</p></div></div><div className="panel brackets col"><div className="panel-hd"><Zap size={14} /><h3>Next Routing</h3></div><div style={{ padding: 16 }} className="col gap10">{models.map((m) => <div key={m.id} className="panel" style={{ padding: 12 }}><ModelChip id={m.id} /><p style={{ marginTop: 8, color: 'var(--ink-3)' }}>{m.tier} · {m.auth}</p></div>)}</div></div></div></div>
}

export function App() {
  const [view, setView] = useState<View>('dashboard')
  const [projects, setProjects] = useState<Project[]>(fallbackProjects)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [projectContext, setProjectContext] = useState('active')
  const [actions, setActions] = useState(seedActions)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [queueTasks, setQueueTasks] = useState<QueueTask[]>([])
  const [decisionWork, setDecisionWork] = useState<ProjectWork[]>([])
  const [modelUsage, setModelUsage] = useState<ModelUsage[]>(fallbackModelUsage)
  const [modelAuth, setModelAuth] = useState<ModelAuthStatus[]>([])
  const [operationsOverview, setOperationsOverview] = useState<OperationsOverview | null>(null)
  const [model, setModel] = useState<ModelId>('opus')
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)

  const applyOperationsOverview = (overview: OperationsOverview) => {
    setOperationsOverview(overview)
    if (overview.projects?.length) setProjects(overview.projects)
    if (overview.openDecisions) setActions(overview.openDecisions)
    if (overview.tasks) setQueueTasks(overview.tasks)
    if (overview.runs) setRuns(overview.runs as AgentRun[])
    if (overview.modelUsage?.length) setModelUsage(overview.modelUsage)
    if (overview.modelAuth) setModelAuth(overview.modelAuth)
  }

  const loadProjects = async () => {
    const data = await apiJson<{ projects?: Project[] }>('/api/projects')
    if (data?.projects?.length) {
      setProjects(data.projects)
    }
  }

  const loadActions = async () => {
    const data = await apiJson<{ actions?: InboxAction[] }>('/api/inbox')
    if (data?.actions) {
      setActions(data.actions)
    }
  }

  const loadOperations = async () => {
    const overview = await apiJson<OperationsOverview>('/api/operations/overview')
    if (overview?.ok) {
      applyOperationsOverview(overview)
      return
    }
    const [runsData, queueData, usageData] = await Promise.all([
      apiJson<{ runs?: AgentRun[] }>('/api/runs'),
      apiJson<{ tasks?: QueueTask[] }>('/api/queue'),
      apiJson<{ models?: ModelUsage[] }>('/api/model-usage'),
    ])
    if (runsData?.runs) setRuns(runsData.runs)
    if (queueData?.tasks) setQueueTasks(queueData.tasks)
    if (usageData?.models?.length) setModelUsage(usageData.models)
  }

  const loadModelAuth = async () => {
    const data = await apiJson<{ models?: ModelAuthStatus[] }>('/api/agent-auth')
    if (data?.models) {
      setModelAuth(data.models)
      return data.models
    }
    return []
  }

  useEffect(() => {
    void loadProjects()
    void loadActions()
    void loadOperations()
    void loadModelAuth()
  }, [])

  useEffect(() => {
    let closed = false
    let connectTimer: number | null = null
    let retry: number | null = null
    let socket: WebSocket | null = null

    const connect = () => {
      connectTimer = null
      socket = new WebSocket(realtimeUrl('/ws'))
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as {
            type?: string
            payload?: {
              overview?: OperationsOverview
              projects?: Project[]
              actions?: InboxAction[]
              runs?: AgentRun[]
              tasks?: QueueTask[]
              models?: ModelUsage[]
            }
          }
          const payload = message.payload
          if (!payload) return
          if (payload.overview?.ok) {
            applyOperationsOverview(payload.overview)
            return
          }
          if (Array.isArray(payload.projects)) setProjects(payload.projects)
          if (Array.isArray(payload.actions)) setActions(payload.actions)
          if (Array.isArray(payload.runs)) setRuns(payload.runs)
          if (Array.isArray(payload.tasks)) setQueueTasks(payload.tasks)
          if (Array.isArray(payload.models)) setModelUsage(payload.models)
        } catch {
          // Ignore malformed local realtime frames; polling remains the fallback.
        }
      }
      socket.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, 2500)
      }
      socket.onerror = () => socket?.close()
    }

    connectTimer = window.setTimeout(connect, 0)
    return () => {
      closed = true
      if (connectTimer !== null) window.clearTimeout(connectTimer)
      if (retry !== null) window.clearTimeout(retry)
      socket?.close()
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadModelAuth()
    }, 30000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadOperations()
    }, 2500)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(async () => {
      if (!projects.some((project) => project.active)) return
      if ((operationsOverview?.queuePressure.totalOpen ?? queueTasks.length) > 0) return
      const data = await apiSend<{ projects?: Project[]; actions?: InboxAction[] }>('/api/autonomy/tick', { method: 'POST' })
      if (data?.projects?.length) setProjects(data.projects)
      if (data?.actions) setActions(data.actions)
    }, 45000)
    return () => window.clearInterval(id)
  }, [operationsOverview, projects, queueTasks.length])

  const setProjectActive = async (id: string, active: boolean) => {
    setProjects((items) =>
      items.map((project) =>
        project.id === id
          ? {
              ...project,
              active,
              autonomous: active,
              cadence: active ? 'slow' : 'paused',
              status: active && project.status !== 'needs-input' && project.status !== 'blocked' ? 'running' : project.status,
              agentsActive: active ? Math.max(project.agentsActive, 1) : 0,
            }
          : project,
      ),
    )
    const data = await apiSend<{ projects?: Project[]; actions?: InboxAction[] }>(`/api/projects/${id}/activation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    if (data?.projects?.length) setProjects(data.projects)
    if (data?.actions) setActions(data.actions)
  }

  const recordDecisionWork = (item: InboxAction, choice: string) => {
    const project = projects.find((candidate) => candidate.id === item.project)
    const taskId = item.task ?? `DEC-${item.id}`
    const work: ProjectWork = {
      id: `decision-${item.id}`,
      taskId,
      project: item.project,
      title: item.task ? item.title : `Follow-up from ${item.title}`,
      model: item.model,
      status: 'running',
      progress: item.type === 'review' ? 0.82 : 0.36,
      stage: `decision applied: ${choice}`,
      eta: item.type === 'review' ? 'reviewing' : 'live',
      branch: item.task ?? project?.branch ?? '-',
      source: 'decision',
      detail: item.type === 'review'
        ? 'Patch decision recorded; the Review flow owns any local apply step.'
        : 'Answer saved to the inbox record. It has not spawned a local CLI by itself.',
      updatedAt: new Date().toISOString(),
    }
    setDecisionWork((items) => [work, ...items.filter((current) => current.id !== work.id)].slice(0, 12))
    setProjects((items) =>
      items.map((candidate) =>
        candidate.id === item.project
          ? {
              ...candidate,
              status: 'running',
              agentsActive: Math.max(candidate.agentsActive, 1),
              lastEvent: work.stage,
              lastAgo: 'now',
            }
          : candidate,
      ),
    )
  }

  const workItems = useMemo(() => mergeProjectWork(queueTasks.length ? queueTasks : seedQueue, runs, decisionWork), [decisionWork, queueTasks, runs])
  const openReview = (taskId?: string | null) => {
    setReviewTaskId(taskId ?? null)
    setView('review')
  }

  const screen = useMemo(() => {
    if (view === 'dashboard') return <Dashboard projects={projects} overview={operationsOverview} openInbox={(id) => { setProjectFilter(id); setView('inbox') }} openGraph={() => setView('graph')} setProjectActive={setProjectActive} />
    if (view === 'health') return <Health />
    if (view === 'inbox') return <Inbox projects={projects} projectFilter={projectFilter} actions={actions} setActions={setActions} clearProjectFilter={() => setProjectFilter(null)} openReview={openReview} workItems={workItems} onDecision={recordDecisionWork} />
    if (view === 'queue') return <Queue projects={projects} overview={operationsOverview} openReview={openReview} />
    if (view === 'schedule') return <Schedule />
    if (view === 'graph') return <Graph projects={projects} openReview={openReview} />
    if (view === 'review') return <Review taskId={reviewTaskId} back={() => setView('queue')} />
    return <SettingsView />
  }, [actions, operationsOverview, projectFilter, projects, reviewTaskId, view, workItems])

  return <><div className="starfield" /><div className="gridwash" /><div className="app"><Rail view={view} setView={setView} actionsOpen={actions.length} /><HUD view={view} projects={projects} modelUsage={modelUsage} modelAuth={modelAuth} refreshModelAuth={loadModelAuth} /><main className="main">{screen}</main><CommandBar model={model} setModel={setModel} projects={projects} projectContext={projectContext} setProjectContext={setProjectContext} setProjectActive={setProjectActive} afterDispatch={async () => { await loadProjects(); await loadActions(); await loadOperations(); await loadModelAuth() }} /></div></>
}
