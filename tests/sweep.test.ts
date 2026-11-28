import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { archiveFileName, rememberArchive } from '../src/archive.ts'
import { deleteMemory, restoreMemory, writeMemory } from '../src/store.ts'
import { sweepMemory } from '../src/sweep.ts'
import type { SweepOptions } from '../src/types.ts'

const scratch: string[] = []

async function memoryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-mem-sweep-'))
  scratch.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    dryRun: true,
    archiveOverflow: false,
    archiveMaxAgeDays: 30,
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    ...overrides,
  }
}

async function seedSweepable(dir: string): Promise<void> {
  const alpha = await writeMemory(dir, { title: 'Alpha', file: 'alpha.md', content: '# Same\n\nBody.' })
  const beta = await writeMemory(dir, { title: 'Beta', file: 'beta.md', content: '# Same\n\nBody.' })
  // Make the duplicate winner deterministic rather than depending on write timing.
  const older = new Date(Date.now() - 60_000)
  await utimes(alpha.path, older, older)
  await utimes(beta.path, new Date(), new Date())
  await writeFile(path.join(dir, 'empty.md'), '', 'utf8')
  const old = new Date(Date.now() - 2 * 3_600_000)
  await writeFile(path.join(dir, 'old.tmp'), 'old', 'utf8')
  await utimes(path.join(dir, 'old.tmp'), old, old)
  await writeFile(path.join(dir, 'new.tmp'), 'new', 'utf8')
}

test('sweep dry-run predicts empty, duplicate, and temp cleanup without changing files', async () => {
  const dir = await memoryDirectory()
  await seedSweepable(dir)
  const report = await sweepMemory(dir, options())
  assert.equal(report.dryRun, true)
  assert.deepEqual(report.archived.map(item => item.file).sort(), ['alpha.md', 'empty.md'])
  assert.deepEqual(report.removedTemps, ['old.tmp'])
  assert.equal(report.after.notes, 1)
  assert.equal(report.indexRewritten, true)
  await access(path.join(dir, 'alpha.md'))
  await access(path.join(dir, 'empty.md'))
  await access(path.join(dir, 'old.tmp'))
  await assert.rejects(access(report.archived[0].archivePath), /ENOENT/u)
})

test('sweep applies cleanup, keeps the newest duplicate, and removes only old temps', async () => {
  const dir = await memoryDirectory()
  await seedSweepable(dir)
  const report = await sweepMemory(dir, options({ dryRun: false }))
  assert.equal(report.dryRun, false)
  assert.equal(report.after.notes, 1)
  assert.deepEqual(report.archived.map(item => item.file).sort(), ['alpha.md', 'empty.md'])
  assert.deepEqual(report.removedTemps, ['old.tmp'])
  assert.equal((await readFile(path.join(dir, 'beta.md'), 'utf8')).includes('Body.'), true)
  await assert.rejects(access(path.join(dir, 'alpha.md')), /ENOENT/u)
  await assert.rejects(access(path.join(dir, 'empty.md')), /ENOENT/u)
  await assert.rejects(access(path.join(dir, 'old.tmp')), /ENOENT/u)
  await access(path.join(dir, 'new.tmp'))
  const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8')
  assert.match(index, /beta\.md/u)
  assert.doesNotMatch(index, /alpha\.md|empty\.md/u)
  for (const item of report.archived) await access(item.archivePath)
})

test('sweep previews and applies archive retention without touching younger archives', async () => {
  const dir = await memoryDirectory()
  const oldName = '20200101T000000Z-old-aaaa.md'
  const newName = archiveFileName('new.md')
  await mkdir(path.join(dir, 'archive'), { recursive: true })
  await writeFile(path.join(dir, 'archive', oldName), 'old archive', 'utf8')
  await writeFile(path.join(dir, 'archive', newName), 'new archive', 'utf8')
  await rememberArchive(dir, oldName, 'old.md')
  await rememberArchive(dir, newName, 'new.md')

  const preview = await sweepMemory(dir, options({ dryRun: true }))
  assert.deepEqual(preview.removedArchives, [oldName])
  await access(path.join(dir, 'archive', oldName))

  const disabled = await sweepMemory(dir, options({ dryRun: true, archiveMaxAgeDays: 0 }))
  assert.deepEqual(disabled.removedArchives, [])

  const applied = await sweepMemory(dir, options({ dryRun: false }))
  assert.deepEqual(applied.removedArchives, [oldName])
  await assert.rejects(access(path.join(dir, 'archive', oldName)), /ENOENT/u)
  await access(path.join(dir, 'archive', newName))
  const manifest = JSON.parse(await readFile(path.join(dir, 'archive', '.manifest.json'), 'utf8')) as Record<string, string>
  assert.equal(manifest[oldName], undefined)
  assert.equal(manifest[newName], 'new.md')
})

test('sweep rewrites a stale index even when no note is archived', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Kept', content: '# Kept\n\nBody.' })
  await writeFile(path.join(dir, 'MEMORY.md'), [
    '# Memory index',
    '',
    '- [Gone](gone.md) — stale line',
    '',
  ].join('\n'), 'utf8')
  const report = await sweepMemory(dir, options({ dryRun: false }))
  assert.equal(report.archived.length, 0)
  assert.equal(report.indexRewritten, true)
  const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8')
  assert.match(index, /kept\.md/u)
  assert.doesNotMatch(index, /gone\.md/u)
})

test('sweep archives the oldest notes when overflow archiving is enabled', async () => {
  const dir = await memoryDirectory()
  for (const name of ['one', 'two', 'three']) {
    await writeMemory(dir, { title: name, file: `${name}.md`, content: `# ${name}\n\nBody of ${name}.` })
  }
  const report = await sweepMemory(dir, options({ dryRun: false, archiveOverflow: true, maxIndexLines: 1 }))
  assert.equal(report.after.lines, 1)
  assert.ok(report.archived.every(item => item.reason === 'overflow'))
  assert.equal(report.archived.length, 2)
  assert.equal((await readFile(path.join(dir, 'MEMORY.md'), 'utf8')).split('\n').filter(line => line.startsWith('- ')).length, 1)
})

test('restoreMemory recovers the exact original name through the archive manifest', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Space note', file: 'my note.md', content: '# Space note\n\nBody.' })
  const removed = await deleteMemory(dir, 'my note.md')
  assert.equal(removed.archived, true)
  assert.ok(removed.archivePath)
  const restored = await restoreMemory(dir, path.basename(removed.archivePath))
  assert.equal(restored.file, 'my note.md')
  await access(path.join(dir, 'my note.md'))
  await assert.rejects(access(removed.archivePath), /ENOENT/u)
})

test('restoreMemory moves an archive back and refuses collisions or invalid names', async () => {
  const dir = await memoryDirectory()
  await seedSweepable(dir)
  const report = await sweepMemory(dir, options({ dryRun: false }))
  const alpha = report.archived.find(item => item.file === 'alpha.md')
  assert.ok(alpha)
  const archiveName = path.basename(alpha.archivePath)

  await writeFile(path.join(dir, 'alpha.md'), '# Existing\n\nCollision.', 'utf8')
  await assert.rejects(restoreMemory(dir, archiveName), /already exists/u)
  await rm(path.join(dir, 'alpha.md'))

  const restored = await restoreMemory(dir, archiveName)
  assert.equal(restored.file, 'alpha.md')
  assert.ok(restored.entries.some(entry => entry.file === 'alpha.md'))
  assert.match(await readFile(path.join(dir, 'alpha.md'), 'utf8'), /Same/u)

  await assert.rejects(restoreMemory(dir, '../alpha.md'), /invalid archive file name/u)
  await assert.rejects(restoreMemory(dir, 'not-an-archive.md'), /invalid archive file name/u)
})
