import type { DatabaseSync } from 'node:sqlite'

export type AuditActor =
  | 'operator:web'
  | 'operator:telegram'
  | 'system:scheduler'
  | 'system:expiry'
  | 'system:handoff'
  | 'system:startup'
  | string

export type AuditAction =
  | 'dispatch'
  | 'pause'
  | 'requeue'
  | 'resolve'
  | 'patch-approve'
  | 'patch-request-changes'
  | 'handoff-produce'
  | 'handoff-consume'
  | 'expire'
  | string

export type AuditEntryInput = {
  actor: AuditActor
  action: AuditAction
  subject?: string | null
  detail?: string | null
  meta?: Record<string, unknown> | null
}

export type AuditEntry = {
  id: number
  at: string
  actor: string
  action: string
  subject: string
  detail: string
  meta: Record<string, unknown> | null
}

export type AuditRow = {
  id: number
  at: string
  actor: string
  action: string
  subject: string | null
  detail: string | null
  meta_json: string | null
}

const auditPruneCap = Math.max(500, Number(process.env.NORTHSTAR_AUDIT_PRUNE_CAP ?? 5000) || 5000)

let ensured = new WeakSet<DatabaseSync>()

function ensureTable(db: DatabaseSync) {
  if (ensured.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      subject TEXT,
      detail TEXT,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_subject ON audit_log (subject);
  `)
  ensured.add(db)
}

export function recordAudit(db: DatabaseSync, entry: AuditEntryInput): void {
  try {
    if (!db) return
    ensureTable(db)
    const actor = String(entry.actor ?? '').trim().slice(0, 120) || 'system:unknown'
    const action = String(entry.action ?? '').trim().slice(0, 80) || 'unknown'
    const subject = entry.subject == null ? null : String(entry.subject).trim().slice(0, 200) || null
    const detail = entry.detail == null ? null : String(entry.detail).slice(0, 800) || null
    const meta = entry.meta ? safeStringify(entry.meta) : null
    db.prepare(
      `INSERT INTO audit_log (actor, action, subject, detail, meta_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(actor, action, subject, detail, meta)
  } catch {
    // best-effort — never break the instrumented path
  }
}

export type AuditListOptions = {
  limit?: number
  action?: string
  subject?: string
}

export function listAudit(db: DatabaseSync, options: AuditListOptions = {}): AuditEntry[] {
  try {
    ensureTable(db)
    const limit = clampLimit(options.limit)
    const conditions: string[] = []
    const params: unknown[] = []
    if (options.action?.trim()) {
      conditions.push('action = ?')
      params.push(options.action.trim())
    }
    if (options.subject?.trim()) {
      conditions.push('subject = ?')
      params.push(options.subject.trim())
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit)
    const rows = db
      .prepare(`SELECT id, at, actor, action, subject, detail, meta_json FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as AuditRow[]
    return rows.map(toEntry)
  } catch {
    return []
  }
}

export function pruneAudit(db: DatabaseSync, cap: number = auditPruneCap): number {
  try {
    ensureTable(db)
    const capped = Math.max(100, Math.floor(cap) || auditPruneCap)
    const result = db
      .prepare(
        `DELETE FROM audit_log
         WHERE id IN (
           SELECT id FROM audit_log
           ORDER BY id DESC
           LIMIT -1 OFFSET ?
         )`,
      )
      .run(capped)
    return Number(result.changes ?? 0)
  } catch {
    return 0
  }
}

function clampLimit(value: number | undefined): number {
  const n = Math.floor(Number(value ?? 50))
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(200, Math.max(1, n))
}

function safeStringify(value: Record<string, unknown>): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function toEntry(row: AuditRow): AuditEntry {
  let meta: Record<string, unknown> | null = null
  if (row.meta_json) {
    try {
      const parsed = JSON.parse(row.meta_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>
    } catch {
      meta = null
    }
  }
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    subject: row.subject ?? '',
    detail: row.detail ?? '',
    meta,
  }
}
