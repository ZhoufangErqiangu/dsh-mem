/**
 * Atomic text-file publication.
 *
 * Write a sibling temporary file and rename it over the target, so a crash
 * leaves either the old contents or the complete new contents. The temporary
 * name includes the pid and a random suffix to avoid concurrent collisions.
 *
 * @module @local/dsh-memory/atomic
 */

import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'

/**
 * Publish one file atomically.
 * @param file - absolute target path.
 * @param text - complete contents.
 */
export async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  }
  catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
