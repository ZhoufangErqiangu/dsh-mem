import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

import { apply, name } from '../src/index.ts'
import { globalMemoryDir, memoryDir } from '../src/paths.ts'
import { readState } from '../src/state.ts'
import type {
  MemoryAuditOutput,
  MemoryDeleteOutput,
  MemoryReadOutput,
  MemorySearchOutput,
  MemoryWriteOutput,
} from '../src/index.ts'
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
      'memory_restore',
      'memory_search',
      'memory_sweep',
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
    scope?: string
    dir?: string
    globalEnabled?: boolean
    content?: string
    entry?: { file: string }
    entries?: Array<{ file: string }>
    archived?: boolean | Array<{ file: string; archivePath: string }>
    archivePath?: string
    file?: string
    duplicates?: Array<{ files: string[] }>
    dryRun?: boolean
    after?: { notes: number }
  }
  error?: { code: string; message: string }
}

test('the panel route audits, previews and applies a sweep, then restores', async () => {
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

    await call({ action: 'save', sessionId: 'session-1', title: 'Alpha', file: 'alpha.md', content: '# Same\n\nBody.' })
    await call({ action: 'save', sessionId: 'session-1', title: 'Beta', file: 'beta.md', content: '# Same\n\nBody.' })

    const audit = await call({ action: 'audit', sessionId: 'session-1' })
    assert.equal(audit.ok, true)
    assert.ok((audit.value?.duplicates?.length ?? 0) >= 1)

    const preview = await call({ action: 'sweep', sessionId: 'session-1', dryRun: true })
    assert.equal(preview.ok, true)
    assert.equal(preview.value?.dryRun, true)
    const before = await call({ action: 'list', sessionId: 'session-1' })
    assert.equal(before.value?.entries?.length, 2)

    const applied = await call({ action: 'sweep', sessionId: 'session-1', dryRun: false })
    assert.equal(applied.ok, true)
    assert.equal(applied.value?.after?.notes, 1)
    const archived = applied.value?.archived
    assert.ok(Array.isArray(archived))
    assert.equal(archived.length, 1)
    const archiveName = path.basename((archived[0] as { archivePath: string }).archivePath)

    const restored = await call({ action: 'restore', sessionId: 'session-1', archive: archiveName })
    assert.equal(restored.ok, true)
    assert.equal(restored.value?.file, 'alpha.md')
    assert.equal(restored.value?.entries?.length, 2)
  }
  finally {
    runtime.restore()
  }
})

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

test('globalMemoryDir is the unhashed user layer next to project directories', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  assert.equal(globalMemoryDir(home), path.join(home, 'memory', 'global'))
  assert.notEqual(globalMemoryDir(home), memoryDir(root, home))
})

test('a global write is injected next to project memory and read only with scope', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    const read = runtime.tools.get('memory_read')
    assert.ok(write)
    assert.ok(read)

    await write.execute(
      { title: 'Project fact', content: '# Project fact\n\nOnly this repository.' },
      toolContext(makeAgent()),
    )
    const globalSaved = await write.execute(
      { title: 'User preference', content: '# User preference\n\nAnswer in Chinese.', scope: 'global' },
      toolContext(makeAgent()),
    ) as MemoryWriteOutput
    assert.equal(globalSaved.scope, 'global')
    assert.equal(globalSaved.path, path.join(globalMemoryDir(home), globalSaved.file))

    const handler = preStepHandler(runtime)
    const injected = messagesOf(await handler(payload(makeAgent()), enterWithPrompt))
    assert.equal(injected.length, 2)
    const source = sourceOf(injected[1])
    assert.equal(source.entryCount, 1)
    assert.equal(source.globalEntryCount, 1)
    assert.equal(source.globalMemoryDir, globalMemoryDir(home))
    assert.match(textOf(injected[1]), /User-global memory: 1 note/u)
    assert.match(textOf(injected[1]), /User preference/u)
    assert.match(textOf(injected[1]), /Project fact/u)

    await assert.rejects(
      read.execute({ file: globalSaved.file }, toolContext(makeAgent())),
      /no memory file named .* in project memory/u,
    )
    const globalRead = await read.execute(
      { file: globalSaved.file, scope: 'global' },
      toolContext(makeAgent()),
    ) as MemoryReadOutput
    assert.equal(globalRead.scope, 'global')
    assert.match(globalRead.content, /Answer in Chinese/u)
  }
  finally {
    runtime.restore()
  }
})

test('memory_search searches both scopes and honours a scope filter', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    const search = runtime.tools.get('memory_search')
    assert.ok(write)
    assert.ok(search)

    await write.execute(
      { title: 'Shared project', content: '# Shared project\n\nA needle in the project.' },
      toolContext(makeAgent()),
    )
    await write.execute(
      { title: 'Shared global', content: '# Shared global\n\nA needle in the global layer.', scope: 'global' },
      toolContext(makeAgent()),
    )

    const both = await search.execute({ query: 'needle' }, toolContext(makeAgent())) as MemorySearchOutput
    assert.deepEqual(both.matches.map(match => match.scope), ['project', 'global'])
    assert.deepEqual(both.matches.map(match => match.file), ['shared-project.md', 'shared-global.md'])

    const onlyGlobal = await search.execute(
      { query: 'needle', scope: 'global' },
      toolContext(makeAgent()),
    ) as MemorySearchOutput
    assert.deepEqual(onlyGlobal.matches.map(match => [match.scope, match.file]), [['global', 'shared-global.md']])

    const onlyProject = await search.execute(
      { query: 'needle', scope: 'project' },
      toolContext(makeAgent()),
    ) as MemorySearchOutput
    assert.deepEqual(onlyProject.matches.map(match => [match.scope, match.file]), [['project', 'shared-project.md']])
  }
  finally {
    runtime.restore()
  }
})

test('global notes archive under the global directory and leave project notes alone', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    const remove = runtime.tools.get('memory_delete')
    const read = runtime.tools.get('memory_read')
    assert.ok(write)
    assert.ok(remove)
    assert.ok(read)

    await write.execute(
      { title: 'Project fact', content: '# Project fact\n\nStay here.' },
      toolContext(makeAgent()),
    )
    const globalSaved = await write.execute(
      { title: 'Global pref', content: '# Global pref\n\nAcross projects.', scope: 'global' },
      toolContext(makeAgent()),
    ) as MemoryWriteOutput

    const removed = await remove.execute(
      { file: globalSaved.file, scope: 'global' },
      toolContext(makeAgent()),
    ) as MemoryDeleteOutput
    assert.equal(removed.scope, 'global')
    assert.ok(removed.archivePath.includes(path.join('memory', 'global', 'archive')))
    assert.equal(removed.entries, 0)

    await assert.rejects(
      read.execute({ file: globalSaved.file, scope: 'global' }, toolContext(makeAgent())),
      /no memory file named/u,
    )
    const projectRead = await read.execute({ file: 'project-fact.md' }, toolContext(makeAgent())) as MemoryReadOutput
    assert.equal(projectRead.scope, 'project')
    assert.match(projectRead.content, /Stay here/u)

    const restore = runtime.tools.get('memory_restore')
    assert.ok(restore)
    const restored = await restore.execute(
      { archive: path.basename(removed.archivePath), scope: 'global' },
      toolContext(makeAgent()),
    ) as { file: string; scope: string }
    assert.equal(restored.scope, 'global')
    assert.equal(restored.file, 'global-pref.md')
    const again = await read.execute(
      { file: 'global-pref.md', scope: 'global' },
      toolContext(makeAgent()),
    ) as MemoryReadOutput
    assert.match(again.content, /Across projects/u)
  }
  finally {
    runtime.restore()
  }
})

test('a global write acknowledges the session and an outside global change re-injects', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const handler = preStepHandler(runtime)
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    const agent = makeAgent()

    await handler(payload(agent, 1, 1), enterWithPrompt)
    await write.execute(
      { title: 'Global pref', content: '# Global pref\n\nAnswer in Chinese.', scope: 'global' },
      toolContext(agent),
    )
    assert.equal(messagesOf(await handler(payload(agent, 2, 1), enterWithPrompt)).length, 1)

    await write.execute(
      { title: 'Global addendum', content: '# Global addendum\n\nPrefer pnpm.', scope: 'global' },
      toolContext(makeAgent()),
    )
    const changed = messagesOf(await handler(payload(agent, 3, 1), enterWithPrompt))
    assert.equal(changed.length, 2)
    assert.match(textOf(changed[1]), /Global addendum/u)
  }
  finally {
    runtime.restore()
  }
})

test('global memory can be disabled for tools and the panel', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const agent = makeAgent()
  const sessionId = agent.session.header.id
  const runtime = fakeRuntime(root, home, { agents: [[sessionId, agent]] })
  try {
    apply(runtime.ctx, { globalMemoryEnabled: false })
    const write = runtime.tools.get('memory_write')
    assert.ok(write)
    await assert.rejects(
      write.execute({ title: 'Nope', content: '# Nope\n\nNo.', scope: 'global' }, toolContext(agent)),
      /global memory is disabled/u,
    )

    const handler = preStepHandler(runtime)
    const injected = messagesOf(await handler(payload(agent), enterWithPrompt))
    assert.equal(injected.length, 2)
    assert.doesNotMatch(textOf(injected[1]), /User-global memory/u)

    const route = runtime.routes.get('/api/memory')
    assert.ok(route)
    const response = await route.fetch(new Request('http://localhost/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list', sessionId, scope: 'global' }),
    }))
    const payloadReply = await response.json() as MemoryApiReply
    assert.equal(payloadReply.ok, false)
    assert.equal(payloadReply.error?.code, 'global-disabled')

    const projectList = await route.fetch(new Request('http://localhost/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list', sessionId }),
    }))
    const projectReply = await projectList.json() as MemoryApiReply
    assert.equal(projectReply.ok, true)
    assert.equal(projectReply.value?.globalEnabled, false)
  }
  finally {
    runtime.restore()
  }
})

test('the panel route manages the global layer and refuses global curation', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const agent = makeAgent()
  const sessionId = agent.session.header.id
  const runtime = fakeRuntime(root, home, { agents: [[sessionId, agent]] })
  try {
    apply(runtime.ctx, {})
    const route = runtime.routes.get('/api/memory')
    assert.ok(route)
    const call = async (body: unknown): Promise<MemoryApiReply> => {
      const response = await route.fetch(new Request('http://localhost/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      return await response.json() as MemoryApiReply
    }

    const saved = await call({
      action: 'save',
      sessionId,
      scope: 'global',
      title: 'Global pref',
      content: '# Global pref\n\nAnswer in Chinese.',
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.value?.scope, 'global')

    const listed = await call({ action: 'list', sessionId, scope: 'global' })
    assert.equal(listed.value?.dir, globalMemoryDir(home))
    assert.deepEqual(listed.value?.entries?.map(entry => entry.file), ['global-pref.md'])

    const read = await call({ action: 'read', sessionId, scope: 'global', file: 'global-pref.md' })
    assert.match(read.value?.content ?? '', /Answer in Chinese/u)

    const audit = await call({ action: 'audit', sessionId, scope: 'global' })
    assert.equal(audit.ok, false)
    assert.equal(audit.error?.code, 'unsupported-scope')
    const sweep = await call({ action: 'sweep', sessionId, scope: 'global' })
    assert.equal(sweep.ok, false)
    assert.equal(sweep.error?.code, 'unsupported-scope')

    const deleted = await call({ action: 'delete', sessionId, scope: 'global', file: 'global-pref.md' })
    assert.equal(deleted.ok, true)
    assert.deepEqual(deleted.value?.entries, [])

    const projectlist = await call({ action: 'list', sessionId })
    assert.deepEqual(projectlist.value?.entries, [])
  }
  finally {
    runtime.restore()
  }
})

test('the same file name in both scopes stays separate and reads the selected layer', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    const write = runtime.tools.get('memory_write')
    const read = runtime.tools.get('memory_read')
    assert.ok(write)
    assert.ok(read)

    await write.execute(
      { title: 'Preferences', content: '# Preferences\n\nProject copy.' },
      toolContext(makeAgent()),
    )
    await write.execute(
      { title: 'Preferences', content: '# Preferences\n\nGlobal copy.', scope: 'global' },
      toolContext(makeAgent()),
    )

    const projectRead = await read.execute({ file: 'preferences.md' }, toolContext(makeAgent())) as MemoryReadOutput
    assert.equal(projectRead.scope, 'project')
    assert.match(projectRead.content, /Project copy/u)
    assert.doesNotMatch(projectRead.content, /Global copy/u)

    const globalRead = await read.execute(
      { file: 'preferences.md', scope: 'global' },
      toolContext(makeAgent()),
    ) as MemoryReadOutput
    assert.equal(globalRead.scope, 'global')
    assert.match(globalRead.content, /Global copy/u)
    assert.doesNotMatch(globalRead.content, /Project copy/u)
  }
  finally {
    runtime.restore()
  }
})
