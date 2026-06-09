import { spawnSync } from 'node:child_process'

const apiKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']

export function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of apiKeys) delete env[key]
  return env
}

export function checkNoApiGuardrails() {
  const blockers = apiKeys.filter((key) => process.env[key]).map((key) => `${key} is set; strict no-API mode blocks dispatch.`)
  const codex = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', env: sanitizedEnv() })
  const claude = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', env: sanitizedEnv() })
  const codexAuth = `${codex.stdout}${codex.stderr}`.trim()
  const claudeAuth = `${claude.stdout}${claude.stderr}`.trim()
  if (!codexAuth.includes('ChatGPT')) blockers.push('Codex is not authenticated with ChatGPT.')
  if (!claudeAuth.includes('"authMethod": "claude.ai"')) blockers.push('Claude Code is not authenticated with claude.ai.')
  return { ok: blockers.length === 0, blockers, codexAuth, claudeAuth }
}
