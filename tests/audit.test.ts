import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { auditMemory } from '../src/audit.ts'
import { writeMemory } from '../src/store.ts'
import type { AuditOptions } from '../src/types.ts'

const scratch: string[] = []

async function memoryDirectory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-mem-audit-'))
  scratch.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })))
})

function options(overrides: Partial<AuditOptions> = {}): AuditOptions {
  return {
    staleDays: 90,
    threshold: 0.6,
    limit: 10,
    verbose: false,
    maxNotes: 200,
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    oversizeBytes: 16_384,
    ...overrides,
  }
}

test('audit reports notes with identical bodies as one identical cluster', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Alpha', content: '# Same\n\nShared body.' })
  await writeMemory(dir, { title: 'Beta', content: '# Same\n\nShared body.' })
  const report = await auditMemory(dir, '/work/project', options())
  assert.equal(report.notes, 2)
  assert.equal(report.duplicates.length, 1)
  assert.equal(report.duplicates[0].kind, 'identical')
  assert.deepEqual(report.duplicates[0].files, ['alpha.md', 'beta.md'])
  assert.equal(report.duplicates[0].score, 1)
})

test('audit reports near-duplicate English notes', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, {
    title: 'Testing conventions',
    content: '# Testing conventions\n\nRun node --test before pushing changes.',
  })
  await writeMemory(dir, {
    title: 'Test conventions',
    content: '# Test conventions\n\nRun node --test before pushing every change.',
  })
  const report = await auditMemory(dir, '/work/project', options({ threshold: 0.5 }))
  const group = report.duplicates.find(candidate => candidate.kind === 'near')
  assert.ok(group, 'expected a near-duplicate cluster')
  assert.deepEqual(group.files, ['test-conventions.md', 'testing-conventions.md'])
})

test('audit reports near-duplicate Chinese notes through bigrams', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, {
    title: '发布流程',
    content: '# 发布流程\n\n先打标签再发布到生产环境。',
  })
  await writeMemory(dir, {
    title: '发布步骤',
    content: '# 发布步骤\n\n先打标签后发布到生产环境。',
  })
  const report = await auditMemory(dir, '/work/project', options({ threshold: 0.4 }))
  const group = report.duplicates.find(candidate => candidate.kind === 'near')
  assert.ok(group, 'expected a near-duplicate cluster')
  assert.equal(group.files.length, 2)
})

test('audit reports same-title notes and keeps them separate from exact duplicates', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Deploy', file: 'deploy-a.md', content: '# Deploy\n\nBlue-green releases.' })
  await writeMemory(dir, { title: 'Deploy', file: 'deploy-b.md', content: '# Deploy\n\nCanary releases with a rollback.' })
  const report = await auditMemory(dir, '/work/project', options())
  assert.equal(report.duplicates.length, 1)
  assert.equal(report.duplicates[0].kind, 'same-title')
})

test('audit reports stale and oversized notes', async () => {
  const dir = await memoryDirectory()
  const old = await writeMemory(dir, {
    title: 'Old plan',
    content: '# Old plan\n\nThis decision was superseded.',
  })
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
  await utimes(old.path, tenDaysAgo, tenDaysAgo)
  await writeMemory(dir, {
    title: 'Huge note',
    content: `# Huge note\n\n${'x'.repeat(2_000)}`,
  })

  const report = await auditMemory(dir, '/work/project', options({ staleDays: 1, oversizeBytes: 1_024 }))
  assert.deepEqual(report.stale.map(note => note.file), ['old-plan.md'])
  assert.ok(report.stale[0].ageDays >= 10)
  assert.deepEqual(report.oversized.map(note => note.file), ['huge-note.md'])
})

test('audit reports index budget pressure', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'One', content: '# One\n\nFirst.' })
  await writeMemory(dir, { title: 'Two', content: '# Two\n\nSecond.' })
  const report = await auditMemory(dir, '/work/project', options({ maxIndexLines: 1 }))
  assert.equal(report.budget.overBudget, true)
  assert.equal(report.budget.omitted, 1)
  assert.equal(report.budget.usedLines, 1)
})

test('audit bounds each category and marks the report truncated', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Alpha', content: '# Same\n\nBody.' })
  await writeMemory(dir, { title: 'Beta', content: '# Same\n\nBody.' })
  await writeMemory(dir, { title: 'Gamma', content: '# Other\n\nDifferent body.' })
  await writeMemory(dir, { title: 'Delta', content: '# Other\n\nDifferent body.' })
  const report = await auditMemory(dir, '/work/project', options({ limit: 1 }))
  assert.equal(report.duplicates.length, 1)
  assert.equal(report.truncated, true)
})

test('audit returns the note list only when verbose and marks hand-added files', async () => {
  const dir = await memoryDirectory()
  await writeMemory(dir, { title: 'Indexed', content: '# Indexed\n\nBody.' })
  await writeFile(path.join(dir, 'hand-added.md'), '# Hand added\n\nNot in the index.\n', 'utf8')

  const quiet = await auditMemory(dir, '/work/project', options())
  assert.deepEqual(quiet.notesList, [])

  const verbose = await auditMemory(dir, '/work/project', options({ verbose: true }))
  assert.equal(verbose.notesList.length, 2)
  assert.equal(verbose.notesList.find(note => note.file === 'hand-added.md')?.indexed, false)
  assert.equal(verbose.notesList.find(note => note.file === 'indexed.md')?.indexed, true)
})
