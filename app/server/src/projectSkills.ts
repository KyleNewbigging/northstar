import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { skillsRoot } from './paths.js'
import type { LocalProject } from './projects.js'

export type ProjectSkillSummary = {
  skillsPath: string
  skillsReady: boolean
  skillsUpdatedAt: string | null
  learnedItems: number
}

export function summarizeProjectSkills(project: Pick<LocalProject, 'id'>): ProjectSkillSummary {
  const path = projectSkillsPath(project)
  if (!existsSync(path)) {
    return { skillsPath: displayPath(path), skillsReady: false, skillsUpdatedAt: null, learnedItems: 0 }
  }

  const content = readFileSync(path, 'utf8')
  return {
    skillsPath: displayPath(path),
    skillsReady: true,
    skillsUpdatedAt: statSync(path).mtime.toISOString(),
    learnedItems: countLearnedItems(content),
  }
}

export function ensureProjectSkillsFile(project: LocalProject) {
  const path = projectSkillsPath(project)
  if (existsSync(path)) return summarizeProjectSkills(project)

  mkdirSync(skillsRoot, { recursive: true })
  writeFileSync(path, defaultSkillsFile(project), 'utf8')
  return summarizeProjectSkills(project)
}

export function readProjectSkills(project: LocalProject, maxChars = 5000) {
  const path = projectSkillsPath(project)
  if (!existsSync(path)) return ''
  const content = readFileSync(path, 'utf8').trim()
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars).trim()}\n\n[Northstar truncated older project skills for this dispatch.]`
}

export function appendProjectLearning(project: LocalProject, note: string, source = 'manual') {
  const clean = normalizeLearningNote(note)
  if (!clean) return summarizeProjectSkills(project)

  ensureProjectSkillsFile(project)
  const path = projectSkillsPath(project)
  const stamp = new Date().toISOString()
  const line = `- ${clean} _(source: ${source}, ${stamp})_`
  const content = readFileSync(path, 'utf8')
  const next = content.includes('## Learned Notes')
    ? content.replace('## Learned Notes\n', `## Learned Notes\n${line}\n`)
    : `${content.trim()}\n\n## Learned Notes\n${line}\n`
  writeFileSync(path, next, 'utf8')
  return summarizeProjectSkills(project)
}

export function upsertProjectOnboarding(project: LocalProject, markdown: string) {
  ensureProjectSkillsFile(project)
  const path = projectSkillsPath(project)
  const start = '<!-- northstar:onboarding:start -->'
  const end = '<!-- northstar:onboarding:end -->'
  const block = `${start}\n${markdown.trim()}\n${end}`
  const content = readFileSync(path, 'utf8')
  const next = content.includes(start) && content.includes(end)
    ? content.replace(new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`), block)
    : `${content.trim()}\n\n${block}\n`
  writeFileSync(path, next, 'utf8')
  return summarizeProjectSkills(project)
}

export function extractLearningCandidates(text: string) {
  const notes = text
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*]\s*)?Learning candidate:\s*(.+)$/i)?.[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .map(normalizeLearningNote)
    .filter((line): line is string => Boolean(line))
  return [...new Set(notes)].slice(0, 3)
}

function projectSkillsPath(project: Pick<LocalProject, 'id'>) {
  return join(skillsRoot, `${safeFileStem(project.id)}.md`)
}

function defaultSkillsFile(project: LocalProject) {
  const pathLabel = project.localExists ? project.path : project.github?.fullName ?? project.path
  return [
    `# ${project.name} Skills`,
    '',
    `Project: ${project.name}`,
    `Project ID: ${project.id}`,
    `Runtime file: ${displayPath(projectSkillsPath(project))}`,
    `Project path: ${pathLabel}`,
    '',
    '## Operating Preferences',
    '- Follow the project-local AGENTS.md or equivalent guidance before making edits.',
    '- Prefer small, reviewable patches and preserve existing architecture unless the user approves a broader move.',
    '- Keep private runtime data under ~/.northstar, not inside the project repository.',
    '',
    '## Learned Notes',
    '',
  ].join('\n')
}

function safeFileStem(value: string) {
  return basename(value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/(^-|-$)/g, '') || 'project')
}

function displayPath(path: string) {
  const home = process.env.HOME
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function countLearnedItems(content: string) {
  const learnedSection = content.split(/^## Learned Notes\s*$/m)[1] ?? ''
  return learnedSection.split('\n').filter((line) => /^\s*-\s+\S/.test(line)).length
}

function normalizeLearningNote(note: string) {
  return note
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s*/, '')
    .trim()
    .slice(0, 320)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
