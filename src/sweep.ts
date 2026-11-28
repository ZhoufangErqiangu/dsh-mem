/**
 * Deterministic memory sweep.
 *
 * The sweep only performs changes whose outcome is unambiguous:
 * - reconcile the index with the directory;
 * - archive empty notes;
 * - archive byte-identical duplicate notes, keeping the newest;
 * - remove abandoned `*.tmp` files older than an hour;
 * - optionally archive the oldest notes until the rendered index fits 80% of
 *   its budget, but only when `archiveOverflow` is enabled.
 *
 * Near-duplicates and stale-but-nonempty notes are reported by `memory_audit`,
 * never touched here. `dryRun` predicts every change without moving a file.
 *
 * @module @local/dsh-memory/sweep
 */

import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { ARCHIVE_DIR, archiveFileName, archivePath as archivePathOf, rememberArchive } from './archive.ts'
import { withStoreLock } from './lock.ts'
import { INDEX_FILE, assertContained, isTopicFileName } from './paths.ts'
import { boundEntries } from './render.ts'
import { digestBody } from './similarity.ts'
import { atomicWrite } from './atomic.ts'
import { loadIndex, renderIndex } from './store.ts'
import type { MemoryEntry, SweepArchive, SweepOptions, SweepReport } from './types.ts'

/** Temporary files younger than this are left alone. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1000

/** A note read for the sweep. */
interface NoteFile {
  entry: MemoryEntry
  content: string
  bytes: number
  updatedAt: number
}

/** Whether a thrown value is a filesystem error with one exact code. */
function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

/** Read one note, tolerating a file removed between reconciliation and the read. */
async function readNote(dir: string, entry: MemoryEntry): Promise<NoteFile | undefined> {
  const file = path.join(dir, entry.file)
  try {
    const info = await stat(file)
    if (!info.isFile()) return undefined
    const content = await readFile(file, 'utf8')
    return { entry, content, bytes: info.size, updatedAt: info.mtimeMs }
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Read the current index text, if any. */
async function readIndexText(dir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(dir, INDEX_FILE), 'utf8')
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Find old atomic-write temporary files. */
async function oldTempFiles(dir: string, now: number): Promise<string[]> {
  const found: string[] = []
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.tmp'))
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return []
    throw error
  }
  for (const name of names) {
    const info = await stat(path.join(dir, name)).catch(() => undefined)
    if (info?.isFile() === true && now - info.mtimeMs > TEMP_MAX_AGE_MS) found.push(name)
  }
  return found
}

/** Archive one file, or only predict the path in a dry run. */
async function archiveNote(dir: string, file: string, dryRun: boolean): Promise<string> {
  const target = archivePathOf(dir, archiveFileName(file))
  if (!dryRun) {
    await mkdir(path.join(dir, ARCHIVE_DIR), { recursive: true })
    await rename(assertContained(dir, file), target)
  }
  return target
}

/**
 * Sweep one project's memory.
 * @param dir - absolute memory directory.
 * @param options - dry-run flag, overflow policy, and index budget.
 * @returns the before/after counts and every predicted or performed action.
 */
export async function sweepMemory(dir: string, options: SweepOptions): Promise<SweepReport> {
  return withStoreLock(dir, async () => {
    const now = Date.now()
    const entries = await loadIndex(dir)
    const notes = (await Promise.all(entries.map(entry => readNote(dir, entry))))
      .filter((note): note is NoteFile => note !== undefined)
    const before = {
      notes: notes.length,
      bytes: notes.reduce((sum, note) => sum + note.bytes, 0),
      lines: entries.length,
    }

    const archived = new Map<string, SweepArchive['reason']>()
    for (const note of notes) {
      if (note.content.trim().length === 0) archived.set(note.entry.file, 'empty')
    }

    // Exact duplicates: group by normalized body, keep the newest, archive the rest.
    const byDigest = new Map<string, NoteFile[]>()
    for (const note of notes) {
      if (archived.has(note.entry.file)) continue
      const digest = digestBody(note.content)
      const group = byDigest.get(digest)
      if (group === undefined) byDigest.set(digest, [note])
      else group.push(note)
    }
    for (const group of byDigest.values()) {
      if (group.length < 2) continue
      group.sort((left, right) => right.updatedAt - left.updatedAt || left.entry.file.localeCompare(right.entry.file))
      for (const redundant of group.slice(1)) archived.set(redundant.entry.file, 'duplicate')
    }

    let remaining = notes.filter(note => !archived.has(note.entry.file))

    // Overflow is opt-in: drop the oldest notes until the rendered index fits
    // 80% of its budget, leaving room for future writes.
    if (options.archiveOverflow && options.maxIndexLines > 0 && options.maxIndexBytes > 0) {
      const targetLines = Math.max(1, Math.floor(options.maxIndexLines * 0.8))
      const targetBytes = Math.max(1, Math.floor(options.maxIndexBytes * 0.8))
      while (remaining.length > 0) {
        const bounded = boundEntries(remaining.map(note => note.entry), targetLines, targetBytes)
        if (bounded.omitted === 0) break
        const oldest = [...remaining].sort((left, right) => left.updatedAt - right.updatedAt || left.entry.file.localeCompare(right.entry.file))[0]
        archived.set(oldest.entry.file, 'overflow')
        remaining = remaining.filter(note => note !== oldest)
      }
    }

    const removedTemps = await oldTempFiles(dir, now)
    const remainingEntries = remaining.map(note => note.entry)
    const rendered = renderIndex(remainingEntries)
    const currentIndex = await readIndexText(dir)
    const indexRewritten = currentIndex === undefined ? remainingEntries.length > 0 : currentIndex !== rendered
    const after = {
      notes: remaining.length,
      bytes: remaining.reduce((sum, note) => sum + note.bytes, 0),
      lines: remainingEntries.length,
    }
    const overBudget = boundEntries(remainingEntries, options.maxIndexLines, options.maxIndexBytes).omitted > 0

    const archives: SweepArchive[] = []
    for (const [file, reason] of archived) {
      archives.push({ file, archivePath: await archiveNote(dir, file, true), reason })
    }

    if (!options.dryRun) {
      for (const item of archives) {
        const target = assertContained(dir, path.join(ARCHIVE_DIR, path.basename(item.archivePath)))
        await mkdir(path.join(dir, ARCHIVE_DIR), { recursive: true })
        await rename(assertContained(dir, item.file), target)
        await rememberArchive(dir, path.basename(target), item.file)
        item.archivePath = target
      }
      for (const name of removedTemps) {
        await rm(path.join(dir, name), { force: true })
      }
      if (indexRewritten) await atomicWrite(path.join(dir, INDEX_FILE), rendered)
    }

    return {
      dryRun: options.dryRun,
      before,
      after,
      archived: archives,
      removedTemps,
      indexRewritten,
      overBudget,
    }
  })
}
