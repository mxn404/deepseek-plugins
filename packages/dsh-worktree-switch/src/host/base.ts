/**
 * Where a new copy starts.
 *
 * Creation is the one place this plugin touches the network, and it does so as
 * a person-initiated action, not on behalf of a model turn: the browser asked
 * for a copy, so the host fetches the remote default branch itself instead of
 * borrowing a session's sandbox policy for it. This is the same class of action
 * as the panel's discard verb (see `./git.ts`).
 *
 * The fetch is deliberately best-effort. A stale remote, an unreachable host,
 * or a clone without a default branch must never turn the switch into a dead
 * end, so every failure falls back to the local HEAD — the only case the
 * browser half reports as degraded is "there is a remote and a default branch,
 * yet fetching it failed".
 * @module dsh-worktree-switch/host/base
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BaseRef, PrepareBase } from '../types.ts'
import { runGit } from './git.ts'

/** Whole-command deadline for the plugin's one network call. */
const FETCH_TIMEOUT_MS = 5_000

/** A chosen base and how it was chosen. */
export interface BaseOutcome {
  /** Revision handed to the worktree service's `from` field. */
  readonly from: string
  /** Where `from` came from; only `fallback` is surfaced to the user. */
  readonly base: PrepareBase
}

/** Local HEAD, used by `head` mode and by every silent failure. */
const LOCAL_HEAD: BaseOutcome = { from: 'HEAD', base: { kind: 'head' } }

/**
 * Resolve the default branch `origin` advertises, if it has one.
 *
 * `origin/HEAD` is the clone's own answer; clones that lost it still commonly
 * default to `main` or `master`, so those two are probed before giving up. A
 * repository with no `origin` is a normal local-only project, not a failure:
 * the caller skips fetching entirely and leaves no notice behind.
 * @param ctx - Host context carrying the subprocess provider.
 * @param root - canonical repository root to ask.
 * @param signal - caller cancellation.
 * @returns the branch name without its `origin/` prefix, or null.
 */
async function defaultBranch(ctx: Context, root: string, signal?: AbortSignal): Promise<string | null> {
  const remote = await runGit(ctx, root, ['remote', 'get-url', 'origin'], {
    signal,
    allowedExitCodes: [0, 1, 2],
  })
  if (remote.exitCode !== 0 || remote.stdout.trim() === '') return null
  const symbolic = await runGit(ctx, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    signal,
    // 128 is what Git uses for "not a symbolic ref", which is the common case
    // for a clone whose remote-tracking HEAD was never created.
    allowedExitCodes: [0, 1, 128],
  })
  if (symbolic.exitCode === 0) {
    const name = symbolic.stdout.trim()
    if (name.startsWith('origin/') && name.length > 'origin/'.length) {
      return name.slice('origin/'.length)
    }
  }
  for (const candidate of ['main', 'master']) {
    const known = await runGit(ctx, root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], {
      signal,
      allowedExitCodes: [0, 1],
    })
    if (known.exitCode === 0 && known.stdout.trim() !== '') return candidate
  }
  return null
}

/**
 * Choose the base commit for a copy that is about to be created.
 *
 * `head` mode never touches the network. `fresh` mode fetches only the default
 * branch, with an explicit refspec so a rewritten `remote.origin.fetch` cannot
 * silently skip the update, and returns the fetched commit itself rather than
 * the ref name: another process may advance the ref between the fetch and the
 * worktree service's checkout.
 * @param ctx - Host context carrying the subprocess provider.
 * @param root - canonical repository root the fetch runs in.
 * @param baseRef - configured base point.
 * @param signal - caller cancellation; distinct from the fetch deadline.
 * @returns the revision to create from and the outcome to report.
 * @throws when the caller cancels; every Git failure is contained.
 */
export async function resolveBase(
  ctx: Context,
  root: string,
  baseRef: BaseRef,
  signal?: AbortSignal,
): Promise<BaseOutcome> {
  if (baseRef === 'head') return LOCAL_HEAD
  let branch: string | null
  try {
    branch = await defaultBranch(ctx, root, signal)
  } catch {
    // Not knowing whether a remote exists is not the same as knowing one
    // failed: stay silent rather than claim a degraded fetch.
    signal?.throwIfAborted()
    return LOCAL_HEAD
  }
  if (branch === null) return LOCAL_HEAD
  try {
    await runGit(
      ctx,
      root,
      ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { signal, timeoutMs: FETCH_TIMEOUT_MS },
    )
    const resolved = await runGit(ctx, root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], {
      signal,
    })
    const from = resolved.stdout.trim()
    if (from === '') throw new Error(`origin/${branch} has no commit after fetching it`)
    return { from, base: { kind: 'remote', branch } }
  } catch {
    // A cancelled request is not a degraded fetch: let the caller's abort win
    // instead of quietly creating a copy from HEAD after the user left.
    signal?.throwIfAborted()
    return { from: 'HEAD', base: { kind: 'fallback' } }
  }
}
