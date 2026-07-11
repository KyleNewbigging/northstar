import { AlertTriangle, Boxes, Check, GitBranch, Layers, Network, Sparkles, Zap } from 'lucide-react'
import { useState } from 'react'

import { Ring } from '../components/Ring'
import { Sparkline } from '../components/Sparkline'
import { StatusTag } from '../components/StatusTag'
import { fmtNum, pct } from '../lib/format'
import type { OperationsOverview, Project } from '../types'

export function Dashboard({
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
