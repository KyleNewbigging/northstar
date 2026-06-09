import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { northstarHome } from './paths.js'

export type GithubVisibility = 'public' | 'private' | 'internal' | 'unknown'

export type GithubRepoSummary = {
  id: string
  name: string
  owner: string
  fullName: string
  cloneUrl: string
  url: string
  defaultBranch: string
  visibility: GithubVisibility
  archived: boolean
}

type ConnectorRepo = {
  name?: string
  repository_full_name?: string
  clone_url?: string
  display_url?: string
  default_branch?: string
  visibility?: GithubVisibility
  archived?: boolean
  owner?: { login?: string } | string
}

export const githubCatalogPath = join(northstarHome, 'github-repos.json')

export function parseGithubRemote(remote?: string | null): GithubRepoSummary | null {
  if (!remote) return null
  const trimmed = remote.trim()
  const match =
    trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (!match) return null

  const owner = match[1]
  const repo = match[2]
  return toGithubSummary({
    owner,
    name: repo,
    repository_full_name: `${owner}/${repo}`,
    clone_url: `https://github.com/${owner}/${repo}.git`,
    display_url: `https://github.com/${owner}/${repo}`,
  })
}

export function loadGithubCatalog(): GithubRepoSummary[] {
  const fromFile = readGithubCatalogFile()
  const fromEnv = readGithubCatalogEnv()
  return dedupeGithubRepos([...fromFile, ...fromEnv])
}

export function toGithubSummary(input: ConnectorRepo & { owner?: { login?: string } | string }): GithubRepoSummary {
  const fullName = input.repository_full_name ?? fullNameFromParts(input)
  const [owner, repo] = fullName.split('/')
  const name = input.name ?? repo
  return {
    id: fullName.toLowerCase(),
    name,
    owner,
    fullName,
    cloneUrl: input.clone_url ?? `https://github.com/${owner}/${repo}.git`,
    url: input.display_url ?? `https://github.com/${owner}/${repo}`,
    defaultBranch: input.default_branch ?? 'main',
    visibility: input.visibility ?? 'unknown',
    archived: input.archived ?? false,
  }
}

function readGithubCatalogFile() {
  if (!existsSync(githubCatalogPath)) return []
  try {
    const raw = JSON.parse(readFileSync(githubCatalogPath, 'utf8')) as unknown
    const items = Array.isArray(raw) ? raw : Array.isArray((raw as { repositories?: unknown }).repositories) ? (raw as { repositories: unknown[] }).repositories : []
    return items.map((item) => normalizeCatalogItem(item)).filter((item): item is GithubRepoSummary => Boolean(item))
  } catch {
    return []
  }
}

function readGithubCatalogEnv() {
  const value = process.env.NORTHSTAR_GITHUB_REPOS
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((fullName) => normalizeCatalogItem({ repository_full_name: fullName }))
    .filter((item): item is GithubRepoSummary => Boolean(item))
}

function normalizeCatalogItem(item: unknown): GithubRepoSummary | null {
  if (!item || typeof item !== 'object') return null
  const repo = item as ConnectorRepo
  const fullName = repo.repository_full_name ?? fullNameFromParts(repo)
  if (!fullName.includes('/')) return null
  return toGithubSummary(repo)
}

function fullNameFromParts(input: ConnectorRepo) {
  const owner = typeof input.owner === 'string' ? input.owner : input.owner?.login
  if (owner && input.name) return `${owner}/${input.name}`
  return input.repository_full_name ?? ''
}

function dedupeGithubRepos(repos: GithubRepoSummary[]) {
  const seen = new Set<string>()
  return repos.filter((repo) => {
    const key = repo.fullName.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
