/**
 * Archive naming and validation for soft-deleted notes.
 *
 * A generated archive name carries the UTC time, the original slug, and a
 * random suffix so a restore can recover the original file name without a
 * sidecar manifest:
 *
 * `20261127T190000Z-testing-conventions-a1b2.md`
 *
 * @module @local/dsh-memory/archive
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from './atomic.ts'
import { assertContained, isTopicFileName } from './paths.ts'

/** Subdirectory holding soft-deleted notes. */
export const ARCHIVE_DIR = 'archive'

/** Shape of a generated archive file name. */
const ARCHIVE_PATTERN = /^(\d{8}T\d{6}Z)-(.+)-([0-9a-f]{4})\.md$/u

/** Manifest mapping each generated archive name to its exact original file. */
const MANIFEST_FILE = '.manifest.json'

/** Archive name to original topic file name. */
export type ArchiveManifest = Record<string, string>

/**
 * Build a collision-resistant archive file name.
 * @param file - flat topic file name being archived.
 * @returns the generated archive name.
 */
export function archiveFileName(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  const base = file.slice(0, -3)
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .slice(0, 64)
  const suffix = randomUUID().replace(/-/gu, '').slice(0, 4)
  return `${stamp}-${base}-${suffix}.md`
}

/**
 * Whether a value is a generated archive file name.
 * @param name - candidate name.
 * @returns true only for a flat generated name inside `archive/`.
 */
export function isArchiveFileName(name: unknown): name is string {
  return typeof name === 'string' && ARCHIVE_PATTERN.test(name)
}

/**
 * Read the UTC time encoded in a generated archive file name.
 * @param name - candidate archive name.
 * @returns epoch milliseconds, or undefined when the name is not generated.
 */
export function archiveCreatedAt(name: string): number | undefined {
  const match = ARCHIVE_PATTERN.exec(name)
  if (match === null) return undefined
  const stamp = match[1]
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return undefined
  const date = new Date(time)
  const roundTrips = date.getUTCFullYear() === Number(stamp.slice(0, 4))
    && date.getUTCMonth() === Number(stamp.slice(4, 6)) - 1
    && date.getUTCDate() === Number(stamp.slice(6, 8))
    && date.getUTCHours() === Number(stamp.slice(9, 11))
    && date.getUTCMinutes() === Number(stamp.slice(11, 13))
    && date.getUTCSeconds() === Number(stamp.slice(13, 15))
  return roundTrips ? time : undefined
}

/**
 * Recover the original topic file name from an archive name.
 * @param name - generated archive name.
 * @returns the original `.md` name, or undefined when it would be invalid.
 */
export function originalNameOf(name: string): string | undefined {
  const match = ARCHIVE_PATTERN.exec(name)
  if (match === null) return undefined
  const file = `${match[2]}.md`
  return isTopicFileName(file) ? file : undefined
}

/**
 * Read the archive manifest.
 * @param dir - absolute memory directory.
 * @returns the mapping; a missing or corrupt manifest reads as empty.
 */
export async function readArchiveManifest(dir: string): Promise<ArchiveManifest> {
  let text: string
  try {
    text = await readFile(path.join(dir, ARCHIVE_DIR, MANIFEST_FILE), 'utf8')
  }
  catch (error) {
    if (error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const raw = JSON.parse(text) as unknown
    if (raw === null || typeof raw !== 'object') return {}
    const manifest: ArchiveManifest = {}
    for (const [name, file] of Object.entries(raw as Record<string, unknown>)) {
      if (isArchiveFileName(name) && isTopicFileName(file)) manifest[name] = file
    }
    return manifest
  }
  catch (error) {
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

/**
 * Persist the archive manifest atomically.
 * @param dir - absolute memory directory.
 * @param manifest - complete mapping.
 */
export async function writeArchiveManifest(dir: string, manifest: ArchiveManifest): Promise<void> {
  await mkdir(path.join(dir, ARCHIVE_DIR), { recursive: true, mode: 0o700 })
  await atomicWrite(path.join(dir, ARCHIVE_DIR, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Remember the exact original name for one archived file.
 * @param dir - absolute memory directory.
 * @param name - generated archive name.
 * @param original - original topic file name.
 */
export async function rememberArchive(dir: string, name: string, original: string): Promise<void> {
  const manifest = await readArchiveManifest(dir)
  manifest[name] = original
  await writeArchiveManifest(dir, manifest)
}

/**
 * Forget one archive entry after a restore.
 * @param dir - absolute memory directory.
 * @param name - generated archive name.
 */
export async function forgetArchive(dir: string, name: string): Promise<void> {
  const manifest = await readArchiveManifest(dir)
  if (manifest[name] === undefined) return
  delete manifest[name]
  await writeArchiveManifest(dir, manifest)
}

/**
 * Resolve one archive file, refusing anything outside `archive/`.
 * @param dir - absolute memory directory.
 * @param name - generated archive name.
 * @returns the absolute archive path.
 */
export function archivePath(dir: string, name: string): string {
  return assertContained(dir, path.join(ARCHIVE_DIR, name))
}
