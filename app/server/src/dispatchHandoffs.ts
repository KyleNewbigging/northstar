import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { getDeviceFilesStatus } from './deviceFiles.js'

export type DispatchHandoffArtifact = {
  kind: 'northstar-dispatch'
  version: 1
  taskId: string
  projectId: string
  title: string
  model: string
  agent: string
  priority: string
  lane: string
  prompt: string
  sourceDevice: string
  createdAt: string
}

export type DispatchHandoffTaskInput = {
  id: string
  projectId: string
  title: string
  model: string
  agent: string
  priority: string
  lane: string
  prompt: string
}

export type ProduceDispatchHandoffResult =
  | {
      ok: true
      artifactRelPath: string
      artifactPath: string
      targetDevice: string
      sourceDevice: string
      taskId: string
    }
  | { ok: false; error: string }

export type ConsumeDispatchHandoffsResult = {
  intake: number
  consumed: number
  invalid: number
  skippedUnknownProject: string[]
  skippedDuplicate: string[]
  errors: Array<{ file: string; error: string }>
}

export type ConsumableProject = { id: string }

const artifactPrefix = 'dispatch-'
const artifactExt = '.json'

export function produceDispatchHandoff(
  db: DatabaseSync,
  task: DispatchHandoffTaskInput,
  targetDevice: string,
): ProduceDispatchHandoffResult {
  const status = getDeviceFilesStatus()
  if (!status.rootExists) return { ok: false, error: 'dropbox_root_missing' }
  const cleanedTarget = sanitizeDeviceId(targetDevice)
  if (!cleanedTarget) return { ok: false, error: 'target_device_required' }

  const sourceDevice = status.currentDevice
  const createdAt = new Date().toISOString()
  const artifact: DispatchHandoffArtifact = {
    kind: 'northstar-dispatch',
    version: 1,
    taskId: task.id,
    projectId: task.projectId,
    title: task.title,
    model: task.model,
    agent: task.agent,
    priority: task.priority,
    lane: task.lane,
    prompt: task.prompt,
    sourceDevice,
    createdAt,
  }

  const dir = join(status.rootPath, '_handoffs', cleanedTarget)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const ts = createdAt.replace(/[-:]/g, '').replace(/\..+$/, 'Z')
  const filename = `${artifactPrefix}${task.id}-${ts}${artifactExt}`
  const artifactPath = join(dir, filename)
  const artifactRelPath = `_handoffs/${cleanedTarget}/${filename}`

  try {
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  db.prepare(
    `UPDATE tasks
       SET target_device = ?,
           dispatch_status = 'remote-device',
           dispatch_blocker = ?,
           stage = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(
    cleanedTarget,
    `Handed off to ${cleanedTarget}; awaiting remote pickup.`,
    `handed off to ${cleanedTarget}`,
    task.id,
  )

  return { ok: true, artifactRelPath, artifactPath, targetDevice: cleanedTarget, sourceDevice, taskId: task.id }
}

export function consumeDispatchHandoffs(
  db: DatabaseSync,
  projects: ConsumableProject[],
): ConsumeDispatchHandoffsResult {
  const result: ConsumeDispatchHandoffsResult = {
    intake: 0,
    consumed: 0,
    invalid: 0,
    skippedUnknownProject: [],
    skippedDuplicate: [],
    errors: [],
  }
  const status = getDeviceFilesStatus()
  if (!status.rootExists) return result

  const dir = join(status.rootPath, '_handoffs', status.currentDevice)
  if (!existsSync(dir)) return result

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    result.errors.push({ file: dir, error: error instanceof Error ? error.message : String(error) })
    return result
  }

  const projectIds = new Set(projects.map((p) => p.id))
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tasks
      (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch, source, source_ref, prompt, lane, target_device, dispatch_status, dispatch_blocker)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 'next window', 'received from handoff', 0, '', 'handoff', ?, ?, ?, '', 'unknown', '')`,
  )

  for (const name of names) {
    if (!name.startsWith(artifactPrefix) || !name.endsWith(artifactExt)) continue
    const filePath = join(dir, name)
    let text: string
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      result.errors.push({ file: name, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      renameOnce(filePath, `${filePath}.invalid`, result)
      result.invalid += 1
      continue
    }
    const artifact = validateArtifact(parsed)
    if (!artifact) {
      renameOnce(filePath, `${filePath}.invalid`, result)
      result.invalid += 1
      continue
    }
    if (!projectIds.has(artifact.projectId)) {
      if (!result.skippedUnknownProject.includes(artifact.projectId)) result.skippedUnknownProject.push(artifact.projectId)
      continue
    }

    const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(artifact.taskId) as { id?: string } | undefined
    if (existing?.id) {
      result.skippedDuplicate.push(artifact.taskId)
    } else {
      const artifactRelPath = `_handoffs/${status.currentDevice}/${name}`
      insert.run(
        artifact.taskId,
        artifact.projectId,
        artifact.title,
        artifact.model,
        artifact.agent,
        artifact.priority,
        artifactRelPath,
        artifact.prompt,
        artifact.lane,
      )
      result.intake += 1
    }
    renameOnce(filePath, `${filePath}.consumed`, result)
    result.consumed += 1
  }

  return result
}

function renameOnce(from: string, to: string, result: ConsumeDispatchHandoffsResult) {
  try {
    if (existsSync(to)) return
    renameSync(from, to)
  } catch (error) {
    result.errors.push({ file: from, error: error instanceof Error ? error.message : String(error) })
  }
}

function validateArtifact(value: unknown): DispatchHandoffArtifact | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r.kind !== 'northstar-dispatch') return null
  if (r.version !== 1) return null
  const taskId = typeof r.taskId === 'string' ? r.taskId.trim() : ''
  const projectId = typeof r.projectId === 'string' ? r.projectId.trim() : ''
  if (!taskId || !projectId) return null
  return {
    kind: 'northstar-dispatch',
    version: 1,
    taskId,
    projectId,
    title: strOr(r.title, taskId),
    model: strOr(r.model, 'codex'),
    agent: strOr(r.agent, 'handoff'),
    priority: strOr(r.priority, 'P2'),
    lane: strOr(r.lane, 'dev'),
    prompt: strOr(r.prompt, ''),
    sourceDevice: strOr(r.sourceDevice, ''),
    createdAt: strOr(r.createdAt, new Date().toISOString()),
  }
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function sanitizeDeviceId(value: string): string {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 64)
}
