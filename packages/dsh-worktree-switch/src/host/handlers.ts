/**
 * The plugin's host Remote face: the verbs the browser half can call,
 * expressed against a live session and the checkouts on disk.
 *
 * This module is the seam the host tests drive directly. Everything below it —
 * Git, the worktree service, the sandbox policy it applies, and session
 * working-directory publication — belongs to the harness and is exercised by
 * its own tests.
 * @module dsh-worktree-switch/host/handlers
 */

import { chmod, lstat, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-working-directory'
import { isKeptLeftover } from '../types.ts'
import type {
  BaseRef,
  CopyRef,
  DiscardBranchValue,
  DiscardValue,
  KeptReason,
  ListValue,
  OrphanBranch,
  PrepareValue,
  ReleaseValue,
  ScopeValue,
  SessionScope,
  StatusValue,
  WorktreeItem,
  WorktreeRef,
} from '../types.ts'
import { resolveBase } from './base.ts'
import {
  canonicalPath,
  changedFileCount,
  currentBranch,
  GitFailure,
  listBranchRefs,
  listWorktreeRecords,
  repositoryRoot,
  revListCount,
  revParse,
  runGit,
} from './git.ts'
import type { GitResult, WorktreeRecord } from './git.ts'
import { isGeneratedName, isWorktreeName, worktreeName } from './naming.ts'
import { readOwnership, writeOwnership } from './ownership.ts'
import { contains } from './paths.ts'

/** Attempts at a fresh name before a creation failure becomes an error. */
const CREATE_ATTEMPTS = 3

/** Attempts at removing one clean copy before the failure is reported. */
const REMOVE_ATTEMPTS = 3

/** Delay before the second and third removal attempt; the first is immediate. */
const REMOVE_RETRY_DELAYS_MS: readonly number[] = [100, 250]

export type {
  CopyRef,
  DiscardBranchValue,
  DiscardValue,
  KeptReason,
  ListValue,
  OrphanBranch,
  PrepareValue,
  ReleaseValue,
  ScopeValue,
  SessionScope,
  StatusValue,
  WorktreeItem,
  WorktreeRef,
} from '../types.ts'

/** A failed verb, carrying the stable code the browser half switches on. */
export class WorktreeToggleError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - human-readable explanation.
   * @param details - extra machine-readable facts.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'WorktreeToggleError'
  }
}

/** How one refused checkout removal should be followed up. */
export type RemoveFailureKind = 'retryable' | 'fatal'

/**
 * Failure signatures a second attempt can survive: another process still holds
 * a file open, a read-only entry blocks the recursive delete, or a directory
 * could not be emptied on the first pass.
 *
 * Everything else is reported as-is. In particular a dirty checkout Git
 * refused and a locked worktree are signatures of a state a retry cannot
 * change, so they stay fatal.
 */
const RETRYABLE_REMOVE_SIGNATURES: readonly RegExp[] = [
  /permission denied/i,
  /\bEACCES\b/i,
  /\bEBUSY\b/i,
  /\bEPERM\b/i,
  /\bENOTEMPTY\b/i,
  /device or resource busy/i,
  /is in use/i,
  /being used by another process/i,
  /read-only/i,
  /access is denied/i,
]

/**
 * Classify one failed `git worktree remove` result.
 *
 * Only the error text carries the signature; the exit status does not (Git
 * uses 128 for many different refusals and other values for I/O failures).
 * @param result - the command's captured outcome.
 * @returns whether the removal is worth retrying.
 */
export function classifyRemoveFailure(result: GitResult): RemoveFailureKind {
  const detail = `${result.stderr}\n${result.stdout}`
  return RETRYABLE_REMOVE_SIGNATURES.some(signature => signature.test(detail)) ? 'retryable' : 'fatal'
}

/**
 * Whether one removal attempt reported that Git's registration is already gone.
 *
 * `git worktree remove` deletes the admin directory before it deletes the
 * checkout directory, so a failure in the second phase leaves a directory no
 * `worktree remove` can target any more.
 */
const NOT_A_WORKING_TREE = /is not a working tree/i

/**
 * Best-effort clear of the read-only bits in one directory tree.
 *
 * Native Windows refuses to unlink a file that another process holds open or
 * that carries the read-only attribute, and Git's recursive delete stops at the
 * first such entry. Clearing the bits is what a person would do by hand; this
 * walks the whole copy only on the retry path, and swallows every failure
 * because the retry reports the real reason.
 * @param path - directory to walk; a missing path is already the goal.
 */
async function clearReadOnlyBits(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return
  }
  if (info.isSymbolicLink()) return
  try {
    await chmod(path, info.isDirectory() ? 0o755 : 0o644)
  } catch {
    // Best effort: the retry below reports the real reason if this was it.
  }
  if (!info.isDirectory()) return
  let entries
  try {
    entries = await readdir(path)
  } catch {
    return
  }
  await Promise.all(entries.map(entry => clearReadOnlyBits(join(path, entry))))
}

/**
 * Run one `git worktree remove`, keeping a refused status as a result.
 * @param ctx - host context carrying the subprocess provider.
 * @param root - canonical repository root.
 * @param path - checkout directory to remove.
 * @param signal - caller cancellation.
 * @returns the captured outcome; cancellation and spawn failures still throw.
 */
async function tryRemoveWorktree(
  ctx: Context,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<GitResult> {
  try {
    return await runGit(ctx, root, ['worktree', 'remove', path], { signal })
  } catch (error) {
    if (error instanceof GitFailure) return error.result
    throw error
  }
}

/**
 * Whether a filesystem error just means the path is already gone.
 * @param error - the thrown value.
 * @returns true for `ENOENT`.
 */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Remove one clean checkout, retrying only the failures a second attempt can fix.
 *
 * The dirty guard ran before this: a checkout with content is never retried,
 * never force-removed, and Git's own validation would refuse it besides. What
 * can change between attempts is an open handle or a read-only entry, so those
 * are cleared and retried a bounded number of times. When Git already dropped
 * the registration and only the directory is left, the retry finishes that
 * directory instead of reporting a removal that never completed.
 * @param ctx - host context carrying the subprocess provider.
 * @param root - canonical repository root.
 * @param path - checkout directory to remove.
 * @param name - copy name, for the error details.
 * @param signal - caller cancellation.
 * @throws {WorktreeToggleError} with `worktree-remove-failed` and the real reason.
 */
async function removeCheckout(
  ctx: Context,
  root: string,
  path: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  let last: GitResult | undefined
  let lastLeftover: unknown
  let attempts = 0
  while (attempts < REMOVE_ATTEMPTS) {
    if (attempts > 0) {
      await clearReadOnlyBits(path)
      await sleep(REMOVE_RETRY_DELAYS_MS[attempts - 1] ?? 0, undefined, signal === undefined ? {} : { signal })
    }
    attempts += 1
    const result = await tryRemoveWorktree(ctx, root, path, signal)
    if (result.exitCode === 0) return
    last = result
    const detail = `${result.stderr}\n${result.stdout}`
    if (attempts > 1 && NOT_A_WORKING_TREE.test(detail)) {
      // Git already removed its registration before failing on the directory,
      // so the retry can only finish the leftover checkout.
      try {
        await rm(path, { recursive: true })
        return
      } catch (error) {
        if (isMissing(error)) return
        lastLeftover = error
        // The leftover got a distinct failure instead of a removal refusal;
        // the next attempt retries that filesystem operation, not Git's.
        continue
      }
    }
    if (classifyRemoveFailure(result) === 'fatal') break
  }
  const reasons: string[] = []
  if (last !== undefined) reasons.push(new GitFailure(['worktree', 'remove', path], last).message)
  if (lastLeftover !== undefined) {
    reasons.push(`the leftover checkout could not be removed: ${lastLeftover instanceof Error ? lastLeftover.message : String(lastLeftover)}`)
  }
  throw new WorktreeToggleError(
    'worktree-remove-failed',
    reasons.join('; '),
    { name, path, attempts },
  )
}

/** Row config the verbs read. */
export interface WorktreeToggleOptions {
  /** Default for a project nothing has remembered yet. */
  readonly defaultEnabled: boolean
  /** Commit a new copy starts from: the fetched remote default branch, or local HEAD. */
  readonly baseRef: BaseRef
  /**
   * Report what each verb learned about the session's copy, so the model-facing
   * scope hint can follow it without a second Git walk.
   * @param sessionId - wire session identity.
   * @param scope - the confirmed copy, or null when the session is not in one.
   */
  readonly onScope?: (sessionId: string, scope: SessionScope | null) => void
  /**
   * Read the copy the host already believes a session runs in, so the badge's
   * `scope` verb can answer without a Git walk.
   * @param sessionId - wire session identity.
   * @returns the remembered scope, or null when nothing is known.
   */
  readonly readScope?: (sessionId: string) => SessionScope | null
}

/** The host face the route layer exposes over the Connection fetch bridge. */
export interface WorktreeToggle {
  /**
   * Report whether the session's project can be isolated, and in what.
   * @param request - the calling session.
   * @param signal - caller cancellation.
   * @returns the status payload; `supported: false` is a normal answer.
   */
  status(request: { readonly sessionId: string }, signal?: AbortSignal): Promise<StatusValue>
  /**
   * Put the session into a fresh copy, creating it when necessary.
   * @param request - the calling session.
   * @param signal - caller cancellation.
   * @returns the created or already-present copy.
   * @throws {WorktreeToggleError} when the project cannot host a copy or Git refused.
   */
  prepare(request: { readonly sessionId: string }, signal?: AbortSignal): Promise<PrepareValue>
  /**
   * Put the session back in its project directory and undo the copy the switch
   * created for it, when that copy is provably untouched: owned, still at its
   * base commit, and clean. A copy with content, or one whose ownership cannot
   * be proven, is kept and reported with a reason.
   * @param request - the calling session.
   * @param signal - caller cancellation.
   * @returns the directory the session now runs in, the copy removed, and the
   * copy left on disk with the reason it stayed.
   * @throws {WorktreeToggleError} when the project cannot be resolved, the
   * session could not be moved back, or a delete this call attempted failed.
   */
  release(request: { readonly sessionId: string }, signal?: AbortSignal): Promise<ReleaseValue>
  /**
   * Report whether the session runs in a copy, without touching the source
   * checkout's status and without moving any directory.
   * @param request - the calling session.
   * @param signal - caller cancellation.
   * @returns the copy, its project root, and the copy's own uncommitted count.
   */
  scope(request: { readonly sessionId: string }, signal?: AbortSignal): Promise<ScopeValue>
  /**
   * List the copies under one project's pool, the leftover generated-name
   * branches with no checkout, and how many copies this host kept on leave.
   * @param request - any directory inside the project.
   * @param signal - caller cancellation.
   * @returns the project's cleanup picture, or `supported: false` for a non-repository path.
   */
  list(request: { readonly path: string }, signal?: AbortSignal): Promise<ListValue>
  /**
   * Delete one copy and, unless it is detached, its branch.
   * @param request - a directory inside the project, and the copy's name.
   * @param signal - caller cancellation.
   * @returns the removed copy's identity.
   * @throws {WorktreeToggleError} when the copy is missing, dirty, or Git refused.
   */
  discard(
    request: { readonly path: string; readonly name: string },
    signal?: AbortSignal,
  ): Promise<DiscardValue>
  /**
   * Delete one leftover branch that no checkout has.
   * @param request - a directory inside the project, and the branch name.
   * @param signal - caller cancellation.
   * @returns the deleted branch.
   * @throws {WorktreeToggleError} when the branch is not a generated name, is
   * checked out, or Git refused; an already-deleted branch is a success.
   */
  discardBranch(
    request: { readonly path: string; readonly branch: string },
    signal?: AbortSignal,
  ): Promise<DiscardBranchValue>
}

/**
 * The failure one refused branch delete reports.
 * @param branch - branch the verb tried to delete.
 * @param args - the Git command that refused, for the message.
 * @param result - its captured outcome.
 * @returns the error the browser half switches on.
 */
function branchDeleteFailure(branch: string, args: readonly string[], result: GitResult): WorktreeToggleError {
  return new WorktreeToggleError('branch-delete-failed', new GitFailure(args, result).message, { branch })
}

/** Normalize a browser-supplied path before any filesystem work. */
function absolutePath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new WorktreeToggleError('bad-request', 'a project path is required')
  return resolve(trimmed)
}

/**
 * The copy a session already runs in.
 *
 * A linked worktree is recognised from the checkout itself — its `.git` is a
 * file pointing back at the source repository, not a directory — rather than
 * from any configured pool path. The pool belongs to the harness worktree
 * service, so this plugin never needs a second copy of that setting: moving the
 * pool in the service's row config keeps every verb working.
 * @param ctx - host context carrying `subprocess`.
 * @param current - the session's committed working directory.
 * @param repositoryRoot - canonical root of the project's repository.
 * @param signal - caller cancellation.
 * @returns the copy's identity, or null when the directory is not one.
 */
async function worktreeAt(
  ctx: Context,
  current: string,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<CopyRef | null> {
  const path = await canonicalPath(current)
  if (path === repositoryRoot) return null
  const inside = relative(repositoryRoot, path)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
  const name = basename(path)
  if (!isWorktreeName(name)) return null
  try {
    if (!(await lstat(`${path}/.git`)).isFile()) return null
  } catch {
    return null
  }
  // The checkout's real branch, not its directory name: a detached copy has
  // none, and reporting the name as one would be a lie every surface repeats.
  return { name, path, branch: await currentBranch(ctx, path, signal) }
}

/**
 * Resolve the canonical root of the repository that contains a directory.
 * Git reports the spelling of the path it was given; the worktree service
 * publishes canonical paths, so both halves must agree on one spelling.
 * @param ctx - host context carrying `subprocess`.
 * @param directory - absolute directory inside the project.
 * @param signal - caller cancellation.
 * @returns the canonical repository root.
 */
async function repositoryOf(ctx: Context, directory: string, signal?: AbortSignal): Promise<string> {
  return canonicalPath(await repositoryRoot(ctx, directory, signal))
}

/**
 * Re-derive the copy one session runs in from its committed directory.
 *
 * A copy's root is the only linked checkout whose name matches the pool
 * convention, but a session may have changed into a directory *inside* the copy,
 * so ancestors are probed from the committed directory up to the project
 * anchor.
 * @param ctx - host context carrying `workingDirectory` and `subprocess`.
 * @param agent - live session owner.
 * @param signal - caller cancellation.
 * @returns the copy and project root, or null when the session is not in one.
 */
export async function detectSessionScope(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SessionScope | null> {
  const current = ctx.workingDirectory.get(agent.session)
  const anchor = agent.session.header.cwd ?? current
  if (current === anchor || !contains(anchor, current)) return null
  let root: string
  try {
    root = await repositoryOf(ctx, anchor, signal)
  } catch {
    return null
  }
  signal?.throwIfAborted()
  let probe = current
  for (;;) {
    const copy = await worktreeAt(ctx, probe, root, signal)
    if (copy !== null) return { worktree: copy, repositoryRoot: root }
    const parent = dirname(probe)
    if (probe === root || probe === anchor || parent === probe) return null
    probe = parent
  }
}

/**
 * The copy rows of one repository, newest first.
 *
 * A row whose checkout directory is gone is still a copy: Git keeps the
 * registration until it is pruned, and the panel offers the same discard for
 * it, marked as missing. A detached copy keeps `branch: null` so no verb can
 * ever mistake the directory name for a branch to delete.
 * @param ctx - host context carrying `subprocess`.
 * @param root - canonical repository root.
 * @param records - `git worktree list` records for the repository.
 * @param signal - caller cancellation.
 * @returns one row per copy under the project.
 */
async function copyItems(
  ctx: Context,
  root: string,
  records: readonly WorktreeRecord[],
  signal?: AbortSignal,
): Promise<WorktreeItem[]> {
  const items: WorktreeItem[] = []
  for (const record of records) {
    signal?.throwIfAborted()
    const path = await canonicalPath(record.path)
    // The repository's own checkout is the source, never a copy.
    if (path === root) continue
    const name = basename(path)
    if (!isWorktreeName(name)) continue
    let createdAt = 0
    let prunable = true
    try {
      const info = await stat(path)
      createdAt = Math.trunc(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs)
      prunable = false
    } catch {
      // The checkout directory is gone; Git still lists it until pruned.
    }
    const changedFiles = prunable ? 0 : await changedFileCount(ctx, path, signal)
    items.push({ name, path, branch: record.branch ?? null, createdAt, changedFiles, prunable })
  }
  items.sort((left, right) => right.createdAt - left.createdAt || left.name.localeCompare(right.name))
  return items
}

/**
 * Generated-name branches that no checkout holds.
 *
 * Deliberately narrow: only the names this plugin generates qualify, so an
 * ordinary feature branch never appears in a list whose only action is delete.
 * The commit count is what the source checkout's HEAD does not contain — a
 * branch whose work is fully merged reads as 0, which is the one safe signal.
 * @param ctx - host context carrying `subprocess`.
 * @param root - canonical repository root.
 * @param records - `git worktree list` records for the repository.
 * @param signal - caller cancellation.
 * @returns the leftover branches, newest commit first.
 */
async function orphanBranches(
  ctx: Context,
  root: string,
  records: readonly WorktreeRecord[],
  signal?: AbortSignal,
): Promise<OrphanBranch[]> {
  const checkedOut = new Set<string>()
  for (const record of records) {
    if (record.branch !== undefined) checkedOut.add(record.branch)
  }
  const orphans: OrphanBranch[] = []
  for (const ref of await listBranchRefs(ctx, root, signal)) {
    signal?.throwIfAborted()
    if (!isGeneratedName(ref.name) || checkedOut.has(ref.name)) continue
    let commits = 0
    try {
      commits = await revListCount(ctx, root, `HEAD..${ref.commit}`, signal)
    } catch {
      // An unborn HEAD (a repository with no commits) cannot answer; the
      // branch still lists, with nothing claimed about its size.
    }
    orphans.push({
      branch: ref.name,
      commits,
      subject: ref.subject,
      committedAt: ref.committedAt,
    })
  }
  orphans.sort(
    (left, right) => right.committedAt - left.committedAt || left.branch.localeCompare(right.branch),
  )
  return orphans
}

/** The wire identity of one listed copy; a detached copy keeps its null branch. */
function copyRef(item: WorktreeItem): CopyRef {
  return { name: item.name, path: item.path, branch: item.branch }
}

/**
 * Build the host face.
 * @param ctx - Host context with `agents`, `worktrees`, `workingDirectory`, and `subprocess`.
 * @param options - resolved row config.
 * @returns the verbs above.
 */
export function createWorktreeToggle(ctx: Context, options: WorktreeToggleOptions): WorktreeToggle {
  /** One in-flight preparation per session, so a double mount cannot create twice. */
  const pending = new Map<string, Promise<PrepareValue>>()
  /**
   * Copies this host instance kept when the switch was turned off because they
   * had content (or because deleting them failed), by repository root. A copy
   * left only because another session owns it is not one of these: it is still
   * listed as a copy, but it is not this host's leftover to clean up. A host
   * restart forgets the set; the panel's count then honestly drops back to
   * leftovers only.
   */
  const keptCopies = new Map<string, Set<string>>()

  const keep = (root: string, name: string): void => {
    const names = keptCopies.get(root) ?? new Set<string>()
    names.add(name)
    keptCopies.set(root, names)
  }

  const forget = (root: string, name: string): void => {
    keptCopies.get(root)?.delete(name)
  }

  const sessionOf = async (sessionId: string, signal?: AbortSignal): Promise<Agent> => {
    signal?.throwIfAborted()
    if (sessionId === '') throw new WorktreeToggleError('bad-request', 'a session id is required')
    const controller = ctx.get('sessionController')
    if (controller !== undefined) {
      const resolved = await controller.resolveAgent(sessionId as SessionId)
      if ('error' in resolved) {
        throw new WorktreeToggleError(resolved.error.code, resolved.error.message, {
          sessionId,
        })
      }
      return resolved.agent
    }
    const agent = ctx.agents.get(sessionId as SessionId)
    if (agent === undefined) {
      throw new WorktreeToggleError('session-not-found', `no live agent for session ${sessionId}`, {
        sessionId,
      })
    }
    return agent
  }

  const status = async (
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<StatusValue> => {
    const agent = await sessionOf(request.sessionId, signal)
    // The immutable creation directory is the project anchor; the committed
    // working directory may already be a copy this session entered.
    const startDirectory = agent.session.header.cwd ?? ctx.workingDirectory.get(agent.session)
    let root: string
    try {
      root = await repositoryOf(ctx, startDirectory, signal)
    } catch (error) {
      if (error instanceof GitFailure) {
        return { supported: false, reason: 'not-a-git-repository', defaultEnabled: options.defaultEnabled }
      }
      throw error
    }
    const current = ctx.workingDirectory.get(agent.session)
    signal?.throwIfAborted()
    const sourceDirty = await changedFileCount(ctx, root, signal)
    const copy = await worktreeAt(ctx, current, root, signal)
    options.onScope?.(request.sessionId, copy === null ? null : { worktree: copy, repositoryRoot: root })
    return {
      supported: true,
      repositoryRoot: root,
      sessionWorktree: copy,
      sourceDirty,
      defaultEnabled: options.defaultEnabled,
    }
  }

  const prepareOnce = async (
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<PrepareValue> => {
    const agent = await sessionOf(request.sessionId, signal)
    const current = await status(request, signal)
    if (!current.supported) {
      throw new WorktreeToggleError(
        'not-a-git-repository',
        'the session project is not inside a Git working tree',
      )
    }
    if (current.sessionWorktree !== null) {
      options.onScope?.(request.sessionId, {
        worktree: current.sessionWorktree,
        repositoryRoot: current.repositoryRoot,
      })
      return {
        state: 'existing',
        worktree: current.sessionWorktree,
        repositoryRoot: current.repositoryRoot,
        sourceDirty: current.sourceDirty,
      }
    }
    // Status anchors on the immutable creation directory, while the worktree
    // service creates relative to the session's CURRENT directory. Refuse to
    // create when the two name different repositories: a copy in the wrong
    // project would look like success and be worse than no copy.
    const working = ctx.workingDirectory.get(agent.session)
    const workingProject = await repositoryOf(ctx, working, signal)
    if (workingProject !== current.repositoryRoot) {
      throw new WorktreeToggleError(
        'session-moved',
        `this session now works in ${workingProject}, not in its project ${current.repositoryRoot}`,
        { repositoryRoot: current.repositoryRoot, workingProject },
      )
    }
    // The base is resolved once, before any name attempt: a fetch is the one
    // costly step here, and a name collision must not repeat it.
    const base = await resolveBase(ctx, current.repositoryRoot, options.baseRef, signal)
    let lastFailure: unknown
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      const name = worktreeName()
      try {
        const created = await ctx.worktrees.create(agent, { name, from: base.from }, signal)
        const worktree: WorktreeRef = { name: created.branch, path: created.path, branch: created.branch }
        // Record the claim where it survives a restart. No caller signal here:
        // the copy already exists and the session is already inside it, so
        // finishing this bookkeeping beats aborting half-done. A failed write
        // must not fail the creation either — the copy then reads as not-owned
        // later, is kept, and the notice says so.
        const baseCommit = await revParse(ctx, created.path, 'HEAD')
        if (baseCommit !== null) {
          try {
            await writeOwnership(ctx, created.path, {
              sessionId: request.sessionId,
              createdAt: Date.now(),
              baseCommit,
            })
          } catch {
            // Deliberately swallowed: see above.
          }
        }
        options.onScope?.(request.sessionId, { worktree, repositoryRoot: created.repositoryRoot })
        return {
          state: 'created',
          worktree,
          repositoryRoot: created.repositoryRoot,
          sourceDirty: current.sourceDirty,
          base: base.base,
        }
      } catch (error) {
        lastFailure = error
        const message = error instanceof Error ? error.message : String(error)
        // A name collision is the one failure a fresh name can fix. Everything
        // else (no commits yet, branch or path exists, Git missing) is reported
        // as-is: the caller must not be told "created" after a silent retry.
        if (!/already exists|worktree branch already exists|worktree path already exists/i.test(message)) {
          throw new WorktreeToggleError('worktree-create-failed', message, { name })
        }
      }
    }
    throw new WorktreeToggleError(
      'worktree-create-failed',
      `could not allocate a free worktree name after ${CREATE_ATTEMPTS} attempts`,
      { cause: lastFailure instanceof Error ? lastFailure.message : String(lastFailure) },
    )
  }

  const prepare = async (
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<PrepareValue> => {
    const running = pending.get(request.sessionId)
    if (running !== undefined) return running
    const operation = prepareOnce(request, signal)
    pending.set(request.sessionId, operation)
    try {
      return await operation
    } finally {
      if (pending.get(request.sessionId) === operation) pending.delete(request.sessionId)
    }
  }

  const scope = async (
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<ScopeValue> => {
    const agent = await sessionOf(request.sessionId, signal)
    const current = ctx.workingDirectory.get(agent.session)
    const known = options.readScope?.(request.sessionId) ?? null
    // The host's own memory answers first; the directory check only re-derives
    // when the session has moved somewhere memory does not explain.
    const found = known !== null && contains(known.worktree.path, current)
      ? known
      : await detectSessionScope(ctx, agent, signal)
    if (found === null) return { inWorktree: false }
    signal?.throwIfAborted()
    const changedFiles = await changedFileCount(ctx, found.worktree.path, signal)
    options.onScope?.(request.sessionId, found)
    return {
      inWorktree: true,
      worktree: found.worktree,
      repositoryRoot: found.repositoryRoot,
      changedFiles,
    }
  }

  const list = async (
    request: { readonly path: string },
    signal?: AbortSignal,
  ): Promise<ListValue> => {
    const directory = absolutePath(request.path)
    let root: string
    try {
      root = await repositoryOf(ctx, directory, signal)
    } catch (error) {
      if (error instanceof GitFailure) return { supported: false, reason: 'not-a-git-repository' }
      throw error
    }
    const records = await listWorktreeRecords(ctx, root, signal)
    const items = await copyItems(ctx, root, records, signal)
    const orphans = await orphanBranches(ctx, root, records, signal)
    const kept = keptCopies.get(root)
    // Only copies that still exist count: a kept copy someone deleted by hand
    // must not inflate the number the sidebar shows.
    const keptCopiesStillHere = kept === undefined
      ? 0
      : items.filter(item => kept.has(item.name)).length
    return { supported: true, repositoryRoot: root, items, orphans, keptCopies: keptCopiesStillHere }
  }

  /**
   * Delete one branch by name.
   * @param root - canonical repository root.
   * @param branch - branch to delete; already validated by the caller.
   * @param signal - caller cancellation.
   * @throws {WorktreeToggleError} when Git refused.
   */
  const deleteBranch = async (root: string, branch: string, signal?: AbortSignal): Promise<void> => {
    const deleted = await runGit(ctx, root, ['branch', '-D', '--', branch], {
      signal,
      allowedExitCodes: [0, 1],
    })
    // Status 1 with "not found" is the branch already being gone (removed by
    // hand between the read and the click); that is not a failed delete.
    const gone = deleted.exitCode === 1 && /not found/i.test(deleted.stderr)
    if (deleted.exitCode !== 0 && !gone) throw branchDeleteFailure(branch, ['branch', '-D', branch], deleted)
  }

  /**
   * Delete a branch a prunable copy still holds.
   *
   * `git branch -D` refuses while any worktree registration names the branch,
   * even a registration whose directory is gone, so the branch is removed
   * through the ref itself. The registration still pins Git's bookkeeping, but
   * nothing can have the branch checked out any more: the directory is missing.
   * @param root - canonical repository root.
   * @param branch - branch to delete; already validated by the caller.
   * @param signal - caller cancellation.
   * @throws {WorktreeToggleError} when Git refused (for example a locked ref).
   */
  const deleteBranchByRef = async (root: string, branch: string, signal?: AbortSignal): Promise<void> => {
    const deleted = await runGit(ctx, root, ['update-ref', '-d', `refs/heads/${branch}`], {
      signal,
      allowedExitCodes: [0, 1],
    })
    if (deleted.exitCode !== 0) {
      throw branchDeleteFailure(branch, ['update-ref', '-d', branch], deleted)
    }
  }

  /**
   * Delete one clean copy and, unless it is detached, its branch.
   *
   * Both the panel's discard and the switch's own undo go through here, so the
   * dirty guard and the delete order have one home. A prunable copy — its
   * directory was deleted by hand — deletes the branch first and prunes the
   * registration only once that succeeded, so a refused delete cannot leave the
   * registration already gone.
   * @param root - canonical repository root.
   * @param name - copy name; already validated by the caller.
   * @param signal - caller cancellation.
   * @returns the removed copy's identity.
   */
  const removeCopy = async (
    root: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<DiscardValue> => {
    const records = await listWorktreeRecords(ctx, root, signal)
    const items = await copyItems(ctx, root, records, signal)
    const item = items.find(entry => entry.name === name)
    if (item === undefined) {
      throw new WorktreeToggleError(
        'worktree-not-found',
        `no worktree named ${name} in ${root}`,
        { name, repositoryRoot: root },
      )
    }
    if (item.changedFiles > 0) {
      throw new WorktreeToggleError(
        'worktree-dirty',
        `${item.name} has ${item.changedFiles} uncommitted change(s); commit or discard them first`,
        { name: item.name, changedFiles: item.changedFiles },
      )
    }
    if (item.prunable) {
      if (item.branch !== null) await deleteBranchByRef(root, item.branch, signal)
      await runGit(ctx, root, ['worktree', 'prune'], { signal })
    } else {
      await removeCheckout(ctx, root, item.path, item.name, signal)
      if (item.branch !== null) await deleteBranch(root, item.branch, signal)
    }
    forget(root, item.name)
    return { removed: true, name: item.name, branch: item.branch, path: item.path }
  }

  const discard = async (
    request: { readonly path: string; readonly name: string },
    signal?: AbortSignal,
  ): Promise<DiscardValue> => {
    const directory = absolutePath(request.path)
    if (!isWorktreeName(request.name)) {
      throw new WorktreeToggleError('worktree-name-invalid', `not a worktree name: ${request.name}`)
    }
    const root = await repositoryOf(ctx, directory, signal)
    return await removeCopy(root, request.name, signal)
  }

  const discardBranch = async (
    request: { readonly path: string; readonly branch: string },
    signal?: AbortSignal,
  ): Promise<DiscardBranchValue> => {
    const directory = absolutePath(request.path)
    if (!isGeneratedName(request.branch)) {
      throw new WorktreeToggleError(
        'branch-name-invalid',
        `not a branch this plugin generated: ${request.branch}`,
      )
    }
    const root = await repositoryOf(ctx, directory, signal)
    const records = await listWorktreeRecords(ctx, root, signal)
    if (records.some(record => record.branch === request.branch)) {
      throw new WorktreeToggleError(
        'branch-in-use',
        `${request.branch} is checked out by a worktree; discard that copy instead`,
        { branch: request.branch },
      )
    }
    // Deleting a branch that is already gone is the second click of a double
    // click, not a failure: the caller's goal is reached either way.
    const known = new Set((await listBranchRefs(ctx, root, signal)).map(ref => ref.name))
    if (known.has(request.branch)) await deleteBranch(root, request.branch, signal)
    return { removed: true, branch: request.branch }
  }

  const release = async (
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<ReleaseValue> => {
    // A create may still be in flight for this session: undo after it settles,
    // so a switch turned off mid-creation cannot race the copy into existence.
    const running = pending.get(request.sessionId)
    if (running !== undefined) {
      try {
        await running
      } catch {
        // Creation failed and already moved nothing; there is nothing to undo.
      }
    }
    signal?.throwIfAborted()
    const agent = await sessionOf(request.sessionId, signal)
    const current = ctx.workingDirectory.get(agent.session)
    // The immutable creation directory anchors the project, exactly as status
    // does: the committed directory may already be a copy this session entered.
    const anchor = agent.session.header.cwd ?? current
    let root: string
    try {
      root = await repositoryOf(ctx, anchor, signal)
    } catch (error) {
      if (error instanceof GitFailure) {
        throw new WorktreeToggleError(
          'not-a-git-repository',
          'the session project is not inside a Git working tree',
        )
      }
      throw error
    }
    const records = await listWorktreeRecords(ctx, root, signal)
    const items = await copyItems(ctx, root, records, signal)
    const path = await canonicalPath(current)
    const item = items.find(entry => contains(entry.path, path))
    if (item === undefined) {
      options.onScope?.(request.sessionId, null)
      return { directory: current, removed: null, kept: null, keptReason: null }
    }
    const copy = copyRef(item)
    signal?.throwIfAborted()
    let directory: string
    try {
      directory = await ctx.workingDirectory.set(agent, anchor, signal)
    } catch (error) {
      throw new WorktreeToggleError(
        'release-failed',
        `could not move the session back to ${anchor}: ${error instanceof Error ? error.message : String(error)}`,
        { name: copy.name, path: copy.path },
      )
    }
    options.onScope?.(request.sessionId, null)
    const keepCopy = (reason: KeptReason, error?: string): ReleaseValue => {
      // Only copies with content are cleanup the sidebar should count. A copy
      // kept because another session owns it is not a leftover of this host.
      if (isKeptLeftover(reason)) keep(root, item.name)
      return error === undefined
        ? { directory, removed: null, kept: copy, keptReason: reason }
        : { directory, removed: null, kept: copy, keptReason: reason, error }
    }
    // Ownership, not memory, decides: the claim was written into the copy's own
    // admin directory when it was created, so a restarted host still knows.
    const ownership = await readOwnership(ctx, item.path, signal)
    if (ownership === null || ownership.sessionId !== request.sessionId) {
      return keepCopy('not-owned')
    }
    if (item.changedFiles > 0) {
      return keepCopy('dirty', `${item.changedFiles} uncommitted change(s)`)
    }
    // Nothing may have happened inside the copy for it to be undone: the tip
    // must still be the commit it was created from.
    const tip = await revParse(ctx, item.path, 'HEAD', signal)
    if (tip === null || tip !== ownership.baseCommit) {
      let commits = 0
      try {
        commits = await revListCount(ctx, item.path, `${ownership.baseCommit}..HEAD`, signal)
      } catch {
        // The base commit is gone (for example after a rebase); the copy still
        // has content this call cannot undo, so it stays.
      }
      return keepCopy('dirty', `${commits} new commit(s)`)
    }
    // From here on a failure is reported, never swallowed: the caller is not
    // told the switch is off while a delete it attempted silently failed. The
    // copy (or the branch it left behind) is a cleanup item, so record it
    // before throwing — the sidebar count is how a person finds it again.
    let removed: DiscardValue
    try {
      removed = await removeCopy(root, item.name, signal)
    } catch (error) {
      keep(root, item.name)
      throw error
    }
    return {
      directory,
      removed: { name: removed.name, path: removed.path, branch: removed.branch },
      kept: null,
      keptReason: null,
    }
  }

  return { status, prepare, release, scope, list, discard, discardBranch }
}
