/**
 * Durable Auto Dream clock and gate for one project memory directory.
 *
 * `.state.json` is deliberately small: it records how many sessions have run
 * since the last successful curation, when curation last succeeded or was
 * attempted, and the last error. A corrupt or missing file is treated as a
 * fresh clock, because the notes and index remain the source of truth.
 *
 * @module @local/dsh-memory/state
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { withStoreLock } from './lock.ts'
import { atomicWrite } from './atomic.ts'
import type { CurationState, DreamResult, Settings } from './types.ts'

/** State file beside `MEMORY.md`. */
export const STATE_FILE = '.state.json'

/** One hour in milliseconds. */
const HOUR_MS = 3_600_000

/** Whether a thrown value is a filesystem error with one exact code. */
function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

/** A fresh curation clock. */
function emptyState(): CurationState {
  return { version: 1, sessionsSinceCurate: 0 }
}

/** Keep a valid ISO timestamp or drop the field. */
function optionalIso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined
}

/** Keep a bounded free-form error string. */
function optionalError(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 500) : undefined
}

/** Normalize untrusted parsed JSON. */
function normalizeState(raw: unknown): CurationState {
  if (raw === null || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return emptyState()
  const row = raw as Record<string, unknown>
  const sessions = typeof row.sessionsSinceCurate === 'number'
    && Number.isInteger(row.sessionsSinceCurate)
    && row.sessionsSinceCurate >= 0
    ? row.sessionsSinceCurate
    : 0
  const state: CurationState = { version: 1, sessionsSinceCurate: sessions }
  const lastSessionAt = optionalIso(row.lastSessionAt)
  const lastCuratedAt = optionalIso(row.lastCuratedAt)
  const lastDreamAttemptAt = optionalIso(row.lastDreamAttemptAt)
  const lastDreamError = optionalError(row.lastDreamError)
  if (lastSessionAt !== undefined) state.lastSessionAt = lastSessionAt
  if (lastCuratedAt !== undefined) state.lastCuratedAt = lastCuratedAt
  if (lastDreamAttemptAt !== undefined) state.lastDreamAttemptAt = lastDreamAttemptAt
  if (lastDreamError !== undefined) state.lastDreamError = lastDreamError
  if (row.lastCuratedBy === 'dream') state.lastCuratedBy = 'dream'
  const last = row.lastCuration
  if (last !== null && typeof last === 'object') {
    const entry = last as Record<string, unknown>
    const at = optionalIso(entry.at)
    if (at !== undefined) {
      state.lastCuration = {
        at,
        notes: typeof entry.notes === 'number' && Number.isInteger(entry.notes) && entry.notes >= 0 ? entry.notes : 0,
        summary: typeof entry.summary === 'string' ? entry.summary.slice(0, 2_000) : '',
      }
    }
  }
  return state
}

/**
 * Read one project's curation clock.
 * @param dir - absolute memory directory.
 * @returns normalized state; a missing or corrupt file reads as fresh.
 */
export async function readState(dir: string): Promise<CurationState> {
  let text: string
  try {
    text = await readFile(path.join(dir, STATE_FILE), 'utf8')
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return emptyState()
    throw error
  }
  try {
    return normalizeState(JSON.parse(text) as unknown)
  }
  catch (error) {
    if (error instanceof SyntaxError) return emptyState()
    throw error
  }
}

/** Persist the clock atomically. */
async function writeState(dir: string, state: CurationState): Promise<void> {
  await atomicWrite(path.join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Whether a curation pass is due.
 *
 * All three gates must pass: the wall-clock window, the completed-session
 * count, and the retry window after a previous attempt. The function is pure
 * so tests can pin `now`.
 * @param state - current clock.
 * @param now - epoch milliseconds.
 * @param settings - resolved configuration.
 * @returns true when Auto Dream may start.
 */
export function curationDue(state: CurationState, now: number, settings: Settings): boolean {
  if (!settings.curationEnabled) return false
  const lastSuccess = state.lastCuratedAt === undefined ? 0 : Date.parse(state.lastCuratedAt)
  const lastAttempt = state.lastDreamAttemptAt === undefined ? 0 : Date.parse(state.lastDreamAttemptAt)
  return now - lastSuccess >= settings.curationMinHours * HOUR_MS
    && state.sessionsSinceCurate >= settings.curationMinSessions
    && now - lastAttempt >= settings.curationRetryHours * HOUR_MS
}

/**
 * Count one session and reserve a due attempt.
 *
 * Reserving `lastDreamAttemptAt` before the child session starts prevents two
 * sessions from launching the same pass. The retry gate keeps a failed
 * attempt from being retried immediately.
 * @param dir - absolute memory directory.
 * @param settings - resolved configuration.
 * @param hasNotes - whether the project has anything to curate.
 * @returns the updated clock and whether the caller should start a pass.
 */
export async function markSession(
  dir: string,
  settings: Settings,
  hasNotes: boolean,
): Promise<{ state: CurationState; due: boolean }> {
  return withStoreLock(dir, async () => {
    const state = await readState(dir)
    const now = Date.now()
    state.sessionsSinceCurate += 1
    state.lastSessionAt = new Date(now).toISOString()
    const due = hasNotes && curationDue(state, now, settings)
    if (due) state.lastDreamAttemptAt = new Date(now).toISOString()
    await writeState(dir, state)
    return { state, due }
  })
}

/**
 * Record the outcome of a curation pass.
 * @param dir - absolute memory directory.
 * @param result - child outcome.
 * @returns the updated clock.
 */
export async function finishCuration(dir: string, result: DreamResult): Promise<CurationState> {
  return withStoreLock(dir, async () => {
    const state = await readState(dir)
    const at = new Date().toISOString()
    if (result.ok) {
      state.lastCuratedAt = at
      state.lastCuratedBy = 'dream'
      state.sessionsSinceCurate = 0
      delete state.lastDreamError
      state.lastCuration = { at, notes: result.notes, summary: result.summary }
    }
    else {
      state.lastDreamError = (result.error ?? 'curation failed').slice(0, 500)
    }
    await writeState(dir, state)
    return state
  })
}
