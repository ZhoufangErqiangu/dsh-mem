/**
 * Markdown memory store: one index plus one file per memory.
 *
 * `MEMORY.md` is only an index; the topic files are the truth. Reading the index
 * therefore reconciles it against the directory, so a hand-added, hand-edited, or
 * hand-deleted file behaves sensibly without a migration step.
 *
 * @module @local/dsh-memory/store
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { INDEX_FILE, assertContained, isTopicFileName } from './paths.ts'
import type {
  MemoryEntry,
  MemoryMatch,
  ReadMemoryResult,
  SearchOptions,
  SearchResult,
  StoredMemory,
  WriteMemoryInput,
} from './types.ts'

/** One index line: `- [Title](file.md) — summary`. */
const ENTRY_PATTERN = /^\s*[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)(?:\s+[—–-]\s*(.*))?$/

/** Bound for one summary derived from note content. */
const SUMMARY_MAX_CHARS = 160

/** Bound for the head of a file inspected to derive an index line. */
const HEAD_BYTES = 4096

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
      entries.push({ title: match[1].trim() || file.replace(/\.md$/u, ''), file, summary: oneLine(match[3] ?? '') })
    }
  }
  for (const file of await listTopicFiles(dir)) {
    if (seen.has(file)) continue
    const head = await readHead(path.join(dir, file))
    entries.push({ title: titleFromHead(head, file), file, summary: summaryFromHead(head) })
  }
  return entries
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
    return { text: buffer.toString('utf8'), bytes: info.size, truncated: info.size > maxBytes }
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

/** Publish one file atomically so a crash cannot leave a half-written index. */
async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, file)
  }
  catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Write one memory and keep its index line in sync.
 * @param dir - absolute memory directory.
 * @param input - title, body, and optional file or summary.
 * @returns the stored entry, its complete path, and the remaining entries.
 */
export async function writeMemory(dir: string, input: WriteMemoryInput): Promise<StoredMemory> {
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
  await mkdir(dir, { recursive: true })
  await atomicWrite(target, text)
  const entries = await loadIndex(dir)
  const entry: MemoryEntry = { title, file, summary }
  const position = entries.findIndex(candidate => candidate.file === file)
  if (position >= 0) entries[position] = entry
  else entries.unshift(entry)
  await atomicWrite(path.join(dir, INDEX_FILE), renderIndex(entries))
  return { entry, path: target, entries }
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Delete one memory and its index line.
 * @param dir - absolute memory directory.
 * @param file - flat topic file name.
 * @returns the remaining entries.
 */
export async function deleteMemory(dir: string, file: string): Promise<MemoryEntry[]> {
  if (!isTopicFileName(file)) throw new Error(`invalid memory file name: ${file}`)
  const target = assertContained(dir, file)
  await rm(target, { force: true })
  const entries = (await loadIndex(dir)).filter(entry => entry.file !== file)
  await atomicWrite(path.join(dir, INDEX_FILE), renderIndex(entries))
  return entries
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
    scannedBytes += content.length
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
