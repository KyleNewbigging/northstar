import { Network, Search, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { communities, graphEdges, graphNodes } from '../data/seed'
import { apiJson } from '../lib/api'
import type { GraphPayload, Project } from '../types'

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

export function Graph({ projects, openReview }: { projects: Project[]; openReview: (taskId?: string | null) => void }) {
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
