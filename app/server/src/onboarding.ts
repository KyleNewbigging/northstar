import type { DatabaseSync } from 'node:sqlite'

import { ensureProjectSkillsFile, upsertProjectOnboarding } from './projectSkills.js'
import type { LocalProject } from './projects.js'

type ProjectProfile = {
  id: string
  label: string
  goals: string[]
  queue: Array<{ id: string; title: string; model: 'opus' | 'spark' | 'codex'; priority: 'P1' | 'P2' | 'P3'; stage: string }>
  skills: string[]
}

const researchNotes = [
  'Graphify-first: build or refresh graph context before reading large source trees.',
  'Caveman mode: prefer concise, technically exact summaries when routing background work.',
  'AGENTS.md first: project-local instructions outrank generic Northstar defaults.',
  'Human gate: ask before architecture, dependency, billing, auth, or data-migration changes.',
]

export function listOnboarding(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT
        project_id AS projectId,
        profile,
        goals_json AS goalsJson,
        queue_json AS queueJson,
        skills_json AS skillsJson,
        updated_at AS updatedAt
      FROM project_onboarding
      ORDER BY updated_at DESC, project_id ASC`,
    )
    .all()
    .map((row) => {
      const item = row as { projectId: string; profile: string; goalsJson: string; queueJson: string; skillsJson: string; updatedAt: string }
      return {
        projectId: item.projectId,
        profile: item.profile,
        goals: JSON.parse(item.goalsJson) as string[],
        queue: JSON.parse(item.queueJson) as ProjectProfile['queue'],
        skills: JSON.parse(item.skillsJson) as string[],
        updatedAt: item.updatedAt,
      }
    })
}

export function seedProjectOnboarding(db: DatabaseSync, projects: LocalProject[]) {
  const seeded = projects.map((project) => seedOneProject(db, project))
  return {
    ok: true,
    seeded: seeded.length,
    local: projects.filter((project) => project.localExists).length,
    githubOnly: projects.filter((project) => !project.localExists).length,
    profiles: profileCounts(seeded),
    projects: seeded,
  }
}

function seedOneProject(db: DatabaseSync, project: LocalProject) {
  const profile = classifyProject(project)
  ensureProjectRow(db, project)
  ensureProjectSkillsFile(project)
  upsertProjectOnboarding(project, onboardingMarkdown(project, profile))

  db.prepare(
    `INSERT INTO project_onboarding (project_id, profile, goals_json, queue_json, skills_json, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(project_id) DO UPDATE SET
       profile = excluded.profile,
       goals_json = excluded.goals_json,
       queue_json = excluded.queue_json,
       skills_json = excluded.skills_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(project.id, profile.label, JSON.stringify(profile.goals), JSON.stringify(profile.queue), JSON.stringify(profile.skills))

  for (const item of profile.queue) {
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, model, agent, status, priority, progress, eta, stage, files, branch)
       VALUES (?, ?, ?, ?, 'onboarding', 'queued', ?, 0, 'nightly', ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         model = excluded.model,
         priority = excluded.priority,
         stage = excluded.stage,
         eta = excluded.eta`,
    ).run(item.id, project.id, item.title, item.model, item.priority, item.stage, project.localExists ? `agent/${project.id}-onboarding` : '-')
  }

  return { projectId: project.id, name: project.name, profile: profile.label, goals: profile.goals.length, queued: profile.queue.length }
}

function classifyProject(project: LocalProject): ProjectProfile {
  const text = `${project.name} ${project.lang} ${project.github?.fullName ?? ''}`.toLowerCase()
  if (project.lang.includes('Flutter') || text.includes('mobile')) return mobileProfile(project)
  if (text.includes('zebra') || text.includes('dashboard') || text.includes('billing')) return opsDashboardProfile(project)
  if (project.lang.includes('React') || project.lang.includes('Vue') || project.lang.includes('TypeScript')) return frontendProfile(project)
  if (project.lang.includes('Python') || text.includes('ai') || text.includes('processing')) return pythonProfile(project)
  if (text.includes('portfolio') || text.includes('wiki') || text.includes('website')) return contentProfile(project)
  return generalRepoProfile(project)
}

function frontendProfile(project: LocalProject): ProjectProfile {
  return baseProfile(project, 'frontend/full-stack', [
    'Keep UI dense, readable, and visually consistent with existing design tokens.',
    'Verify responsive layout and text overflow before accepting UI patches.',
    'Prefer API-backed state with seeded fallback data during early milestones.',
  ], [
    queue(project, 'MAP', 'Refresh graph and identify primary UI/API seams', 'spark', 'P2', 'graph + route map'),
    queue(project, 'UX', 'Review core flows for empty/loading/error states', 'opus', 'P2', 'interaction review'),
    queue(project, 'PATCH', 'Find one small safe implementation patch', 'spark', 'P3', 'candidate patch'),
  ])
}

function opsDashboardProfile(project: LocalProject): ProjectProfile {
  return baseProfile(project, 'corporate/orchestration', [
    'Treat billing, auth, student/family data, and outbound communication as high-risk.',
    'Prefer inbox-style review flows with explicit status transitions.',
    'Ask before changing production data, payment workflows, or email behavior.',
    'For Zebra/corporate work, map agent domains, owners, and communication protocols before increasing autonomy.',
    'Separate personal-assistant tasks from code-orchestration tasks so the cockpit can scale to many agents without mixing blast radius.',
  ], [
    queue(project, 'RISK', 'Map high-risk workflows and current manual gates', 'opus', 'P1', 'risk map'),
    queue(project, 'AGENTS', 'Draft the agent/domain registry and communication protocol map', 'opus', 'P1', 'agent protocol map'),
    queue(project, 'MAP', 'Refresh graph and summarize data entry points', 'spark', 'P2', 'graph + data map'),
    queue(project, 'NEXT', 'Propose the next review-gated automation candidate', 'spark', 'P2', 'workflow candidate'),
  ])
}

function mobileProfile(project: LocalProject): ProjectProfile {
  return baseProfile(project, 'mobile/flutter', [
    'Protect platform-specific build settings and generated files.',
    'Prefer small UI/state patches that can be manually tested on simulator/device.',
    'Ask before package upgrades or native permission changes.',
  ], [
    queue(project, 'MAP', 'Refresh graph and identify app entry points', 'spark', 'P2', 'graph + app map'),
    queue(project, 'UX', 'Review navigation and user-facing flows', 'opus', 'P3', 'mobile UX review'),
  ])
}

function pythonProfile(project: LocalProject): ProjectProfile {
  return baseProfile(project, 'python/automation', [
    'Identify scripts, data inputs, and generated outputs before edits.',
    'Prefer deterministic tests or sample fixtures before changing automation logic.',
    'Ask before long-running jobs, external services, or destructive file operations.',
  ], [
    queue(project, 'MAP', 'Refresh graph and list runnable scripts', 'spark', 'P2', 'script map'),
    queue(project, 'TEST', 'Find a small smoke test or fixture opportunity', 'spark', 'P3', 'test candidate'),
  ])
}

function contentProfile(project: LocalProject): ProjectProfile {
  return baseProfile(project, 'content/site', [
    'Preserve voice, links, and published structure unless a redesign is requested.',
    'Check mobile layout and real content readability before visual polish.',
    'Ask before changing branding, public URLs, or SEO metadata.',
  ], [
    queue(project, 'MAP', 'Refresh graph and identify content surfaces', 'spark', 'P3', 'content map'),
    queue(project, 'REVIEW', 'Review stale pages, broken links, and next polish target', 'opus', 'P3', 'content review'),
  ])
}

function generalRepoProfile(project: LocalProject): ProjectProfile {
  return baseProfile(project, 'general/repo', [
    'Start with graph context, README, and repository instructions.',
    'Ask for the project outcome before implementing broad changes.',
    'Prefer one small reversible task over speculative rewrites.',
  ], [
    queue(project, 'MAP', 'Refresh graph and summarize repository purpose', 'spark', 'P3', 'repo map'),
    queue(project, 'ASK', 'Generate the first clarifying question for this project', 'spark', 'P3', 'question seed'),
  ])
}

function baseProfile(project: LocalProject, label: string, skills: string[], queueItems: ProjectProfile['queue']): ProjectProfile {
  return {
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    goals: [
      'Maintain a current project status summary in Northstar.',
      'Use graph context before reading broad code areas.',
      'Keep a short queue of reviewable next actions.',
      project.localExists ? 'Prepare local worktree tasks only after the user approves the lane.' : 'Clone locally before any implementation dispatch.',
    ],
    skills: [...researchNotes, ...skills],
    queue: queueItems,
  }
}

function queue(
  project: LocalProject,
  suffix: string,
  title: string,
  model: 'opus' | 'spark' | 'codex',
  priority: 'P1' | 'P2' | 'P3',
  stage: string,
) {
  return { id: `ONB-${safeId(project.id)}-${suffix}`, title, model, priority, stage }
}

function onboardingMarkdown(project: LocalProject, profile: ProjectProfile) {
  return [
    '## Northstar Onboarding',
    `Profile: ${profile.label}`,
    `Source: ${project.localExists ? 'local checkout' : 'GitHub catalog only'}`,
    '',
    '### Initial Goals',
    ...profile.goals.map((goal) => `- ${goal}`),
    '',
    '### Initial Queue',
    ...profile.queue.map((item) => `- ${item.id}: ${item.title} (${item.model}, ${item.priority})`),
    '',
    '### Reusable Skills',
    ...profile.skills.map((skill) => `- ${skill}`),
  ].join('\n')
}

function profileCounts(items: Array<{ profile: string }>) {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.profile] = (acc[item.profile] ?? 0) + 1
    return acc
  }, {})
}

function ensureProjectRow(db: DatabaseSync, project: LocalProject) {
  db.prepare(
    `INSERT INTO projects
      (id, name, path, branch, lang, status, label, health, coverage, tokens, budget, runtime, last_event, last_ago)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       path = excluded.path,
       branch = excluded.branch,
       lang = excluded.lang,
       status = excluded.status,
       label = excluded.label,
       health = excluded.health,
       coverage = excluded.coverage,
       tokens = excluded.tokens,
       budget = excluded.budget,
       runtime = excluded.runtime,
       last_event = excluded.last_event,
       last_ago = excluded.last_ago`,
  ).run(
    project.id,
    project.name,
    project.path,
    project.branch,
    project.lang,
    project.status,
    project.label,
    project.health,
    project.coverage,
    project.tokens,
    project.budget,
    project.runtime,
    project.lastEvent,
    project.lastAgo,
  )
}

function safeId(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'PROJECT'
}
