import type { DeviceFileActions } from '../deviceFiles.js'
import type { HeartbeatWriteResult } from '../heartbeat.js'

export type TelegramBridgeSettings = {
  id: 'default'
  enabled: boolean
  chatId: string
  allowedUserIds: string[]
  notifyInbox: boolean
  notifyRunResults: boolean
  notifyImportant: boolean
  notifyLifecycleDebug: boolean
  notifyRunTelemetryDebug: boolean
  notifyDigest: boolean
  debugUntil: string | null
  notifyScheduler: boolean
  notifyPriorities: Array<'P0' | 'P1' | 'P2' | 'P3'>
  lastUpdateId: number | null
  lastSeenAt: string | null
  lastError: string | null
  updatedAt: string
}

export type TelegramSettingsRow = {
  id: 'default'
  enabled: number
  chat_id: string
  allowed_user_ids_json: string
  notify_inbox: number
  notify_run_results: number
  notify_important?: number
  notify_lifecycle_debug?: number
  notify_run_telemetry_debug?: number
  notify_digest?: number
  debug_until?: string | null
  notify_scheduler: number
  notify_priorities_json: string
  last_update_id: number | null
  last_seen_at: string | null
  last_error: string | null
  updated_at: string
}

export type TelegramBridgeInput = Partial<
  Pick<
    TelegramBridgeSettings,
    'enabled' | 'chatId' | 'allowedUserIds' | 'notifyInbox' | 'notifyRunResults' | 'notifyImportant' | 'notifyLifecycleDebug' | 'notifyRunTelemetryDebug' | 'notifyDigest' | 'debugUntil' | 'notifyScheduler' | 'notifyPriorities'
  >
>

export type BridgePriority = TelegramBridgeSettings['notifyPriorities'][number]

export type BridgeInboxAction = {
  id: string
  type: 'question' | 'review' | 'blocked' | 'suggest'
  project: string
  task: string | null
  model: string
  priority: BridgePriority
  urgency: 'high' | 'med' | 'low'
  title: string
  ctx: string
  options?: string[]
  recommend?: number
  help?: string
}

export type BridgeTask = {
  status?: string
  id?: string
  title?: string
  project?: string
  source?: string
  sourceRef?: string
  priority?: BridgePriority
  lane?: string
  stage?: string
  dispatchability?: {
    status?: string
    runnable?: boolean
    canDispatchNow?: boolean
    reason?: string
    action?: string
    stale?: boolean
    schedulerWaiting?: boolean
  }
}

export type BridgeRun = {
  id?: string
  taskId?: string
  taskTitle?: string | null
  taskSource?: string | null
  projectId?: string
  model?: string
  status?: string
  attachCommand?: string | null
  stdout?: string | null
  stderr?: string | null
  finalText?: string | null
  completedAt?: string | null
  updatedAt?: string | null
  startedAt?: string | null
}

export type BridgeProject = {
  active?: boolean
}

export type BridgeSnapshot = {
  actions: BridgeInboxAction[]
  tasks: BridgeTask[]
  runs: BridgeRun[]
  projects: BridgeProject[]
}

export type BridgeOperationsOverview = {
  summary?: {
    activeProjects?: number
    totalProjects?: number
    openDecisions?: number
    runningTasks?: number
    queuedTasks?: number
    blockedTasks?: number
    liveRuns?: number
    runnableTasks?: number
    manualTasks?: number
    githubOnlyTasks?: number
    attentionPending?: number
    attentionFailed?: number
  }
  queuePressure?: {
    totalOpen?: number
    runnable?: number
    schedulerWaiting?: number
    blocked?: number
    needsInput?: number
    manual?: number
    githubOnly?: number
    modelDisabled?: number
    noFreeSlot?: number
  }
  nextAction?: {
    kind?: string
    title?: string
    reason?: string
    command?: string
    taskId?: string
    actionId?: string
    project?: string
    priority?: string
  } | null
  activeProjects?: Array<{ id?: string; name?: string; status?: string; runtime?: string; lastEvent?: string; lastAgo?: string }>
  openDecisions?: BridgeInboxAction[]
  liveRuns?: BridgeRun[]
  telegram?: { ready?: boolean; polling?: boolean; sessions?: TelegramSession[]; configuredChat?: boolean }
}

export type BridgeTaskDetail = {
  ok: boolean
  error?: string
  task?: BridgeTask & {
    model?: string
    agent?: string
    priority?: string
    stage?: string
    source?: string
    sourceRef?: string
    dispatchability?: {
      status?: string
      runnable?: boolean
      canDispatchNow?: boolean
      reason?: string
      action?: string
      stale?: boolean
      schedulerWaiting?: boolean
    }
  }
  dispatchability?: {
    status?: string
    runnable?: boolean
    canDispatchNow?: boolean
    reason?: string
    action?: string
    stale?: boolean
    schedulerWaiting?: boolean
  }
  project?: { id?: string; name?: string; path?: string; source?: string; localExists?: boolean }
  runs?: BridgeRun[]
  actions?: BridgeInboxAction[]
}

export type BridgeRunTaskResult = {
  ok?: boolean
  error?: string
  blocked?: boolean
  dispatchability?: BridgeTaskDetail['dispatchability']
  task?: BridgeTask
  queueTask?: BridgeTask
  run?: BridgeRun & { attachCommand?: string | null }
}

export type BridgeResolveResult = {
  ok: boolean
  id: string
  choice: string
  error?: string
  taskResolution?: {
    taskId?: string
    status?: string
    model?: string
  } | null
  delivery?: 'injected' | 'requeued' | 'record-only'
  deliveryDetail?: string
  deliveryRunId?: string
  deliveryTaskId?: string
}

export type TelegramLogger = {
  info: (...args: any[]) => void
  warn: (...args: any[]) => void
  error?: (...args: any[]) => void
}

export type BridgeQueueMutation = {
  ok: boolean
  id: string
  status?: string
  error?: string
}

export type TelegramBridgeOptions = {
  logger: TelegramLogger
  getSnapshot: () => BridgeSnapshot
  getOperationsOverview?: () => BridgeOperationsOverview
  getQueueTask?: (id: string) => BridgeTaskDetail
  runQueueTask?: (id: string) => BridgeRunTaskResult
  listQueueTasks?: () => BridgeTask[]
  pauseQueueTask?: (id: string) => BridgeQueueMutation
  requeueQueueTask?: (id: string) => BridgeQueueMutation
  resolveInboxAction: (id: string, choice: string) => BridgeResolveResult
  queuePrompt?: (input: TelegramPromptInput) => TelegramPromptResult
  fileActions?: DeviceFileActions
  getHeartbeat?: () => HeartbeatWriteResult
}

export type TelegramBridgeMode = 'poll' | 'grammy'

export type TelegramPromptInput = {
  text: string
  session: TelegramSession
  messageId: number
  autoDispatch?: boolean
}

export type TelegramPromptResult =
  | { ok: true; taskId: string; actionId?: string | null; project: string; model: string; status?: string; autoDispatched?: boolean; dispatch?: BridgeRunTaskResult; lane?: string; laneWarning?: string | null }
  | { ok: false; error: string }

export type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

export type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export type TelegramMessage = {
  message_id: number
  message_thread_id?: number
  text?: string
  caption?: string
  voice?: {
    file_id?: string
    file_unique_id?: string
    duration?: number
    mime_type?: string
  }
  document?: {
    file_id?: string
    file_name?: string
    mime_type?: string
    file_size?: number
  }
  chat: { id: number | string; type?: string }
  from?: { id: number; username?: string; first_name?: string }
}

export type TelegramSentMessage = {
  message_id: number
}

export type TelegramCallbackQuery = {
  id: string
  from?: { id: number; username?: string; first_name?: string }
  message?: TelegramMessage
  data?: string
}

export type TelegramSession = {
  chatId: string
  threadId: string
  project: string
  model: string
  agent: string
  cwd: string
  sessionKey: string
  updatedAt: string
}

export type TelegramUseLane = 'orchestrator' | 'personal'

export type NaturalTelegramRoute = {
  project: string
  model: string
  agent: string
  reason: string
}

export type TelegramSessionRow = {
  chat_id: string
  thread_id: string
  project: string
  model: string
  agent: string
  cwd: string
  session_key: string
  updated_at: string
}

export type AttentionAlertPriority = BridgePriority
export type AttentionEventType = 'task' | 'run'

export type TelegramDocumentProbeInput = {
  fileName?: string
  mimeType?: string
  fileSize?: number
  caption?: string
  sourceText?: string
}

export type TelegramDocumentProbeResult =
  | { ok: true; prompt: string }
  | { ok: false; message: string }

export type RunTelemetryState = {
  stdoutCursor: number
  stderrCursor: number
  sequence: number
  lastSentAt: number
}

export type DigestState = {
  timer: NodeJS.Timeout | null
  taskKeys: Set<string>
  runKeys: Set<string>
  seenTaskKeys: Set<string>
  seenRunKeys: Set<string>
  needsInput: number
  runFinished: number
  blocked: number
  projects: Set<string>
  action: string | null
}

export type AttentionAlertRow = {
  id: string
  event_type: AttentionEventType
  event_key: string
  payload_json: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  next_retry_at: string | null
}

export type AttentionAlertPayload = {
  eventType: AttentionEventType
  key: string
  title: string
  text: string
  priority: AttentionAlertPriority
  channel: string
  project: string
  source?: string
}

export type AttentionAlertDbRow = {
  id: string
  event_type: AttentionEventType
  event_key: string
  payload_json: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  next_retry_at: string | null
}
