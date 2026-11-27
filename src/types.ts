/**
 * Shared value types for the memory store, plus the type-only DSH API surface
 * this plugin programs against.
 *
 * DSH packages are build-only devDependencies pinned to the Harness version
 * used for the build. They are imported with `import type` — the side-effect
 * imports below only load declaration merging — so `lib/` carries no runtime
 * import of any `@deepseek-ai` package: the Host ships those packages.
 *
 * @module @local/dsh-memory/types
 */

// Load the Host declarations that merge into the Cordis `Context`: `tools`,
// `workingDirectory`, `agents`, and `connection`.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

export type { Context } from '@deepseek-ai/cordis'
export type { Agent } from '@deepseek-ai/dsh-agent'
export type { Session, SessionId } from '@deepseek-ai/dsh-session'
export type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
export type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** One line of the project memory index. */
export interface MemoryEntry {
  /** Index label. */
  title: string
  /** Flat topic file name, such as `testing-conventions.md`. */
  file: string
  /** One-line index summary; empty when the note has no body line. */
  summary: string
  /** Whether `MEMORY.md` names this file; a hand-added file is `false`. */
  indexed?: boolean
}

/** One existing note that resembles a note being written. */
export interface SimilarNote {
  file: string
  title: string
  /** Normalized title/summary similarity in `[0, 1]`. */
  score: number
}

/** One matching note line. */
export interface MemoryMatch {
  file: string
  line: number
  text: string
}

/** Resolved row configuration plus the process-owned harness home. */
export interface Settings {
  maxIndexLines: number
  maxIndexBytes: number
  maxTopicBytes: number
  maxSearchResults: number
  maxSearchBytes: number
  /** Notes older than this many days are reported as stale. */
  staleDays: number
  /** Title/summary similarity at or above which notes are reported as duplicates. */
  duplicateThreshold: number
  /** Notes at or above this byte size are reported as oversized. */
  oversizeBytes: number
  /** Upper bound on notes inspected by one audit. */
  maxAuditNotes: number
  home: string
}

/** One project's memory scope. */
export interface ProjectScope {
  /** Absolute project root, derived from the session working directory. */
  projectRoot: string
  /** Absolute memory directory owned by that root. */
  memoryDir: string
}

/** Rendered memory context plus the digest used to decide re-injection. */
export interface RenderedMemory extends ProjectScope {
  entries: MemoryEntry[]
  text: string
  digest: string
}

/** Arguments accepted by {@link writeMemory}. */
export interface WriteMemoryInput {
  title: string
  content: string
  file?: string
  summary?: string
}

/** Optional limits for one write. */
export interface WriteMemoryOptions {
  /** Similarity at or above which a note is returned in `similar`. */
  duplicateThreshold?: number
}

/** Result of one successful write. */
export interface StoredMemory {
  entry: MemoryEntry
  path: string
  entries: MemoryEntry[]
  /** Existing notes that resemble the written one. */
  similar: SimilarNote[]
}

/** Why a note was archived. */
export type ArchiveReason = 'manual' | 'duplicate' | 'empty' | 'overflow'

/** Options for {@link deleteMemory}. */
export interface DeleteMemoryOptions {
  /** Remove the file instead of archiving it. Defaults to `false`. */
  permanent?: boolean
  /** Recorded reason for an archive (reserved for the manifest). */
  reason?: ArchiveReason
}

/** Result of one delete. */
export interface DeleteMemoryResult {
  entries: MemoryEntry[]
  /** Whether the file was moved under `archive/`. */
  archived: boolean
  /** Absolute archive path when `archived` is true. */
  archivePath?: string
}

/** One note with filesystem metadata, used by the audit report. */
export interface NoteInfo extends MemoryEntry {
  bytes: number
  lines: number
  /** Filesystem modification time in epoch milliseconds. */
  updatedAt: number
}

/** How two notes are related. */
export type DuplicateKind = 'identical' | 'near' | 'same-title'

/** One cluster of related notes. */
export interface DuplicateGroup {
  kind: DuplicateKind
  score: number
  files: string[]
  titles: string[]
}

/** Options for {@link auditMemory}. */
export interface AuditOptions {
  staleDays: number
  threshold: number
  limit: number
  verbose: boolean
  maxNotes: number
  maxIndexLines: number
  maxIndexBytes: number
  oversizeBytes: number
}

/** One audit report. */
export interface AuditReport {
  dir: string
  projectRoot: string
  notes: number
  bytes: number
  truncated: boolean
  budget: {
    maxLines: number
    maxBytes: number
    usedLines: number
    usedBytes: number
    omitted: number
    overBudget: boolean
  }
  duplicates: DuplicateGroup[]
  stale: Array<{ file: string; title: string; ageDays: number; bytes: number }>
  oversized: Array<{ file: string; title: string; bytes: number; lines: number }>
  notesList: NoteInfo[]
}

/** Result of one bounded read. */
export interface ReadMemoryResult {
  file: string
  path: string
  content: string
  bytes: number
  truncated: boolean
}

/** Limits for one search. */
export interface SearchOptions {
  limit: number
  maxBytes: number
}

/** Result of one search. */
export interface SearchResult {
  matches: MemoryMatch[]
  truncated: boolean
}

/** Inputs to {@link renderMemoryContext}. */
export interface RenderMemoryContextInput {
  projectRoot: string
  entries: readonly MemoryEntry[]
  maxIndexLines: number
  maxIndexBytes: number
}

/** One named contribution of the injected snapshot. */
export interface MemoryContextSection {
  name: string
  text: string
}

/** Source recorded on the injected memory message. */
export interface MemoryMessageSource {
  kind: 'memory'
  form: 'snapshot'
  sections: readonly MemoryContextSection[]
  /** Digest of the rendered text, used to detect a stale delivery. */
  memoryDigest: string
  projectRoot: string
  memoryDir: string
  /** Number of index entries in the rendered context. */
  entryCount: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Per-session project memory index injected by this plugin. */
    memory: MemoryMessageSource
  }
}
