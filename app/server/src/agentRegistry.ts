import type { DatabaseSync } from 'node:sqlite'

export type AgentRow = {
  id: string
  name: string
  domain: string
  charter: string
  contract: string
  default_model: string
  project_id: string
  active: number
  created_at: string
  updated_at: string
}

export type AgentRecord = {
  id: string
  name: string
  domain: string
  charter: string
  contract: string
  defaultModel: string
  projectId: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export type AgentUpsertInput = {
  id: string
  name?: string
  domain?: string
  charter?: string
  contract?: string
  defaultModel?: string
  projectId?: string
  active?: boolean
}

export type AgentUpsertResult =
  | { ok: true; agent: AgentRecord; created: boolean }
  | { ok: false; error: string }

const seededAgents: Array<Omit<AgentRecord, 'createdAt' | 'updatedAt'>> = [
  {
    id: 'frontend',
    name: 'Frontend Agent',
    domain: 'frontend',
    charter:
      'Owns the React/Vite cockpit, queue, graph, and dashboard surfaces. Boundary: no backend schema or scheduler changes without a backend handoff.',
    contract:
      'Reports via patch review + Telegram digest. May prepare review-gated patches inside a spawned worktree. Must ask before dependency, routing, or design-token changes; never pushes or merges.',
    defaultModel: 'spark',
    projectId: '',
    active: true,
  },
  {
    id: 'backend',
    name: 'Backend Agent',
    domain: 'backend',
    charter:
      'Owns the Fastify/SQLite server, scheduler, guardrails, and dispatch contracts. Boundary: no destructive migrations or auth changes without operator sign-off.',
    contract:
      'Reports via inbox actions and patch review. May draft review-gated patches in a worktree. Must ask before schema migrations, guardrail relaxation, or new external calls; never pushes.',
    defaultModel: 'spark',
    projectId: '',
    active: true,
  },
  {
    id: 'design',
    name: 'Design Agent',
    domain: 'design',
    charter:
      'Preserves the deep-space cockpit language across cockpit surfaces. Boundary: no functional/backend changes; visual and copy proposals only.',
    contract:
      'Reports via inbox questions with 2-3 answer options. May annotate mockups and propose token adjustments; never applies patches, pushes, or merges.',
    defaultModel: 'opus',
    projectId: '',
    active: true,
  },
  {
    id: 'marketing',
    name: 'Marketing Agent',
    domain: 'marketing',
    charter:
      'Captures positioning and release notes when outward-facing work is requested. Boundary: standing by until explicitly invoked.',
    contract:
      'Reports via Telegram digest and inbox. Drafts copy in Dropbox resources; never touches code, dispatch, or public channels without operator approval.',
    defaultModel: 'spark',
    projectId: '',
    active: true,
  },
]

let ensured = new WeakSet<DatabaseSync>()

function ensureTable(db: DatabaseSync) {
  if (ensured.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT '',
      charter TEXT NOT NULL DEFAULT '',
      contract TEXT NOT NULL DEFAULT '',
      default_model TEXT NOT NULL DEFAULT 'spark',
      project_id TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agents_domain ON agents (domain);
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id);
  `)
  ensured.add(db)
}

export function seedAgentRegistry(db: DatabaseSync): number {
  ensureTable(db)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, domain, charter, contract, default_model, project_id, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let inserted = 0
  for (const agent of seededAgents) {
    const result = insert.run(
      agent.id,
      agent.name,
      agent.domain,
      agent.charter,
      agent.contract,
      agent.defaultModel,
      agent.projectId,
      agent.active ? 1 : 0,
    )
    if (Number(result.changes ?? 0) > 0) inserted += 1
  }
  return inserted
}

export type ListAgentsOptions = {
  activeOnly?: boolean
  projectId?: string
}

export function listAgents(db: DatabaseSync, options: ListAgentsOptions = {}): AgentRecord[] {
  ensureTable(db)
  const conditions: string[] = []
  const params: unknown[] = []
  if (options.activeOnly) conditions.push('active = 1')
  if (typeof options.projectId === 'string') {
    conditions.push('project_id = ?')
    params.push(options.projectId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT id, name, domain, charter, contract, default_model, project_id, active, created_at, updated_at
       FROM agents ${where}
       ORDER BY project_id ASC, domain ASC, id ASC`,
    )
    .all(...params) as AgentRow[]
  return rows.map(toRecord)
}

export function getAgent(db: DatabaseSync, id: string): AgentRecord | null {
  ensureTable(db)
  const slug = slugifyAgentId(id)
  if (!slug) return null
  const row = db
    .prepare(
      `SELECT id, name, domain, charter, contract, default_model, project_id, active, created_at, updated_at
       FROM agents WHERE id = ?`,
    )
    .get(slug) as AgentRow | undefined
  return row ? toRecord(row) : null
}

export function upsertAgent(db: DatabaseSync, input: AgentUpsertInput): AgentUpsertResult {
  ensureTable(db)
  const slug = slugifyAgentId(input.id)
  if (!slug) return { ok: false, error: 'invalid_agent_id' }
  const existing = getAgent(db, slug)
  const name = cleanText(input.name, existing?.name ?? slug, 120)
  if (!name) return { ok: false, error: 'name_required' }
  const domain = cleanText(input.domain, existing?.domain ?? '', 60)
  const charter = cleanText(input.charter, existing?.charter ?? '', 2000)
  const contract = cleanText(input.contract, existing?.contract ?? '', 2000)
  const defaultModel = cleanText(input.defaultModel, existing?.defaultModel ?? 'spark', 40) || 'spark'
  const projectId = cleanText(input.projectId, existing?.projectId ?? '', 80)
  const active = input.active == null ? (existing?.active ?? true) : Boolean(input.active)

  db.prepare(
    `INSERT INTO agents (id, name, domain, charter, contract, default_model, project_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       domain = excluded.domain,
       charter = excluded.charter,
       contract = excluded.contract,
       default_model = excluded.default_model,
       project_id = excluded.project_id,
       active = excluded.active,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(slug, name, domain, charter, contract, defaultModel, projectId, active ? 1 : 0)

  const agent = getAgent(db, slug)
  if (!agent) return { ok: false, error: 'upsert_failed' }
  return { ok: true, agent, created: !existing }
}

export function setAgentActive(db: DatabaseSync, id: string, active: boolean): AgentUpsertResult {
  ensureTable(db)
  const existing = getAgent(db, id)
  if (!existing) return { ok: false, error: 'agent_not_found' }
  db.prepare("UPDATE agents SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(active ? 1 : 0, existing.id)
  const agent = getAgent(db, existing.id)
  if (!agent) return { ok: false, error: 'agent_not_found' }
  return { ok: true, agent, created: false }
}

export function slugifyAgentId(value: string | undefined | null): string {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return cleaned.slice(0, 60)
}

function cleanText(value: string | undefined | null, fallback: string, maxLength: number): string {
  if (value == null) return fallback
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  return trimmed.slice(0, maxLength)
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    charter: row.charter,
    contract: row.contract,
    defaultModel: row.default_model,
    projectId: row.project_id,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function buildAgentsListMessage(agents: AgentRecord[]): string {
  if (!agents.length) return 'Northstar agents\nNo agents registered yet.'
  const lines = ['Northstar agents']
  for (const agent of agents) {
    const scope = agent.projectId ? `project:${agent.projectId}` : 'global'
    const state = agent.active ? 'active' : 'inactive'
    lines.push(`- ${agent.id} · ${agent.name}`)
    lines.push(`    ${agent.domain || 'general'} · ${agent.defaultModel} · ${state} · ${scope}`)
  }
  lines.push('', 'Use /agents <id> for charter + contract.')
  return lines.join('\n')
}

export function buildAgentDetailMessage(agent: AgentRecord | null, id: string): string {
  if (!agent) return `No agent registered as ${id}. Use /agents to list them.`
  const scope = agent.projectId ? `project:${agent.projectId}` : 'global'
  const state = agent.active ? 'active' : 'inactive'
  return [
    `Agent ${agent.id}: ${agent.name}`,
    `${agent.domain || 'general'} · ${agent.defaultModel} · ${state} · ${scope}`,
    '',
    'Charter:',
    agent.charter || '(none set)',
    '',
    'Contract:',
    agent.contract || '(none set)',
  ].join('\n')
}
