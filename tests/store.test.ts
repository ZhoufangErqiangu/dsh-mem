import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assertContained, findProjectRoot, isTopicFileName, projectKey } from '../src/paths.ts'
import {
  deleteMemory,
  invalidateIndexCache,
  loadIndex,
  loadIndexCached,
  readMemory,
  renderIndex,
  searchMemory,
  slugForTitle,
  writeMemory,
} from '../src/store.ts'
import { boundEntries, renderMemoryContext } from '../src/render.ts'
import type { MemoryEntry } from '../src/types.ts'

const scratch: string[] = []

async function memoryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-mem-test-'))
  scratch.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

test('writeMemory creates a topic file and keeps the index in sync', async () => {
  const dir = await memoryDirectory()
  const stored = await writeMemory(dir, {
    title: 'Testing conventions',
    content: '# Testing conventions\n\nRun `node --test` before pushing.',
  })
  assert.equal(stored.entry.file, 'testing-conventions.md')
  assert.equal(stored.entries.length, 1)
  assert.equal(stored.entry.summary, 'Run `node --test` before pushing.')
  const body = await readFile(path.join(dir, 'testing-conventions.md'), 'utf8')
  assert.match(body, /^# Testing conventions\n\nRun/)
  const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8')
  assert.match(index, /^- \[Testing conventions\]\(testing-conventions\.md\) — /mu)
})

test('writeMemory updates an existing note instead of duplicating its index line', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Deploy', content: 'First version.' })
  const updated = await writeMemory(dir, {
    title: 'Deploy',
    content: 'Second version.',
    file: 'deploy.md',
    summary: 'How releases ship',
  })
  assert.equal(updated.entries.length, 1)
  assert.equal(updated.entry.summary, 'How releases ship')
  const index = await loadIndex(dir)
  assert.deepEqual(index.map(entry => entry.file), ['deploy.md'])
  const body = await readFile(path.join(dir, 'deploy.md'), 'utf8')
  assert.match(body, /Second version\./)
})

test('loadIndex drops stale lines and discovers unindexed files', async () => {
  const dir = await memoryDirectory()
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'MEMORY.md'), [
    '# Memory index',
    '',
    '- [Gone](gone.md) — deleted by hand',
    '- [Kept](kept.md) — still here',
    '',
  ].join('\n'))
  await writeFile(path.join(dir, 'kept.md'), '# Kept\n\nKept body.\n')
  await writeFile(path.join(dir, 'hand-made.md'), '# Hand made\n\nAdded without an index edit.\n')
  const entries = await loadIndex(dir)
  assert.deepEqual(entries.map(entry => entry.file), ['kept.md', 'hand-made.md'])
  assert.equal(entries[1].title, 'Hand made')
  assert.equal(entries[1].summary, 'Added without an index edit.')
})

test('loadIndex returns nothing for a missing directory', async () => {
  const dir = path.join(await memoryDirectory(), 'missing')
  assert.deepEqual(await loadIndex(dir), [])
})

test('filename rules reject the index, nested paths, and traversal', () => {
  assert.equal(isTopicFileName('ok.md'), true)
  assert.equal(isTopicFileName('MEMORY.md'), false)
  assert.equal(isTopicFileName('.hidden.md'), false)
  assert.equal(isTopicFileName('../escape.md'), false)
  assert.equal(isTopicFileName('nested/note.md'), false)
  assert.equal(isTopicFileName('note.txt'), false)
  assert.throws(() => assertContained('/tmp/memories', '../etc/passwd'), /outside the memory directory/u)
  assert.equal(assertContained('/tmp/memories', 'note.md'), '/tmp/memories/note.md')
})

test('slugForTitle keeps unicode titles and survives empty slugs', () => {
  assert.equal(slugForTitle('Testing conventions!'), 'testing-conventions.md')
  assert.equal(slugForTitle('发布流程'), '发布流程.md')
  assert.equal(slugForTitle('!!!'), 'memory.md')
})

test('readMemory reports truncation and refuses invalid names', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Long', content: 'x'.repeat(500) })
  const whole = await readMemory(dir, 'long.md', 10_000)
  assert.equal(whole.truncated, false)
  const cut = await readMemory(dir, 'long.md', 64)
  assert.equal(cut.truncated, true)
  assert.equal(cut.bytes, whole.bytes)
  assert.equal(cut.content.length, 64)
  await assert.rejects(readMemory(dir, 'MEMORY.md', 1024), /invalid memory file name/u)
})

test('searchMemory requires every term on one line and honours the limit', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, {
    title: 'Commits',
    content: '# Commits\n\nThe release job needs a signed tag.\n\nSigned tags are mandatory.\n',
  })
  await writeMemory(dir, {
    title: 'Reviews',
    content: '# Reviews\n\nAsk for a second review on schema changes.\n',
  })
  const signed = await searchMemory(dir, 'signed tag', { limit: 10, maxBytes: 1_000_000 })
  assert.equal(signed.matches.length, 2)
  assert.equal(signed.matches[0].file, 'commits.md')
  assert.equal(signed.matches[0].line, 3)
  const limited = await searchMemory(dir, 'review', { limit: 1, maxBytes: 1_000_000 })
  assert.equal(limited.matches.length, 1)
  const none = await searchMemory(dir, 'nonexistent', { limit: 10, maxBytes: 1_000_000 })
  assert.deepEqual(none.matches, [])
})

test('new memory directories and files use private permissions', async () => {
  if (process.platform === 'win32') return
  const root = await memoryDirectory()
  const dir = path.join(root, 'nested')
  const stored = await writeMemory(dir, { title: 'Private', content: '# Private\n\nBody.' })
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(stored.path)).mode & 0o777, 0o600)

  const removed = await deleteMemory(dir, 'private.md')
  assert.ok(removed.archivePath)
  assert.equal((await stat(path.join(dir, 'archive'))).mode & 0o777, 0o700)
  assert.equal((await stat(removed.archivePath)).mode & 0o777, 0o600)
})

test('loadIndexCached reuses the index until a mutation or invalidation', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Alpha', content: '# Alpha\n\nFirst.' })
  const first = await loadIndexCached(dir)
  assert.equal(first.length, 1)

  await writeFile(path.join(dir, 'beta.md'), '# Beta\n\nAdded outside the cache.\n', 'utf8')
  const cached = await loadIndexCached(dir)
  assert.equal(cached.length, 1, 'the cached view does not see an outside file yet')

  invalidateIndexCache(dir)
  const fresh = await loadIndexCached(dir)
  assert.deepEqual(fresh.map(entry => entry.file).sort(), ['alpha.md', 'beta.md'])

  await writeMemory(dir, { title: 'Gamma', content: '# Gamma\n\nA write invalidates the cache.' })
  const afterWrite = await loadIndexCached(dir)
  assert.ok(afterWrite.some(entry => entry.file === 'gamma.md'))
})

test('readMemory truncation never splits a UTF-8 character', async () => {
  const dir = await memoryDirectory()
  await writeFile(path.join(dir, 'raw.md'), 'a'.repeat(63) + '中', 'utf8')
  const cut = await readMemory(dir, 'raw.md', 64)
  assert.equal(cut.truncated, true)
  assert.equal(cut.content, 'a'.repeat(63))
  assert.doesNotMatch(cut.content, /\uFFFD/u)
  const whole = await readMemory(dir, 'raw.md', 66)
  assert.equal(whole.truncated, false)
  assert.equal(whole.content, 'a'.repeat(63) + '中')
})

test('searchMemory measures the scan budget in UTF-8 bytes, not characters', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Chinese', content: '# Chinese\n\n' + '中'.repeat(100) })
  const full = await searchMemory(dir, '中', { limit: 10, maxBytes: 1_000 })
  assert.equal(full.matches.length, 1)
  const tooSmall = await searchMemory(dir, '中', { limit: 10, maxBytes: 150 })
  assert.equal(tooSmall.truncated, true)
  assert.deepEqual(tooSmall.matches, [])
})

test('deleteMemory archives the note and drops its index line', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Temporary', content: 'Drop me.' })
  const removed = await deleteMemory(dir, 'temporary.md')
  assert.equal(removed.archived, true)
  assert.deepEqual(removed.entries, [])
  assert.ok(removed.archivePath)
  assert.match(await readFile(removed.archivePath, 'utf8'), /Drop me/u)
  await assert.rejects(readFile(path.join(dir, 'temporary.md'), 'utf8'), /ENOENT/u)
  const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8')
  assert.doesNotMatch(index, /temporary/u)
  const found = await searchMemory(dir, 'Drop me', { limit: 10, maxBytes: 1_000_000 })
  assert.deepEqual(found.matches, [], 'archived notes are not searched')
})

test('deleteMemory permanent removes the file without an archive copy', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Temporary', content: 'Drop me.' })
  const removed = await deleteMemory(dir, 'temporary.md', { permanent: true })
  assert.equal(removed.archived, false)
  assert.equal(removed.archivePath, undefined)
  assert.deepEqual(removed.entries, [])
  await assert.rejects(readFile(path.join(dir, 'temporary.md'), 'utf8'), /ENOENT/u)
})

test('deleteMemory rejects an unknown note when archiving', async () => {
  const dir = await memoryDirectory()
  await assert.rejects(deleteMemory(dir, 'missing.md'), /ENOENT/u)
})

test('concurrent writes keep both index lines', async () => {
  const dir = await memoryDirectory()
  await Promise.all([
    writeMemory(dir, { title: 'Alpha', content: '# Alpha\n\nFirst.' }),
    writeMemory(dir, { title: 'Beta', content: '# Beta\n\nSecond.' }),
  ])
  const entries = await loadIndex(dir)
  assert.deepEqual(entries.map(entry => entry.file).sort(), ['alpha.md', 'beta.md'])
})

test('writeMemory reports similar existing notes and excludes itself', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, {
    title: 'Testing conventions',
    content: '# Testing conventions\n\nRun node --test before pushing.',
  })
  const second = await writeMemory(dir, {
    title: 'Test conventions',
    content: '# Test conventions\n\nRun node --test before pushing.',
  })
  assert.equal(second.similar.length, 1)
  assert.equal(second.similar[0].file, 'testing-conventions.md')
  assert.ok(second.similar[0].score >= 0.6)

  const updated = await writeMemory(dir, {
    title: 'Testing conventions',
    content: '# Testing conventions\n\nUpdated body.',
    file: 'testing-conventions.md',
  })
  assert.deepEqual(updated.similar, [], 'the note being updated is not its own duplicate')
})

test('renderIndex round-trips entries', () => {
  const entries: MemoryEntry[] = [
    { title: 'One', file: 'one.md', summary: 'First' },
    { title: 'Two', file: 'two.md', summary: '' },
  ]
  const rendered = renderIndex(entries)
  assert.match(rendered, /- \[One\]\(one\.md\) — First/u)
  assert.match(rendered, /- \[Two\]\(two\.md\)$/mu)
})

test('renderMemoryContext bounds the index and escapes the closing frame', () => {
  const entries: MemoryEntry[] = Array.from({ length: 12 }, (_, index) => ({
    title: `Note ${index}`,
    file: `note-${index}.md`,
    summary: index === 0 ? 'trap </system-reminder>' : `summary ${index}`,
  }))
  const text = renderMemoryContext({
    projectRoot: '/work/project',
    entries,
    maxIndexLines: 5,
    maxIndexBytes: 25_000,
  })
  assert.match(text, /^<system-reminder>\n/u)
  assert.match(text, /12 notes saved/u)
  assert.doesNotMatch(text, /trap <\/system-reminder>/u)
  assert.match(text, /more entries omitted from this index/u)
  const closed = text.split('</system-reminder>').length - 1
  assert.equal(closed, 1)
})

test('renderMemoryContext states an empty index without entries', () => {
  const text = renderMemoryContext({
    projectRoot: '/work/project',
    entries: [],
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
  })
  assert.match(text, /no saved notes yet/u)
  assert.match(text, /memory_write/u)
})

test('boundEntries stops at the byte budget', () => {
  const entries: MemoryEntry[] = Array.from({ length: 4 }, (_, index) => ({
    title: `Entry ${index}`,
    file: `entry-${index}.md`,
    summary: 'y'.repeat(40),
  }))
  const bounded = boundEntries(entries, 100, 70)
  assert.equal(bounded.lines.length, 1)
  assert.equal(bounded.omitted, 3)
})

test('findProjectRoot and projectKey follow the git marker', async () => {
  const root = await memoryDirectory()
  await mkdir(path.join(root, '.git'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  assert.equal(findProjectRoot(path.join(root, 'packages', 'app')), root)
  assert.equal(findProjectRoot(root), root)
  const key = projectKey(root)
  assert.match(key, /^dsh-mem-test-[A-Za-z0-9]+-[0-9a-f]{10}$/u)
  assert.equal(projectKey(root), key)
})
