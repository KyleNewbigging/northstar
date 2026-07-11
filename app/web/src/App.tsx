import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  Clock,
  GitPullRequest,
  HeartPulse,
  Inbox as InboxIcon,
  Layers,
  Mic,
  Network,
  Search,
  Settings,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react'

import { ModelChip } from './components/ModelChip'
import { fallbackProjects, models, queue as seedQueue, actions as seedActions } from './data/seed'
import { Dashboard } from './screens/Dashboard'
import { Graph } from './screens/Graph'
import { Health } from './screens/Health'
import { Inbox } from './screens/Inbox'
import { Queue } from './screens/Queue'
import { Review } from './screens/Review'
import { Schedule } from './screens/Schedule'
import { apiJson, apiSend, realtimeUrl } from './lib/api'
import { fmtReset, fmtTokens, fmtUsagePct, modelColor, modelLabel, pct, projectContextLabel } from './lib/format'
import { mergeProjectWork, runOutput, type AgentRun, type ProjectWork } from './lib/work'
import type { InboxAction, ModelAuthStatus, ModelId, ModelUsage, OperationsOverview, Project, QueueTask } from './types'

type View = 'dashboard' | 'health' | 'inbox' | 'queue' | 'schedule' | 'graph' | 'review' | 'settings'

type DispatchResponse =
  | { ok: true; task: { id: string; projectId: string; model: ModelId; status: string }; run: { id: string; status: string; finalText: string; exitCode: number | null; worktreePath?: string; transport?: string; tmuxSession?: string; attachCommand?: string } }
  | { ok: false; blocked?: boolean; code?: string; error: string; guardrails?: { blockers?: string[] } }

const fallbackModelUsage: ModelUsage[] = [
  { id: 'codex', label: 'Codex GPT-5.5', provider: 'OpenAI', source: 'local fallback', sourceKind: 'local_estimate', sourceFresh: false, tokens5h: 0, tokens5hCap: 250000, tokensWeek: 0, tokensWeekCap: 1000000, computePct: 0, liveRuns: 0, queued: 0, updatedAt: '' },
  { id: 'spark', label: 'Codex Spark', provider: 'OpenAI', source: 'local fallback', sourceKind: 'local_estimate', sourceFresh: false, tokens5h: 0, tokens5hCap: 1000000, tokensWeek: 0, tokensWeekCap: 10000000, computePct: 0, liveRuns: 0, queued: 0, updatedAt: '' },
  { id: 'opus', label: 'Claude Code', provider: 'Anthropic', source: 'local fallback', sourceKind: 'local_estimate', sourceFresh: false, tokens5h: 0, tokens5hCap: 500000, tokensWeek: 0, tokensWeekCap: 3000000, computePct: 0, liveRuns: 0, queued: 0, updatedAt: '' },
]

type VoiceEngine = 'whisper' | 'web-speech'
type VoiceState = 'idle' | 'listening-whisper' | 'listening-webspeech' | 'transcribing'

const voiceMeterBars = 18
const idleVoiceLevels = Array.from({ length: voiceMeterBars }, () => 0)
const preferredMicrophoneStorageKey = 'northstar.preferredBuiltInMicrophone'
const localMicConstraints: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

function scoreAudioInput(device: MediaDeviceInfo) {
  const label = device.label.toLowerCase()
  if (!label) return 0

  let score = 0
  if (/\bdefault\b/.test(label)) score += 5
  if (label.includes('built-in') || label.includes('built in') || label.includes('internal')) score += 100
  if (label.includes('macbook') || label.includes('mac microphone') || label.includes('studio display')) score += 80
  if (label.includes('iphone') || label.includes('ipad') || label.includes('continuity')) score -= 120
  if (label.includes('airpods') || label.includes('bluetooth') || label.includes('headset')) score -= 60
  return score
}

function readPreferredMicrophone() {
  try {
    return window.localStorage.getItem(preferredMicrophoneStorageKey)
  } catch {
    return null
  }
}

function rememberPreferredMicrophone(deviceId: string) {
  try {
    window.localStorage.setItem(preferredMicrophoneStorageKey, deviceId)
  } catch {
    // Persistence is helpful but not required for voice capture.
  }
}

function forgetPreferredMicrophone() {
  try {
    window.localStorage.removeItem(preferredMicrophoneStorageKey)
  } catch {
    // Nothing to clean up when localStorage is blocked.
  }
}

async function findPreferredMicrophoneDeviceId() {
  if (!navigator.mediaDevices?.enumerateDevices) return null

  const devices = await navigator.mediaDevices.enumerateDevices()
  const audioInputs = devices.filter((device) => device.kind === 'audioinput')
  const savedDeviceId = readPreferredMicrophone()
  const savedDevice = audioInputs.find((device) => device.deviceId === savedDeviceId)
  if (savedDevice && scoreAudioInput(savedDevice) >= 0) return savedDevice.deviceId

  const bestDevice = audioInputs
    .map((device) => ({ device, score: scoreAudioInput(device) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)[0]?.device

  if (!bestDevice) return null
  rememberPreferredMicrophone(bestDevice.deviceId)
  return bestDevice.deviceId
}

async function getPreferredMicrophoneStream() {
  const deviceId = await findPreferredMicrophoneDeviceId()

  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...localMicConstraints, deviceId: { exact: deviceId } },
      })
    } catch {
      forgetPreferredMicrophone()
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: localMicConstraints })
  const preferredDeviceId = await findPreferredMicrophoneDeviceId()
  if (!preferredDeviceId) return stream

  const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId
  if (activeDeviceId === preferredDeviceId) return stream

  stream.getTracks().forEach((track) => track.stop())
  return navigator.mediaDevices.getUserMedia({
    audio: { ...localMicConstraints, deviceId: { exact: preferredDeviceId } },
  })
}

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

function Rail({ view, setView, actionsOpen }: { view: View; setView: (view: View) => void; actionsOpen: number }) {
  const nav: Array<[View, React.ReactNode, string]> = [
    ['dashboard', <Boxes size={18} />, 'Dashboard'],
    ['health', <HeartPulse size={18} />, 'Health'],
    ['inbox', <InboxIcon size={18} />, 'Inbox'],
    ['queue', <Layers size={18} />, 'Agent Queue'],
    ['schedule', <Clock size={18} />, 'Schedule'],
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
          <button key={id} className={`rail-btn${view === id ? ' on' : ''}`} title={label} aria-label={label} onClick={() => setView(id)}>
            {icon}
            {id === 'inbox' ? <span className="rail-badge">{actionsOpen}</span> : null}
            <span className="rail-tip">{label}</span>
          </button>
        ))}
      </div>
      <button className={`rail-btn${view === 'settings' ? ' on' : ''}`} title="Settings" aria-label="Settings" style={{ marginTop: 'auto' }} onClick={() => setView('settings')}>
        <Settings size={18} />
        <span className="rail-tip">Settings</span>
      </button>
    </nav>
  )
}

function ModelUsageCell({
  usage,
  auth,
  recheckAuth,
}: {
  usage: ModelUsage
  auth?: ModelAuthStatus
  recheckAuth: (status: ModelAuthStatus) => void
}) {
  const hasProviderUsage = usage.sourceFresh && (typeof usage.fiveHourUsedPct === 'number' || typeof usage.weeklyUsedPct === 'number')
  const authBlocked = auth ? !auth.ok : false
  const fivePct = typeof usage.fiveHourUsedPct === 'number'
    ? Math.min(1, usage.fiveHourUsedPct / 100)
    : usage.tokens5hCap ? Math.min(1, usage.tokens5h / usage.tokens5hCap) : 0
  const weekPct = typeof usage.weeklyUsedPct === 'number'
    ? Math.min(1, usage.weeklyUsedPct / 100)
    : usage.tokensWeekCap ? Math.min(1, usage.tokensWeek / usage.tokensWeekCap) : 0
  const fiveLabel = fmtUsagePct(usage.fiveHourUsedPct) ?? `${fmtTokens(usage.tokens5h)} / ${fmtTokens(usage.tokens5hCap)}`
  const weekLabel = fmtUsagePct(usage.weeklyUsedPct) ?? `${fmtTokens(usage.tokensWeek)} / ${fmtTokens(usage.tokensWeekCap)}`
  const fiveReset = fmtReset(usage.fiveHourResetAt)
  const weekReset = fmtReset(usage.weeklyResetAt)
  return (
    <div className={`model-usage${authBlocked ? ' warn' : ''}`} title={`${usage.source} · ${usage.provider}${authBlocked ? ` · ${auth?.blockers[0]}` : ''}`}>
      <div className="row gap6">
        <i className="dot" style={{ background: modelColor[usage.id] }} />
        <span className="mono model-usage-name">{usage.label}</span>
        <span className="grow" />
        {authBlocked && auth ? (
          <button type="button" className="auth-warn" title={`${auth.blockers[0]} Click to recheck ${auth.checkCommand}.`} onClick={() => recheckAuth(auth)}>
            <AlertTriangle size={11} />
          </button>
        ) : null}
        <span className={`tnum model-compute${hasProviderUsage ? ' real' : ''}`}>{usage.computePct}%</span>
      </div>
      <div className="usage-bars">
        <span className="eyebrow">5H</span>
        <div className="meter"><i style={{ width: pct(fivePct) }} /></div>
        <span className="tnum">{fiveLabel}{fiveReset ? ` >${fiveReset}` : ''}</span>
        <span className="eyebrow">WK</span>
        <div className="meter cool"><i style={{ width: pct(weekPct) }} /></div>
        <span className="tnum">{weekLabel}{weekReset ? ` >${weekReset}` : ''}</span>
      </div>
      <div className="usage-live">
        <span>{hasProviderUsage ? 'live source' : 'estimate'}</span>
        <span>{usage.liveRuns} live</span>
        <span>{usage.queued} queued</span>
      </div>
    </div>
  )
}

function HUD({
  view,
  projects,
  modelUsage,
  modelAuth,
  refreshModelAuth,
}: {
  view: View
  projects: Project[]
  modelUsage: ModelUsage[]
  modelAuth: ModelAuthStatus[]
  refreshModelAuth: () => Promise<ModelAuthStatus[]>
}) {
  const [clock, setClock] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-GB'))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  const title: Record<View, [string, string]> = {
    dashboard: ['FLIGHT DECK', `${projects.length} projects · local inventory`],
    health: ['HEALTH', 'Garmin-first body telemetry and goals'],
    inbox: ['MISSION INBOX', 'what needs you - across all projects'],
    queue: ['AGENT QUEUE', 'what to work on next'],
    schedule: ['SCHEDULE', 'overnight usage and onboarding'],
    graph: ['GRAPH COCKPIT', 'graphify-oriented knowledge graph'],
    review: ['PATCH REVIEW', 'worktree patch preview'],
    settings: ['SETTINGS', 'local guardrails and model routing'],
  }
  const [h, sub] = title[view]
  const authByModel = new Map(modelAuth.map((item) => [item.model, item]))
  const recheckAuth = async (status: ModelAuthStatus) => {
    const next = await refreshModelAuth()
    const updated = next.find((item) => item.model === status.model) ?? status
    setAuthNotice(
      updated.ok
        ? `${models.find((item) => item.id === updated.model)?.label ?? updated.model} auth OK via ${updated.checkCommand}.`
        : `${models.find((item) => item.id === updated.model)?.label ?? updated.model}: ${updated.blockers[0] ?? 'authentication is not ready'} Run ${updated.loginCommand}, then click the warning again.`,
    )
  }
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
      <div className="hud-usage">
        {modelUsage.map((usage) => <ModelUsageCell key={usage.id} usage={usage} auth={authByModel.get(usage.id)} recheckAuth={recheckAuth} />)}
        {authNotice ? <div className="auth-notice mono">{authNotice}</div> : null}
        <div className="row gap6"><Zap size={14} style={{ color: 'var(--star)' }} /><span className="tnum">{projects.filter((p) => p.status === 'needs-input').length}</span></div>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{clock}</span>
      </div>
    </header>
  )
}

function CommandBar({
  model,
  setModel,
  projects,
  projectContext,
  setProjectContext,
  setProjectActive,
  afterDispatch,
}: {
  model: ModelId
  setModel: (model: ModelId) => void
  projects: Project[]
  projectContext: string
  setProjectContext: (context: string) => void
  setProjectActive: (id: string, active: boolean) => void
  afterDispatch: () => Promise<void>
}) {
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [open, setOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'ok' | 'warn'>('ok')
  const [dispatching, setDispatching] = useState(false)
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>('whisper')
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recognitionRef = useRef<any>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const activeEngineRef = useRef<VoiceEngine | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const meterAudioContextRef = useRef<AudioContext | null>(null)
  const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const webSpeechMeterStreamRef = useRef<MediaStream | null>(null)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const [voiceLevels, setVoiceLevels] = useState<number[]>(idleVoiceLevels)

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

  const stopVoiceMeter = () => {
    if (meterFrameRef.current !== null) window.cancelAnimationFrame(meterFrameRef.current)
    meterFrameRef.current = null
    meterSourceRef.current?.disconnect()
    meterSourceRef.current = null
    void meterAudioContextRef.current?.close().catch(() => {})
    meterAudioContextRef.current = null
    setVoiceLevels(idleVoiceLevels)
  }

  const stopWebSpeechMeterStream = () => {
    webSpeechMeterStreamRef.current?.getTracks().forEach((track) => track.stop())
    webSpeechMeterStreamRef.current = null
  }

  const startVoiceMeter = (stream: MediaStream) => {
    stopVoiceMeter()
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) return

    const audioContext = new AudioContextCtor()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72

    const source = audioContext.createMediaStreamSource(stream)
    source.connect(analyser)
    meterAudioContextRef.current = audioContext
    meterSourceRef.current = source

    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      const slice = Math.max(1, Math.floor(data.length / voiceMeterBars))
      const levels = Array.from({ length: voiceMeterBars }, (_, index) => {
        let sum = 0
        const start = index * slice
        const end = Math.min(data.length, start + slice)
        for (let i = start; i < end; i += 1) {
          const centered = (data[i] - 128) / 128
          sum += centered * centered
        }
        const rms = Math.sqrt(sum / Math.max(1, end - start))
        return Math.min(1, rms * 5.2)
      })
      setVoiceLevels(levels)
      meterFrameRef.current = window.requestAnimationFrame(tick)
    }

    meterFrameRef.current = window.requestAnimationFrame(tick)
  }

  useEffect(() => () => {
    stopVoiceMeter()
    stopWebSpeechMeterStream()
  }, [])

  useEffect(() => {
    if (!projectOpen) return

    const closeIfOutside = (event: PointerEvent | FocusEvent) => {
      const target = event.target
      if (target instanceof Node && projectMenuRef.current?.contains(target)) return
      setProjectOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectOpen(false)
    }

    document.addEventListener('pointerdown', closeIfOutside, true)
    document.addEventListener('focusin', closeIfOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true)
      document.removeEventListener('focusin', closeIfOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [projectOpen])

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

  const startWebSpeechCapture = async () => {
    const recognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!recognitionCtor) {
      setError('Browser speech API unavailable; use local Whisper or type directly.')
      setVoiceEngine('whisper')
      return
    }

    if (navigator.mediaDevices) {
      try {
        const meterStream = await getPreferredMicrophoneStream()
        webSpeechMeterStreamRef.current = meterStream
        startVoiceMeter(meterStream)
      } catch {
        stopVoiceMeter()
        stopWebSpeechMeterStream()
      }
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
      stopVoiceMeter()
      stopWebSpeechMeterStream()
      setRecording(false)
      setVoiceState('idle')
      activeEngineRef.current = null
      setTimeout(() => {
        recognitionRef.current = null
      }, 0)
    }

    recognition.onerror = (event: any) => {
      stopVoiceMeter()
      stopWebSpeechMeterStream()
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
      const stream = await getPreferredMicrophoneStream()
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      activeEngineRef.current = 'whisper'
      audioChunksRef.current = []
      startVoiceMeter(stream)
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
          stopVoiceMeter()
          setVoiceState('idle')
          setRecording(false)
          activeEngineRef.current = null
        }
      }

      recorder.start()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to access microphone.'
      setError(`${message} Check that the built-in MacBook microphone is allowed for this browser.`)
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
    void startWebSpeechCapture()
  }

  const dispatchPrompt = async () => {
    const prompt = text.trim()
    if (!prompt) {
      setMessageTone('warn')
      setMessage('Type or speak a command before dispatch.')
      return
    }
    setError('')
    setMessageTone('ok')
    setMessage(`Dispatching ${models.find((item) => item.id === model)?.label ?? model}...`)
    setDispatching(true)
    const response = await apiSend<DispatchResponse>('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, projectContext }),
    })
    setDispatching(false)

    if (!response) {
      setMessageTone('warn')
      setMessage('Dispatch failed: local API is not reachable.')
      return
    }
    if (!response.ok) {
      setMessageTone('warn')
      setMessage(response.guardrails?.blockers?.[0] ?? response.error)
      return
    }

    setMessageTone('ok')
    setText('')
    setMessage(`${modelLabel(response.task.model)} running in ${response.run.worktreePath ?? 'worktree'}...`)
    void pollRun(response.run.id, response.task.model)
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return

      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(false)
        setProjectOpen(false)
        inputRef.current?.focus()
        inputRef.current?.select()
        return
      }

      if (event.key.toLowerCase() === 'j') {
        event.preventDefault()
        toggleRecording()
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        void dispatchPrompt()
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })

  const pollRun = async (runId: string, runModel: ModelId) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      const data = await apiJson<{ run?: AgentRun | null }>(`/api/runs/${runId}`)
      const run = data?.run
      if (!run) continue
      if (run.status === 'running') {
        const streamed = run.stdout || run.stderr || ''
        setMessage(`${modelLabel(runModel)} running${streamed ? `: ${streamed.replace(/\s+/g, ' ').slice(-96)}` : '...'}`)
        continue
      }
      const text = runOutput(run)
      setMessageTone(run.status === 'done' ? 'ok' : 'warn')
      setMessage(`${modelLabel(runModel)} ${run.status}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
      await afterDispatch()
      return
    }
    setMessageTone('warn')
    setMessage(`${modelLabel(runModel)} is still running. Check Agent Queue or /api/runs/${runId}.`)
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
          disabled={voiceState === 'transcribing'}
          className={`cmd-mic${recording ? ' on' : ''}`}
          onClick={toggleRecording}
          title={recording ? 'Stop dictation and transcribe' : voiceState === 'transcribing' ? 'Transcribing voice input' : 'Talk to Northstar'}
        >
          {recording ? <Square size={14} fill="currentColor" /> : <Mic size={17} />}
          {voiceState !== 'idle' ? <span className="mic-rings"><i></i><i></i><i></i></span> : null}
        </button>
        {recording ? (
          <div className="voice-meter on" aria-hidden="true" title="Voice input level">
            {voiceLevels.map((level, index) => (
              <i key={index} style={{ '--level': level } as React.CSSProperties} />
            ))}
          </div>
        ) : null}
        <div className="cmd-context" ref={projectMenuRef}>
          <button
            type="button"
            className="cmd-ctx"
            aria-label="Project context selector"
            aria-expanded={projectOpen}
            aria-haspopup="menu"
            onClick={() => setProjectOpen((value) => !value)}
          >
            <i className={`dot ${projectContext === 'all' || projects.some((project) => project.active) ? 'dot-run live' : 'dot-idle'}`} />
            <span className="mono">{projectContextLabel(projects, projectContext)}</span>
            <ChevronDown size={12} />
          </button>
          {projectOpen ? (
            <div className="project-menu fade-in" role="menu">
              <div className="eyebrow project-menu-hd">ACTIVE CONTEXT</div>
              <button
                type="button"
                className={`project-menu-all${projectContext === 'active' ? ' on' : ''}`}
                onClick={() => {
                  setProjectContext('active')
                  setProjectOpen(false)
                }}
              >
                <i className="dot dot-run" />
                <span className="mono grow">All active projects</span>
                <span className="chip-n">{projects.filter((project) => project.active).length}</span>
              </button>
              <button
                type="button"
                className={`project-menu-all${projectContext === 'all' ? ' on' : ''}`}
                onClick={() => {
                  setProjectContext('all')
                  setProjectOpen(false)
                }}
              >
                <Search size={13} />
                <span className="mono grow">All projects</span>
                <span className="chip-n">{projects.length}</span>
              </button>
              <div className="eyebrow project-menu-hd">PROJECT AUTONOMY</div>
              <div className="project-menu-list">
                {projects.map((project) => (
                  <div key={project.id} className={`project-opt${projectContext === project.id ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="project-pick"
                      disabled={!project.active}
                      onClick={() => {
                        setProjectContext(project.id)
                        setProjectOpen(false)
                      }}
                    >
                      <i className={`dot ${project.active ? 'dot-run live' : 'dot-idle'}`} />
                      <span className="mono grow">{project.name}</span>
                      <span className="project-state">{project.active ? 'active' : 'disabled'}</span>
                    </button>
                    <button
                      type="button"
                      className={`project-toggle${project.active ? ' on' : ''}`}
                      onClick={() => setProjectActive(project.id, !project.active)}
                    >
                      {project.active ? 'Disable' : 'Activate'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <input
          ref={inputRef}
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
        <button type="button" className="btn btn-primary" disabled={dispatching} onClick={dispatchPrompt}><ArrowRight size={15} /> {dispatching ? 'Running' : 'Dispatch'}</button>
      </div>
      <div className="cmd-hint">
        <span><span className="kbd">CMD K</span> command palette · <span className="kbd">CMD J</span> dictation</span>
        <span style={{ color: error ? 'var(--err)' : message ? (messageTone === 'ok' ? 'var(--ok)' : 'var(--star)') : 'var(--ink-4)' }}>{error || message || commandHint}</span>
        <span><span className="kbd">@</span> files · <span className="kbd">#</span> tasks</span>
      </div>
    </div>
  )
}

function SettingsView() {
  return <div className="screen"><div className="screen-grid" style={{ gridTemplateColumns: '1fr 1fr' }}><div className="panel brackets col"><div className="panel-hd"><Settings size={14} /><h3>Guardrails</h3></div><div style={{ padding: 16 }} className="col gap10"><p>Strict no-API mode blocks dispatch when API key env vars are present.</p><p>Codex uses ChatGPT login. Claude uses claude.ai login. Spark means Codex Spark, not an Ollama endpoint.</p><p>Runtime data lives in ~/.northstar. Each project has a private skills file under ~/.northstar/skills, and learned notes are fed back into plan-mode dispatch.</p><p>Worktrees stay isolated and no push happens in v1.</p></div></div><div className="panel brackets col"><div className="panel-hd"><Zap size={14} /><h3>Next Routing</h3></div><div style={{ padding: 16 }} className="col gap10">{models.map((m) => <div key={m.id} className="panel" style={{ padding: 12 }}><ModelChip id={m.id} /><p style={{ marginTop: 8, color: 'var(--ink-3)' }}>{m.tier} · {m.auth}</p></div>)}</div></div></div></div>
}

export function App() {
  const [view, setView] = useState<View>('dashboard')
  const [projects, setProjects] = useState<Project[]>(fallbackProjects)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [projectContext, setProjectContext] = useState('active')
  const [actions, setActions] = useState(seedActions)
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [queueTasks, setQueueTasks] = useState<QueueTask[]>([])
  const [decisionWork, setDecisionWork] = useState<ProjectWork[]>([])
  const [modelUsage, setModelUsage] = useState<ModelUsage[]>(fallbackModelUsage)
  const [modelAuth, setModelAuth] = useState<ModelAuthStatus[]>([])
  const [operationsOverview, setOperationsOverview] = useState<OperationsOverview | null>(null)
  const [model, setModel] = useState<ModelId>('opus')
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)

  const applyOperationsOverview = (overview: OperationsOverview) => {
    setOperationsOverview(overview)
    if (overview.projects?.length) setProjects(overview.projects)
    if (overview.openDecisions) setActions(overview.openDecisions)
    if (overview.tasks) setQueueTasks(overview.tasks)
    if (overview.runs) setRuns(overview.runs as AgentRun[])
    if (overview.modelUsage?.length) setModelUsage(overview.modelUsage)
    if (overview.modelAuth) setModelAuth(overview.modelAuth)
  }

  const loadProjects = async () => {
    const data = await apiJson<{ projects?: Project[] }>('/api/projects')
    if (data?.projects?.length) {
      setProjects(data.projects)
    }
  }

  const loadActions = async () => {
    const data = await apiJson<{ actions?: InboxAction[] }>('/api/inbox')
    if (data?.actions) {
      setActions(data.actions)
    }
  }

  const loadOperations = async () => {
    const overview = await apiJson<OperationsOverview>('/api/operations/overview')
    if (overview?.ok) {
      applyOperationsOverview(overview)
      return
    }
    const [runsData, queueData, usageData] = await Promise.all([
      apiJson<{ runs?: AgentRun[] }>('/api/runs'),
      apiJson<{ tasks?: QueueTask[] }>('/api/queue'),
      apiJson<{ models?: ModelUsage[] }>('/api/model-usage'),
    ])
    if (runsData?.runs) setRuns(runsData.runs)
    if (queueData?.tasks) setQueueTasks(queueData.tasks)
    if (usageData?.models?.length) setModelUsage(usageData.models)
  }

  const loadModelAuth = async () => {
    const data = await apiJson<{ models?: ModelAuthStatus[] }>('/api/agent-auth')
    if (data?.models) {
      setModelAuth(data.models)
      return data.models
    }
    return []
  }

  useEffect(() => {
    void loadProjects()
    void loadActions()
    void loadOperations()
    void loadModelAuth()
  }, [])

  useEffect(() => {
    let closed = false
    let connectTimer: number | null = null
    let retry: number | null = null
    let socket: WebSocket | null = null

    const connect = () => {
      connectTimer = null
      socket = new WebSocket(realtimeUrl('/ws'))
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as {
            type?: string
            payload?: {
              overview?: OperationsOverview
              projects?: Project[]
              actions?: InboxAction[]
              runs?: AgentRun[]
              tasks?: QueueTask[]
              models?: ModelUsage[]
            }
          }
          const payload = message.payload
          if (!payload) return
          if (payload.overview?.ok) {
            applyOperationsOverview(payload.overview)
            return
          }
          if (Array.isArray(payload.projects)) setProjects(payload.projects)
          if (Array.isArray(payload.actions)) setActions(payload.actions)
          if (Array.isArray(payload.runs)) setRuns(payload.runs)
          if (Array.isArray(payload.tasks)) setQueueTasks(payload.tasks)
          if (Array.isArray(payload.models)) setModelUsage(payload.models)
        } catch {
          // Ignore malformed local realtime frames; polling remains the fallback.
        }
      }
      socket.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, 2500)
      }
      socket.onerror = () => socket?.close()
    }

    connectTimer = window.setTimeout(connect, 0)
    return () => {
      closed = true
      if (connectTimer !== null) window.clearTimeout(connectTimer)
      if (retry !== null) window.clearTimeout(retry)
      socket?.close()
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadModelAuth()
    }, 30000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadOperations()
    }, 2500)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(async () => {
      if (!projects.some((project) => project.active)) return
      if ((operationsOverview?.queuePressure.totalOpen ?? queueTasks.length) > 0) return
      const data = await apiSend<{ projects?: Project[]; actions?: InboxAction[] }>('/api/autonomy/tick', { method: 'POST' })
      if (data?.projects?.length) setProjects(data.projects)
      if (data?.actions) setActions(data.actions)
    }, 45000)
    return () => window.clearInterval(id)
  }, [operationsOverview, projects, queueTasks.length])

  const setProjectActive = async (id: string, active: boolean) => {
    setProjects((items) =>
      items.map((project) =>
        project.id === id
          ? {
              ...project,
              active,
              autonomous: active,
              cadence: active ? 'slow' : 'paused',
              status: active && project.status !== 'needs-input' && project.status !== 'blocked' ? 'running' : project.status,
              agentsActive: active ? Math.max(project.agentsActive, 1) : 0,
            }
          : project,
      ),
    )
    const data = await apiSend<{ projects?: Project[]; actions?: InboxAction[] }>(`/api/projects/${id}/activation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    if (data?.projects?.length) setProjects(data.projects)
    if (data?.actions) setActions(data.actions)
  }

  const recordDecisionWork = (item: InboxAction, choice: string) => {
    const project = projects.find((candidate) => candidate.id === item.project)
    const taskId = item.task ?? `DEC-${item.id}`
    const work: ProjectWork = {
      id: `decision-${item.id}`,
      taskId,
      project: item.project,
      title: item.task ? item.title : `Follow-up from ${item.title}`,
      model: item.model,
      status: 'running',
      progress: item.type === 'review' ? 0.82 : 0.36,
      stage: `decision applied: ${choice}`,
      eta: item.type === 'review' ? 'reviewing' : 'live',
      branch: item.task ?? project?.branch ?? '-',
      source: 'decision',
      detail: item.type === 'review'
        ? 'Patch decision recorded; the Review flow owns any local apply step.'
        : 'Answer saved to the inbox record. It has not spawned a local CLI by itself.',
      updatedAt: new Date().toISOString(),
    }
    setDecisionWork((items) => [work, ...items.filter((current) => current.id !== work.id)].slice(0, 12))
    setProjects((items) =>
      items.map((candidate) =>
        candidate.id === item.project
          ? {
              ...candidate,
              status: 'running',
              agentsActive: Math.max(candidate.agentsActive, 1),
              lastEvent: work.stage,
              lastAgo: 'now',
            }
          : candidate,
      ),
    )
  }

  const workItems = useMemo(() => mergeProjectWork(queueTasks.length ? queueTasks : seedQueue, runs, decisionWork), [decisionWork, queueTasks, runs])
  const openReview = (taskId?: string | null) => {
    setReviewTaskId(taskId ?? null)
    setView('review')
  }

  const screen = useMemo(() => {
    if (view === 'dashboard') return <Dashboard projects={projects} overview={operationsOverview} openInbox={(id) => { setProjectFilter(id); setView('inbox') }} openGraph={() => setView('graph')} setProjectActive={setProjectActive} />
    if (view === 'health') return <Health />
    if (view === 'inbox') return <Inbox projects={projects} projectFilter={projectFilter} actions={actions} setActions={setActions} clearProjectFilter={() => setProjectFilter(null)} openReview={openReview} workItems={workItems} onDecision={recordDecisionWork} />
    if (view === 'queue') return <Queue projects={projects} overview={operationsOverview} openReview={openReview} />
    if (view === 'schedule') return <Schedule />
    if (view === 'graph') return <Graph projects={projects} openReview={openReview} />
    if (view === 'review') return <Review taskId={reviewTaskId} back={() => setView('queue')} />
    return <SettingsView />
  }, [actions, operationsOverview, projectFilter, projects, reviewTaskId, view, workItems])

  return <><div className="starfield" /><div className="gridwash" /><div className="app"><Rail view={view} setView={setView} actionsOpen={actions.length} /><HUD view={view} projects={projects} modelUsage={modelUsage} modelAuth={modelAuth} refreshModelAuth={loadModelAuth} /><main className="main">{screen}</main><CommandBar model={model} setModel={setModel} projects={projects} projectContext={projectContext} setProjectContext={setProjectContext} setProjectActive={setProjectActive} afterDispatch={async () => { await loadProjects(); await loadActions(); await loadOperations(); await loadModelAuth() }} /></div></>
}
