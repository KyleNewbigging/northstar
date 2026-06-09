import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Inbox as InboxIcon,
  Layers,
  Mic,
  Network,
  Pause,
  Play,
  Search,
  Settings,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'

import { actions as seedActions, communities, fallbackProjects, graphEdges, graphNodes, models, patch, queue as seedQueue } from './data/seed'
import type { InboxAction, ModelId, Project, QueueTask, Status } from './types'

type View = 'dashboard' | 'inbox' | 'queue' | 'graph' | 'review' | 'settings'

const modelColor: Record<ModelId, string> = { opus: 'var(--c1)', codex: 'var(--c4)', spark: 'var(--cyan)' }
const priorityColor = { P0: 'var(--err)', P1: 'var(--star)', P2: 'var(--cyan)', P3: 'var(--ink-3)' }
const statusDot: Record<Status, string> = {
  running: 'dot-run',
  'needs-input': 'dot-queue',
  queued: 'dot-queue',
  blocked: 'dot-block',
  done: 'dot-done',
  idle: 'dot-idle',
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

function fmtNum(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value)
}

function projectName(projects: Project[], id: string) {
  return projects.find((project) => project.id === id)?.name ?? id
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

type VoiceEngine = 'whisper' | 'web-speech'
type VoiceState = 'idle' | 'listening-whisper' | 'listening-webspeech' | 'transcribing'

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
    ['inbox', <InboxIcon size={18} />, 'Inbox'],
    ['queue', <Layers size={18} />, 'Agent Queue'],
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
          <button key={id} className={`rail-btn${view === id ? ' on' : ''}`} title={label} onClick={() => setView(id)}>
            {icon}
            {id === 'inbox' ? <span className="rail-badge">{actionsOpen}</span> : null}
            <span className="rail-tip">{label}</span>
          </button>
        ))}
      </div>
      <button className={`rail-btn${view === 'settings' ? ' on' : ''}`} title="Settings" style={{ marginTop: 'auto' }} onClick={() => setView('settings')}>
        <Settings size={18} />
        <span className="rail-tip">Settings</span>
      </button>
    </nav>
  )
}

function HUD({ view, projects }: { view: View; projects: Project[] }) {
  const [clock, setClock] = useState('')
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-GB'))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  const title: Record<View, [string, string]> = {
    dashboard: ['FLIGHT DECK', `${projects.length} projects · local inventory`],
    inbox: ['MISSION INBOX', 'what needs you - across all projects'],
    queue: ['AGENT QUEUE', 'what to work on next'],
    graph: ['GRAPH COCKPIT', 'graphify-oriented knowledge graph'],
    review: ['PATCH REVIEW', 'worktree patch preview'],
    settings: ['SETTINGS', 'local guardrails and model routing'],
  }
  const [h, sub] = title[view]
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
      <div className="row gap16">
        <div className="usage"><span className="eyebrow" style={{ fontSize: 9 }}>TOKENS / DAY</span><div className="meter" style={{ width: 96, marginTop: 4 }}><i style={{ width: '33%' }} /></div></div>
        <div className="usage"><span className="eyebrow" style={{ fontSize: 9 }}>COMPUTE</span><div className="meter cool" style={{ width: 96, marginTop: 4 }}><i style={{ width: '61%' }} /></div></div>
        <div className="usage"><span className="eyebrow" style={{ fontSize: 9 }}>CODEX · SPARK</span><span className="tnum" style={{ marginTop: 4, fontSize: 10, color: 'var(--ink-2)' }}>2 background slots</span></div>
        <div className="row gap6"><Zap size={14} style={{ color: 'var(--star)' }} /><span className="tnum">{projects.filter((p) => p.status === 'needs-input').length}</span></div>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{clock}</span>
      </div>
    </header>
  )
}

function CommandBar({ model, setModel }: { model: ModelId; setModel: (model: ModelId) => void }) {
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>('whisper')
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recognitionRef = useRef<any>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const activeEngineRef = useRef<VoiceEngine | null>(null)

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

  const startWebSpeechCapture = () => {
    const recognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!recognitionCtor) {
      setError('Browser speech API unavailable; use local Whisper or type directly.')
      setVoiceEngine('whisper')
      return
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
      setRecording(false)
      setVoiceState('idle')
      activeEngineRef.current = null
      setTimeout(() => {
        recognitionRef.current = null
      }, 0)
    }

    recognition.onerror = (event: any) => {
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      activeEngineRef.current = 'whisper'
      audioChunksRef.current = []
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
          setVoiceState('idle')
          setRecording(false)
          activeEngineRef.current = null
        }
      }

      recorder.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to access microphone.'
      setError(message)
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
    startWebSpeechCapture()
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
          className={`cmd-mic${recording ? ' on' : ''}`}
          onClick={toggleRecording}
          title="Talk to Northstar"
        >
          <Mic size={17} />
          {voiceState !== 'idle' ? <span className="mic-rings"><i></i><i></i><i></i></span> : null}
        </button>
        <button type="button" className="cmd-ctx" aria-label="Project context selector"><i className="dot dot-run" /><span className="mono">all-projects</span><ChevronDown size={12} /></button>
        <input
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
        <button type="button" className="btn btn-primary" onClick={() => setText('')}><ArrowRight size={15} /> Dispatch</button>
      </div>
      <div className="cmd-hint">
        <span><span className="kbd">CMD K</span> command palette</span>
        <span style={{ color: error ? 'var(--err)' : 'var(--ink-4)' }}>{error || commandHint}</span>
        <span><span className="kbd">@</span> files · <span className="kbd">#</span> tasks</span>
      </div>
    </div>
  )
}

function Dashboard({ projects, openInbox }: { projects: Project[]; openInbox: (id: string) => void }) {
  const active = projects.filter((p) => p.status === 'needs-input' || p.status === 'running').length
  const changed = projects.reduce((sum, p) => sum + p.openTasks, 0)
  return (
    <div className="screen">
      <div className="dash-stats">
        <Stat label="PROJECTS TRACKED" value={projects.length} sub="local git repos under ~/dev" icon={<Boxes size={14} />} />
        <Stat label="NEEDS YOU" value={active} sub="dirty, behind, or missing graphify" accent="var(--cyan)" icon={<AlertTriangle size={14} />} />
        <Stat label="OPEN LOOPS" value={changed} sub="derived from git status + graph state" icon={<Layers size={14} />} />
        <Stat label="MODEL ROUTER" value="Spark" sub="background default; 5.5 reserved" accent="var(--star)" icon={<Zap size={14} />} />
      </div>
      <div className="dash-body">
        <div className="dash-main scroll">
          <div className="row gap10" style={{ marginBottom: 10 }}><span className="eyebrow">PROJECTS</span><span className="tnum" style={{ fontSize: 11, color: 'var(--ink-4)' }}>{projects.length} tracked · ~/dev</span><span className="grow" /></div>
          <div className="dash-cards">{projects.map((p) => <ProjectCard key={p.id} project={p} onClick={() => openInbox(p.id)} />)}</div>
        </div>
        <div className="dash-side"><Telemetry projects={projects} /></div>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, icon, accent }: { label: string; value: string | number; sub: string; icon: React.ReactNode; accent?: string }) {
  return <div className="panel brackets stat-tile"><div className="row gap8" style={{ justifyContent: 'space-between' }}><span className="eyebrow">{label}</span><span style={{ color: accent ?? 'var(--ink-3)' }}>{icon}</span></div><span className="tnum" style={{ display: 'block', marginTop: 8, fontSize: 30, lineHeight: 1, color: accent ?? 'var(--ink)' }}>{value}</span><div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6 }}>{sub}</div></div>
}

function ProjectCard({ project, onClick }: { project: Project; onClick: () => void }) {
  return (
    <button className="panel brackets proj-card" onClick={onClick}>
      <div className="row gap10" style={{ justifyContent: 'space-between' }}><div className="row gap8 grow"><Ring value={project.health} /><div className="col grow" style={{ minWidth: 0 }}><span className="mono proj-name">{project.name}</span><span className="row gap6" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}><GitBranch size={11} />{project.branch}<span className={`lbl lbl-${project.label}`}>{project.label}</span></span></div></div><StatusTag status={project.status} /></div>
      <div className="proj-meta"><div className="pm"><span className="eyebrow">LANG</span><span className="mono">{project.lang}</span></div><div className="pm"><span className="eyebrow">NODES</span><span className="tnum">{fmtNum(project.nodes)}</span></div><div className="pm"><span className="eyebrow">HEALTH</span><span className="tnum">{pct(project.health)}</span></div><div className="pm"><span className="eyebrow">RUNTIME</span><span className="tnum">{project.runtime}</span></div></div>
      <div className="row gap8" style={{ margin: '2px 0 4px' }}><Sparkline data={project.spark} width={120} color={project.status === 'blocked' ? 'var(--err)' : 'var(--star)'} /><span className="grow" /><div className="col" style={{ alignItems: 'flex-end' }}><span className="tnum" style={{ fontSize: 11 }}>{project.linesNet}</span><span className="eyebrow" style={{ fontSize: 9 }}>WORKTREE</span></div></div>
      <div className="proj-foot"><div className="row gap8"><span className="tag"><i className={`dot ${project.agentsActive ? 'dot-run live' : 'dot-idle'}`} />{project.agentsActive ? `${project.agentsActive} AGENT` : 'IDLE'}</span><span style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{project.openTasks} open · {project.queued} queued</span></div><span className="proj-event mono">{project.lastEvent}<span style={{ color: 'var(--ink-4)' }}> · {project.lastAgo}</span></span></div>
      <div className="meter" style={{ marginTop: 2 }}><i style={{ width: pct(Math.min(1, project.tokens / project.budget)) }} /></div>
    </button>
  )
}

function Telemetry({ projects }: { projects: Project[] }) {
  return <div className="panel brackets col" style={{ overflow: 'hidden' }}><div className="panel-hd"><Zap size={14} style={{ color: 'var(--star)' }} /><h3>Telemetry Stream</h3><span className="grow" /><i className="dot dot-run live" /></div><div className="scroll grow" style={{ padding: '6px 4px' }}>{projects.slice(0, 8).map((p) => <div key={p.id} className="feed-row"><span className="tnum feed-time">{p.lastAgo}</span><AlertTriangle size={13} style={{ color: p.status === 'needs-input' ? 'var(--cyan)' : 'var(--star)', flex: 'none' }} /><div className="col grow"><span style={{ fontSize: 12 }}>{p.lastEvent}</span><span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{p.name} · {p.lang}</span></div></div>)}</div></div>
}

function Inbox({ projects, projectFilter, actions, setActions, openReview }: { projects: Project[]; projectFilter: string | null; actions: InboxAction[]; setActions: (items: InboxAction[]) => void; openReview: () => void }) {
  const filtered = actions.filter((a) => !projectFilter || a.project === projectFilter).sort((a, b) => a.priority.localeCompare(b.priority))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = filtered.find((a) => a.id === selectedId) ?? filtered[0]
  const resolve = (item: InboxAction, choice: string) => setActions(actions.filter((a) => a.id !== item.id))
  return <div className="screen inbox-screen"><div className="ib-banner"><Zap size={15} style={{ color: 'var(--star)' }} /><span className="mono"><b>{projects.filter((p) => p.status === 'needs-input').length} projects</b> need attention</span><span className="grow" /><span className="chip on">{projectFilter ? projectName(projects, projectFilter) : 'All'}</span></div><div className="inbox-grid"><div className="panel brackets col" style={{ overflow: 'hidden' }}><div className="ib-typebar"><button className="ib-tab on">All <span className="chip-n">{filtered.length}</span></button><button className="ib-tab">Questions</button><button className="ib-tab">Reviews</button><button className="ib-tab">Suggestions</button></div><div className="scroll grow">{filtered.map((a, i) => <button key={a.id} className={`ib-row${selected?.id === a.id ? ' active' : ''}`} onClick={() => setSelectedId(a.id)}><span className="ib-prio" style={{ background: priorityColor[a.priority] }} /><span className="ib-ticon"><AlertTriangle size={15} /></span><div className="col grow"><div className="row gap8">{i === 0 ? <span className="ib-next">NEXT</span> : null}<span className="ib-title grow">{a.title}</span></div><div className="row gap8"><span className="mono ib-proj">{projectName(projects, a.project)}</span><span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{a.type}</span><span className="grow" /><span className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{a.ago}</span></div></div></button>)}</div></div><div className="panel brackets" style={{ overflow: 'auto' }}>{selected ? <div className="ib-detail"><div className="ib-detail-hd"><span className="tag">{selected.type.toUpperCase()}</span><span className="tag mono">{selected.priority}</span><span className="mono ib-proj">{projectName(projects, selected.project)}</span></div><h2 className="ib-detail-title">{selected.title}</h2><p className="ib-ctx">{selected.ctx}</p>{selected.type === 'review' ? <div className="row gap8"><button className="btn btn-primary" onClick={openReview}>Open full review</button><button className="btn" onClick={() => resolve(selected, 'approved')}>Approve locally</button></div> : <div className="ib-opts">{(selected.options ?? ['Acknowledge']).map((o, i) => <button key={o} className={`ib-opt${selected.recommend === i ? ' rec' : ''}`} onClick={() => resolve(selected, o)}><span className="ib-optdot" /><span className="grow" style={{ textAlign: 'left' }}>{o}</span>{selected.recommend === i ? <span className="ib-rec">recommended</span> : null}</button>)}</div>}{selected.help ? <div className="ib-help"><ModelChip id={selected.model} small /><p>{selected.help}</p></div> : null}</div> : <div className="ib-empty">Inbox zero.</div>}</div></div></div>
}

function Queue({ projects, openReview }: { projects: Project[]; openReview: () => void }) {
  const [paused, setPaused] = useState<Record<string, boolean>>({})
  return <div className="screen queue-screen"><div className="queue-grid"><div className="col" style={{ minHeight: 0, gap: 12 }}><div className="panel brackets next-up"><span className="eyebrow" style={{ color: 'var(--star)' }}>WHAT TO WORK ON NEXT</span><div className="row gap12" style={{ marginTop: 8 }}><div className="col grow"><span className="q-title">Answer merge strategy and queue graphify snapshots</span><span style={{ color: 'var(--ink-3)' }}>Northstar · local dashboard can now see your repos</span></div><button className="btn btn-primary">Resolve</button></div></div><div className="row gap6 q-filters"><span className="chip on">All <span className="chip-n">{seedQueue.length}</span></span><span className="chip">Running</span><span className="chip">Queued</span><span className="grow" /><span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>2 background slots · strict no-API</span></div><div className="panel brackets grow col" style={{ overflow: 'hidden' }}><div className="panel-hd"><Layers size={14} /><h3>Execution Queue</h3></div><div className="scroll grow">{seedQueue.map((q) => <div key={q.id} className="q-item"><div className="q-prio" style={{ background: priorityColor[q.priority] }} /><div className="col grow"><div className="row gap10"><span className="mono q-id">{q.id}</span><span className="q-title grow">{q.title}</span><StatusTag status={q.status} /></div><div className="row gap10"><span className="q-tag mono">{projectName(projects, q.project)}</span><ModelChip id={q.model} small /><span className="q-tag mono">{q.agent}</span><span className="grow" /><span className="mono" style={{ color: 'var(--ink-3)' }}>{q.stage}</span></div><div className="meter" style={{ marginTop: 8 }}><i style={{ width: pct(q.progress) }} /></div></div><div className="q-actions"><button className="btn btn-sm" onClick={openReview}>Review</button><button className="btn btn-sm btn-ghost" onClick={() => setPaused({ ...paused, [q.id]: !paused[q.id] })}>{paused[q.id] ? <Play size={12} /> : <Pause size={12} />}</button></div></div>)}</div></div></div><div className="panel brackets col" style={{ overflow: 'hidden' }}><div className="panel-hd"><AlertTriangle size={14} style={{ color: 'var(--cyan)' }} /><h3>Local Projects</h3><span className="grow" /><span className="tag">{projects.length} repos</span></div><div className="scroll grow" style={{ padding: 12 }}>{projects.map((p) => <div key={p.id} className="inbox-card"><div className="row gap8"><span className={`u-dot u-${p.status === 'needs-input' ? 'high' : 'low'}`} /><span className="mono">{p.name}</span><span className="grow" /><span className={`lbl lbl-${p.label}`}>{p.label}</span></div><p className="inbox-q">{p.lastEvent}</p><p className="inbox-ctx">{p.path} · {p.branch}</p></div>)}</div></div></div></div>
}

function Graph({ openReview }: { openReview: () => void }) {
  const [selected, setSelected] = useState('ProjectIngest')
  const selectedNode = graphNodes.find((n) => n.id === selected)
  return <div className="screen graph-screen" style={{ padding: 0 }}><div className="graph-wrap"><div className="graph-toolbar"><div className="g-search"><Search size={14} /><input placeholder='query nodes - "project", "agent"...' /></div><button className="chip on"><Zap size={12} /> agent activity</button><span className="grow" /><div className="g-stats"><span><b>{graphNodes.length}</b> nodes</span><span><b>{graphEdges.length}</b> edges</span><span><b>{communities.length}</b> communities</span></div></div><svg className="graph-svg" viewBox="0 0 1000 680">{graphEdges.map(([a, b, conf]) => { const na = graphNodes.find((n) => n.id === a)!; const nb = graphNodes.find((n) => n.id === b)!; return <line key={`${a}-${b}`} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke={selected === a || selected === b ? 'var(--star)' : 'var(--ink-3)'} strokeDasharray={conf === 'ext' ? 'none' : conf === 'inf' ? '4 4' : '1.5 5'} opacity={selected === a || selected === b ? .8 : .25} /> })}{graphNodes.map((n) => <g key={n.id} transform={`translate(${n.x} ${n.y})`} onClick={() => setSelected(n.id)} className="g-node"><circle r={n.kind === 'god' ? 18 : 11} fill={communities[n.c]?.color ?? 'var(--star)'} stroke="var(--bg)" strokeWidth="2" />{n.agent ? <circle r="7" fill="var(--star)" /> : null}<text y="32" textAnchor="middle" className="g-label" style={{ fill: selected === n.id ? 'var(--star)' : 'var(--ink-2)' }}>{n.id}</text></g>)}</svg><div className="graph-legend"><span className="eyebrow">COMMUNITIES</span>{communities.map((c) => <div key={c.id} className="legend-row"><span className="g-swatch sm" style={{ background: c.color }} /><span className="mono grow">{c.name}</span></div>)}</div>{selectedNode ? <div className="g-inspector"><div className="row gap8"><span className="eyebrow">NODE INSPECTOR</span><span className="grow" /><button className="btn btn-ghost btn-sm" onClick={() => setSelected('')}><X size={13} /></button></div><div className="row gap8" style={{ marginTop: 10 }}><span className="g-swatch" style={{ background: communities[selectedNode.c]?.color }} /><span className="mono" style={{ fontSize: 15 }}>{selectedNode.id}</span></div><div className="g-agentbox"><span className="eyebrow" style={{ color: 'var(--star)' }}>AGENT ACTIVE</span><p>Northstar is mapping this area into graphify-ready project context.</p><button className="btn btn-primary btn-sm" onClick={openReview}>Review patch</button></div></div> : null}</div></div>
}

function Review({ back }: { back: () => void }) {
  return <div className="screen review-screen"><div className="rv-head"><button className="btn btn-ghost btn-sm" onClick={back}>Queue</button><div className="col rv-headcol"><div className="row gap8"><span className="mono q-id">{patch.task}</span><span className="rv-title grow">{patch.title}</span></div><div className="row gap8" style={{ color: 'var(--ink-3)', fontSize: 11 }}><span>{patch.project}</span><span>{patch.branch} to {patch.base}</span><span>{patch.worktree}</span></div></div><span className="grow" /><ModelChip id={patch.model} /><button className="btn">Request changes</button><button className="btn btn-primary">Approve locally</button></div><div className="rv-bar">{patch.checks.map((c) => <span key={c.name} className="check-pill"><Check size={12} />{c.name} {c.detail}</span>)}<span className="grow" /><span className="mono rv-stat"><b style={{ color: 'var(--ok)' }}>+{patch.additions}</b> / <b style={{ color: 'var(--err)' }}>-{patch.deletions}</b></span></div><div className="rv-body"><div className="panel brackets col"><div className="panel-hd"><Layers size={13} /><h3>Changed Files</h3></div>{patch.files.map((f) => <button key={f.path} className="file-row"><span className="file-badge">{f.status}</span><span className="mono file-path grow">{f.path}</span><span style={{ color: 'var(--ok)' }}>+{f.add}</span><span style={{ color: 'var(--err)' }}>-{f.del}</span></button>)}</div><div className="panel brackets col"><div className="panel-hd"><GitPullRequest size={13} /><h3>Diff Preview</h3></div><div className="diff-unified">{patch.diff.map((l, i) => l.t === 'hunk' ? <div key={i} className="diff-hunk">@@ {l.s} @@</div> : <div key={i} className={`dline ${l.t}`}><span className="gut">{'n1' in l ? l.n1 : ''}</span><span className="gut">{'n2' in l ? l.n2 : ''}</span><span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '}</span><code>{l.s}</code></div>)}</div></div><div className="panel brackets col"><div className="panel-hd"><Sparkles size={13} /><h3>Agent Rationale</h3></div><div style={{ padding: 14 }}><p className="rat-summary">{patch.summary}</p><ol className="rat-list">{patch.rationale.map((r) => <li key={r}>{r}</li>)}</ol></div></div></div></div>
}

function SettingsView() {
  return <div className="screen"><div className="screen-grid" style={{ gridTemplateColumns: '1fr 1fr' }}><div className="panel brackets col"><div className="panel-hd"><Settings size={14} /><h3>Guardrails</h3></div><div style={{ padding: 16 }} className="col gap10"><p>Strict no-API mode blocks dispatch when API key env vars are present.</p><p>Codex uses ChatGPT login. Claude uses claude.ai login. Spark means Codex Spark, not an Ollama endpoint.</p><p>Runtime data lives in ~/.northstar. Worktrees stay isolated and no push happens in v1.</p></div></div><div className="panel brackets col"><div className="panel-hd"><Zap size={14} /><h3>Next Routing</h3></div><div style={{ padding: 16 }} className="col gap10">{models.map((m) => <div key={m.id} className="panel" style={{ padding: 12 }}><ModelChip id={m.id} /><p style={{ marginTop: 8, color: 'var(--ink-3)' }}>{m.tier} · {m.auth}</p></div>)}</div></div></div></div>
}

export function App() {
  const [view, setView] = useState<View>('dashboard')
  const [projects, setProjects] = useState<Project[]>(fallbackProjects)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [actions, setActions] = useState(seedActions)
  const [model, setModel] = useState<ModelId>('opus')

  useEffect(() => {
    const loadProjects = async () => {
      for (const url of ['/api/projects', 'http://127.0.0.1:4317/api/projects']) {
        try {
          const res = await fetch(url)
          if (!res.ok) continue
          const data = (await res.json()) as { projects?: Project[] }
          if (data.projects?.length) {
            setProjects(data.projects)
            return
          }
        } catch {
          // Keep seed fallback when the local API is not running.
        }
      }
    }

    void loadProjects()
  }, [])

  const screen = useMemo(() => {
    if (view === 'dashboard') return <Dashboard projects={projects} openInbox={(id) => { setProjectFilter(id); setView('inbox') }} />
    if (view === 'inbox') return <Inbox projects={projects} projectFilter={projectFilter} actions={actions} setActions={setActions} openReview={() => setView('review')} />
    if (view === 'queue') return <Queue projects={projects} openReview={() => setView('review')} />
    if (view === 'graph') return <Graph openReview={() => setView('review')} />
    if (view === 'review') return <Review back={() => setView('queue')} />
    return <SettingsView />
  }, [actions, projectFilter, projects, view])

  return <><div className="starfield" /><div className="gridwash" /><div className="app"><Rail view={view} setView={setView} actionsOpen={actions.length} /><HUD view={view} projects={projects} /><main className="main">{screen}</main><CommandBar model={model} setModel={setModel} /></div></>
}
