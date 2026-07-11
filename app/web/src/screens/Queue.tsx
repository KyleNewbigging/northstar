import { Layers, Network, Pause, Play, Terminal, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ModelChip } from '../components/ModelChip'
import { StatusTag } from '../components/StatusTag'
import { queue as seedQueue } from '../data/seed'
import { apiJson, apiSend } from '../lib/api'
import { modelLabel, pct, priorityColor, projectName, queueSourceLabel, taskAgeLabel } from '../lib/format'
import { runAttachCommand, runCommand, runCwd, runOutput, runTaskId, runWorktree, type AgentRun } from '../lib/work'
import type { OperationsOverview, Project, QueueTask } from '../types'

export function Queue({ projects, overview, openReview }: { projects: Project[]; overview: OperationsOverview | null; openReview: (taskId?: string | null) => void }) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [queueTasks, setQueueTasks] = useState<QueueTask[]>([])
  const [working, setWorking] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [queueFilter, setQueueFilter] = useState<'all' | 'runnable' | 'blocked' | 'manual' | 'github-only' | 'scheduler' | 'stale'>('all')
  const [laneFilter, setLaneFilter] = useState<'all' | 'dev' | 'personal' | 'telegram-intent'>('all')

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
  const laneTasks = tasks.filter((task) => laneFilter === 'all' || task.lane === laneFilter)
  const visibleTasks = laneTasks.filter((task) => queueFilter === 'all'
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
    { id: 'all', label: 'All', count: laneTasks.length },
    { id: 'runnable', label: 'Runnable', count: laneTasks.filter((task) => task.dispatchability?.canDispatchNow).length },
    { id: 'blocked', label: 'Blocked', count: laneTasks.filter((task) => task.status === 'blocked' || task.status === 'needs-input').length },
    { id: 'manual', label: 'Manual', count: laneTasks.filter((task) => task.dispatchability?.status === 'manual').length },
    { id: 'github-only', label: 'GitHub-only', count: laneTasks.filter((task) => task.dispatchability?.status === 'github-only').length },
    { id: 'scheduler', label: 'Scheduler', count: laneTasks.filter((task) => task.dispatchability?.schedulerWaiting).length },
    { id: 'stale', label: 'Stale', count: laneTasks.filter((task) => task.dispatchability?.stale).length },
  ]
  const laneFilters: Array<{ id: typeof laneFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: tasks.length },
    { id: 'dev', label: 'Dev', count: tasks.filter((task) => task.lane === 'dev').length },
    { id: 'personal', label: 'Personal', count: tasks.filter((task) => task.lane === 'personal').length },
    { id: 'telegram-intent', label: 'Telegram', count: tasks.filter((task) => task.lane === 'telegram-intent').length },
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
            {laneFilters.map(({ id, label, count }) => (
              <button key={id} type="button" className={`chip${laneFilter === id ? ' on' : ''}`} onClick={() => setLaneFilter(id)}>
                {label}<span className="chip-n">{count}</span>
              </button>
            ))}
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
