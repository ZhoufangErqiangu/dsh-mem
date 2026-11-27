/**
 * Cheap, local similarity for duplicate detection.
 *
 * Two kinds of comparison share one tokenizer:
 * - write-time hints compare title and summary only, so every write stays
 *   O(notes) with no extra file reads;
 * - the audit compares title/summary plus a body head, and treats notes with
 *   equal normalized bodies as exact duplicates.
 *
 * Latin words are whitespace-delimited; CJK runs are split into single
 * characters and bigrams because they have no spaces.
 *
 * @module @local/dsh-memory/similarity
 */

import { createHash } from 'node:crypto'
import type { MemoryEntry, SimilarNote } from './types.ts'

/** Scripts written without spaces, compared as character bigrams. */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/** Words in spaced scripts. */
const WORD = /[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}_-]*/gu

/** Normalize a note body before hashing or comparing. */
export function normalizeBody(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * Hash one normalized body.
 * @param text - note body.
 * @returns stable SHA-256 hex digest.
 */
export function digestBody(text: string): string {
  return createHash('sha256').update(normalizeBody(text)).digest('hex')
}

/**
 * Turn text into a comparison set.
 * @param text - title, summary, or body head.
 * @returns lowercase words plus CJK single characters and bigrams.
 */
export function tokensOf(text: string): Set<string> {
  const stripped = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
  const tokens = new Set<string>()
  for (const run of stripped.match(CJK_RUN) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let index = 0; index + 1 < run.length; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  for (const word of stripped.replace(CJK_RUN, ' ').match(WORD) ?? []) {
    if (word.length > 1) tokens.add(word)
  }
  return tokens
}

/**
 * Jaccard similarity of two token sets.
 * @param left - first set.
 * @param right - second set.
 * @returns value in `[0, 1]`; `0` when both sets are empty.
 */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0
  let intersection = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const token of small) {
    if (large.has(token)) intersection += 1
  }
  return intersection / (left.size + right.size - intersection)
}

/**
 * Similarity of two index entries, using title and summary only.
 * @param left - one entry.
 * @param right - another entry.
 * @returns value in `[0, 1]`.
 */
export function entrySimilarity(left: MemoryEntry, right: MemoryEntry): number {
  return jaccard(
    tokensOf(`${left.title} ${left.summary}`),
    tokensOf(`${right.title} ${right.summary}`),
  )
}

/**
 * Find existing notes that resemble one file's entry.
 * @param entries - current index entries.
 * @param file - file being written; excluded from the result.
 * @param threshold - minimum similarity.
 * @param limit - maximum hints returned.
 * @returns the highest-scoring notes, at most `limit`.
 */
export function similarEntries(
  entries: readonly MemoryEntry[],
  file: string,
  threshold: number,
  limit = 3,
): SimilarNote[] {
  const target = entries.find(entry => entry.file === file)
  if (target === undefined) return []
  const targetTokens = tokensOf(`${target.title} ${target.summary}`)
  const found: SimilarNote[] = []
  for (const entry of entries) {
    if (entry.file === file) continue
    const score = jaccard(targetTokens, tokensOf(`${entry.title} ${entry.summary}`))
    if (score >= threshold) found.push({ file: entry.file, title: entry.title, score: Math.round(score * 100) / 100 })
  }
  found.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
  return found.slice(0, limit)
}
