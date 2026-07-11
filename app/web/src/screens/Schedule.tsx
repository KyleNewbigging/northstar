import { Clock, Play, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ModelChip } from '../components/ModelChip'
import { apiJson, apiSend } from '../lib/api'
import type { ProjectOnboarding, SchedulerSettings } from '../types'

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
  codexEnabled: true,
  updatedAt: '',
}

export function Schedule() {
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
              <button type="button" className={`toggle-pill${scheduler.codexEnabled ? ' on' : ''}`} onClick={() => setBoolean('codexEnabled', !scheduler.codexEnabled)}><ModelChip id="codex" small />Primary</button>
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
