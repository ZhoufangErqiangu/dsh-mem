/**
 * Filesystem locations for the memory store.
 *
 * A project's memories live outside the workspace, under the harness home, so
 * they survive repository checkouts and never show up in `git status`. The
 * directory name carries a readable project basename plus a short hash of the
 * absolute root, so two checkouts with the same basename stay separate.
 *
 * @module @local/dsh-memory/paths
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** The index file naming every memory of one project. */
export const INDEX_FILE = 'MEMORY.md'

/**
 * Resolve the harness home holding durable user state.
 * @param env - process environment, injectable for tests.
 * @returns the absolute harness home, `$DSH_HOME` or `~/.dsh`.
 */
export function dshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? path.resolve(configured) : path.join(homedir(), '.dsh')
}

/**
 * Find the project root above a working directory.
 *
 * The nearest ancestor holding `.git`, mirroring how DSH itself marks project
 * roots, so memory scopes line up with instruction scopes. A directory without
 * any marker keeps its own scope, which is the working directory.
 * @param cwd - absolute working directory of the session.
 * @returns the absolute project root.
 */
export function findProjectRoot(cwd) {
  const start = path.resolve(cwd)
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/**
 * Build the stable directory name for one project root.
 * @param projectRoot - absolute project root.
 * @returns a filename-safe key such as `dsh-mem-1a2b3c4d5e`.
 */
export function projectKey(projectRoot) {
  const root = path.resolve(projectRoot)
  const base = path.basename(root)
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64) || 'project'
  const digest = createHash('sha1').update(root).digest('hex').slice(0, 10)
  return `${base}-${digest}`
}

/**
 * Resolve the memory directory of one project.
 * @param projectRoot - absolute project root.
 * @param home - harness home; defaults to {@link dshHome}.
 * @returns the absolute memory directory.
 */
export function memoryDir(projectRoot, home = dshHome()) {
  return path.join(home, 'memory', projectKey(projectRoot))
}

/**
 * Resolve a child path and refuse anything escaping its root.
 * @param root - directory the result must stay inside.
 * @param candidate - relative or absolute path to resolve.
 * @returns the absolute, contained path.
 * @throws Error when the resolved path leaves the root.
 */
export function assertContained(root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`refusing path outside the memory directory: ${candidate}`)
  }
  return resolved
}

/**
 * Whether a name is one flat topic file this store may touch.
 * @param fileName - bare file name.
 * @returns true when the name is a plain `.md` file, never the index.
 */
export function isTopicFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) return false
  if (fileName === INDEX_FILE) return false
  if (fileName.startsWith('.')) return false
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return false
  if (fileName.includes('..')) return false
  return fileName.endsWith('.md')
}
