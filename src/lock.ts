/**
 * Serialize writes to one memory directory.
 *
 * Two independent locks:
 * - `.store.lock` protects short index read-modify-write cycles, using an
 *   in-process queue plus an advisory file so two Host processes cannot both
 *   read the old index and overwrite the other's line;
 * - `.dream.lock` protects a long curation session, so a project never runs
 *   two Auto Dream passes at once.
 *
 * A crashed process leaves a lock file behind; each lock has its own stale
 * timeout and is reclaimed by the next caller.
 *
 * @module @local/dsh-memory/lock
 */

import { mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Lock file guarding index writes. */
const STORE_LOCK_FILE = '.store.lock'

/** Lock file guarding one curation session. */
const CURATION_LOCK_FILE = '.dream.lock'

/** A store lock older than this is assumed orphaned. */
const STORE_STALE_MS = 5 * 60 * 1000

/** A curation lock older than this is assumed orphaned. */
const CURATION_STALE_MS = 30 * 60 * 1000

/** How long a store write waits for a busy lock before failing. */
const STORE_WAIT_MS = 5_000

/** Delay between lock attempts. */
const RETRY_MS = 25

/** Tail of the in-process queue for each resolved directory. */
const tails = new Map<string, Promise<void>>()

/** Directories with an in-process curation session. */
const curationOwners = new Set<string>()

/** Thrown when a lock is held by another operation. */
export class MemoryLockBusy extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryLockBusy'
  }
}

/** Whether a thrown value is a filesystem error with one exact code. */
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

/**
 * Acquire one advisory lock file.
 * @param dir - absolute memory directory.
 * @param name - lock file name.
 * @param staleMs - age at which the lock is reclaimed.
 * @param waitMs - how long to wait for a live holder.
 * @returns the exact release function.
 * @throws {MemoryLockBusy} when the holder does not release within `waitMs`.
 */
async function acquireFileLock(dir: string, name: string, staleMs: number, waitMs: number): Promise<() => Promise<void>> {
  const lock = path.join(dir, name)
  const started = Date.now()
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8')
      }
      finally {
        await handle.close()
      }
      break
    }
    catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      const info = await stat(lock).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > staleMs) {
        try {
          await rm(lock, { force: true })
          continue
        }
        catch {
          // A lock we cannot reclaim falls through to the normal wait/timeout.
        }
      }
      if (Date.now() - started >= waitMs) {
        throw new MemoryLockBusy(`memory lock is busy (${lock})`)
      }
      await delay(RETRY_MS)
    }
  }
  return async () => {
    await rm(lock, { force: true }).catch(() => {})
  }
}

/**
 * Run one operation while holding the store lock for its directory.
 *
 * The callback must not call another locked public store function for the same
 * directory; use the module's unlocked helpers instead. The directory is
 * created first so the lock file has a home.
 * @param dir - absolute memory directory.
 * @param operation - critical section.
 * @returns the operation's exact result.
 */
export async function withStoreLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir)
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  tails.set(key, tail)
  await previous
  try {
    await mkdir(key, { recursive: true, mode: 0o700 })
    const unlock = await acquireFileLock(key, STORE_LOCK_FILE, STORE_STALE_MS, STORE_WAIT_MS)
    try {
      return await operation()
    }
    finally {
      await unlock()
    }
  }
  finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/**
 * Try to claim the long curation lock without waiting.
 * @param dir - absolute memory directory.
 * @returns the release function, or undefined when a pass is already running.
 */
export async function tryAcquireCurationLock(dir: string): Promise<(() => Promise<void>) | undefined> {
  const key = path.resolve(dir)
  if (curationOwners.has(key)) return undefined
  curationOwners.add(key)
  try {
    await mkdir(key, { recursive: true, mode: 0o700 })
    const unlock = await acquireFileLock(key, CURATION_LOCK_FILE, CURATION_STALE_MS, 0)
    return async () => {
      try {
        await unlock()
      }
      finally {
        curationOwners.delete(key)
      }
    }
  }
  catch (error) {
    curationOwners.delete(key)
    if (error instanceof MemoryLockBusy) return undefined
    throw error
  }
}
