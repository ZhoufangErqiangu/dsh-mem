import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { curationDue, finishCuration, markSession, readState, STATE_FILE } from '../src/state.ts'
import type { Settings } from '../src/types.ts'

const scratch: string[] = []

async function memoryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-mem-state-'))
  scratch.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    globalMemoryEnabled: true,
    maxGlobalIndexLines: 40,
    maxGlobalIndexBytes: 6_000,
    maxTopicBytes: 65_536,
    maxSearchResults: 20,
    maxSearchBytes: 4_194_304,
    staleDays: 90,
    duplicateThreshold: 0.6,
    oversizeBytes: 16_384,
    maxAuditNotes: 200,
    archiveOverflow: false,
    archiveMaxAgeDays: 30,
    curationEnabled: true,
    curationMinHours: 24,
    curationMinSessions: 5,
    curationRetryHours: 1,
    curationTimeoutMs: 600_000,
    curationProvider: '',
    curationModel: '',
    curationMaxTokens: 4_096,
    home: '/tmp',
    ...overrides,
  }
}

async function seed(dir: string, state: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(dir, STATE_FILE), JSON.stringify({ version: 1, ...state }), 'utf8')
}

test('a missing or corrupt state file reads as a fresh clock', async () => {
  const dir = await memoryDirectory()
  const missing = await readState(dir)
  assert.equal(missing.sessionsSinceCurate, 0)
  assert.equal(missing.lastCuratedAt, undefined)

  await writeFile(path.join(dir, STATE_FILE), '{not json', 'utf8')
  const corrupt = await readState(dir)
  assert.equal(corrupt.sessionsSinceCurate, 0)
})

test('markSession increments once per session and does not trigger before five sessions', async () => {
  const dir = await memoryDirectory()
  const first = await markSession(dir, settings(), true)
  assert.equal(first.due, false)
  assert.equal(first.state.sessionsSinceCurate, 1)
  assert.ok(first.state.lastSessionAt)

  await seed(dir, { sessionsSinceCurate: 3 })
  const fourth = await markSession(dir, settings({ curationMinSessions: 5 }), true)
  assert.equal(fourth.due, false)

  // The session gate is satisfied, but a recent success keeps the wall-clock gate closed.
  await seed(dir, {
    sessionsSinceCurate: 4,
    lastCuratedAt: new Date().toISOString(),
  })
  const fifth = await markSession(dir, settings({ curationMinSessions: 5, curationMinHours: 24 }), true)
  assert.equal(fifth.due, false)
})

test('a session past both gates is due and reserves an attempt', async () => {
  const dir = await memoryDirectory()
  await seed(dir, {
    sessionsSinceCurate: 4,
    lastCuratedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
  })
  const marked = await markSession(dir, settings({ curationMinSessions: 5, curationMinHours: 24 }), true)
  assert.equal(marked.due, true)
  assert.equal(marked.state.sessionsSinceCurate, 5)
  assert.ok(marked.state.lastDreamAttemptAt)
})

test('the retry gate blocks a second attempt inside the retry window', async () => {
  const dir = await memoryDirectory()
  await seed(dir, {
    sessionsSinceCurate: 20,
    lastCuratedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    lastDreamAttemptAt: new Date().toISOString(),
  })
  const marked = await markSession(dir, settings({ curationRetryHours: 1 }), true)
  assert.equal(marked.due, false)
})

test('curationDue is false when curation is disabled or there are no notes', async () => {
  const dir = await memoryDirectory()
  const disabled = await markSession(dir, settings({ curationEnabled: false }), true)
  assert.equal(disabled.due, false)

  await seed(dir, {
    sessionsSinceCurate: 100,
    lastCuratedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
  })
  const noNotes = await markSession(dir, settings(), false)
  assert.equal(noNotes.due, false)
})

test('finishCuration resets the clock on success and records the summary', async () => {
  const dir = await memoryDirectory()
  await seed(dir, { sessionsSinceCurate: 7, lastDreamError: 'old failure' })
  const state = await finishCuration(dir, { ok: true, notes: 3, summary: 'Merged two notes.' })
  assert.equal(state.sessionsSinceCurate, 0)
  assert.equal(state.lastCuratedBy, 'dream')
  assert.equal(state.lastDreamError, undefined)
  assert.ok(state.lastCuratedAt)
  assert.deepEqual(state.lastCuration, {
    at: state.lastCuratedAt,
    notes: 3,
    summary: 'Merged two notes.',
  })
  const persisted = JSON.parse(await readFile(path.join(dir, STATE_FILE), 'utf8')) as { sessionsSinceCurate: number }
  assert.equal(persisted.sessionsSinceCurate, 0)
})

test('finishCuration keeps the session count and records the error on failure', async () => {
  const dir = await memoryDirectory()
  await seed(dir, { sessionsSinceCurate: 7, lastCuratedAt: new Date(Date.now() - 48 * 3_600_000).toISOString() })
  const before = await readState(dir)
  const state = await finishCuration(dir, { ok: false, notes: 0, summary: '', error: 'model route unavailable' })
  assert.equal(state.sessionsSinceCurate, 7)
  assert.equal(state.lastCuratedAt, before.lastCuratedAt)
  assert.equal(state.lastDreamError, 'model route unavailable')
})

test('curationDue is a pure function over normalized state', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z')
  const base = { version: 1 as const, sessionsSinceCurate: 5 }
  assert.equal(curationDue(base, now, settings()), true)
  assert.equal(curationDue({ ...base, lastDreamAttemptAt: '2026-11-27T11:30:00.000Z' }, now, settings()), false)
  assert.equal(curationDue({ ...base, lastCuratedAt: '2026-11-27T11:00:00.000Z' }, now, settings()), false)
  assert.equal(curationDue(base, now, settings({ curationEnabled: false })), false)
})
