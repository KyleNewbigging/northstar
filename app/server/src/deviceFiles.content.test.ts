import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildContentSearchMessage } from './telegram/messages.js'
import { searchDeviceFileContents } from './deviceFiles.js'

const originalRoot = process.env.NORTHSTAR_DROPBOX_ROOT
const originalRgBin = process.env.NORTHSTAR_RIPGREP_BIN

function forceNodeFallback() {
  process.env.NORTHSTAR_RIPGREP_BIN = '/nonexistent/rg-does-not-exist'
}

describe('searchDeviceFileContents (node fallback)', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'northstar-content-'))
    process.env.NORTHSTAR_DROPBOX_ROOT = tempRoot
    forceNodeFallback()
  })

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.NORTHSTAR_DROPBOX_ROOT
    else process.env.NORTHSTAR_DROPBOX_ROOT = originalRoot
    if (originalRgBin === undefined) delete process.env.NORTHSTAR_RIPGREP_BIN
    else process.env.NORTHSTAR_RIPGREP_BIN = originalRgBin
  })

  it('returns query_required error when no query is given', () => {
    const result = searchDeviceFileContents({})
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'query_required')
  })

  it('returns query_too_short error for a single character', () => {
    const result = searchDeviceFileContents({ query: 'x' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'query_too_short')
  })

  it('finds matches in .md files and reports relative paths', () => {
    writeFileSync(join(tempRoot, 'notes.md'), 'hello world\nfoo bar\nhello again\n')
    const result = searchDeviceFileContents({ query: 'hello' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.engine, 'node')
    assert.ok(result.results.length >= 2)
    assert.ok(result.results.every((m) => !m.relPath.startsWith('/')))
    assert.ok(result.results.some((m) => m.relPath === 'notes.md'))
  })

  it('caps matches per file at 3', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `hit line ${i + 1}`)
    writeFileSync(join(tempRoot, 'many.md'), lines.join('\n'))
    const result = searchDeviceFileContents({ query: 'hit line' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const fileMatches = result.results.filter((m) => m.relPath === 'many.md')
    assert.ok(fileMatches.length <= 3)
  })

  it('enforces the limit parameter across multiple files', () => {
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(tempRoot, `file${i}.md`), `needle here line1\nneedle here line2\nneedle here line3\n`)
    }
    const result = searchDeviceFileContents({ query: 'needle here', limit: 4 })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.results.length, 4)
    assert.equal(result.truncated, true)
  })

  it('ignores non-.md files', () => {
    writeFileSync(join(tempRoot, 'data.txt'), 'findme in txt\n')
    writeFileSync(join(tempRoot, 'data.json'), '{"key": "findme"}')
    writeFileSync(join(tempRoot, 'doc.md'), 'findme in md\n')
    const result = searchDeviceFileContents({ query: 'findme' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.results.every((m) => m.relPath.endsWith('.md')))
    assert.ok(result.results.some((m) => m.relPath === 'doc.md'))
  })

  it('trims snippets to 200 chars', () => {
    const longLine = 'x'.repeat(100) + ' match ' + 'y'.repeat(200)
    writeFileSync(join(tempRoot, 'long.md'), longLine + '\n')
    const result = searchDeviceFileContents({ query: 'match' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.results.every((m) => m.snippet.length <= 200))
  })

  it('searches recursively into subdirectories', () => {
    mkdirSync(join(tempRoot, 'projects', 'alpha', 'sessions'), { recursive: true })
    writeFileSync(join(tempRoot, 'projects', 'alpha', 'sessions', 'transcript.md'), 'deep content match here\n')
    const result = searchDeviceFileContents({ query: 'deep content match' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.results.some((m) => m.relPath.includes('sessions/transcript.md')))
  })

  it('is case-insensitive', () => {
    writeFileSync(join(tempRoot, 'case.md'), 'Hello World\nHELLO WORLD\nhello world\n')
    const result = searchDeviceFileContents({ query: 'hello world' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.ok(result.results.length >= 3)
  })

  it('returns truncated=false when all results fit', () => {
    writeFileSync(join(tempRoot, 'small.md'), 'unique-query-xyz\n')
    const result = searchDeviceFileContents({ query: 'unique-query-xyz' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.truncated, false)
  })
})

describe('buildContentSearchMessage', () => {
  it('returns null when there are no results', () => {
    const msg = buildContentSearchMessage({
      ok: true,
      status: {} as never,
      query: 'foo',
      engine: 'node',
      results: [],
      truncated: false,
    })
    assert.equal(msg, null)
  })

  it('returns null on error result', () => {
    const msg = buildContentSearchMessage({
      ok: false,
      error: 'query_required',
      detail: 'Usage',
      status: {} as never,
    })
    assert.equal(msg, null)
  })

  it('formats results with relPath:line snippet', () => {
    const msg = buildContentSearchMessage({
      ok: true,
      status: {} as never,
      query: 'hello',
      engine: 'node',
      results: [{ relPath: 'notes.md', line: 3, snippet: 'hello world' }],
      truncated: false,
    })
    assert.ok(msg !== null)
    assert.match(msg!, /notes\.md:3 hello world/)
    assert.match(msg!, /node/)
  })

  it('includes truncation notice when truncated', () => {
    const msg = buildContentSearchMessage({
      ok: true,
      status: {} as never,
      query: 'x',
      engine: 'ripgrep',
      results: [{ relPath: 'a.md', line: 1, snippet: 'x' }],
      truncated: true,
    })
    assert.ok(msg !== null)
    assert.match(msg!, /More content matches/)
  })
})
