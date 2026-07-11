import { AlertTriangle, Check, GitPullRequest, Layers, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ModelChip } from '../components/ModelChip'
import { patch as seedPatch } from '../data/seed'
import { apiJson, apiSend } from '../lib/api'
import type { Patch } from '../types'

export function Review({ taskId, back }: { taskId: string | null; back: () => void }) {
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
