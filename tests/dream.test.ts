import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildDreamPrompt, MEMORY_TOOL_NAMES, runDream } from '../src/dream.ts'
import { writeMemory } from '../src/store.ts'
import type {
  Agent,
  AgentHandle,
  Context,
  CreateAgentOptions,
  Session,
  Settings,
  UserMessage,
} from '../src/types.ts'

const scratch: string[] = []

async function memoryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-mem-dream-'))
  scratch.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    maxTopicBytes: 65_536,
    maxSearchResults: 20,
    maxSearchBytes: 4_194_304,
    staleDays: 90,
    duplicateThreshold: 0.6,
    oversizeBytes: 16_384,
    maxAuditNotes: 200,
    curationEnabled: true,
    curationMinHours: 24,
    curationMinSessions: 5,
    curationRetryHours: 1,
    curationTimeoutMs: 600_000,
    curationProvider: '',
    curationModel: '',
    curationMaxTokens: 4_096,
    home: '/tmp',
    ...overrides,
  }
}

interface FakeChild {
  session: Session
  ctx: Context
  followup: (message: UserMessage) => void
  cancel: () => void
}

/** Build a parent agent whose only live surface is the session header. */
function parentAgent(): Agent {
  return {
    session: {
      header: { id: 'parent-session', delegationDepth: 0 },
      requestHeader: () => ({ config: { provider: 'provider-a', model: 'model-a' } }),
    },
  } as unknown as Agent
}

/** Build the setup scope services the child factory would receive. */
function setupContext(restrict: (filter: { allow?: readonly string[] }) => void = () => {}): Context {
  return {
    tools: { restrict },
    get: (name: string) => name === 'workingDirectory'
      ? { set: async () => '/work/project' }
      : undefined,
  } as unknown as Context
}

/** Build a fake child that emits one turn/end after followup. */
function fakeChild(reason: { kind: string; error?: unknown }): {
  child: FakeChild
  listeners: Array<(session: Session, event: { type: string; data: { reason: typeof reason } }) => void>
} {
  const listeners: Array<(session: Session, event: { type: string; data: { reason: typeof reason } }) => void> = []
  const session = {
    header: { id: 'dream-session' },
    surface: { nodes: [] },
    eventAt: () => undefined,
  } as unknown as Session
  const child: FakeChild = {
    session,
    ctx: {
      on: (_event: string, listener: typeof listeners[number]) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    } as unknown as Context,
    followup: () => {
      queueMicrotask(() => {
        for (const listener of [...listeners]) {
          listener(session, { type: 'turn/end', data: { reason } })
        }
      })
    },
    cancel: () => {},
  }
  return { child, listeners }
}

test('buildDreamPrompt names the directory and every curation rule', () => {
  const prompt = buildDreamPrompt(
    { projectRoot: '/work/project', memoryDir: '/home/.dsh/memory/project-123' },
    settings({ maxIndexLines: 80, maxIndexBytes: 12_000 }),
  )
  assert.match(prompt, /\/home\/\.dsh\/memory\/project-123/u)
  assert.match(prompt, /Start with memory_audit/u)
  assert.match(prompt, /Never pass permanent: true/u)
  assert.match(prompt, /80 lines and 12000 bytes/u)
  assert.match(prompt, /At most 40 tool calls/u)
})

test('runDream restricts the child to memory tools and disposes it after one turn', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Existing', content: '# Existing\n\nBody.' })
  const { child } = fakeChild({ kind: 'completed' })
  let restricted: string[] = []
  let disposed = false
  const started: string[] = []
  const finished: string[] = []
  let createOptions: CreateAgentOptions | undefined

  const handle: AgentHandle = {
    agent: child as unknown as Agent,
    dispose: async () => {
      disposed = true
    },
  }
  const result = await runDream({
    createAgent: async (options) => {
      createOptions = options
      await options.setup?.(setupContext((filter) => {
        restricted = [...(filter.allow ?? [])]
      }), child as unknown as Agent)
      return handle
    },
    parent: parentAgent(),
    project: { projectRoot: '/work/project', memoryDir: dir },
    settings: settings(),
    onStarted: sessionId => started.push(sessionId),
    onFinished: sessionId => finished.push(sessionId),
  })

  assert.equal(result.ok, true)
  assert.equal(result.notes, 1)
  assert.deepEqual(restricted, [...MEMORY_TOOL_NAMES])
  assert.equal(disposed, true)
  assert.equal(started.length, 1)
  assert.equal(finished.length, 1)
  assert.equal(started[0], finished[0])
  assert.equal(createOptions?.meta?.origin, 'subagent')
  assert.equal(createOptions?.meta?.cwd, '/work/project')
  assert.equal(createOptions?.meta?.parentSession, 'parent-session')
  assert.equal(createOptions?.agentOptions?.provider, 'provider-a')
  assert.equal(createOptions?.agentOptions?.model, 'model-a')
  assert.equal(createOptions?.agentOptions?.maxTokens, 4_096)
})

test('runDream returns a failure when the child turn errors', async () => {
  const dir = await memoryDirectory()
  const { child } = fakeChild({ kind: 'error', error: new Error('route failed') })
  let disposed = false
  const result = await runDream({
    createAgent: async (options) => {
      await options.setup?.(setupContext(), child as unknown as Agent)
      return {
        agent: child as unknown as Agent,
        dispose: async () => {
          disposed = true
        },
      }
    },
    parent: parentAgent(),
    project: { projectRoot: '/work/project', memoryDir: dir },
    settings: settings(),
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /curation turn failed: route failed/u)
  assert.equal(disposed, true)
})

test('runDream times out and cancels the child', async () => {
  const dir = await memoryDirectory()
  let cancelled = false
  const child: FakeChild = {
    session: { header: { id: 'dream-session' }, surface: { nodes: [] }, eventAt: () => undefined } as unknown as Session,
    ctx: { on: () => () => {} } as unknown as Context,
    followup: () => {},
    cancel: () => {
      cancelled = true
    },
  }
  let disposed = false
  const result = await runDream({
    createAgent: async (options) => {
      await options.setup?.(setupContext(), child as unknown as Agent)
      return {
        agent: child as unknown as Agent,
        dispose: async () => {
          disposed = true
        },
      }
    },
    parent: parentAgent(),
    project: { projectRoot: '/work/project', memoryDir: dir },
    settings: settings({ curationTimeoutMs: 30 }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /timed out/u)
  assert.equal(cancelled, true)
  assert.equal(disposed, true)
})
