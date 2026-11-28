/**
 * `@local/dsh-memory` — durable, file-based memory for DSH agents.
 *
 * Each session receives the project's `MEMORY.md` index as one injected context
 * message, plus the smaller user-global index when it has notes. Eight tools
 * maintain the store: `memory_write`, `memory_read`, `memory_search`,
 * `memory_delete`, `memory_audit`, `memory_sweep`, `memory_restore`, and
 * `memory_dream`. Files live under `<harness home>/memory/<scope>/` as plain
 * markdown, so they are inspectable, editable, and never mixed into the
 * repository.
 *
 * @module @local/dsh-memory
 */

import { createHash, randomUUID } from 'node:crypto'
import { auditMemory } from './audit.ts'
import { runDream } from './dream.ts'
import { tryAcquireCurationLock } from './lock.ts'
import { finishCuration, markSession } from './state.ts'
import { deleteMemory, loadIndex, loadIndexCached, readMemory, restoreMemory, searchMemory, writeMemory } from './store.ts'
import { sweepMemory } from './sweep.ts'
import { dshHome, findProjectRoot, globalMemoryDir, memoryDir } from './paths.ts'
import { renderEntry, renderMemoryContext } from './render.ts'
import type {
  Agent,
  AuditReport,
  Context,
  ContentBlock,
  DeleteMemoryResult,
  DreamResult,
  MemoryEntry,
  MemoryMatch,
  MemoryMessageSource,
  MemoryScope,
  ProjectScope,
  ReadMemoryResult,
  RenderedMemory,
  RestoreMemoryResult,
  Session,
  SessionId,
  Settings,
  SimilarNote,
  StoredMemory,
  SweepReport,
  ToolDefinition,
  ToolRunContext,
  UserMessage,
} from './types.ts'

/** Plugin name, also the injected message's source kind. */
export const name = 'memory'

/** Services this plugin needs to resolve a session working directory and register tools. */
export const inject = ['tools', 'workingDirectory']

const DEFAULT_MAX_INDEX_LINES = 200
const DEFAULT_MAX_INDEX_BYTES = 25_000
const DEFAULT_GLOBAL_MEMORY_ENABLED = true
const DEFAULT_MAX_GLOBAL_INDEX_LINES = 40
const DEFAULT_MAX_GLOBAL_INDEX_BYTES = 6_000
const DEFAULT_MAX_TOPIC_BYTES = 65_536
const DEFAULT_MAX_SEARCH_RESULTS = 20
const DEFAULT_MAX_SEARCH_BYTES = 4 * 1024 * 1024
const DEFAULT_STALE_DAYS = 90
const DEFAULT_DUPLICATE_THRESHOLD = 0.6
const DEFAULT_OVERSIZE_BYTES = 16_384
const DEFAULT_MAX_AUDIT_NOTES = 200
const DEFAULT_ARCHIVE_OVERFLOW = false
const DEFAULT_ARCHIVE_MAX_AGE_DAYS = 30
const DEFAULT_CURATION_ENABLED = false
const DEFAULT_CURATION_MIN_HOURS = 24
const DEFAULT_CURATION_MIN_SESSIONS = 5
const DEFAULT_CURATION_RETRY_HOURS = 1
const DEFAULT_CURATION_TIMEOUT_MS = 600_000
const DEFAULT_CURATION_MAX_TOKENS = 4_096

/** Canonical value of one successful `memory_write`. */
export interface MemoryWriteOutput {
  file: string
  path: string
  line: string
  entries: number
  similar: SimilarNote[]
  scope: MemoryScope
}

/** Canonical value of one `memory_read`. */
export interface MemoryReadOutput extends ReadMemoryResult {
  scope: MemoryScope
}

/** Canonical value of one `memory_search`. */
export interface MemorySearchOutput {
  matches: MemoryMatch[]
  truncated: boolean
}

/** Canonical value of one `memory_delete`. */
export interface MemoryDeleteOutput {
  file: string
  archived: boolean
  archivePath: string
  entries: number
  scope: MemoryScope
}

/** Canonical value of one `memory_audit`. */
export type MemoryAuditOutput = AuditReport

/** Canonical value of one `memory_sweep`. */
export type MemorySweepOutput = SweepReport

/** Canonical value of one `memory_restore`. */
export interface MemoryRestoreOutput {
  file: string
  entries: RestoreMemoryResult['entries']
  scope: MemoryScope
}

/** Narrow untrusted tool arguments to a string-keyed record. */
function recordOf(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' ? args as Record<string, unknown> : {}
}

/** Read one optional string field from untrusted arguments. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read the errno code of a thrown filesystem error. */
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined
}

function boundedInteger(value: unknown, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : fallback
}

/** Read one optional number inside a closed range. */
function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback
}

function normalizeSettings(config?: unknown): Settings {
  const row = recordOf(config)
  return {
    maxIndexLines: boundedInteger(row.maxIndexLines, DEFAULT_MAX_INDEX_LINES, 0),
    maxIndexBytes: boundedInteger(row.maxIndexBytes, DEFAULT_MAX_INDEX_BYTES, 0),
    globalMemoryEnabled: typeof row.globalMemoryEnabled === 'boolean' ? row.globalMemoryEnabled : DEFAULT_GLOBAL_MEMORY_ENABLED,
    maxGlobalIndexLines: boundedInteger(row.maxGlobalIndexLines, DEFAULT_MAX_GLOBAL_INDEX_LINES, 0),
    maxGlobalIndexBytes: boundedInteger(row.maxGlobalIndexBytes, DEFAULT_MAX_GLOBAL_INDEX_BYTES, 0),
    maxTopicBytes: boundedInteger(row.maxTopicBytes, DEFAULT_MAX_TOPIC_BYTES, 256),
    maxSearchResults: boundedInteger(row.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS, 1),
    maxSearchBytes: boundedInteger(row.maxSearchBytes, DEFAULT_MAX_SEARCH_BYTES, 1024),
    staleDays: boundedInteger(row.staleDays, DEFAULT_STALE_DAYS, 1),
    duplicateThreshold: boundedNumber(row.duplicateThreshold, DEFAULT_DUPLICATE_THRESHOLD, 0.3, 0.95),
    oversizeBytes: boundedInteger(row.oversizeBytes, DEFAULT_OVERSIZE_BYTES, 1024),
    maxAuditNotes: Math.min(boundedInteger(row.maxAuditNotes, DEFAULT_MAX_AUDIT_NOTES, 1), 1000),
    archiveOverflow: row.archiveOverflow === true,
    archiveMaxAgeDays: boundedInteger(row.archiveMaxAgeDays, DEFAULT_ARCHIVE_MAX_AGE_DAYS, 0),
    curationEnabled: row.curationEnabled === true,
    curationMinHours: boundedInteger(row.curationMinHours, DEFAULT_CURATION_MIN_HOURS, 1),
    curationMinSessions: boundedInteger(row.curationMinSessions, DEFAULT_CURATION_MIN_SESSIONS, 1),
    curationRetryHours: boundedInteger(row.curationRetryHours, DEFAULT_CURATION_RETRY_HOURS, 1),
    curationTimeoutMs: boundedInteger(row.curationTimeoutMs, DEFAULT_CURATION_TIMEOUT_MS, 30_000),
    curationProvider: stringOf(row.curationProvider)?.trim() ?? '',
    curationModel: stringOf(row.curationModel)?.trim() ?? '',
    curationMaxTokens: boundedInteger(row.curationMaxTokens, DEFAULT_CURATION_MAX_TOKENS, 256),
    home: dshHome(),
  }
}

function digestOf(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** The most recent memory context visible to this agent's session, if any. */
function visibleMemoryDigest(agent: Agent): string | undefined {
  try {
    const session = agent.session
    const nodes = session.surface.nodes
    if (nodes.length === 0) return undefined
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.eventAt(nodes[index])
      if (event?.type !== 'user/message') continue
      const source = event.data.source
      if (source.kind !== name) continue
      return source.memoryDigest
    }
  }
  catch {
    // An unexpected surface shape only means the session re-injects once.
  }
  return undefined
}

function createMemoryMessage(
  text: string,
  details: {
    digest: string
    projectRoot: string
    memoryDir: string
    entries: readonly MemoryEntry[]
    globalEntries?: readonly MemoryEntry[]
    globalMemoryDir?: string
  },
): UserMessage {
  const source: MemoryMessageSource = {
    kind: name,
    form: 'snapshot',
    sections: [{ name, text }],
    memoryDigest: details.digest,
    projectRoot: details.projectRoot,
    memoryDir: details.memoryDir,
    entryCount: details.entries.length,
    ...(details.globalMemoryDir === undefined ? {} : {
      globalMemoryDir: details.globalMemoryDir,
      globalEntryCount: details.globalEntries?.length ?? 0,
    }),
  }
  const content: ContentBlock[] = [{ type: 'text', text }]
  return {
    id: randomUUID() as UserMessage['id'],
    role: 'user',
    content,
    source,
  }
}

/**
 * Register the memory tools and the per-session index injection.
 * @param ctx - Host plugin context.
 * @param config - loader row configuration.
 */
export function apply(ctx: Context, config?: unknown): void {
  const settings = normalizeSettings(config)
  /** Digest of the context already delivered to a session, keyed by session. */
  const delivered = new WeakMap<Session, { digest: string; turn: number }>()
  /**
   * Digest the session already knows without an injection: either it was just
   * injected or the model wrote it. Own writes must not re-inject the whole
   * index, because the tool result already carries the updated index line.
   */
  const acknowledged = new WeakMap<Session, string>()
  /** Sessions owned by a curation pass; they never trigger or receive another. */
  const dreamSessions = new Set<SessionId>()
  /** Whether a tool call runs inside a curation child. */
  const isDreamSession = (exec: ToolRunContext): boolean => (
    exec.agent !== undefined && dreamSessions.has(exec.agent.session.header.id)
  )
  /** Curation children are project-only; they must never touch global memory. */
  const rejectGlobalInDream = (scope: MemoryScope, exec: ToolRunContext): void => {
    if (scope === 'global' && isDreamSession(exec)) {
      throw new Error('curation sessions may only use project memory; scope: global is not allowed')
    }
  }
  /** Sessions already counted toward the Auto Dream gate. */
  const countedSessions = new WeakSet<Session>()
  /** Set while the `agents` service is available and curation is enabled. */
  let triggerCuration: ((agent: Agent) => void) | undefined

  /** Resolve the project and its memory directory for one agent. */
  const projectFor = async (agent: Agent, signal?: AbortSignal): Promise<ProjectScope> => {
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const projectRoot = findProjectRoot(cwd)
    return { projectRoot, memoryDir: memoryDir(projectRoot, settings.home) }
  }

  /** Absolute user-global memory directory, whether or not the layer is enabled. */
  const globalDir = (): string => globalMemoryDir(settings.home)

  /** Narrow an untrusted `scope` argument; the default is the project layer. */
  const scopeOf = (value: unknown): MemoryScope => {
    if (value === undefined || value === null) return 'project'
    if (value === 'project' || value === 'global') return value
    throw new Error(`unknown memory scope: ${String(value)}; expected "project" or "global"`)
  }

  /** Reject a global call while the layer is disabled. */
  const requireGlobal = (): void => {
    if (!settings.globalMemoryEnabled) throw new Error('global memory is disabled; set globalMemoryEnabled to true to use scope: global')
  }

  /** Load the global index, or nothing while the layer is disabled. */
  const loadGlobal = async (): Promise<MemoryEntry[]> => (
    settings.globalMemoryEnabled ? loadIndexCached(globalDir()) : []
  )

  const renderFor = (
    projectRoot: string,
    entries: readonly MemoryEntry[],
    globalEntries: readonly MemoryEntry[],
  ): {
    entries: MemoryEntry[]
    globalEntries: MemoryEntry[]
    globalEntryCount: number
    globalMemoryDir: string
    text: string
    digest: string
  } => {
    const text = renderMemoryContext({
      projectRoot,
      entries,
      maxIndexLines: settings.maxIndexLines,
      maxIndexBytes: settings.maxIndexBytes,
      ...(settings.globalMemoryEnabled ? {
        globalEntries,
        maxGlobalIndexLines: settings.maxGlobalIndexLines,
        maxGlobalIndexBytes: settings.maxGlobalIndexBytes,
      } : {}),
    })
    return {
      entries: [...entries],
      globalEntries: [...globalEntries],
      globalEntryCount: globalEntries.length,
      globalMemoryDir: globalDir(),
      text,
      digest: digestOf(text),
    }
  }

  const contextFor = async (agent: Agent, signal?: AbortSignal): Promise<RenderedMemory> => {
    const project = await projectFor(agent, signal)
    const [entries, globalEntries] = await Promise.all([
      loadIndexCached(project.memoryDir),
      loadGlobal(),
    ])
    return { ...project, ...renderFor(project.projectRoot, entries, globalEntries) }
  }

  const writeTool: ToolDefinition = {
    name: 'memory_write',
    description: 'Save one durable note. Creates or updates a topic file and its one-line entry in the memory index, so a later session can recall it. The default scope is this project; use scope: "global" only for user preferences that should apply in every project. Do not save secrets, credentials, or material that is cheap to re-read from the repository.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'content'],
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the note; also its index label.',
        },
        content: {
          type: 'string',
          description: 'Markdown body of the note. Keep it short and self-contained: what was learned, why it matters, and what to do next time. Write with markdown escapes, not raw markdown.',
        },
        file: {
          type: 'string',
          description: 'Optional topic file name ending in .md; derived from the title when omitted. Reusing a name updates that note.',
        },
        summary: {
          type: 'string',
          description: 'Optional one-line index summary; derived from the first content line when omitted.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Which layer to write. Defaults to project. Global notes apply across projects and should hold preferences, not project facts.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'path', 'line', 'entries', 'similar', 'scope'],
        properties: {
          file: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'string' },
          entries: { type: 'integer' },
          scope: { type: 'string', enum: ['project', 'global'] },
          similar: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'title', 'score'],
              properties: {
                file: { type: 'string' },
                title: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemoryWriteOutput
        const label = output.scope === 'global' ? 'global memory' : 'project memory'
        const lines = [`Saved ${output.file} to ${label} (${output.entries} memories indexed, under ${output.path}).`, output.line]
        if (Array.isArray(output.similar) && output.similar.length > 0) {
          lines.push(`Similar existing notes: ${output.similar.map(note => `${note.file} (${Math.round(note.score * 100)}%)`).join(', ')}. Consider merging instead of adding a new note.`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_write requires an agent session')
      const row = recordOf(args)
      const scope = scopeOf(row.scope)
      if (scope === 'global') {
        requireGlobal()
        rejectGlobalInDream(scope, exec)
      }
      const project = await projectFor(exec.agent, exec.signal)
      const file = stringOf(row.file)
      const summary = stringOf(row.summary)
      const stored: StoredMemory = await writeMemory(scope === 'global' ? globalDir() : project.memoryDir, {
        title: stringOf(row.title) ?? '',
        content: stringOf(row.content) ?? '',
        ...(file === undefined ? {} : { file }),
        ...(summary === undefined ? {} : { summary }),
      }, { duplicateThreshold: settings.duplicateThreshold })
      // The write is the only change this session knows about; the tool result
      // already names the new index line, so the next step need not repeat the
      // whole index. An outside change still differs from this digest.
      const projectEntries = scope === 'project' ? stored.entries : await loadIndexCached(project.memoryDir)
      const globalEntries = scope === 'global' ? stored.entries : await loadGlobal()
      acknowledged.set(exec.agent.session, renderFor(project.projectRoot, projectEntries, globalEntries).digest)
      return {
        file: stored.entry.file,
        path: stored.path,
        line: renderEntry(stored.entry),
        entries: stored.entries.length,
        similar: stored.similar,
        scope,
      } satisfies MemoryWriteOutput
    },
  }

  const readTool: ToolDefinition = {
    name: 'memory_read',
    description: 'Read one memory file listed in the memory index. Returns the note body, bounded; a truncated result says so. Reads the selected scope only; it never falls back to the other layer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          description: 'Topic file name from an index line, such as `testing-conventions.md`.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Which layer to read. Defaults to project; global notes require an explicit scope.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'path', 'content', 'bytes', 'truncated', 'scope'],
        properties: {
          file: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          scope: { type: 'string', enum: ['project', 'global'] },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemoryReadOutput
        return [{
          type: 'text',
          text: `${output.path}${output.truncated ? ` (first ${Buffer.byteLength(output.content, 'utf8')} of ${output.bytes} bytes)` : ''}\n\n${output.content}`,
        }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_read requires an agent session')
      const row = recordOf(args)
      const scope = scopeOf(row.scope)
      if (scope === 'global') {
        requireGlobal()
        rejectGlobalInDream(scope, exec)
      }
      const dir = scope === 'global' ? globalDir() : (await projectFor(exec.agent, exec.signal)).memoryDir
      const file = String(row.file ?? '')
      try {
        const read = await readMemory(dir, file, settings.maxTopicBytes)
        return { ...read, scope } satisfies MemoryReadOutput
      }
      catch (error) {
        if (error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          const hint = scope === 'global'
            ? 'check the file name in the global index.'
            : 'pass scope: "global" for the global layer, or use memory_search to find it.'
          throw new Error(`no memory file named ${file} in ${scope} memory (${dir}); ${hint}`)
        }
        throw error
      }
    },
  }

  const searchTool: ToolDefinition = {
    name: 'memory_search',
    description: 'Search memory notes for a literal string. Every whitespace-separated term must appear on the same line. By default it searches project memory first and then user-global memory when the project result leaves room; every match says which scope it came from, and scope searches one layer only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Terms to look for, case-insensitive.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: `Maximum matches returned; defaults to ${DEFAULT_MAX_SEARCH_RESULTS}.`,
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Search only one layer. Omit to search project memory and then user-global memory.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['matches', 'truncated'],
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'line', 'text', 'scope'],
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                text: { type: 'string' },
                scope: { type: 'string', enum: ['project', 'global'] },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemorySearchOutput
        if (!Array.isArray(output.matches) || output.matches.length === 0) return [{ type: 'text', text: 'No matching memory lines.' }]
        const lines = output.matches.map(match => `${match.scope === 'global' ? '[global] ' : ''}${match.file}:${match.line}: ${match.text}`)
        if (output.truncated) lines.push('… more matches omitted; narrow the query, raise limit, or pick a scope.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_search requires an agent session')
      const row = recordOf(args)
      let scope = row.scope === undefined || row.scope === null ? undefined : scopeOf(row.scope)
      if (scope === 'global') {
        requireGlobal()
        rejectGlobalInDream(scope, exec)
      }
      // A curation child only ever sees the project layer, even with the default
      // merged search.
      if (isDreamSession(exec)) scope = 'project'
      const query = String(row.query ?? '')
      const limit = boundedInteger(row.limit, settings.maxSearchResults, 1)
      const maxBytes = settings.maxSearchBytes
      const matches: MemoryMatch[] = []
      let truncated = false

      if (scope !== 'global') {
        const project = await projectFor(exec.agent, exec.signal)
        const found = await searchMemory(project.memoryDir, query, { limit, maxBytes })
        matches.push(...found.matches.map(match => ({ ...match, scope: 'project' as const })))
        truncated = found.truncated
        if (scope === undefined && settings.globalMemoryEnabled && !truncated && matches.length < limit) {
          const remainingBytes = maxBytes - found.scannedBytes
          if (remainingBytes <= 0) {
            truncated = true
          }
          else {
            const global = await searchMemory(globalDir(), query, {
              limit: limit - matches.length,
              maxBytes: remainingBytes,
            })
            matches.push(...global.matches.map(match => ({ ...match, scope: 'global' as const })))
            truncated = global.truncated
          }
        }
      }
      else {
        const global = await searchMemory(globalDir(), query, { limit, maxBytes })
        matches.push(...global.matches.map(match => ({ ...match, scope: 'global' as const })))
        truncated = global.truncated
      }

      return { matches, truncated } satisfies MemorySearchOutput
    },
  }

  const deleteTool: ToolDefinition = {
    name: 'memory_delete',
    description: 'Remove one note from the selected memory layer. By default the file is archived under that layer and can be recovered; pass permanent: true only when the note is certainly unwanted. The default scope is project; deleting a global note requires scope: "global".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          description: 'Topic file name from an index line, such as `testing-conventions.md`.',
        },
        permanent: {
          type: 'boolean',
          description: 'Delete the file instead of archiving it. Defaults to false.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Which layer to delete from. Defaults to project.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'archived', 'archivePath', 'entries', 'scope'],
        properties: {
          file: { type: 'string' },
          archived: { type: 'boolean' },
          archivePath: { type: 'string' },
          entries: { type: 'integer' },
          scope: { type: 'string', enum: ['project', 'global'] },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemoryDeleteOutput
        const label = output.scope === 'global' ? 'global memory' : 'project memory'
        const text = output.archived
          ? `Archived ${output.file} from ${label} to ${output.archivePath} (${output.entries} ${output.entries === 1 ? 'memory' : 'memories'} remain). Move it back to restore it.`
          : `Deleted ${output.file} permanently from ${label} (${output.entries} ${output.entries === 1 ? 'memory' : 'memories'} remain).`
        return [{ type: 'text', text }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_delete requires an agent session')
      const row = recordOf(args)
      const file = String(row.file ?? '')
      const scope = scopeOf(row.scope)
      if (scope === 'global') {
        requireGlobal()
        rejectGlobalInDream(scope, exec)
      }
      const dir = scope === 'global' ? globalDir() : (await projectFor(exec.agent, exec.signal)).memoryDir
      try {
        const removed: DeleteMemoryResult = await deleteMemory(dir, file, { permanent: row.permanent === true })
        return {
          file,
          archived: removed.archived,
          archivePath: removed.archivePath ?? '',
          entries: removed.entries.length,
          scope,
        } satisfies MemoryDeleteOutput
      }
      catch (error) {
        if (errorCode(error) === 'ENOENT') {
          const hint = scope === 'global'
            ? 'check the file name in the global index.'
            : 'pass scope: "global" for the global layer, or use memory_search to find it.'
          throw new Error(`no memory file named ${file} in ${scope} memory (${dir}); ${hint}`)
        }
        throw error
      }
    },
  }

  const auditTool: ToolDefinition = {
    name: 'memory_audit',
    description: 'Report this project memory\'s health: duplicate clusters, stale notes, oversized notes, and index budget pressure. Read-only. Use it before merging, archiving, or deleting notes; near-duplicates are reported but never merged automatically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        staleDays: {
          type: 'integer',
          minimum: 1,
          maximum: 3650,
          description: `Notes older than this many days are stale; defaults to ${DEFAULT_STALE_DAYS}.`,
        },
        threshold: {
          type: 'number',
          minimum: 0.3,
          maximum: 0.95,
          description: `Similarity at or above which notes are reported as near-duplicates; defaults to ${DEFAULT_DUPLICATE_THRESHOLD}.`,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum entries per category; defaults to 10.',
        },
        verbose: {
          type: 'boolean',
          description: 'Include the per-note list (bounded by maxAuditNotes). Defaults to false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dir', 'projectRoot', 'notes', 'bytes', 'truncated', 'budget', 'duplicates', 'stale', 'oversized', 'notesList'],
        properties: {
          dir: { type: 'string' },
          projectRoot: { type: 'string' },
          notes: { type: 'integer' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          budget: {
            type: 'object',
            additionalProperties: false,
            required: ['maxLines', 'maxBytes', 'usedLines', 'usedBytes', 'omitted', 'overBudget'],
            properties: {
              maxLines: { type: 'integer' },
              maxBytes: { type: 'integer' },
              usedLines: { type: 'integer' },
              usedBytes: { type: 'integer' },
              omitted: { type: 'integer' },
              overBudget: { type: 'boolean' },
            },
          },
          duplicates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'score', 'files', 'titles'],
              properties: {
                kind: { type: 'string', enum: ['identical', 'near', 'same-title'] },
                score: { type: 'number' },
                files: { type: 'array', items: { type: 'string' } },
                titles: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          stale: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'title', 'ageDays', 'bytes'],
              properties: {
                file: { type: 'string' },
                title: { type: 'string' },
                ageDays: { type: 'integer' },
                bytes: { type: 'integer' },
              },
            },
          },
          oversized: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'title', 'bytes', 'lines'],
              properties: {
                file: { type: 'string' },
                title: { type: 'string' },
                bytes: { type: 'integer' },
                lines: { type: 'integer' },
              },
            },
          },
          notesList: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'title', 'summary', 'bytes', 'lines', 'updatedAt', 'indexed'],
              properties: {
                file: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                bytes: { type: 'integer' },
                lines: { type: 'integer' },
                updatedAt: { type: 'number' },
                indexed: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemoryAuditOutput
        const budget = output.budget
        const noun = output.notes === 1 ? 'note' : 'notes'
        const lines = [
          `${output.notes} ${noun}, ${output.bytes} bytes. Index: ${budget.usedLines}/${budget.maxLines} lines, ${budget.usedBytes}/${budget.maxBytes} bytes${budget.overBudget ? ' (over budget)' : ''}.`,
        ]
        if (output.duplicates.length > 0) {
          lines.push('Duplicates:')
          for (const group of output.duplicates) {
            lines.push(`- ${group.kind} (${Math.round(group.score * 100)}%): ${group.files.join(', ')}`)
          }
        }
        if (output.stale.length > 0) {
          lines.push('Stale:')
          for (const note of output.stale) lines.push(`- ${note.file} (${note.ageDays} days old)`)
        }
        if (output.oversized.length > 0) {
          lines.push('Oversized:')
          for (const note of output.oversized) lines.push(`- ${note.file} (${note.bytes} bytes, ${note.lines} lines)`)
        }
        if (output.duplicates.length === 0 && output.stale.length === 0 && output.oversized.length === 0) {
          lines.push('No duplicate, stale, or oversized notes found.')
        }
        if (output.truncated) lines.push('Report truncated; raise limit or maxAuditNotes to inspect more.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_audit requires an agent session')
      const row = recordOf(args)
      const project = await projectFor(exec.agent, exec.signal)
      return auditMemory(project.memoryDir, project.projectRoot, {
        staleDays: Math.min(3650, boundedInteger(row.staleDays, settings.staleDays, 1)),
        threshold: boundedNumber(row.threshold, settings.duplicateThreshold, 0.3, 0.95),
        limit: Math.min(50, boundedInteger(row.limit, 10, 1)),
        verbose: row.verbose === true,
        maxNotes: settings.maxAuditNotes,
        maxIndexLines: settings.maxIndexLines,
        maxIndexBytes: settings.maxIndexBytes,
        oversizeBytes: settings.oversizeBytes,
      })
    },
  }

  const sweepTool: ToolDefinition = {
    name: 'memory_sweep',
    description: 'Preview or apply deterministic memory cleanup: reconcile the index, archive empty notes, archive exact duplicate notes (keeping the newest), remove stale temporary files, and permanently remove archived notes older than the configured archiveMaxAgeDays. Near-duplicates are never merged here. Defaults to a dry run; pass dryRun: false to apply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Only report what would change. Defaults to true.',
        },
        archiveOverflow: {
          type: 'boolean',
          description: 'Archive the oldest notes until the index fits 80% of its budget. Defaults to the plugin configuration.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dryRun', 'before', 'after', 'archived', 'removedTemps', 'removedArchives', 'indexRewritten', 'overBudget'],
        properties: {
          dryRun: { type: 'boolean' },
          before: {
            type: 'object',
            additionalProperties: false,
            required: ['notes', 'bytes', 'lines'],
            properties: {
              notes: { type: 'integer' },
              bytes: { type: 'integer' },
              lines: { type: 'integer' },
            },
          },
          after: {
            type: 'object',
            additionalProperties: false,
            required: ['notes', 'bytes', 'lines'],
            properties: {
              notes: { type: 'integer' },
              bytes: { type: 'integer' },
              lines: { type: 'integer' },
            },
          },
          archived: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'archivePath', 'reason'],
              properties: {
                file: { type: 'string' },
                archivePath: { type: 'string' },
                reason: { type: 'string', enum: ['duplicate', 'empty', 'overflow'] },
              },
            },
          },
          removedTemps: { type: 'array', items: { type: 'string' } },
          removedArchives: { type: 'array', items: { type: 'string' } },
          indexRewritten: { type: 'boolean' },
          overBudget: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemorySweepOutput
        const verb = output.dryRun ? 'would be archived' : 'archived'
        const archiveNoun = output.archived.length === 1 ? 'note' : 'notes'
        const tempNoun = output.removedTemps.length === 1 ? 'temp file' : 'temp files'
        const lines = [
          `${output.dryRun ? 'Sweep preview' : 'Sweep complete'}: ${output.before.notes} -> ${output.after.notes} notes, ${output.before.bytes} -> ${output.after.bytes} bytes.`,
          `Index: ${output.after.lines} entries${output.overBudget ? ' (still over budget)' : ''}. ${output.removedTemps.length} ${tempNoun} ${output.dryRun ? 'would be' : 'were'} removed; ${output.archived.length} ${archiveNoun} ${verb}.`,
        ]
        for (const item of output.archived) lines.push(`- ${item.file} -> ${item.archivePath} (${item.reason})`)
        if (output.removedArchives.length > 0) {
          const noun = output.removedArchives.length === 1 ? 'archive' : 'archives'
          lines.push(`${output.removedArchives.length} old ${noun} ${output.dryRun ? 'would be' : 'were'} permanently removed by the retention policy.`)
          for (const name of output.removedArchives) lines.push(`- ${name} (retention)`)
        }
        if (output.indexRewritten) lines.push(`${output.dryRun ? 'The index would be rewritten.' : 'The index was rewritten.'}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_sweep requires an agent session')
      const row = recordOf(args)
      const project = await projectFor(exec.agent, exec.signal)
      const archiveOverflow = row.archiveOverflow === true
        ? true
        : row.archiveOverflow === false
          ? false
          : settings.archiveOverflow
      return sweepMemory(project.memoryDir, {
        dryRun: row.dryRun !== false,
        archiveOverflow,
        archiveMaxAgeDays: settings.archiveMaxAgeDays,
        maxIndexLines: settings.maxIndexLines,
        maxIndexBytes: settings.maxIndexBytes,
      })
    },
  }

  const restoreTool: ToolDefinition = {
    name: 'memory_restore',
    description: 'Restore one note previously archived by memory_delete or memory_sweep. Takes the archive file name from an archive path and reads that layer\'s archive directory; refuses to overwrite an existing note. The default scope is project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['archive'],
      properties: {
        archive: {
          type: 'string',
          description: 'Generated archive file name, such as `20261127T190000Z-testing-a1b2.md`.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: 'Which layer to restore into. Defaults to project.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'entries', 'scope'],
        properties: {
          file: { type: 'string' },
          scope: { type: 'string', enum: ['project', 'global'] },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'title', 'summary'],
              properties: {
                file: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const output = value as unknown as MemoryRestoreOutput
        const label = output.scope === 'global' ? 'global memory' : 'project memory'
        return [{ type: 'text', text: `Restored ${output.file} into ${label} (${output.entries.length} ${output.entries.length === 1 ? 'memory' : 'memories'} indexed).` }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.agent === undefined) throw new Error('memory_restore requires an agent session')
      const row = recordOf(args)
      const archive = String(row.archive ?? '')
      const scope = scopeOf(row.scope)
      if (scope === 'global') {
        requireGlobal()
        rejectGlobalInDream(scope, exec)
      }
      const dir = scope === 'global' ? globalDir() : (await projectFor(exec.agent, exec.signal)).memoryDir
      try {
        const restored = await restoreMemory(dir, archive)
        return {
          file: restored.file,
          entries: restored.entries.map(entry => ({
            file: entry.file,
            title: entry.title,
            summary: entry.summary,
          })),
          scope,
        } satisfies MemoryRestoreOutput
      }
      catch (error) {
        if (errorCode(error) === 'ENOENT') {
          const hint = scope === 'global'
            ? 'check the archive path in the global layer.'
            : 'pass scope: "global" if it was archived from the global layer.'
          throw new Error(`no archive file named ${archive} in the ${scope} archive (${dir}/archive); ${hint}`)
        }
        throw error
      }
    },
  }

  ctx.effect(() => ctx.tools.register(writeTool))
  ctx.effect(() => ctx.tools.register(readTool))
  ctx.effect(() => ctx.tools.register(searchTool))
  ctx.effect(() => ctx.tools.register(deleteTool))
  ctx.effect(() => ctx.tools.register(auditTool))
  ctx.effect(() => ctx.tools.register(sweepTool))
  ctx.effect(() => ctx.tools.register(restoreTool))

  // Curation needs the agent factory. The manual tool is always available when
  // the service exists; the automatic trigger is added only when enabled.
  ctx.inject(['agents'], (scope) => {
    /**
     * Run one pass under the project's curation lock, or return undefined when
     * another pass already owns it.
     */
    const run = async (agent: Agent, signal?: AbortSignal): Promise<DreamResult | undefined> => {
      const project = await projectFor(agent, signal)
      const release = await tryAcquireCurationLock(project.memoryDir)
      if (release === undefined) return undefined
      try {
        const entries = await loadIndex(project.memoryDir)
        if (entries.length === 0) return { ok: true, notes: 0, summary: 'No notes to curate.' }
        const result = await runDream({
          createAgent: options => scope.agents.create(options),
          parent: agent,
          project,
          settings,
          ...(signal === undefined ? {} : { signal }),
          onStarted: sessionId => dreamSessions.add(sessionId),
          onFinished: sessionId => dreamSessions.delete(sessionId),
        })
        await finishCuration(project.memoryDir, result)
        return result
      }
      finally {
        await release()
      }
    }

    if (settings.curationEnabled) {
      const start = (agent: Agent): void => {
        void (async () => {
          try {
            const project = await projectFor(agent)
            const entries = await loadIndex(project.memoryDir)
            const marked = await markSession(project.memoryDir, settings, entries.length > 0)
            if (!marked.due) return
            const result = await run(agent)
            if (result === undefined) return
            ctx.logger.info('memory curation %s: %d notes remain', result.ok ? 'completed' : 'failed', result.notes)
          }
          catch (error) {
            ctx.logger.warn('memory curation failed: %o', error)
          }
        })()
      }
      triggerCuration = start
      scope.effect(() => () => {
        if (triggerCuration === start) triggerCuration = undefined
      })
    }

    const dreamTool: ToolDefinition = {
      name: 'memory_dream',
      description: 'Run one memory curation pass now in a restricted background child agent. Uses one model turn. The automatic Auto Dream pass is opt-in; this is its explicit equivalent. For a small cleanup, prefer memory_audit and memory_delete directly.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      timeoutMs: Math.min(settings.curationTimeoutMs + 60_000, 900_000),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'notes', 'summary', 'error'],
          properties: {
            ok: { type: 'boolean' },
            notes: { type: 'integer' },
            summary: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const output = value as unknown as DreamResult
          return [{
            type: 'text',
            text: output.ok
              ? `Curation completed; ${output.notes} ${output.notes === 1 ? 'note' : 'notes'} remain.${output.summary.length > 0 ? `\n${output.summary}` : ''}`
              : `Curation failed: ${output.error ?? 'unknown error'}`,
          }]
        },
      },
      async execute(_args: unknown, exec: ToolRunContext) {
        if (exec.agent === undefined) throw new Error('memory_dream requires an agent session')
        const result = await run(exec.agent, exec.signal)
        if (result === undefined) {
          return { ok: false, notes: 0, summary: '', error: 'a curation pass is already running for this project' } satisfies DreamResult
        }
        return {
          ok: result.ok,
          notes: result.notes,
          summary: result.summary,
          error: result.error ?? '',
        } satisfies DreamResult
      },
    }
    scope.effect(() => scope.tools.register(dreamTool))
  })

  // The Web UI panel reaches the same store through one owner-only exact route.
  // Tools and the panel therefore share one implementation of every operation.
  ctx.inject(['connection', 'agents'], (scope) => {
    const reply = (value: unknown, status = 200): Response => Response.json(value, { status })
    const failure = (code: string, message: string, status: number): Response => reply({ ok: false, error: { code, message } }, status)

    const serve = async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      }
      catch {
        return failure('bad-request', 'expected a JSON body', 400)
      }
      const row = recordOf(body)
      const sessionId = stringOf(row.sessionId)
      const agent = sessionId === undefined ? undefined : scope.agents.get(sessionId as SessionId)
      if (agent === undefined) {
        return failure('no-session', 'open a session before managing its memory', 409)
      }
      let memoryScope: MemoryScope
      try {
        memoryScope = scopeOf(row.scope)
      }
      catch (error) {
        return failure('bad-scope', error instanceof Error ? error.message : String(error), 400)
      }
      if (memoryScope === 'global' && !settings.globalMemoryEnabled) {
        return failure('global-disabled', 'global memory is disabled in this profile', 400)
      }
      try {
        const cwd = await scope.workingDirectory.ensure(agent, request.signal)
        const projectRoot = findProjectRoot(cwd)
        const dir = memoryScope === 'global' ? globalMemoryDir(settings.home) : memoryDir(projectRoot, settings.home)
        switch (row.action) {
          case 'list':
            return reply({ ok: true, value: { scope: memoryScope, projectRoot, dir, entries: await loadIndex(dir), globalEnabled: settings.globalMemoryEnabled } })
          case 'read':
            return reply({ ok: true, value: { ...await readMemory(dir, String(row.file ?? ''), settings.maxTopicBytes), scope: memoryScope } })
          case 'save': {
            const file = stringOf(row.file)
            const summary = stringOf(row.summary)
            const stored = await writeMemory(dir, {
              title: String(row.title ?? ''),
              content: String(row.content ?? ''),
              ...(file === undefined ? {} : { file }),
              ...(summary === undefined ? {} : { summary }),
            })
            return reply({
              ok: true,
              value: { entry: stored.entry, entries: stored.entries, line: renderEntry(stored.entry), scope: memoryScope },
            })
          }
          case 'delete': {
            const removed = await deleteMemory(dir, String(row.file ?? ''), { permanent: row.permanent === true })
            return reply({
              ok: true,
              value: {
                entries: removed.entries,
                archived: removed.archived,
                archivePath: removed.archivePath ?? '',
                scope: memoryScope,
              },
            })
          }
          case 'audit':
            if (memoryScope === 'global') {
              return failure('unsupported-scope', 'global curation is not available yet; run memory_audit on a project', 400)
            }
            return reply({
              ok: true,
              value: await auditMemory(dir, projectRoot, {
                staleDays: settings.staleDays,
                threshold: settings.duplicateThreshold,
                limit: 10,
                verbose: false,
                maxNotes: settings.maxAuditNotes,
                maxIndexLines: settings.maxIndexLines,
                maxIndexBytes: settings.maxIndexBytes,
                oversizeBytes: settings.oversizeBytes,
              }),
            })
          case 'sweep': {
            if (memoryScope === 'global') {
              return failure('unsupported-scope', 'global curation is not available yet; run memory_sweep on a project', 400)
            }
            const archiveOverflow = row.archiveOverflow === true
              ? true
              : row.archiveOverflow === false
                ? false
                : settings.archiveOverflow
            return reply({
              ok: true,
              value: await sweepMemory(dir, {
                dryRun: row.dryRun !== false,
                archiveOverflow,
                archiveMaxAgeDays: settings.archiveMaxAgeDays,
                maxIndexLines: settings.maxIndexLines,
                maxIndexBytes: settings.maxIndexBytes,
              }),
            })
          }
          case 'restore':
            return reply({
              ok: true,
              value: { ...await restoreMemory(dir, String(row.archive ?? '')), scope: memoryScope },
            })
          default:
            return failure('bad-action', 'unknown action; expected list, read, save, delete, audit, sweep, or restore', 400)
        }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return failure('failed', message, 400)
      }
    }

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/memory',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: serve,
    }), 'memory: panel route')
  })

  // A new agent session object starts with nothing delivered; a resumed,
  // cleared, or compacted session must reconcile against visible history again
  // and cannot rely on a write acknowledgement whose tool result is gone.
  ctx.on('agent/created', ({ agent }) => {
    delivered.delete(agent.session)
    acknowledged.delete(agent.session)
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (signal.aborted) return decision
    // An empty first entry owns a no-step turn; keep the context for a later step.
    if (step === 1 && decision.messages.length === 0) return decision
    const sessionId = agent.session.header.id
    if (dreamSessions.has(sessionId)) return decision
    if (triggerCuration !== undefined
      && agent.session.header.origin !== 'subagent'
      && !countedSessions.has(agent.session)) {
      countedSessions.add(agent.session)
      triggerCuration(agent)
    }
    let context: RenderedMemory
    try {
      context = await contextFor(agent, signal)
    }
    catch (error) {
      ctx.logger.warn('memory index unavailable: %o', error)
      return decision
    }
    signal.throwIfAborted()
    const record = delivered.get(agent.session)
    // History is authoritative at the start of every turn, so an interrupted
    // injection is retried instead of being treated as delivered.
    const current = record?.turn === turn ? record.digest : visibleMemoryDigest(agent)
    const ack = acknowledged.get(agent.session)
    // An acknowledgement covers exactly the state it was recorded for; any later
    // change, including an edit from outside this session, falls back to injection.
    if (ack !== undefined && ack !== context.digest) acknowledged.delete(agent.session)
    delivered.set(agent.session, { digest: context.digest, turn })
    if (current === context.digest || ack === context.digest) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createMemoryMessage(context.text, {
          digest: context.digest,
          projectRoot: context.projectRoot,
          memoryDir: context.memoryDir,
          entries: context.entries,
          ...(settings.globalMemoryEnabled && context.globalEntryCount > 0 ? {
            globalEntries: context.globalEntries,
            globalMemoryDir: context.globalMemoryDir,
          } : {}),
        }),
      ],
    }
  })
}
