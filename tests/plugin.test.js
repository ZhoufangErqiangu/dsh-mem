import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, name } from '../index.js'

const scratch = []

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-mem-plugin-'))
  scratch.push(root)
  await mkdir(path.join(root, '.git'), { recursive: true })
  return root
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

function fakeRuntime(cwd, home, options = {}) {
  const tools = new Map()
  const listeners = new Map()
  const routes = new Map()
  const agents = new Map(options.agents ?? [])
  const ctx = {
    effect: factory => factory(),
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    inject: (_services, callback) => {
      callback(ctx)
      return () => {}
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    agents: { get: sessionId => agents.get(sessionId) },
    workingDirectory: { ensure: async () => cwd },
    logger: { warn: () => {} },
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    ctx,
    tools,
    listeners,
    routes,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

function session() {
  return { surface: { nodes: [] }, eventAt: () => undefined }
}

function payload(agent, turn = 1, step = 1) {
  return { agent, turn, step, signal: new AbortController().signal }
}

test('apply registers the three memory tools', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const runtime = fakeRuntime(root, home)
  try {
    apply(runtime.ctx, {})
    assert.deepEqual([...runtime.tools.keys()].sort(), ['memory_read', 'memory_search', 'memory_write'])
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
    const handler = runtime.listeners.get('agent/pre-step')
    assert.equal(typeof handler, 'function')
    const agent = { session: session() }
    const next = async () => ({ kind: 'messages', messages: [{ id: 'prompt' }] })

    const first = await handler(payload(agent, 1, 1), next)
    assert.equal(first.messages.length, 2)
    const injected = first.messages[1]
    assert.equal(injected.source.kind, name)
    assert.match(injected.content[0].text, /no saved notes yet/u)

    const second = await handler(payload(agent, 1, 2), next)
    assert.equal(second.messages.length, 1)

    const nextTurn = await handler(payload(agent, 2, 1), next)
    assert.equal(nextTurn.messages.length, 2, 'a new turn re-checks visible history')
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
    const handler = runtime.listeners.get('agent/pre-step')
    const agent = { session: session() }
    const rejection = { kind: 'reject', reason: 'empty' }
    assert.equal(await handler(payload(agent), async () => rejection), rejection)
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
    const saved = await write.execute(
      { title: 'Release flow', content: '# Release flow\n\nTag first, then publish.' },
      { agent: { session: session() }, signal: new AbortController().signal },
    )
    assert.equal(saved.file, 'release-flow.md')
    assert.match(saved.line, /Release flow/u)

    const handler = runtime.listeners.get('agent/pre-step')
    const agent = { session: session() }
    const injected = await handler(payload(agent), async () => ({ kind: 'messages', messages: [{ id: 'prompt' }] }))
    assert.equal(injected.messages.length, 2)
    assert.match(injected.messages[1].content[0].text, /release-flow\.md/u)
    assert.match(injected.messages[1].content[0].text, /1 note saved/u)
    assert.equal(injected.messages[1].source.entryCount, 1)
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
    const handler = runtime.listeners.get('agent/pre-step')
    const next = async () => ({ kind: 'messages', messages: [{ id: 'prompt' }] })
    const agent = { session: session() }

    const baseline = await handler(payload(agent, 1, 1), next)
    assert.equal(baseline.messages.length, 2)

    await runtime.tools.get('memory_write').execute(
      { title: 'Orbit', content: '# Orbit\n\nAlways file under orbit.' },
      { agent, signal: new AbortController().signal },
    )
    const nextStep = await handler(payload(agent, 1, 2), next)
    assert.equal(nextStep.messages.length, 1, 'own write is acknowledged, not injected')
    const nextTurn = await handler(payload(agent, 2, 1), next)
    assert.equal(nextTurn.messages.length, 1, 'the acknowledgement survives into later turns')
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
    const handler = runtime.listeners.get('agent/pre-step')
    const next = async () => ({ kind: 'messages', messages: [{ id: 'prompt' }] })
    const agent = { session: session() }
    await handler(payload(agent, 1, 1), next)
    await runtime.tools.get('memory_write').execute(
      { title: 'Orbit', content: '# Orbit\n\nAlways file under orbit.' },
      { agent, signal: new AbortController().signal },
    )
    assert.equal((await handler(payload(agent, 2, 1), next)).messages.length, 1)

    const other = { session: session() }
    await runtime.tools.get('memory_write').execute(
      { title: 'Rings', content: '# Rings\n\nRings are render-only.' },
      { agent: other, signal: new AbortController().signal },
    )
    const changed = await handler(payload(agent, 3, 1), next)
    assert.equal(changed.messages.length, 2)
    assert.match(changed.messages[1].content[0].text, /rings\.md/u)
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
    const handler = runtime.listeners.get('agent/pre-step')
    const next = async () => ({ kind: 'messages', messages: [{ id: 'prompt' }] })
    const agent = { session: session() }
    await handler(payload(agent, 1, 1), next)
    await runtime.tools.get('memory_write').execute(
      { title: 'Orbit', content: '# Orbit\n\nAlways file under orbit.' },
      { agent, signal: new AbortController().signal },
    )
    assert.equal((await handler(payload(agent, 2, 1), next)).messages.length, 1)

    runtime.listeners.get('agent/created')({ agent, source: { kind: 'compaction' } })
    const afterCompaction = await handler(payload(agent, 3, 1), next)
    assert.equal(afterCompaction.messages.length, 2, 'the index returns after its history is summarized away')
  }
  finally {
    runtime.restore()
  }
})

test('the panel route lists, saves, reads, and deletes through the same store', async () => {
  const root = await workspace()
  const home = path.join(root, 'home')
  const agent = { session: session() }
  const runtime = fakeRuntime(root, home, { agents: [['session-1', agent]] })
  try {
    apply(runtime.ctx, {})
    const route = runtime.routes.get('/api/memory')
    assert.ok(route, 'the owner-only panel route is registered')
    const call = async (body) => {
      const response = await route.fetch(new Request('http://localhost/api/memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      return response.json()
    }

    const saved = await call({ action: 'save', sessionId: 'session-1', title: 'Release', content: 'Tag then publish.' })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.entry.file, 'release.md')

    const listed = await call({ action: 'list', sessionId: 'session-1' })
    assert.deepEqual(listed.value.entries.map(entry => entry.file), ['release.md'])

    const read = await call({ action: 'read', sessionId: 'session-1', file: 'release.md' })
    assert.match(read.value.content, /Tag then publish/u)

    const removed = await call({ action: 'delete', sessionId: 'session-1', file: 'release.md' })
    assert.deepEqual(removed.value.entries, [])

    const missing = await call({ action: 'list', sessionId: 'other-session' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'no-session')

    const traversal = await call({ action: 'read', sessionId: 'session-1', file: '../MEMORY.md' })
    assert.equal(traversal.ok, false)
  }
  finally {
    runtime.restore()
  }
})
