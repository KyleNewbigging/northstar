import { existsSync } from 'node:fs'
import { rm, readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

type WhisperTranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; reason: string; details?: string }

const WHISPER_COMMAND = process.env.WHISPER_COMMAND?.trim() || 'whisper'
const WHISPER_MODEL = process.env.WHISPER_MODEL?.trim() || 'base.en'
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE?.trim() || 'en'

let whisperAvailableCache: boolean | null = null

function mimeToExt(mimeType?: string | null): string {
  if (!mimeType) return 'webm'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('flac')) return 'flac'
  if (mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('webm')) return 'webm'
  return 'webm'
}

function hasWhisperBinary(): boolean {
  if (whisperAvailableCache !== null) return whisperAvailableCache
  try {
    const probe = spawnSync(WHISPER_COMMAND, ['--help'], { stdio: 'ignore', timeout: 1500 })
    whisperAvailableCache = (probe.status === 0) || (probe.status === 1)
  } catch {
    whisperAvailableCache = false
  }
  return whisperAvailableCache
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd })
    const chunks = { out: '', err: '' }

    proc.stdout.on('data', (chunk) => {
      chunks.out += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      chunks.err += chunk.toString()
    })
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
    }, 90000)
    proc.on('error', reject)
    proc.on('close', (code) => {
      clearTimeout(timeout)
      resolve({ code: code ?? 0, stdout: chunks.out, stderr: chunks.err })
    })
  })
}

export function isWhisperAvailable(): boolean {
  return hasWhisperBinary()
}

export async function transcribeWithWhisper(audioBase64: string, mimeType?: string | null): Promise<WhisperTranscriptionResult> {
  if (!audioBase64?.trim()) return { ok: false, reason: 'empty_payload' }
  if (!hasWhisperBinary()) return { ok: false, reason: 'missing_binary' }

  const workDir = await mkdtemp(join(tmpdir(), 'northstar-whisper-'))
  const stem = randomUUID()
  const ext = mimeToExt(mimeType)
  const audioPath = join(workDir, `${stem}.${ext}`)
  const outputPath = `${audioPath}.txt`

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64')
    if (audioBuffer.length === 0) return { ok: false, reason: 'empty_audio' }
    await writeFile(audioPath, audioBuffer)

    const args = [
      '--language',
      WHISPER_LANGUAGE,
      '--model',
      WHISPER_MODEL,
      '--output_format',
      'txt',
      audioPath,
    ]
    const result = await runCommand(WHISPER_COMMAND, args, workDir)
    if (result.code !== 0) {
      return { ok: false, reason: 'transcode_failed', details: result.stderr || result.stdout }
    }

    if (!existsSync(outputPath)) return { ok: false, reason: 'missing_output' }
    const text = (await readFile(outputPath, 'utf8')).trim()
    return { ok: true, text: text.replace(/\s*\r?\n\s*/g, ' ') }
  } catch (error) {
    return {
      ok: false,
      reason: 'runtime_error',
      details: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
