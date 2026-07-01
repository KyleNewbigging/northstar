import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const apiKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']
export type GuardrailModel = 'opus' | 'spark' | 'codex'

const authCommands: Record<GuardrailModel, { check: string; login: string }> = {
  opus: { check: 'claude auth status', login: 'claude auth login' },
  spark: { check: 'codex login status', login: 'codex login' },
  codex: { check: 'codex login status', login: 'codex login' },
}
const cliPathCache = new Map<string, string | null>()

export function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of apiKeys) delete env[key]
  return env
}

export function checkNoApiGuardrails(model: GuardrailModel = 'opus') {
  const blockers = apiKeys.filter((key) => process.env[key]).map((key) => `${key} is set; strict no-API mode blocks dispatch.`)
  const needsCodex = model === 'spark' || model === 'codex'
  const needsClaude = model === 'opus'
  let codexAuth = ''
  let claudeAuth = ''

  if (needsCodex) {
    const codexPath = resolveCliExecutable('codex')
    if (!codexPath) {
      blockers.push('Codex CLI is not available to the Northstar server process.')
    } else {
      const codex = spawnSync(codexPath, ['login', 'status'], { encoding: 'utf8', env: sanitizedEnv() })
      codexAuth = commandOutput(codex)
      if (codex.status !== 0 || !codexAuth.includes('ChatGPT')) blockers.push('Codex is not authenticated with ChatGPT.')
    }
  }

  if (needsClaude) {
    const claudePath = resolveCliExecutable('claude')
    if (!claudePath) {
      blockers.push('Claude CLI is not available to the Northstar server process.')
    } else {
      const claude = spawnSync(claudePath, ['auth', 'status'], { encoding: 'utf8', env: sanitizedEnv() })
      claudeAuth = commandOutput(claude)
      if (claude.status !== 0 || !isClaudeAiAuth(claudeAuth)) blockers.push('Claude Code is not authenticated with claude.ai.')
    }
  }

  return { ok: blockers.length === 0, blockers, codexAuth, claudeAuth, checked: { codex: needsCodex, claude: needsClaude } }
}

export function modelAuthStatus(model: GuardrailModel) {
  const result = checkNoApiGuardrails(model)
  return {
    model,
    ok: result.ok,
    blockers: result.blockers,
    checkCommand: authCommands[model].check,
    loginCommand: authCommands[model].login,
    checked: result.checked,
  }
}

export function resolveCliExecutable(name: 'codex' | 'claude') {
  if (cliPathCache.has(name)) return cliPathCache.get(name) ?? null

  const localPath = findLocalCli(name)
  if (localPath) {
    cliPathCache.set(name, localPath)
    return localPath
  }

  const direct = spawnSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', env: sanitizedEnv() })
  const directPath = direct.status === 0 ? direct.stdout.trim().split('\n')[0] : ''
  if (directPath) {
    cliPathCache.set(name, directPath)
    return directPath
  }

  const loginShell = spawnSync('/bin/zsh', ['-lc', `command -v ${name}`], { encoding: 'utf8', env: sanitizedEnv() })
  const loginPath = loginShell.status === 0 ? loginShell.stdout.trim().split('\n')[0] : ''
  cliPathCache.set(name, loginPath || null)
  return loginPath || null
}

function findLocalCli(name: 'codex' | 'claude') {
  const home = process.env.HOME || homedir()
  const candidates = [
    join(home, '.local', 'bin', name),
    join(home, 'Library', 'pnpm', name),
  ]

  const fnmRoot = join(home, '.local', 'state', 'fnm_multishells')
  try {
    const fnmCandidates = readdirSync(fnmRoot)
      .map((entry) => join(fnmRoot, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .map((path) => join(path, 'bin', name))
    candidates.push(...fnmCandidates)
  } catch {
    // No fnm-managed Node install is present.
  }

  return candidates.find((path) => existsSync(path)) ?? ''
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return result.error ? `${output}\n${result.error.message}`.trim() : output
}

function isClaudeAiAuth(output: string) {
  try {
    const parsed = JSON.parse(output) as { authMethod?: string; loggedIn?: boolean }
    return parsed.loggedIn === true && parsed.authMethod === 'claude.ai'
  } catch {
    return output.includes('"authMethod": "claude.ai"')
  }
}
