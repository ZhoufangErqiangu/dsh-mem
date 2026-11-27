import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

import { apply, name } from '../src/index.ts'
import { memoryDir } from '../src/paths.ts'
import { readState } from '../src/state.ts'
import type { MemoryAuditOutput, MemoryDeleteOutput, MemoryWriteOutput } from '../src/index.ts'
import type {
  Agent,
  Context,
  MemoryMessageSource,
  Session,
  ToolDefinition,
  ToolRunContext,
  UserMessage,
} from '../src/types.ts'

const scratch: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-mem-plugin-'))
  scratch.push(root)
  await mkdir(path.join(root, '.git'), { recursive: true })
  return root
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

type Handler = (...args: any[]) => any

/** The subset of a pre-step payload these tests build by hand. */
interface PreStepPayload {
  agent: Agent
  turn: number
  step: number
  signal: AbortSignal
}

type PreStepHandler = (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>

interface FakeRuntime {
  ctx: Context
  tools: Map<string, ToolDefinition>
  listeners: Map<string, Handler>
  routes: Map<string, ConnectionFetchRoute>
  restore: () => void
}

function fakeRuntime(cwd: string, home: string, options: { agents?: Array<readonly [string, Agent]> } = {}): FakeRuntime {
  const tools = new Map<string, ToolDefinition>()
  const listeners = new Map<string, Handler>()
  const routes = new Map<string, ConnectionFetchRoute>()
  const agents = new Map<string, Agent>(options.agents ?? [])
  const ctx = {
    effect: (factory: () => unknown) => factory(),
    on: (event: string, handler: Handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    inject: (_services: string[], callback: (scope: unknown) => void) => {
      callback(ctx)
      return () => {}
    },
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    connection: {
      fetch: {
        register: (route: ConnectionFetchRoute) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    agents: { get: (sessionId: string) => agents.get(sessionId) },
    workingDirectory: { ensure: async () => cwd },
    logger: { warn: () => {} },
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    ctx: ctx as unknown as Context,
    tools,
    listeners,
    routes,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

let nextSessionId = 0

function session(): Session {
  nextSessionId += 1
  return {
    header: { id: `session-${nextSessionId}` },
    surface: { nodes: [] },
    eventAt: () => undefined,
  } as unknown as Session
}

function makeAgent(): Agent {
  return { session: session() } as unknown as Agent
}

function payload(agent: Agent, turn = 1, step = 1): PreStepPayload {
  return { agent, turn, step, signal: new AbortController().signal }
}

function toolContext(agent: Agent): ToolRunContext {
  return { agent, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** Hand off an ordinary prompt from the next pre-step listener. */
function enterWithPrompt(): Promise<PreStepDecision> {
  const prompt = { id: 'prompt' } as unknown as UserMessage
  return Promise.resolve({ kind: 'enter', messages: [prompt] })
}

function preStepHandler(runtime: FakeRuntime): PreStepHandler {
  const handler = runtime.listeners.get('agent/pre-step')
  assert.equal(typeof handler, 'function')
  return handler as PreStepHandler
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function messagesOf(decision: PreStepDecision): UserMessage[] {
  if (decision.kind !== 'enter') throw new Error(`expected an entering decision, got ${decision.kind}`)
  return decision.messages
}

function sourceOf(message: UserMessage): MemoryMessageSource {
  if (message.source.kind !== name) throw new Error(`unexpected source kind ${message.source.kind}`)
  return message.source
}

test('apply registers the memory tools', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    assert.deepEqual([...runtime.tools.keys()].sort(), [
      'memory_audit',
      'memory_delete',
      'memory_dream',
      'memory_read',
      'memory_search',
      'memory_write',
    ])
  }
  finally {
    runtime.restore()
  }
})

test('memory_delete archives by default and supports permanent deletion', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    const remove = runtime.tools.get('memory_delete')
    assert.ok(write)
    assert.ok(remove)

    const first = await write.execute(
      { title: 'Scratch', content: '# Scratch\n\nArchive me.' },
      toolContext(makeAgent()),
    ) as MemoryWriteOutput
    const archived = await remove.execute({ file: first.file }, toolContext(makeAgent())) as MemoryDeleteOutput
    assert.equal(archived.archived, true)
    assert.ok(archived.archivePath)
    assert.match(await readFile(archived.archivePath, 'utf8'), /Archive me/u)
    await assert.rejects(readFile(first.path, 'utf8'), /ENOENT/u)

    const second = await write.execute(
      { title: 'Gone', content: '# Gone\n\nDelete me.' },
      toolContext(makeAgent()),
    ) as MemoryWriteOutput
    const deleted = await remove.execute({ file: second.file, permanent: true }, toolContext(makeAgent())) as MemoryDeleteOutput
    assert.equal(deleted.archived, false)
    assert.equal(deleted.archivePath, '')
    await assert.rejects(readFile(second.path, 'utf8'), /ENOENT/u)
  }
  finally {
    runtime.restore()
  }
})

test('memory_write hints at a similar note and memory_audit reports the cluster', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    const audit = runtime.tools.get('memory_audit')
    assert.ok(write)
    assert.ok(audit)

    await write.execute(
      { title: 'Testing conventions', content: '# Testing conventions\n\nRun node --test before pushing.' },
      toolContext(makeAgent()),
    )
    const second = await write.execute(
      { title: 'Test conventions', content: '# Test conventions\n\nRun node --test before pushing.' },
      toolContext(makeAgent()),
    ) as MemoryWriteOutput
    assert.equal(second.similar.length, 1)
    assert.equal(second.similar[0].file, 'testing-conventions.md')

    const report = await audit.execute({ threshold: 0.5, limit: 5 }, toolContext(makeAgent())) as MemoryAuditOutput
    assert.ok(report.duplicates.length >= 1)
    assert.ok(report.duplicates.some(group => group.files.includes('testing-conventions.md') && group.files.includes('test-conventions.md')))
    assert.equal(report.budget.overBudget, false)
  }
  finally {
    runtime.restore()
  }
})

test('an over-budget injection points at the audit and delete tools', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, { maxIndexLines: 1 })
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    const writer = makeAgent()
    await write.execute({ title: 'One', content: '# One\n\nFirst.' }, toolContext(writer))
    await write.execute({ title: 'Two', content: '# Two\n\nSecond.' }, toolContext(writer))
    const handler = preStepHandler(runtime)
    const injected = messagesOf(await handler(payload(makeAgent()), enterWithPrompt))
    assert.match(textOf(injected[1]), /over budget/u)
    assert.match(textOf(injected[1]), /memory_audit/u)
    assert.match(textOf(injected[1]), /memory_delete/u)
  }
  finally {
    runtime.restore()
  }
})

test('curation counts a session before any dream is due', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, { curationEnabled: true, curationMinSessions: 5 })
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    const agent = makeAgent()
    await write.execute({ title: 'Seed', content: '# Seed\n\nNote.' }, toolContext(agent))

    const handler = preStepHandler(runtime)
    await handler(payload(agent), enterWithPrompt)

    const dir = memoryDir(root, home)
    let state = await readState(dir)
    for (let attempt = 0; attempt < 50 && state.sessionsSinceCurate === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      state = await readState(dir)
    }
    assert.equal(state.sessionsSinceCurate, 1)
    assert.ok(state.lastSessionAt)
    assert.equal(state.lastDreamAttemptAt, undefined)
  }
  finally {
    runtime.restore()
  }
})

test('pre-step injects the memory context once per turn and stays silent afterwards', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const handler = preStepHandler(runtime)
    const agent = makeAgent()

    const first = messagesOf(await handler(payload(agent, 1, 1), enterWithPrompt))
    assert.equal(first.length, 2)
    const injected = first[1]
    assert.equal(injected.source.kind, name)
    assert.match(textOf(injected), /no saved notes yet/u)

    const second = messagesOf(await handler(payload(agent, 1, 2), enterWithPrompt))
    assert.equal(second.length, 1)

    const nextTurn = messagesOf(await handler(payload(agent, 2, 1), enterWithPrompt))
    assert.equal(nextTurn.length, 2, 'a new turn re-checks visible history')
  }
  finally {
    runtime.restore()
  }
})

test('a rejected pre-step never receives memory context', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const handler = preStepHandler(runtime)
    const agent = makeAgent()
    const rejection: PreStepDecision = { kind: 'reject' }
    assert.equal(await handler(payload(agent), () => Promise.resolve(rejection)), rejection)
  }
  finally {
    runtime.restore()
  }
})

test('memory_write then a later turn recalls the saved note', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    const saved = await write.execute(
      { title: 'Release flow', content: '# Release flow\n\nTag first, then publish.' },
      toolContext(makeAgent()),
    ) as MemoryWriteOutput
    assert.equal(saved.file, 'release-flow.md')
    assert.match(saved.line, /Release flow/u)

    const handler = preStepHandler(runtime)
    const agent = makeAgent()
    const injected = messagesOf(await handler(payload(agent), enterWithPrompt))
    assert.equal(injected.length, 2)
    assert.match(textOf(injected[1]), /release-flow\.md/u)
    assert.match(textOf(injected[1]), /1 note saved/u)
    assert.equal(sourceOf(injected[1]).entryCount, 1)
  }
  finally {
    runtime.restore()
  }
})

test('a write in this session does not re-inject the whole index', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const handler = preStepHandler(runtime)
    const agent = makeAgent()

    const baseline = messagesOf(await handler(payload(agent, 1, 1), enterWithPrompt))
    assert.equal(baseline.length, 2)

    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    await write.execute(
      { title: 'Orbit', content: '# Orbit\n\nAlways file under orbit.' },
      toolContext(agent),
    )
    const nextStep = messagesOf(await handler(payload(agent, 1, 2), enterWithPrompt))
    assert.equal(nextStep.length, 1, 'own write is acknowledged, not injected')
    const nextTurn = messagesOf(await handler(payload(agent, 2, 1), enterWithPrompt))
    assert.equal(nextTurn.length, 1, 'the acknowledgement survives into later turns')
  }
  finally {
    runtime.restore()
  }
})

test('an outside change still injects after an acknowledgement', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const handler = preStepHandler(runtime)
    const agent = makeAgent()
    await handler(payload(agent, 1, 1), enterWithPrompt)
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    await write.execute(
      { title: 'Orbit', content: '# Orbit\n\nAlways file under orbit.' },
      toolContext(agent),
    )
    assert.equal(messagesOf(await handler(payload(agent, 2, 1), enterWithPrompt)).length, 1)

    const other = makeAgent()
    await write.execute(
      { title: 'Rings', content: '# Rings\n\nRings are render-only.' },
      toolContext(other),
    )
    const changed = messagesOf(await handler(payload(agent, 3, 1), enterWithPrompt))
    assert.equal(changed.length, 2)
    assert.match(textOf(changed[1]), /rings\.md/u)
  }
  finally {
    runtime.restore()
  }
})

test('compaction invalidates the acknowledgement', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const handler = preStepHandler(runtime)
    const agent = makeAgent()
    await handler(payload(agent, 1, 1), enterWithPrompt)
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    await write.execute(
      { title: 'Orbit', content: '# Orbit\n\nAlways file under orbit.' },
      toolContext(agent),
    )
    assert.equal(messagesOf(await handler(payload(agent, 2, 1), enterWithPrompt)).length, 1)

    const created = runtime.listeners.get('agent/created')
    assert.ok(created)
    created({ agent, source: { kind: 'compact' } })
    const afterCompaction = messagesOf(await handler(payload(agent, 3, 1), enterWithPrompt))
    assert.equal(afterCompaction.length, 2, 'the index returns after its history is summarized away')
  }
  finally {
    runtime.restore()
  }
})

interface MemoryApiReply {
  ok: boolean
  value?: {
    dir?: string
    content?: string
    entry?: { file: string }
    entries?: Array<{ file: string }>
  }
  error?: { code: string; message: string }
}

test('the panel route lists, saves, reads, and deletes through the same store', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const agent = makeAgent()
  const runtime = fakeRuntime(root, home, { agents: [['session-1', agent]] })
  try {
    apply(runtime.ctx, {})
    const route = runtime.routes.get('/api/memory')
    assert.ok(route, 'the owner-only panel route is registered')
    const call = async (body: unknown): Promise<MemoryApiReply> => {
      const response = await route.fetch(new Request('http://localhost/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      return await response.json() as MemoryApiReply
    }

    const saved = await call({ action: 'save', sessionId: 'session-1', title: 'Release', content: 'Tag then publish.' })
    assert.equal(saved.ok, true)
    assert.equal(saved.value?.entry?.file, 'release.md')

    const listed = await call({ action: 'list', sessionId: 'session-1' })
    assert.deepEqual(listed.value?.entries?.map(entry => entry.file), ['release.md'])

    const read = await call({ action: 'read', sessionId: 'session-1', file: 'release.md' })
    assert.match(read.value?.content ?? '', /Tag then publish/u)

    const removed = await call({ action: 'delete', sessionId: 'session-1', file: 'release.md' })
    assert.deepEqual(removed.value?.entries, [])

    const missing = await call({ action: 'list', sessionId: 'other-session' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error?.code, 'no-session')

    const traversal = await call({ action: 'read', sessionId: 'session-1', file: '../MEMORY.md' })
    assert.equal(traversal.ok, false)
  }
  finally {
    runtime.restore()
  }
})
