import { Activity, Bike, CalendarDays, Dumbbell, Flame, HeartPulse, Moon, Scale, Target } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Ring } from '../components/Ring'
import { Sparkline } from '../components/Sparkline'
import { healthProfile } from '../data/seed'
import { apiJson, apiSend } from '../lib/api'
import type { HealthActivity, HealthDailyMetric, HealthProfile, HealthSyncStatus } from '../types'

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

export function Health() {
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
