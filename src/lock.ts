/**
 * Serialize index read-modify-write cycles for one memory directory.
 *
 * Two layers protect the same critical section:
 * - an in-process promise chain, so several sessions in one Host cannot
 *   interleave their `loadIndex` / `atomicWrite` pair;
 * - an advisory lock file, so a second Host process pointed at the same
 *   harness home waits instead of overwriting the index.
 *
 * The lock file is a short-lived sibling of `MEMORY.md`. A crash leaves it
 * behind, so a lock older than {@link STALE_MS} is reclaimed.
 *
 * @module @local/dsh-memory/lock
 */

import { mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Lock file name inside one memory directory. */
const LOCK_FILE = '.store.lock'

/** A lock older than this is assumed orphaned and reclaimed. */
const STALE_MS = 5 * 60 * 1000

/** How long to wait for a busy lock before failing the operation. */
const WAIT_MS = 5_000

/** Delay between lock attempts. */
const RETRY_MS = 25

/** Tail of the in-process queue for each resolved directory. */
const tails = new Map<string, Promise<void>>()

/** Whether a thrown value is a filesystem error with one exact code. */
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
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
    await mkdir(key, { recursive: true })
    return await withFileLock(key, operation)
  }
  finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/** Acquire the advisory lock file, run the operation, and always release it. */
async function withFileLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, LOCK_FILE)
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
      if (info !== undefined && Date.now() - info.mtimeMs > STALE_MS) {
        try {
          await rm(lock, { force: true })
          continue
        }
        catch {
          // A lock we cannot reclaim falls through to the normal wait/timeout.
        }
      }
      if (Date.now() - started >= WAIT_MS) {
        throw new Error(`memory store is busy; retry (lock: ${lock})`)
      }
      await delay(RETRY_MS)
    }
  }
  try {
    return await operation()
  }
  finally {
    await rm(lock, { force: true }).catch(() => {})
  }
}
