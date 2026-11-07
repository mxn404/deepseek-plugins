/**
 * The switch's claim on a copy.
 *
 * "This copy was created by the switch for this session" used to live only in
 * host memory, so a host restart turned every copy into a stranger and the
 * leave path could never prove it was safe to undo. The claim is now stored in
 * the checkout's own Git administration directory: it travels with the copy,
 * vanishes when the copy is deleted, never appears in the working tree, and
 * survives a restart. A missing or unparseable marker means "not owned" — the
 * plugin does not guess, because guessing wrong deletes work.
 * @module dsh-worktree-switch/host/ownership
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { absoluteGitDir } from './git.ts'

/** File name inside the checkout's admin directory. */
const MARKER_FILE = 'dsh-worktree-switch.json'

/** What the switch records about one copy it created. */
export interface Ownership {
  /** Session the copy was created for. */
  readonly sessionId: string
  /** When the copy was created, in milliseconds since the epoch. */
  readonly createdAt: number
  /** Commit the copy started from; any other tip means the copy has commits. */
  readonly baseCommit: string
}

/**
 * Read one checkout's ownership marker.
 *
 * Every failure — no admin directory, no marker, invalid JSON, a shape this
 * version does not understand — reads as "no claim". The leave path treats
 * that as a reason to keep the copy, never as a reason to take it.
 * @param ctx - Host context carrying the subprocess provider.
 * @param checkout - absolute directory of the copy.
 * @param signal - caller cancellation.
 * @returns the recorded claim, or null when there is none.
 */
export async function readOwnership(
  ctx: Context,
  checkout: string,
  signal?: AbortSignal,
): Promise<Ownership | null> {
  try {
    const directory = await absoluteGitDir(ctx, checkout, signal)
    const raw = await readFile(join(directory, MARKER_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const { sessionId, createdAt, baseCommit } = record
    if (typeof sessionId !== 'string' || sessionId === '') return null
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
    if (typeof baseCommit !== 'string' || baseCommit === '') return null
    return { sessionId, createdAt, baseCommit }
  } catch {
    return null
  }
}

/**
 * Record the switch's claim on a freshly created copy.
 * @param ctx - Host context carrying the subprocess provider.
 * @param checkout - absolute directory of the copy.
 * @param ownership - the claim to write.
 * @param signal - caller cancellation.
 * @throws when the admin directory cannot be resolved or the marker cannot be written.
 */
export async function writeOwnership(
  ctx: Context,
  checkout: string,
  ownership: Ownership,
  signal?: AbortSignal,
): Promise<void> {
  const directory = await absoluteGitDir(ctx, checkout, signal)
  await writeFile(join(directory, MARKER_FILE), `${JSON.stringify(ownership)}\n`, 'utf8')
}
