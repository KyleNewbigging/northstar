import { AlertTriangle, ArrowRight, Check, GitPullRequest, Inbox as InboxIcon, Sparkles, Terminal, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ModelChip } from '../components/ModelChip'
import { Ring } from '../components/Ring'
import { StatusTag } from '../components/StatusTag'
import { apiSend } from '../lib/api'
import { pct, priorityColor, priorityRank, projectName, statusDot, urgencyRank } from '../lib/format'
import type { ProjectWork } from '../lib/work'
import type { InboxAction, Project } from '../types'

function InboxTypeIcon({ type }: { type: InboxAction['type'] }) {
  if (type === 'review') return <GitPullRequest size={15} />
  if (type === 'suggest') return <Sparkles size={15} />
  if (type === 'blocked') return <AlertTriangle size={15} />
  return <InboxIcon size={15} />
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

export function Inbox({
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
