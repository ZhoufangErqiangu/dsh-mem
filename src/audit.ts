/**
 * Read-only memory audit.
 *
 * The report answers the questions a curation pass needs before touching
 * anything: which notes are duplicates, which are stale or oversized, and
 * whether the rendered index is already over budget.
 *
 * Duplicate detection is deliberately local and deterministic: normalized
 * body hashes catch identical notes, and token Jaccard similarity catches
 * near-duplicates in English and CJK. Near-duplicates are only reported, never
 * merged automatically.
 *
 * @module @local/dsh-memory/audit
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { loadIndex } from './store.ts'
import { boundEntries } from './render.ts'
import { digestBody, jaccard, tokensOf } from './similarity.ts'
import type {
  AuditOptions,
  AuditReport,
  DuplicateGroup,
  DuplicateKind,
  MemoryEntry,
  NoteInfo,
} from './types.ts'

/** Milliseconds in one day. */
const DAY_MS = 86_400_000

/** Body head compared for near-duplicate detection. */
const BODY_HEAD_CHARS = 8_192

/** Line count at or above which a note is reported as oversized. */
const OVERSIZE_LINES = 400

/** Upper bound for one serialized report, so `verbose` cannot flood a turn. */
const MAX_REPORT_BYTES = 8_192

/** One note plus the bytes read for the report. */
interface LoadedNote {
  entry: MemoryEntry
  info: NoteInfo
  content?: string
}

/** Whether a thrown value is a filesystem error with one exact code. */
function hasErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
}

/** Load one note's metadata and body, tolerating a file deleted mid-audit. */
async function loadNote(dir: string, entry: MemoryEntry): Promise<LoadedNote | undefined> {
  const file = path.join(dir, entry.file)
  try {
    const info = await stat(file)
    if (!info.isFile()) return undefined
    const content = await readFile(file, 'utf8')
    return {
      entry,
      content,
      info: {
        ...entry,
        bytes: info.size,
        lines: content.length === 0 ? 0 : content.split(/\r?\n/u).length,
        updatedAt: info.mtimeMs,
        indexed: entry.indexed === true,
      },
    }
  }
  catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
}

/** Normalize a title for the same-title check. */
function normalizedTitle(title: string): string {
  return title.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

/** Precedence of duplicate kinds when one cluster has several relations. */
function kindRank(kind: DuplicateKind): number {
  switch (kind) {
    case 'identical': return 0
    case 'near': return 1
    case 'same-title': return 2
  }
}

/** One pair relation found during the pairwise pass. */
interface Relation {
  left: number
  right: number
  kind: DuplicateKind
  score: number
}

/** Build duplicate clusters from the audited notes. */
function duplicateGroups(notes: readonly LoadedNote[], threshold: number, limit: number): { groups: DuplicateGroup[]; truncated: boolean } {
  const parents = notes.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parents[root] !== root) root = parents[root]
    while (parents[index] !== index) {
      const next = parents[index]
      parents[index] = root
      index = next
    }
    return root
  }
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
  }
  const relations: Relation[] = []

  // Precompute every token set once: the pairwise pass below is O(n²) and must
  // not re-tokenize note bodies for each pair.
  const digests = notes.map(note => digestBody(note.content ?? ''))
  const titleTokens = notes.map(note => tokensOf(`${note.entry.title} ${note.entry.summary}`))
  const bodyTokens = notes.map(note => tokensOf((note.content ?? '').slice(0, BODY_HEAD_CHARS)))
  const titles = notes.map(note => normalizedTitle(note.entry.title))

  // Exact duplicates first: equal normalized bodies form a complete relation.
  const byDigest = new Map<string, number[]>()
  digests.forEach((digest, index) => {
    const group = byDigest.get(digest)
    if (group === undefined) byDigest.set(digest, [index])
    else group.push(index)
  })
  for (const group of byDigest.values()) {
    if (group.length < 2) continue
    for (let index = 1; index < group.length; index += 1) {
      relations.push({ left: group[0], right: group[index], kind: 'identical', score: 1 })
    }
  }

  // Near-duplicates and same-title pairs. Identical pairs are already covered.
  for (let left = 0; left < notes.length; left += 1) {
    for (let right = left + 1; right < notes.length; right += 1) {
      if (digests[left] === digests[right]) continue
      const titleScore = jaccard(titleTokens[left], titleTokens[right])
      const bodyScore = jaccard(bodyTokens[left], bodyTokens[right])
      const score = Math.max(titleScore, 0.8 * bodyScore)
      const sameTitle = titles[left] === titles[right]
      if (sameTitle) relations.push({ left, right, kind: 'same-title', score: Math.max(score, 0.5) })
      if (score >= threshold) relations.push({ left, right, kind: 'near', score })
    }
  }

  for (const relation of relations) union(relation.left, relation.right)

  const clusters = new Map<number, { indices: Set<number>; kind: DuplicateKind; score: number }>()
  for (const relation of relations) {
    const root = find(relation.left)
    const cluster = clusters.get(root) ?? { indices: new Set<number>(), kind: relation.kind, score: 0 }
    cluster.indices.add(relation.left)
    cluster.indices.add(relation.right)
    if (kindRank(relation.kind) < kindRank(cluster.kind)) cluster.kind = relation.kind
    cluster.score = Math.max(cluster.score, relation.score)
    clusters.set(root, cluster)
  }

  const groups: DuplicateGroup[] = []
  for (const cluster of clusters.values()) {
    const indices = [...cluster.indices].sort((left, right) => notes[left].entry.file.localeCompare(notes[right].entry.file))
    groups.push({
      kind: cluster.kind,
      score: Math.round(cluster.score * 100) / 100,
      files: indices.map(index => notes[index].entry.file),
      titles: indices.map(index => notes[index].entry.title),
    })
  }
  groups.sort((left, right) => kindRank(left.kind) - kindRank(right.kind) || right.score - left.score || left.files[0].localeCompare(right.files[0]))
  return { groups: groups.slice(0, limit), truncated: groups.length > limit }
}

/**
 * Inspect one project's memory without changing it.
 * @param dir - absolute memory directory.
 * @param projectRoot - absolute project root for the report.
 * @param options - thresholds, limits, and index budget.
 * @returns the bounded audit report.
 */
export async function auditMemory(dir: string, projectRoot: string, options: AuditOptions): Promise<AuditReport> {
  const entries = await loadIndex(dir)
  const loaded = (await Promise.all(entries.map(entry => loadNote(dir, entry))))
    .filter((note): note is LoadedNote => note !== undefined)
  const now = Date.now()
  const bytes = loaded.reduce((sum, note) => sum + note.info.bytes, 0)
  const byUpdated = [...loaded].sort((left, right) => right.info.updatedAt - left.info.updatedAt)
  const audited = byUpdated.slice(0, options.maxNotes)
  const duplicates = duplicateGroups(audited, options.threshold, options.limit)

  const staleAll = loaded
    .filter(note => now - note.info.updatedAt >= options.staleDays * DAY_MS)
    .sort((left, right) => left.info.updatedAt - right.info.updatedAt)
  const stale = staleAll.slice(0, options.limit).map(note => ({
    file: note.entry.file,
    title: note.entry.title,
    ageDays: Math.max(0, Math.floor((now - note.info.updatedAt) / DAY_MS)),
    bytes: note.info.bytes,
  }))

  const oversizedAll = loaded
    .filter(note => note.info.bytes > options.oversizeBytes || note.info.lines > OVERSIZE_LINES)
    .sort((left, right) => right.info.bytes - left.info.bytes)
  const oversized = oversizedAll.slice(0, options.limit).map(note => ({
    file: note.entry.file,
    title: note.entry.title,
    bytes: note.info.bytes,
    lines: note.info.lines,
  }))

  const bounded = boundEntries(entries, options.maxIndexLines, options.maxIndexBytes)
  const usedBytes = bounded.lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  const notesList = options.verbose ? byUpdated.slice(0, options.maxNotes).map(note => note.info) : []

  const report: AuditReport = {
    dir,
    projectRoot,
    notes: loaded.length,
    bytes,
    truncated: loaded.length > options.maxNotes || duplicates.truncated || staleAll.length > options.limit || oversizedAll.length > options.limit,
    budget: {
      maxLines: options.maxIndexLines,
      maxBytes: options.maxIndexBytes,
      usedLines: bounded.lines.length,
      usedBytes,
      omitted: bounded.omitted,
      overBudget: bounded.omitted > 0,
    },
    duplicates: duplicates.groups,
    stale,
    oversized,
    notesList,
  }

  // `verbose` is a convenience, not a license to flood the turn: trim the note
  // list until the serialized report fits the same budget as the injected index.
  while (report.notesList.length > 0 && Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_REPORT_BYTES) {
    report.notesList.pop()
    report.truncated = true
  }
  return report
}
