/**
 * Markdown memory store: one index plus one file per memory.
 *
 * `MEMORY.md` is only an index; the topic files are the truth. Reading the index
 * therefore reconciles it against the directory, so a hand-added, hand-edited, or
 * hand-deleted file behaves sensibly without a migration step.
 *
 * @module @local/dsh-memory/store
 */

import { existsSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from './atomic.ts'
import { INDEX_FILE, assertContained, isTopicFileName } from './paths.ts'
import { ARCHIVE_DIR, archiveFileName, archivePath as resolveArchivePath, forgetArchive, isArchiveFileName, originalNameOf, readArchiveManifest, rememberArchive } from './archive.ts'
import { withStoreLock } from './lock.ts'
import { similarEntries } from './similarity.ts'
import type {
  ArchiveReason,
  DeleteMemoryOptions,
  DeleteMemoryResult,
  MemoryEntry,
  MemoryMatch,
  ReadMemoryResult,
  RestoreMemoryResult,
  SearchOptions,
  SearchResult,
  StoredMemory,
  WriteMemoryInput,
  WriteMemoryOptions,
} from './types.ts'

/** One index line: `- [Title](file.md) — summary`. */
const ENTRY_PATTERN = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)(?:\s+[—–-]\s*(.*))?$/

/** Bound for one summary derived from note content. */
const SUMMARY_MAX_CHARS = 160

/** Bound for the head of a file inspected to derive an index line. */
const HEAD_BYTES = 4096

/** How long a reconciled index may be reused across pre-step calls. */
const INDEX_CACHE_TTL_MS = 5_000

/** Maximum directories retained in the index cache. */
const INDEX_CACHE_MAX = 64

/** Reconciled index cache keyed by resolved memory directory. */
const indexCache = new Map<string, { entries: MemoryEntry[]; at: number }>()

export { ARCHIVE_DIR }

/** Default title/summary similarity for write-time duplicate hints. */
const DEFAULT_DUPLICATE_THRESHOLD = 0.6

/** Whether a thrown value is a filesystem error with one exact code. */
function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function listTopicFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && isTopicFileName(entry.name))
      .map(entry => entry.name)
      .sort()
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return []
    throw error
  }
}

/** Collapse arbitrary text into one line. */
function oneLine(text: unknown): string {
  return String(text).replace(/\s+/gu, ' ').trim()
}

function clampSummary(text: unknown): string {
  const line = oneLine(text)
  return line.length <= SUMMARY_MAX_CHARS ? line : `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Derive a readable title from a note head.
 * @param head - first bytes of the note.
 * @param fileName - fallback name.
 * @returns the heading text, or the file name without its extension.
 */
function titleFromHead(head: string, fileName: string): string {
  for (const line of head.split(/\r?\n/u)) {
    const match = /^#\s+(.+)$/u.exec(line.trim())
    if (match !== null && match[1].trim().length > 0) return clampSummary(match[1])
  }
  return fileName.replace(/\.md$/u, '').replace(/[-_]+/gu, ' ')
}

/**
 * Derive a one-line summary from a note head.
 * @param head - first bytes of the note.
 * @returns the first body line, stripped of markdown.
 */
function summaryFromHead(head: string): string {
  for (const line of head.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) continue
    return clampSummary(trimmed)
  }
  return ''
}

/**
 * Turn a note title into a flat file name.
 * @param title - note title.
 * @returns a `.md` file name safe on the local filesystem.
 */
export function slugForTitle(title: string): string {
  const base = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '')
  return `${base.length > 0 ? base : 'memory'}.md`
}

/**
 * Read one project's effective index, reconciled against its directory.
 * @param dir - absolute memory directory.
 * @returns index entries in index order, then unindexed files by name.
 */
export async function loadIndex(dir: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []
  const seen = new Set<string>()
  const indexText = await readTextIfExists(path.join(dir, INDEX_FILE))
  if (indexText !== undefined) {
    for (const line of indexText.split(/\r?\n/u)) {
      const match = ENTRY_PATTERN.exec(line)
      if (match === null) continue
      const file = match[2]
      if (!isTopicFileName(file) || seen.has(file)) continue
      if (!existsSync(path.join(dir, file))) continue
      seen.add(file)
      entries.push({ title: match[1].trim() || file.replace(/\.md$/u, ''), file, summary: oneLine(match[3] ?? ''), indexed: true })
    }
  }
  for (const file of await listTopicFiles(dir)) {
    if (seen.has(file)) continue
    const head = await readHead(path.join(dir, file))
    entries.push({ title: titleFromHead(head, file), file, summary: summaryFromHead(head), indexed: false })
  }
  return entries
}

/**
 * Load an index through a short-lived cache.
 *
 * `agent/pre-step` runs once per model step, so a turn with several steps would
 * otherwise re-read every note head each time. Mutations invalidate the entry
 * explicitly; external edits become visible after the TTL.
 * @param dir - absolute memory directory.
 * @returns the reconciled entries.
 */
export async function loadIndexCached(dir: string): Promise<MemoryEntry[]> {
  const key = path.resolve(dir)
  const hit = indexCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < INDEX_CACHE_TTL_MS) return hit.entries
  const entries = await loadIndex(dir)
  if (indexCache.size >= INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value
    if (oldest !== undefined) indexCache.delete(oldest)
  }
  indexCache.set(key, { entries, at: Date.now() })
  return entries
}

/**
 * Drop one directory's cached index, or clear the whole cache.
 * @param dir - memory directory; omit to clear every entry.
 */
export function invalidateIndexCache(dir?: string): void {
  if (dir === undefined) indexCache.clear()
  else indexCache.delete(path.resolve(dir))
}

async function readHead(file: string): Promise<string> {
  try {
    return (await readBoundedText(file, HEAD_BYTES)).text
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return ''
    throw error
  }
}

/** Read at most `maxBytes` of a file without buffering the rest. */
async function readBoundedText(file: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    const length = Math.min(Math.max(info.size, 0), maxBytes)
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, 0)
    // Stream mode holds back an incomplete trailing code point instead of
    // emitting U+FFFD when the byte budget lands inside a character.
    const text = length === 0 ? '' : new TextDecoder('utf-8', { fatal: false }).decode(buffer, { stream: true })
    return { text, bytes: info.size, truncated: info.size > maxBytes }
  }
  finally {
    await handle.close()
  }
}

/**
 * Render index entries back to markdown.
 * @param entries - ordered entries.
 * @returns the complete `MEMORY.md` body.
 */
export function renderIndex(entries: readonly MemoryEntry[]): string {
  const lines = [
    '# Memory index',
    '',
    'One memory per line. Each file sits next to this index; open one with `memory_read`.',
    '',
  ]
  for (const entry of entries) {
    const label = oneLine(entry.title).replace(/[[\]]/gu, '')
    const file = entry.file.replace(/[)\s]/gu, '')
    const summary = oneLine(entry.summary).replace(/[—–]/gu, '-')
    lines.push(summary.length > 0 ? `- [${label}](${file}) — ${summary}` : `- [${label}](${file})`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Write one memory and keep its index line in sync.
 *
 * The whole index update runs under the store lock, so two sessions writing at
 * the same time cannot both read the old index and then overwrite each other's
 * line.
 * @param dir - absolute memory directory.
 * @param input - title, body, and optional file or summary.
 * @param options - optional duplicate-hint threshold.
 * @returns the stored entry, its path, the entries, and similar notes.
 */
export async function writeMemory(
  dir: string,
  input: WriteMemoryInput,
  options: WriteMemoryOptions = {},
): Promise<StoredMemory> {
  const title = oneLine(input.title)
  if (title.length === 0) throw new Error('memory_write requires a non-empty title')
  const body = String(input.content ?? '')
  if (body.trim().length === 0) throw new Error('memory_write requires non-empty content')
  const file = typeof input.file === 'string' && input.file.trim().length > 0
    ? input.file.trim()
    : slugForTitle(title)
  if (!isTopicFileName(file)) {
    throw new Error(`invalid memory file name: ${file}. Use a flat name ending in .md, without path separators, and never ${INDEX_FILE}.`)
  }
  const target = assertContained(dir, file)
  const summary = typeof input.summary === 'string' && input.summary.trim().length > 0
    ? clampSummary(input.summary)
    : summaryFromHead(body)
  const text = body.trimStart().startsWith('#') ? ensureTrailingNewline(body) : `# ${title}\n\n${ensureTrailingNewline(body)}`
  return withStoreLock(dir, async () => {
    await mkdir(dir, { recursive: true })
    await atomicWrite(target, text)
    const entries = await loadIndex(dir)
    const entry: MemoryEntry = { title, file, summary, indexed: true }
    const position = entries.findIndex(candidate => candidate.file === file)
    if (position >= 0) entries[position] = entry
    else entries.unshift(entry)
    await atomicWrite(path.join(dir, INDEX_FILE), renderIndex(entries))
    invalidateIndexCache(dir)
    const similar = similarEntries(entries, file, options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD)
    return { entry, path: target, entries, similar }
  })
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** Move one note into `archive/` and return its absolute path. */
async function archiveLocked(dir: string, file: string, _reason: ArchiveReason): Promise<string> {
  const archiveDir = path.join(dir, ARCHIVE_DIR)
  await mkdir(archiveDir, { recursive: true })
  const archivePath = resolveArchivePath(dir, archiveFileName(file))
  await rename(assertContained(dir, file), archivePath)
  await rememberArchive(dir, path.basename(archivePath), file)
  return archivePath
}

/**
 * Delete one memory and its index line.
 *
 * The default is a soft delete: the note moves to `archive/` and can be
 * restored by moving it back. Pass `permanent: true` to remove the file.
 * @param dir - absolute memory directory.
 * @param file - flat topic file name.
 * @param options - permanent flag and archive reason.
 * @returns the remaining entries and whether the note was archived.
 */
export async function deleteMemory(
  dir: string,
  file: string,
  options: DeleteMemoryOptions = {},
): Promise<DeleteMemoryResult> {
  if (!isTopicFileName(file)) throw new Error(`invalid memory file name: ${file}`)
  return withStoreLock(dir, async () => {
    const target = assertContained(dir, file)
    if (options.permanent === true) {
      await rm(target, { force: true })
      const entries = (await loadIndex(dir)).filter(entry => entry.file !== file)
      await atomicWrite(path.join(dir, INDEX_FILE), renderIndex(entries))
      invalidateIndexCache(dir)
      return { entries, archived: false }
    }
    const archivePath = await archiveLocked(dir, file, options.reason ?? 'manual')
    const entries = (await loadIndex(dir)).filter(entry => entry.file !== file)
    await atomicWrite(path.join(dir, INDEX_FILE), renderIndex(entries))
    invalidateIndexCache(dir)
    return { entries, archived: true, archivePath }
  })
}

/**
 * Restore one generated archive file to the top level.
 *
 * The archive name carries the original file name, so no manifest is needed.
 * A collision with an existing topic file is refused rather than overwritten.
 * @param dir - absolute memory directory.
 * @param archiveName - generated archive file name.
 * @returns the restored file name and the rebuilt index entries.
 */
export async function restoreMemory(dir: string, archiveName: string): Promise<RestoreMemoryResult> {
  if (!isArchiveFileName(archiveName)) throw new Error(`invalid archive file name: ${archiveName}`)
  return withStoreLock(dir, async () => {
    const manifest = await readArchiveManifest(dir)
    const original = manifest[archiveName] ?? originalNameOf(archiveName)
    if (original === undefined) throw new Error(`archive name does not name a valid topic file: ${archiveName}`)
    const source = resolveArchivePath(dir, archiveName)
    const target = assertContained(dir, original)
    if (existsSync(target)) throw new Error(`cannot restore ${archiveName}: ${original} already exists`)
    await rename(source, target)
    await forgetArchive(dir, archiveName)
    const entries = await loadIndex(dir)
    await atomicWrite(path.join(dir, INDEX_FILE), renderIndex(entries))
    invalidateIndexCache(dir)
    return { file: original, entries }
  })
}

/**
 * Read one memory, bounded.
 * @param dir - absolute memory directory.
 * @param file - flat topic file name.
 * @param maxBytes - maximum bytes returned.
 * @returns the content and whether it was cut.
 */
export async function readMemory(dir: string, file: string, maxBytes: number): Promise<ReadMemoryResult> {
  if (!isTopicFileName(file)) throw new Error(`invalid memory file name: ${file}`)
  const target = assertContained(dir, file)
  const bounded = await readBoundedText(target, maxBytes)
  return {
    file,
    path: target,
    bytes: bounded.bytes,
    truncated: bounded.truncated,
    content: bounded.text,
  }
}

/**
 * Search note contents for a literal query.
 *
 * Line-level, case-insensitive matching keeps results small and attributable.
 * Every whitespace-separated token must appear on the line.
 * @param dir - absolute memory directory.
 * @param query - user or model supplied search text.
 * @param options - result and scan limits.
 * @returns matched lines and whether the result was cut.
 */
export async function searchMemory(dir: string, query: string, options: SearchOptions): Promise<SearchResult> {
  const tokens = oneLine(query).toLowerCase().split(/\s+/u).filter(token => token.length > 0)
  if (tokens.length === 0) throw new Error('memory_search requires a non-empty query')
  const matches: MemoryMatch[] = []
  let truncated = false
  let scannedBytes = 0
  for (const file of await listTopicFiles(dir)) {
    if (matches.length >= options.limit) {
      truncated = true
      break
    }
    let content: string
    try {
      content = await readFile(path.join(dir, file), 'utf8')
    }
    catch (error) {
      if (hasErrnoCode(error, 'ENOENT')) continue
      throw error
    }
    scannedBytes += Buffer.byteLength(content, 'utf8')
    if (scannedBytes > options.maxBytes) {
      truncated = true
      break
    }
    const lines = content.split(/\r?\n/u)
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase()
      if (!tokens.every(token => lower.includes(token))) continue
      const text = lines[index].trim()
      if (text.length === 0) continue
      if (matches.length >= options.limit) {
        truncated = true
        break
      }
      matches.push({ file, line: index + 1, text: text.length > 240 ? `${text.slice(0, 239)}…` : text })
    }
  }
  return { matches, truncated }
}
