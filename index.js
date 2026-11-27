/**
 * `@local/dsh-memory` — durable, file-based project memory for DSH agents.
 *
 * Each session receives the project's `MEMORY.md` index as one injected context
 * message, and three tools maintain the store: `memory_write`, `memory_read`, and
 * `memory_search`. Files live under `<harness home>/memory/<project key>/` as plain
 * markdown, so they are inspectable, editable, and never mixed into the repository.
 *
 * @module @local/dsh-memory
 */

import { createHash, randomUUID } from 'node:crypto'
import { loadIndex, readMemory, searchMemory, writeMemory } from './lib/store.js'
import { dshHome, findProjectRoot, memoryDir } from './lib/paths.js'
import { renderEntry, renderMemoryContext } from './lib/render.js'

/** Plugin name, also the injected message's source kind. */
export const name = 'memory'

/** Services this plugin needs to resolve a session working directory and register tools. */
export const inject = ['tools', 'workingDirectory']

const DEFAULT_MAX_INDEX_LINES = 200
const DEFAULT_MAX_INDEX_BYTES = 25_000
const DEFAULT_MAX_TOPIC_BYTES = 65_536
const DEFAULT_MAX_SEARCH_RESULTS = 20
const DEFAULT_MAX_SEARCH_BYTES = 4 * 1024 * 1024

function boundedInteger(value, fallback, minimum) {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum ? value : fallback
}

function normalizeSettings(config) {
  const row = config !== null && typeof config === 'object' ? config : {}
  return {
    maxIndexLines: boundedInteger(row.maxIndexLines, DEFAULT_MAX_INDEX_LINES, 0),
    maxIndexBytes: boundedInteger(row.maxIndexBytes, DEFAULT_MAX_INDEX_BYTES, 0),
    maxTopicBytes: boundedInteger(row.maxTopicBytes, DEFAULT_MAX_TOPIC_BYTES, 256),
    maxSearchResults: boundedInteger(row.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS, 1),
    maxSearchBytes: boundedInteger(row.maxSearchBytes, DEFAULT_MAX_SEARCH_BYTES, 1024),
    home: dshHome(),
  }
}

function digestOf(text) {
  return createHash('sha1').update(text).digest('hex')
}

/** The most recent memory context visible to this agent's session, if any. */
function visibleMemoryDigest(agent) {
  try {
    const session = agent.session
    const surface = session.surface
    const nodes = surface?.nodes
    if (nodes === undefined || nodes.length === 0) return undefined
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.eventAt(nodes[index])
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind !== name) continue
      return typeof source.memoryDigest === 'string' ? source.memoryDigest : undefined
    }
  }
  catch {
    // An unexpected surface shape only means the session re-injects once.
  }
  return undefined
}

function createMemoryMessage(text, details) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: name,
      form: 'snapshot',
      sections: [{ name, text }],
      memoryDigest: details.digest,
      projectRoot: details.projectRoot,
      memoryDir: details.memoryDir,
      entryCount: details.entries.length,
    },
  }
}

/**
 * Register the memory tools and the per-session index injection.
 * @param ctx - Host plugin context.
 * @param config - loader row configuration.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  /** Digest of the context already delivered to a session, keyed by session. */
  const delivered = new WeakMap()
  /**
   * Digest the session already knows without an injection: either it was just
   * injected or the model wrote it. Own writes must not re-inject the whole
   * index, because the tool result already carries the updated index line.
   */
  const acknowledged = new WeakMap()

  /** Resolve the project and its memory directory for one agent. */
  const projectFor = async (agent, signal) => {
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const projectRoot = findProjectRoot(cwd)
    return { projectRoot, memoryDir: memoryDir(projectRoot, settings.home) }
  }

  const renderFor = (projectRoot, entries) => {
    const text = renderMemoryContext({
      projectRoot,
      entries,
      maxIndexLines: settings.maxIndexLines,
      maxIndexBytes: settings.maxIndexBytes,
    })
    return { entries, text, digest: digestOf(text) }
  }

  const contextFor = async (agent, signal) => {
    const project = await projectFor(agent, signal)
    const entries = await loadIndex(project.memoryDir)
    return { ...project, ...renderFor(project.projectRoot, entries) }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'memory_write',
    description: 'Save one durable note to this project\'s memory. Creates or updates a topic file and its one-line entry in the project memory index, so a later session can recall it. Use it for user corrections and preferences, project conventions the code does not make obvious, and conclusions that took real work to establish. Do not save secrets, credentials, or material that is cheap to re-read from the repository.',
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
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'path', 'line', 'entries'],
        properties: {
          file: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'string' },
          entries: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved ${value.file} (${value.entries} memories indexed, under ${value.path}).\n${value.line}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('memory_write requires an agent session')
      const project = await projectFor(exec.agent, exec.signal)
      const stored = await writeMemory(project.memoryDir, {
        title: args.title,
        content: args.content,
        ...typeof args.file === 'string' ? { file: args.file } : {},
        ...typeof args.summary === 'string' ? { summary: args.summary } : {},
      })
      // The write is the only change this session knows about; the tool result
      // already names the new index line, so the next step need not repeat the
      // whole index. An outside change still differs from this digest.
      acknowledged.set(exec.agent.session, renderFor(project.projectRoot, stored.entries).digest)
      return {
        file: stored.entry.file,
        path: stored.path,
        line: renderEntry(stored.entry),
        entries: stored.entries.length,
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'memory_read',
    description: 'Read one project memory file listed in the memory index. Returns the note body, bounded; a truncated result says so.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          description: 'Topic file name from an index line, such as `testing-conventions.md`.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'path', 'content', 'bytes', 'truncated'],
        properties: {
          file: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.path}${value.truncated ? ` (first ${Buffer.byteLength(value.content, 'utf8')} of ${value.bytes} bytes)` : ''}\n\n${value.content}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('memory_read requires an agent session')
      const project = await projectFor(exec.agent, exec.signal)
      try {
        return await readMemory(project.memoryDir, args.file, settings.maxTopicBytes)
      }
      catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
          throw new Error(`no memory file named ${args.file} in ${project.memoryDir}; use memory_search to find one.`)
        }
        throw error
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'memory_search',
    description: 'Search this project\'s memory notes for a literal string. Every whitespace-separated term must appear on the same line. Returns matching file, line number, and text; use memory_read to open a match.',
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
              required: ['file', 'line', 'text'],
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                text: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (value.matches.length === 0) return [{ type: 'text', text: 'No matching memory lines.' }]
        const lines = value.matches.map(match => `${match.file}:${match.line}: ${match.text}`)
        if (value.truncated) lines.push('… more matches omitted; narrow the query or raise limit.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('memory_search requires an agent session')
      const project = await projectFor(exec.agent, exec.signal)
      return searchMemory(project.memoryDir, args.query, {
        limit: boundedInteger(args.limit, settings.maxSearchResults, 1),
        maxBytes: settings.maxSearchBytes,
      })
    },
  }))

  // A new agent session object starts with nothing delivered; a resumed,
  // cleared, or compacted session must reconcile against visible history again
  // and cannot rely on a write acknowledgement whose tool result is gone.
  ctx.on('agent/created', ({ agent }) => {
    delivered.delete(agent.session)
    acknowledged.delete(agent.session)
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // An empty first entry owns a no-step turn; keep the context for a later step.
    if (step === 1 && decision.messages.length === 0) return decision
    let context
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
        createMemoryMessage(context.text, context),
      ],
    }
  })
}
