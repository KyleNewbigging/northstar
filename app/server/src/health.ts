import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { garminImportRoot } from './paths.js'

type SyncSource = 'strava' | 'garmin'

type SyncSourceRow = {
  source: SyncSource
  connected: number
  auth_state: string
  last_sync_started_at?: string | null
  last_success_at?: string | null
  cursor?: string | null
  last_error?: string | null
  retry_at?: string | null
  config_json?: string | null
  token_json?: string | null
  updated_at: string
}

type HealthProfileRow = {
  id: string
  source: SyncSource
  connected: number
  last_sync: string
  weight: number
  maintenance_calories: number
  goal_id: string
}

type HealthMetricRow = {
  source: SyncSource
  source_date: string
  resting_hr?: number | null
  sleep_hours?: number | null
  active_calories?: number | null
  training_minutes?: number | null
  readiness?: number | null
}

type HealthActivityRow = {
  id: string
  source: SyncSource
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

type StravaConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
  pendingState?: string
}

type StravaToken = {
  access_token: string
  refresh_token: string
  expires_at: number
  expires_in?: number
  token_type?: string
  scope?: string
  athlete?: unknown
}

type StravaActivity = {
  id: number
  name?: string
  type?: string
  sport_type?: string
  start_date?: string
  elapsed_time?: number
  moving_time?: number
  distance?: number
  calories?: number
  average_heartrate?: number
  max_heartrate?: number
}

type GarminDailyMetric = {
  date: string
  restingHr?: number
  sleepHours?: number
  activeCalories?: number
  trainingMinutes?: number
  readiness?: number
  readinessDirect?: boolean
  files: Set<string>
}

type GarminParsedActivity = {
  sourceActivityId: string
  startedAt: string
  name: string
  type: string
  durationSec: number
  distanceM?: number
  calories?: number
  avgHr?: number
  maxHr?: number
  file: string
}

type GarminImportState = {
  daily: Map<string, GarminDailyMetric>
  activities: Map<string, GarminParsedActivity>
  skipped: number
  warnings: string[]
  warningKeys: Set<string>
  filesRead: number
  objectsSeen: number
  objectLimitHit: boolean
}

type GarminImportErrorCode =
  | 'garmin_import_directory_missing'
  | 'garmin_export_files_missing'
  | 'garmin_export_no_importable_records'
  | 'garmin_export_import_failed'

class GarminImportError extends Error {
  code: GarminImportErrorCode
  authState: string

  constructor(code: GarminImportErrorCode, message: string, authState = 'error') {
    super(message)
    this.code = code
    this.authState = authState
  }
}

const stravaAuthorizeUrl = 'https://www.strava.com/oauth/authorize'
const stravaTokenUrl = 'https://www.strava.com/oauth/token'
const stravaApiUrl = 'https://www.strava.com/api/v3'
const healthProfileId = 'default'

const defaultMetrics = [
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
]

const defaultGoals = [
  { id: 'triathlon-base', label: 'Triathlon base', focus: 'swim · bike · run durability', weeklyTrainingHours: 7, maintenanceCalories: 2640, targetWeight: 178 },
  { id: 'marathon-build', label: 'Marathon build', focus: 'aerobic volume and long-run economy', weeklyTrainingHours: 6, maintenanceCalories: 2580, targetWeight: 176 },
  { id: 'frisbee-prep', label: 'Frisbee prep', focus: 'repeat sprint, agility, shoulder resilience', weeklyTrainingHours: 5, maintenanceCalories: 2720, targetWeight: 180 },
  { id: 'general-health', label: 'General health', focus: 'sleep consistency and steady movement', weeklyTrainingHours: 4, maintenanceCalories: 2480, targetWeight: 182 },
]

const defaultWeeklyPlan = [
  { day: 'Mon', focus: 'Zone 2 run + mobility', duration: 45, intensity: 'easy' },
  { day: 'Tue', focus: 'Strength + strides', duration: 55, intensity: 'moderate' },
  { day: 'Wed', focus: 'Bike intervals', duration: 60, intensity: 'hard' },
  { day: 'Thu', focus: 'Swim technique', duration: 40, intensity: 'easy' },
  { day: 'Fri', focus: 'Recovery walk + core', duration: 30, intensity: 'recovery' },
  { day: 'Sat', focus: 'Long aerobic session', duration: 90, intensity: 'moderate' },
  { day: 'Sun', focus: 'Optional sport play', duration: 60, intensity: 'moderate' },
] as const

export function getHealthOverview(db: DatabaseSync) {
  ensureHealthRows(db)
  const profile = db.prepare('SELECT * FROM health_profile WHERE id = ?').get(healthProfileId) as HealthProfileRow
  const metrics = listDailyMetrics(db)
  const sync = listSyncSources(db)
  const activities = listActivities(db)
  const connectedSource = sync.find((item) => item.connected && item.source === 'garmin') ?? sync.find((item) => item.connected)
  return {
    ok: true,
    profile: {
      source: connectedSource?.source ?? profile.source,
      connected: Boolean(connectedSource),
      lastSync: connectedSource?.lastSuccessAt ?? profile.last_sync,
      weight: profile.weight,
      maintenanceCalories: profile.maintenance_calories,
      goalId: profile.goal_id,
      metrics: metrics.length ? metrics : defaultMetrics,
      goals: defaultGoals,
      weeklyPlan: defaultWeeklyPlan,
    },
    sync,
    activities,
  }
}

export function configureStrava(db: DatabaseSync, body: { clientId?: string; clientSecret?: string; redirectUri?: string }) {
  ensureHealthRows(db)
  const clientId = body.clientId?.trim()
  const clientSecret = body.clientSecret?.trim()
  if (!clientId || !clientSecret) return { ok: false as const, error: 'client_id_and_secret_required' }

  const config: StravaConfig = {
    clientId,
    clientSecret,
    redirectUri: body.redirectUri?.trim() || defaultStravaRedirectUri(),
  }
  updateSyncSource(db, 'strava', {
    connected: 0,
    auth_state: 'needs_auth',
    config_json: JSON.stringify(config),
    last_error: null,
  })
  return { ok: true as const, source: 'strava', authUrl: buildStravaAuthorizationUrl(db) }
}

export function buildStravaAuthorizationUrl(db: DatabaseSync) {
  ensureHealthRows(db)
  const row = getSyncSource(db, 'strava')
  const config = parseJson<StravaConfig>(row.config_json)
  if (!config?.clientId || !config.clientSecret) return { ok: false as const, error: 'missing_strava_config' }

  const pendingState = randomUUID()
  const nextConfig: StravaConfig = { ...config, pendingState }
  updateSyncSource(db, 'strava', { config_json: JSON.stringify(nextConfig), last_error: null })

  const url = new URL(stravaAuthorizeUrl)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri || defaultStravaRedirectUri())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('approval_prompt', 'auto')
  url.searchParams.set('scope', 'activity:read_all,profile:read_all')
  url.searchParams.set('state', pendingState)
  return { ok: true as const, authorizationUrl: url.toString(), redirectUri: config.redirectUri || defaultStravaRedirectUri() }
}

export async function handleStravaCallback(db: DatabaseSync, query: { code?: string; scope?: string; state?: string; error?: string }) {
  ensureHealthRows(db)
  if (query.error) return { ok: false as const, error: query.error }
  if (!query.code) return { ok: false as const, error: 'missing_code' }

  const row = getSyncSource(db, 'strava')
  const config = parseJson<StravaConfig>(row.config_json)
  if (!config?.clientId || !config.clientSecret) return { ok: false as const, error: 'missing_strava_config' }
  if (config.pendingState && query.state !== config.pendingState) return { ok: false as const, error: 'state_mismatch' }

  const token = await exchangeStravaToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: query.code,
    grant_type: 'authorization_code',
  })
  const nextConfig = { ...config }
  delete nextConfig.pendingState
  updateSyncSource(db, 'strava', {
    connected: 1,
    auth_state: 'connected',
    config_json: JSON.stringify(nextConfig),
    token_json: JSON.stringify({ ...token, scope: query.scope }),
    last_error: null,
  })
  return { ok: true as const, source: 'strava', scope: query.scope ?? '', athlete: token.athlete ?? null }
}

export async function syncHealthSource(db: DatabaseSync, source: SyncSource) {
  ensureHealthRows(db)
  if (source === 'garmin') return syncGarminExport(db)
  return syncStrava(db)
}

export function getHealthSyncStatus(db: DatabaseSync) {
  ensureHealthRows(db)
  return { sync: listSyncSources(db) }
}

async function syncStrava(db: DatabaseSync) {
  const startedAt = new Date().toISOString()
  updateSyncSource(db, 'strava', { auth_state: 'syncing', last_sync_started_at: startedAt, last_error: null })

  try {
    const row = getSyncSource(db, 'strava')
    const config = parseJson<StravaConfig>(row.config_json)
    const token = parseJson<StravaToken>(row.token_json)
    if (!config?.clientId || !config.clientSecret) throw new Error('missing_strava_config')
    if (!token?.refresh_token) throw new Error('strava_needs_auth')

    const accessToken = await validStravaAccessToken(db, config, token)
    const after = Number(row.cursor ?? 0) || Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60
    const activities = await fetchStravaActivities(accessToken, after)
    const imported = upsertStravaActivities(db, activities)
    const nextCursor = activities.reduce((cursor, activity) => {
      const started = activity.start_date ? Math.floor(new Date(activity.start_date).getTime() / 1000) : 0
      return Math.max(cursor, started)
    }, after)

    updateSyncSource(db, 'strava', {
      connected: 1,
      auth_state: 'connected',
      last_success_at: new Date().toISOString(),
      cursor: String(nextCursor),
      last_error: null,
    })
    return { ok: true as const, source: 'strava', imported, seen: activities.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'strava_sync_failed'
    updateSyncSource(db, 'strava', { auth_state: message === 'strava_needs_auth' ? 'needs_auth' : 'error', last_error: message })
    return { ok: false as const, source: 'strava', error: message }
  }
}

function syncGarminExport(db: DatabaseSync) {
  const startedAt = new Date().toISOString()
  const emptyImported = { dailyMetrics: 0, activities: 0 }
  let parsed: GarminImportState | null = null
  updateSyncSource(db, 'garmin', { auth_state: 'syncing', last_sync_started_at: startedAt, last_error: null })

  try {
    if (!existsSync(garminImportRoot)) {
      throw new GarminImportError(
        'garmin_import_directory_missing',
        `Garmin import directory does not exist: ${garminImportRoot}`,
        'missing_import_directory',
      )
    }

    const files = listGarminJsonFiles(garminImportRoot)
    if (!files.length) {
      throw new GarminImportError(
        'garmin_export_files_missing',
        `No Garmin JSON export files found under ${garminImportRoot}`,
        'needs_export_files',
      )
    }

    parsed = parseGarminExportFiles(files)
    fillGarminDailyFromActivities(parsed.daily, parsed.activities)
    fillGarminReadinessProxies(parsed.daily)
    if (!parsed.daily.size && !parsed.activities.size) {
      throw new GarminImportError(
        'garmin_export_no_importable_records',
        `Scanned ${files.length} Garmin JSON files but found no dashboard metrics or activities.`,
        'no_importable_records',
      )
    }

    const imported = upsertGarminExport(db, parsed.daily, parsed.activities)
    const latestDate = latestGarminDate(parsed.daily, parsed.activities)
    const successAt = new Date().toISOString()
    updateSyncSource(db, 'garmin', {
      connected: 1,
      auth_state: 'connected',
      last_success_at: successAt,
      cursor: latestDate,
      last_error: null,
      config_json: JSON.stringify({ importRoot: garminImportRoot }),
    })
    db.prepare(
      `UPDATE health_profile
       SET source = 'garmin',
           connected = 1,
           last_sync = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(successAt, healthProfileId)

    return {
      ok: true as const,
      source: 'garmin',
      imported,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
      latestDate,
      importRoot: garminImportRoot,
    }
  } catch (error) {
    const err = error instanceof GarminImportError
      ? error
      : new GarminImportError('garmin_export_import_failed', error instanceof Error ? error.message : 'Garmin export import failed.')
    updateSyncSource(db, 'garmin', { auth_state: err.authState, last_error: err.message })
    return {
      ok: false as const,
      source: 'garmin',
      imported: emptyImported,
      skipped: parsed?.skipped ?? 0,
      warnings: parsed?.warnings ?? [],
      latestDate: null,
      importRoot: garminImportRoot,
      error: err.code,
      detail: err.message,
    }
  }
}

function listGarminJsonFiles(root: string) {
  const files: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') {
        files.push(fullPath)
      }
    }
  }
  visit(root)
  return files.sort()
}

function parseGarminExportFiles(files: string[]) {
  const state: GarminImportState = {
    daily: new Map(),
    activities: new Map(),
    skipped: 0,
    warnings: [],
    warningKeys: new Set(),
    filesRead: 0,
    objectsSeen: 0,
    objectLimitHit: false,
  }

  for (const file of files) {
    const relPath = relative(garminImportRoot, file)
    try {
      const stat = statSync(file)
      if (!stat.isFile()) continue
      if (stat.size > 50 * 1024 * 1024) {
        state.skipped += 1
        addGarminWarning(state, `large:${relPath}`, `Skipped oversized Garmin JSON file: ${relPath}`)
        continue
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      state.filesRead += 1
      scanGarminValue(parsed, state, relPath, '', 0)
    } catch (error) {
      state.skipped += 1
      const detail = error instanceof Error ? error.message : 'unknown parse error'
      addGarminWarning(state, `parse:${relPath}`, `Skipped unreadable Garmin JSON file ${relPath}: ${detail}`)
    }
  }

  return state
}

function scanGarminValue(value: unknown, state: GarminImportState, fileRelPath: string, keyPath: string, depth: number) {
  if (depth > 18) return
  if (Array.isArray(value)) {
    for (const item of value) scanGarminValue(item, state, fileRelPath, `${keyPath}[]`, depth + 1)
    return
  }
  if (!isRecord(value)) return
  if (state.objectsSeen >= 160_000) {
    if (!state.objectLimitHit) {
      state.objectLimitHit = true
      addGarminWarning(state, 'object-limit', 'Stopped scanning after 160000 Garmin JSON objects; import what was recognized so far.')
    }
    return
  }

  state.objectsSeen += 1
  const activity = activityFromGarminObject(value, fileRelPath, keyPath)
  if (activity) mergeGarminActivity(state.activities, activity)
  const metric = dailyMetricFromGarminObject(value, fileRelPath, keyPath)
  if (metric) mergeGarminDailyMetric(state.daily, metric, fileRelPath)

  for (const [key, child] of Object.entries(value)) {
    if (shouldSkipGarminBranch(key, child)) {
      state.skipped += 1
      continue
    }
    scanGarminValue(child, state, fileRelPath, keyPath ? `${keyPath}.${key}` : key, depth + 1)
  }
}

function shouldSkipGarminBranch(key: string, value: unknown) {
  const normalized = normalizeKey(key)
  if (!Array.isArray(value) && !isRecord(value)) return true
  return [
    'heartratevalues',
    'heartratevalue',
    'stressvalues',
    'stressvalue',
    'timeoffsetheartratesamples',
    'timeoffsetstresslevelvalues',
    'timeoffsetbodybatterysamples',
    'samples',
    'samplepoints',
    'laps',
    'splits',
    'geoencodedpolyline',
  ].some((prefix) => normalized.includes(prefix))
}

function dailyMetricFromGarminObject(obj: Record<string, unknown>, fileRelPath: string, keyPath: string): Omit<GarminDailyMetric, 'files'> | null {
  const context = `${fileRelPath} ${keyPath}`.toLowerCase()
  const isSleep = context.includes('sleep') || hasAnyKey(obj, [
    'sleepTimeSeconds',
    'totalSleepSeconds',
    'sleepDurationSeconds',
    'deepSleepSeconds',
    'lightSleepSeconds',
    'remSleepSeconds',
    'sleepScore',
    'sleepScores',
  ])
  const hasDailyKey = hasAnyKey(obj, ['calendarDate', 'summaryDate', 'sourceDate', 'date'])
  const dailyContext = hasDailyKey || isSleep || /daily|wellness|fitness|summary/.test(context)
  const activityContext = /activit|workout/.test(context) || hasAnyKey(obj, ['activityId', 'activityName'])
  const hasWellnessMetric = hasAnyKey(obj, [
    'restingHeartRateInBeatsPerMinute',
    'restingHeartRate',
    'activeKilocalories',
    'activeCalories',
    'moderateIntensityMinutes',
    'vigorousIntensityMinutes',
    'intensityMinutes',
    'trainingReadinessScore',
    'readinessScore',
  ])
  if (!dailyContext || (activityContext && !isSleep && !hasWellnessMetric)) return null

  const date = dateFromGarminObject(obj)
  if (!date) return null

  const restingHr = validHeartRate(numberForKey(obj, [
    'restingHeartRateInBeatsPerMinute',
    'restingHeartRate',
    'restingHr',
    'restingHR',
    'resting_bpm',
    'dailyRestingHeartRate',
  ]))
  const activeCalories = positiveNumber(numberForKey(obj, [
    'activeKilocalories',
    'activeCalories',
    'activeCalorie',
    'activeKCal',
    'activeKilocaloriesInKilocalories',
    'totalActiveCalories',
    'wellnessActiveKilocalories',
  ]))
  const trainingMinutes = trainingMinutesFromGarminObject(obj)
  const sleepHours = isSleep ? sleepHoursFromGarminObject(obj) : undefined
  const readiness = readinessFromGarminObject(obj, isSleep)
  const hasValues = [restingHr, activeCalories, trainingMinutes, sleepHours, readiness?.value].some((item) => item !== undefined)
  if (!hasValues) return null

  return {
    date,
    restingHr,
    sleepHours,
    activeCalories,
    trainingMinutes,
    readiness: readiness?.value,
    readinessDirect: readiness?.direct,
  }
}

function activityFromGarminObject(obj: Record<string, unknown>, fileRelPath: string, keyPath: string): GarminParsedActivity | null {
  const context = `${fileRelPath} ${keyPath}`.toLowerCase()
  const explicitId = stringForKey(obj, ['activityId', 'activityIdPk', 'activityUuid', 'uuid', 'summaryId'])
  const activityContext = Boolean(explicitId) || /activit|workout/.test(context)
  if (!activityContext) return null

  const startedAt = timestampFromGarminObject(obj, [
    'startTimeGMT',
    'startTimeGmt',
    'startTimeLocal',
    'startTime',
    'beginTimestamp',
    'startTimestampGMT',
    'startTimestampLocal',
    'activityStartTime',
    'startTimeInSeconds',
    'startTimeInMillis',
  ])
  const durationSec = normalizeDurationSeconds(numberForKey(obj, [
    'duration',
    'durationInSeconds',
    'elapsedDuration',
    'elapsedTime',
    'movingDuration',
    'movingTime',
    'activeTimeInSeconds',
  ]))
  if (!startedAt || !durationSec) return null

  const name = stringForKey(obj, ['activityName', 'name', 'title']) ?? 'Garmin activity'
  const type = activityTypeFromGarminObject(obj) ?? 'activity'
  const sourceActivityId = explicitId ?? garminRecordHash([startedAt, name, type, durationSec, numberForKey(obj, ['distance', 'distanceInMeters'])])

  return {
    sourceActivityId,
    startedAt,
    name,
    type,
    durationSec,
    distanceM: positiveNumber(numberForKey(obj, ['distanceInMeters', 'distanceMeters', 'distance'])),
    calories: positiveNumber(numberForKey(obj, ['calories', 'activeKilocalories', 'activeCalories', 'kilocalories'])),
    avgHr: validHeartRate(numberForKey(obj, ['averageHR', 'averageHr', 'averageHeartRate', 'averageHeartRateInBeatsPerMinute', 'avgHr'])),
    maxHr: validHeartRate(numberForKey(obj, ['maxHR', 'maxHr', 'maxHeartRate', 'maximumHeartRateInBeatsPerMinute'])),
    file: fileRelPath,
  }
}

function mergeGarminDailyMetric(metrics: Map<string, GarminDailyMetric>, metric: Omit<GarminDailyMetric, 'files'>, file = '') {
  const existing: GarminDailyMetric = metrics.get(metric.date) ?? { date: metric.date, files: new Set<string>() }
  if (metric.restingHr !== undefined) existing.restingHr = metric.restingHr
  if (metric.sleepHours !== undefined) existing.sleepHours = Math.max(existing.sleepHours ?? 0, metric.sleepHours)
  if (metric.activeCalories !== undefined) existing.activeCalories = Math.max(existing.activeCalories ?? 0, metric.activeCalories)
  if (metric.trainingMinutes !== undefined) existing.trainingMinutes = Math.max(existing.trainingMinutes ?? 0, metric.trainingMinutes)
  if (metric.readiness !== undefined && (metric.readinessDirect || !existing.readinessDirect)) {
    existing.readiness = metric.readiness
    existing.readinessDirect = Boolean(metric.readinessDirect)
  }
  if (file) existing.files.add(file)
  metrics.set(metric.date, existing)
}

function mergeGarminActivity(activities: Map<string, GarminParsedActivity>, activity: GarminParsedActivity) {
  activities.set(activity.sourceActivityId, activity)
}

function fillGarminDailyFromActivities(metrics: Map<string, GarminDailyMetric>, activities: Map<string, GarminParsedActivity>) {
  const byDate = new Map<string, { calories: number; minutes: number; files: Set<string> }>()
  for (const activity of activities.values()) {
    const date = activity.startedAt.slice(0, 10)
    const existing = byDate.get(date) ?? { calories: 0, minutes: 0, files: new Set<string>() }
    existing.calories += activity.calories ?? 0
    existing.minutes += activity.durationSec / 60
    existing.files.add(activity.file)
    byDate.set(date, existing)
  }

  for (const [date, value] of byDate) {
    const existing: GarminDailyMetric = metrics.get(date) ?? { date, files: new Set<string>() }
    if (!hasPositiveValue(existing.activeCalories) && value.calories > 0) existing.activeCalories = Math.round(value.calories)
    if (!hasPositiveValue(existing.trainingMinutes) && value.minutes > 0) existing.trainingMinutes = Math.round(value.minutes)
    for (const file of value.files) existing.files.add(file)
    metrics.set(date, existing)
  }
}

function fillGarminReadinessProxies(metrics: Map<string, GarminDailyMetric>) {
  const restingValues = [...metrics.values()].map((metric) => metric.restingHr).filter((value): value is number => hasPositiveValue(value))
  const baselineHr = restingValues.length ? avg(restingValues) : 55
  for (const metric of metrics.values()) {
    if (metric.readiness !== undefined) continue
    if (!hasPositiveValue(metric.sleepHours) && !hasPositiveValue(metric.restingHr)) continue
    const sleepComponent = metric.sleepHours !== undefined ? clamp(metric.sleepHours / 8, 0, 1) : 0.72
    const hrComponent = metric.restingHr !== undefined ? clamp(1 - (metric.restingHr - baselineHr) / 15, 0, 1) : 0.72
    metric.readiness = roundTo(clamp(sleepComponent * 0.6 + hrComponent * 0.4, 0, 1), 3)
    metric.readinessDirect = false
  }
}

function upsertGarminExport(db: DatabaseSync, metrics: Map<string, GarminDailyMetric>, activities: Map<string, GarminParsedActivity>) {
  const upsertMetric = db.prepare(
    `INSERT INTO health_daily_metrics
      (id, source, source_date, resting_hr, sleep_hours, active_calories, training_minutes, readiness, raw_json, updated_at)
     VALUES (?, 'garmin', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source, source_date) DO UPDATE SET
       resting_hr = excluded.resting_hr,
       sleep_hours = excluded.sleep_hours,
       active_calories = excluded.active_calories,
       training_minutes = excluded.training_minutes,
       readiness = excluded.readiness,
       raw_json = excluded.raw_json,
       updated_at = CURRENT_TIMESTAMP`,
  )
  for (const metric of metrics.values()) {
    upsertMetric.run(
      `garmin:${metric.date}`,
      metric.date,
      metric.restingHr ?? null,
      metric.sleepHours !== undefined ? roundTo(metric.sleepHours, 2) : null,
      metric.activeCalories !== undefined ? Math.round(metric.activeCalories) : null,
      metric.trainingMinutes !== undefined ? Math.round(metric.trainingMinutes) : null,
      metric.readiness !== undefined ? roundTo(metric.readiness, 3) : null,
      JSON.stringify({ importRoot: garminImportRoot, files: [...metric.files].slice(0, 8), readinessDirect: Boolean(metric.readinessDirect) }),
    )
  }

  const upsertActivity = db.prepare(
    `INSERT INTO health_activities
      (id, source, source_activity_id, started_at, name, type, duration_sec, distance_m, calories, avg_hr, max_hr, raw_json, updated_at)
     VALUES (?, 'garmin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source, source_activity_id) DO UPDATE SET
       started_at = excluded.started_at,
       name = excluded.name,
       type = excluded.type,
       duration_sec = excluded.duration_sec,
       distance_m = excluded.distance_m,
       calories = excluded.calories,
       avg_hr = excluded.avg_hr,
       max_hr = excluded.max_hr,
       raw_json = excluded.raw_json,
       updated_at = CURRENT_TIMESTAMP`,
  )
  for (const activity of activities.values()) {
    upsertActivity.run(
      `garmin:${activity.sourceActivityId}`,
      activity.sourceActivityId,
      activity.startedAt,
      activity.name,
      activity.type,
      Math.round(activity.durationSec),
      activity.distanceM ?? null,
      activity.calories ?? null,
      activity.avgHr ?? null,
      activity.maxHr ?? null,
      JSON.stringify({ importRoot: garminImportRoot, file: activity.file }),
    )
  }

  return { dailyMetrics: metrics.size, activities: activities.size }
}

function latestGarminDate(metrics: Map<string, GarminDailyMetric>, activities: Map<string, GarminParsedActivity>) {
  const dates = [
    ...[...metrics.keys()],
    ...[...activities.values()].map((activity) => activity.startedAt.slice(0, 10)),
  ].filter(Boolean)
  return dates.length ? dates.sort().at(-1) ?? null : null
}

function trainingMinutesFromGarminObject(obj: Record<string, unknown>) {
  const moderate = positiveNumber(numberForKey(obj, ['moderateIntensityMinutes', 'moderateActivityMinutes']))
  const vigorous = positiveNumber(numberForKey(obj, ['vigorousIntensityMinutes', 'vigorousActivityMinutes']))
  if (moderate !== undefined || vigorous !== undefined) return (moderate ?? 0) + (vigorous ?? 0)

  const minutes = positiveNumber(numberForKey(obj, [
    'intensityMinutes',
    'totalIntensityMinutes',
    'trainingMinutes',
    'activeMinutes',
    'highlyActiveMinutes',
  ]))
  if (minutes !== undefined) return minutes

  const seconds = positiveNumber(numberForKey(obj, ['activeTimeInSeconds', 'activeTimeSeconds', 'activeSeconds']))
  return seconds !== undefined ? seconds / 60 : undefined
}

function sleepHoursFromGarminObject(obj: Record<string, unknown>) {
  const directHours = positiveNumber(numberForKey(obj, ['sleepHours', 'totalSleepHours']))
  if (directHours !== undefined && directHours <= 24) return directHours

  const directSeconds = numberForKey(obj, [
    'sleepTimeSeconds',
    'totalSleepSeconds',
    'sleepDurationSeconds',
    'sleepTimeInSeconds',
    'durationInSeconds',
    'duration',
  ])
  const normalized = normalizeDurationSeconds(directSeconds)
  if (normalized !== undefined && normalized <= 48 * 60 * 60) return normalized / 3600

  const stageSeconds = [
    'deepSleepSeconds',
    'lightSleepSeconds',
    'remSleepSeconds',
    'awakeSleepSeconds',
  ].reduce((sum, key) => sum + (positiveNumber(numberForKey(obj, [key])) ?? 0), 0)
  return stageSeconds > 0 ? stageSeconds / 3600 : undefined
}

function readinessFromGarminObject(obj: Record<string, unknown>, isSleep: boolean) {
  const direct = numberForKey(obj, [
    'readiness',
    'readinessScore',
    'trainingReadinessScore',
    'dailyReadinessScore',
    'recoveryScore',
  ])
  const directScore = normalizeScore(direct)
  if (directScore !== undefined) return { value: directScore, direct: true }

  if (!isSleep) return null
  const sleepScore = numberForKey(obj, ['sleepScore', 'overallScore', 'sleepQualityScore'])
    ?? sleepNestedScore(obj)
  const normalizedSleepScore = normalizeScore(sleepScore)
  return normalizedSleepScore !== undefined ? { value: normalizedSleepScore, direct: true } : null
}

function sleepNestedScore(obj: Record<string, unknown>) {
  const scoreRoot = valueForKey(obj, ['sleepScores', 'sleepScore'])
  if (!isRecord(scoreRoot)) return undefined
  const overall = valueForKey(scoreRoot, ['overall', 'overallScore'])
  if (overall !== undefined) {
    const score = coerceNumber(overall)
    if (score !== undefined) return score
    if (isRecord(overall)) return numberForKey(overall, ['value', 'score', 'qualifier'])
  }
  return numberForKey(scoreRoot, ['value', 'score', 'overallScore'])
}

function dateFromGarminObject(obj: Record<string, unknown>) {
  for (const key of [
    'calendarDate',
    'summaryDate',
    'sourceDate',
    'date',
    'activityDate',
    'sleepDate',
    'startDate',
    'startTimeLocal',
    'startTimeGMT',
    'sleepStartTimestampGMT',
    'sleepStartTimestampLocal',
    'startTime',
    'beginTimestamp',
    'startTimeInSeconds',
    'startTimeInMillis',
  ]) {
    const date = normalizeDateOnly(valueForKey(obj, [key]))
    if (date) return date
  }
  return null
}

function timestampFromGarminObject(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const timestamp = normalizeTimestamp(valueForKey(obj, [key]))
    if (timestamp) return timestamp
  }
  return null
}

function activityTypeFromGarminObject(obj: Record<string, unknown>) {
  const direct = stringForKey(obj, ['activityTypeKey', 'sportType', 'typeKey', 'type'])
  if (direct) return direct
  const nested = valueForKey(obj, ['activityType', 'activityTypeDTO', 'sportTypeDTO'])
  if (isRecord(nested)) return stringForKey(nested, ['typeKey', 'type', 'name', 'displayName'])
  return undefined
}

function normalizeDateOnly(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const ymd = trimmed.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/)
    if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`
    const mdy = trimmed.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`
  }
  const timestamp = normalizeTimestamp(value)
  return timestamp?.slice(0, 10) ?? null
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : null
    if (ms === null) return null
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return normalizeTimestamp(Number(trimmed))
  const ymd = trimmed.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}T00:00:00.000Z`
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  const date = new Date(hasZone ? normalized : `${normalized}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeDurationSeconds(value: unknown) {
  const number = coerceNumber(value)
  if (number === undefined || number <= 0) return undefined
  return number > 1_000_000 ? number / 1000 : number
}

function normalizeScore(value: unknown) {
  const number = coerceNumber(value)
  if (number === undefined || number < 0) return undefined
  return roundTo(clamp(number > 1 ? number / 100 : number, 0, 1), 3)
}

function numberForKey(obj: Record<string, unknown>, keys: string[]) {
  return coerceNumber(valueForKey(obj, keys))
}

function stringForKey(obj: Record<string, unknown>, keys: string[]) {
  const value = valueForKey(obj, keys)
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (isRecord(value)) return stringForKey(value, ['typeKey', 'name', 'displayName', 'value'])
  return undefined
}

function valueForKey(obj: Record<string, unknown>, keys: string[]) {
  const normalizedKeys = new Set(keys.map(normalizeKey))
  for (const [key, value] of Object.entries(obj)) {
    if (normalizedKeys.has(normalizeKey(key))) return value
  }
  return undefined
}

function hasAnyKey(obj: Record<string, unknown>, keys: string[]) {
  const normalizedKeys = new Set(keys.map(normalizeKey))
  return Object.keys(obj).some((key) => normalizedKeys.has(normalizeKey(key)))
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (isRecord(value)) return numberForKey(value, ['value', 'amount', 'score', 'minutes', 'seconds'])
  return undefined
}

function validHeartRate(value: unknown) {
  const number = coerceNumber(value)
  return number !== undefined && number >= 25 && number <= 230 ? number : undefined
}

function positiveNumber(value: unknown) {
  const number = coerceNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

function hasPositiveValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positiveMetric(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function garminRecordHash(parts: unknown[]) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

function addGarminWarning(state: GarminImportState, key: string, message: string) {
  if (state.warningKeys.has(key)) return
  state.warningKeys.add(key)
  if (state.warnings.length < 8) state.warnings.push(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function avg(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

async function validStravaAccessToken(db: DatabaseSync, config: StravaConfig, token: StravaToken) {
  const expiresAtMs = token.expires_at * 1000
  if (expiresAtMs - Date.now() > 60 * 60 * 1000) return token.access_token

  const refreshed = await exchangeStravaToken({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  })
  const nextToken = { ...token, ...refreshed }
  updateSyncSource(db, 'strava', { token_json: JSON.stringify(nextToken) })
  return nextToken.access_token
}

async function exchangeStravaToken(params: Record<string, string>) {
  const response = await fetch(stravaTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const payload = (await response.json().catch(() => null)) as StravaToken | { message?: string; errors?: unknown[] } | null
  if (!response.ok || !payload || !('access_token' in payload)) {
    const message = payload && 'message' in payload ? payload.message : `strava_token_http_${response.status}`
    throw new Error(message || 'strava_token_exchange_failed')
  }
  return payload
}

async function fetchStravaActivities(accessToken: string, after: number) {
  const activities: StravaActivity[] = []
  for (let page = 1; page <= 3; page += 1) {
    const url = new URL(`${stravaApiUrl}/athlete/activities`)
    url.searchParams.set('after', String(after))
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', '100')
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) throw new Error(`strava_activities_http_${response.status}`)
    const pageItems = (await response.json()) as StravaActivity[]
    activities.push(...pageItems)
    if (pageItems.length < 100) break
  }
  return activities
}

function upsertStravaActivities(db: DatabaseSync, activities: StravaActivity[]) {
  const upsertActivity = db.prepare(
    `INSERT INTO health_activities
      (id, source, source_activity_id, started_at, name, type, duration_sec, distance_m, calories, avg_hr, max_hr, raw_json, updated_at)
     VALUES (?, 'strava', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source, source_activity_id) DO UPDATE SET
       started_at = excluded.started_at,
       name = excluded.name,
       type = excluded.type,
       duration_sec = excluded.duration_sec,
       distance_m = excluded.distance_m,
       calories = excluded.calories,
       avg_hr = excluded.avg_hr,
       max_hr = excluded.max_hr,
       raw_json = excluded.raw_json,
       updated_at = CURRENT_TIMESTAMP`,
  )
  const daily = new Map<string, { calories: number; minutes: number }>()
  let imported = 0
  for (const activity of activities) {
    if (!activity.id || !activity.start_date) continue
    const date = activity.start_date.slice(0, 10)
    const calories = Number(activity.calories ?? 0)
    const minutes = Math.round(Number(activity.moving_time ?? activity.elapsed_time ?? 0) / 60)
    const existing = daily.get(date) ?? { calories: 0, minutes: 0 }
    daily.set(date, { calories: existing.calories + calories, minutes: existing.minutes + minutes })
    upsertActivity.run(
      `strava:${activity.id}`,
      String(activity.id),
      activity.start_date,
      activity.name ?? 'Strava activity',
      activity.sport_type ?? activity.type ?? 'activity',
      Number(activity.moving_time ?? activity.elapsed_time ?? 0),
      Number(activity.distance ?? 0),
      calories || null,
      activity.average_heartrate ?? null,
      activity.max_heartrate ?? null,
      JSON.stringify(activity),
    )
    imported += 1
  }

  const upsertMetric = db.prepare(
    `INSERT INTO health_daily_metrics
      (id, source, source_date, active_calories, training_minutes, raw_json, updated_at)
     VALUES (?, 'strava', ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source, source_date) DO UPDATE SET
       active_calories = excluded.active_calories,
       training_minutes = excluded.training_minutes,
       raw_json = excluded.raw_json,
       updated_at = CURRENT_TIMESTAMP`,
  )
  for (const [date, value] of daily) {
    upsertMetric.run(`strava:${date}`, date, Math.round(value.calories), value.minutes, JSON.stringify(value))
  }
  return imported
}

function ensureHealthRows(db: DatabaseSync) {
  db.prepare(
    `INSERT OR IGNORE INTO health_profile
      (id, source, connected, last_sync, weight, maintenance_calories, goal_id)
     VALUES (?, 'garmin', 0, 'No health sync yet', 182, 2640, 'triathlon-base')`,
  ).run(healthProfileId)
  db.prepare(
    `INSERT OR IGNORE INTO health_sync_sources
      (source, connected, auth_state, last_error)
     VALUES ('strava', 0, 'missing_config', 'Strava app client id/secret required before OAuth.')`,
  ).run()
  db.prepare(
    `INSERT OR IGNORE INTO health_sync_sources
      (source, connected, auth_state, last_error)
     VALUES ('garmin', 0, 'needs_export_or_api_approval', 'Garmin Health API approval or Garmin data export import is required.')`,
  ).run()
}

function listDailyMetrics(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT source, source_date, resting_hr, sleep_hours, active_calories, training_minutes, readiness
       FROM health_daily_metrics
       ORDER BY source_date DESC
       LIMIT 180`,
    )
    .all() as HealthMetricRow[]
  const byDate = new Map<string, {
    sourceDate: string
    restingHr?: number
    sleepHours?: number
    activeCalories?: number
    trainingMinutes?: number
    readiness?: number
    garminActiveCalories?: boolean
    garminTrainingMinutes?: boolean
  }>()

  for (const row of rows.sort((a, b) => a.source_date.localeCompare(b.source_date))) {
    const existing = byDate.get(row.source_date) ?? { sourceDate: row.source_date }
    const restingHr = positiveMetric(row.resting_hr)
    const sleepHours = positiveMetric(row.sleep_hours)
    const activeCalories = positiveMetric(row.active_calories)
    const trainingMinutes = positiveMetric(row.training_minutes)
    const readiness = positiveMetric(row.readiness)

    if (row.source === 'garmin') {
      if (restingHr !== undefined) existing.restingHr = restingHr
      if (sleepHours !== undefined) existing.sleepHours = sleepHours
      if (readiness !== undefined) existing.readiness = readiness
      if (activeCalories !== undefined) {
        existing.activeCalories = activeCalories
        existing.garminActiveCalories = true
      }
      if (trainingMinutes !== undefined) {
        existing.trainingMinutes = trainingMinutes
        existing.garminTrainingMinutes = true
      }
    } else {
      if (restingHr !== undefined && existing.restingHr === undefined) existing.restingHr = restingHr
      if (sleepHours !== undefined && existing.sleepHours === undefined) existing.sleepHours = sleepHours
      if (readiness !== undefined && existing.readiness === undefined) existing.readiness = readiness
      if (activeCalories !== undefined && !existing.garminActiveCalories) existing.activeCalories = activeCalories
      if (trainingMinutes !== undefined && !existing.garminTrainingMinutes) existing.trainingMinutes = trainingMinutes
    }
    byDate.set(row.source_date, existing)
  }

  return [...byDate.values()]
    .sort((a, b) => a.sourceDate.localeCompare(b.sourceDate))
    .slice(-60)
    .map((row) => ({
      date: compactDate(row.sourceDate),
      restingHr: Number(row.restingHr ?? 0),
      sleepHours: Number(row.sleepHours ?? 0),
      activeCalories: Number(row.activeCalories ?? 0),
      trainingMinutes: Number(row.trainingMinutes ?? 0),
      readiness: Number(row.readiness ?? 0),
    }))
}

function listActivities(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT id, source, source_activity_id, started_at, name, type, duration_sec, distance_m, calories, avg_hr, max_hr
       FROM health_activities
       ORDER BY started_at DESC
       LIMIT 20`,
    )
    .all() as HealthActivityRow[]
}

function listSyncSources(db: DatabaseSync) {
  return (db.prepare('SELECT * FROM health_sync_sources ORDER BY source ASC').all() as SyncSourceRow[]).map((row) => ({
    source: row.source,
    connected: row.connected === 1,
    authState: row.auth_state,
    lastSyncStartedAt: row.last_sync_started_at ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    cursor: row.cursor ?? null,
    lastError: row.last_error ?? null,
    retryAt: row.retry_at ?? null,
    updatedAt: row.updated_at,
    configured: Boolean(parseJson<StravaConfig>(row.config_json)?.clientId || row.source === 'garmin'),
  }))
}

function getSyncSource(db: DatabaseSync, source: SyncSource) {
  const row = db.prepare('SELECT * FROM health_sync_sources WHERE source = ?').get(source) as SyncSourceRow | undefined
  if (!row) {
    ensureHealthRows(db)
    return db.prepare('SELECT * FROM health_sync_sources WHERE source = ?').get(source) as SyncSourceRow
  }
  return row
}

function updateSyncSource(db: DatabaseSync, source: SyncSource, updates: Partial<Omit<SyncSourceRow, 'source' | 'updated_at'>>) {
  const current = getSyncSource(db, source)
  db.prepare(
    `UPDATE health_sync_sources
     SET connected = ?,
         auth_state = ?,
         last_sync_started_at = ?,
         last_success_at = ?,
         cursor = ?,
         last_error = ?,
         retry_at = ?,
         config_json = ?,
         token_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE source = ?`,
  ).run(
    updates.connected ?? current.connected,
    updates.auth_state ?? current.auth_state,
    updates.last_sync_started_at ?? current.last_sync_started_at ?? null,
    updates.last_success_at ?? current.last_success_at ?? null,
    updates.cursor ?? current.cursor ?? null,
    updates.last_error === undefined ? current.last_error ?? null : updates.last_error,
    updates.retry_at ?? current.retry_at ?? null,
    updates.config_json ?? current.config_json ?? null,
    updates.token_json ?? current.token_json ?? null,
    source,
  )
}

function parseJson<T>(value?: string | null) {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function defaultStravaRedirectUri() {
  const port = process.env.NORTHSTAR_PORT ?? '4317'
  return `http://127.0.0.1:${port}/api/health/strava/callback`
}

function compactDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
