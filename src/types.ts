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

/** Result of one successful write. */
export interface StoredMemory {
  entry: MemoryEntry
  path: string
  entries: MemoryEntry[]
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
