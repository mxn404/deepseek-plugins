/**
 * The plugin's host Remote face: the five verbs the browser half can call,
 * expressed against a live session and the checkouts on disk.
 *
 * This module is the seam the host tests drive directly. Everything below it —
 * Git, the worktree service, the sandbox policy it applies, and session
 * working-directory publication — belongs to the harness and is exercised by
 * its own tests.
 * @module dsh-worktree-switch/host/handlers
 */

import { lstat, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {
  DiscardValue,
  ListValue,
  PrepareValue,
  ReleaseValue,
  StatusValue,
  WorktreeItem,
  WorktreeRef,
} from '../types.ts'
import {
  canonicalPath,
  changedFileCount,
  GitFailure,
  listWorktreeRecords,
  repositoryRoot,
  runGit,
} from './git.ts'
import { isWorktreeName, worktreeName } from './naming.ts'

/** Attempts at a fresh name before a creation failure becomes an error. */
const CREATE_ATTEMPTS = 3

export type {
  DiscardValue,
  ListValue,
  PrepareValue,
  ReleaseValue,
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

/** Row config the verbs read. */
export interface WorktreeToggleOptions {
  /** Default for a project nothing has remembered yet. */
  readonly defaultEnabled: boolean
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
   * Put the session back in its project directory, undoing a copy the switch
   * created for it when it never became the conversation's workspace.
   * @param request - the calling session.
   * @param signal - caller cancellation.
   * @returns the directory the session now runs in, the copy removed, and the
   * copy left on disk when deleting it was not safe.
   * @throws {WorktreeToggleError} when the project cannot be resolved or the
   * session could not be moved back.
   */
  release(request: { readonly sessionId: string }, signal?: AbortSignal): Promise<ReleaseValue>
  /**
   * List the copies under one project's pool.
   * @param request - any directory inside the project.
   * @param signal - caller cancellation.
   * @returns the pool contents, or `supported: false` for a non-repository path.
   */
  list(request: { readonly path: string }, signal?: AbortSignal): Promise<ListValue>
  /**
   * Delete one copy and its branch.
   * @param request - a directory inside the project, and the copy's name.
   * @param signal - caller cancellation.
   * @returns the removed copy's identity.
   * @throws {WorktreeToggleError} when the copy is missing, dirty, or Git refused.
   */
  discard(
    request: { readonly path: string; readonly name: string },
    signal?: AbortSignal,
  ): Promise<DiscardValue>
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
 * @param current - the session's committed working directory.
 * @param repositoryRoot - canonical root of the project's repository.
 * @returns the copy's identity, or null when the directory is not one.
 */
async function worktreeAt(current: string, repositoryRoot: string): Promise<WorktreeRef | null> {
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
  return { name, path, branch: name }
}

/**
 * Whether one absolute directory is the path itself or an ancestor of it.
 * @param directory - candidate ancestor.
 * @param path - absolute path to test.
 * @returns true when `path` is `directory` or lives below it.
 */
function contains(directory: string, path: string): boolean {
  const inside = relative(directory, path)
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

/**
 * Build the host face.
 * @param ctx - Host context with `agents`, `worktrees`, `workingDirectory`, and `subprocess`.
 * @param options - resolved row config.
 * @returns the five verbs.
 */
export function createWorktreeToggle(ctx: Context, options: WorktreeToggleOptions): WorktreeToggle {
  /** One in-flight preparation per session, so a double mount cannot create twice. */
  const pending = new Map<string, Promise<PrepareValue>>()
  /**
   * Copies this host instance created for a session, by session id. Turning the
   * switch off may only delete what the switch itself just made: a copy that
   * existed before this instance started is left for the panel's explicit
   * discard, because it may carry work the switch never saw.
   */
  const createdBySession = new Map<string, WorktreeRef>()

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

  /**
   * Resolve the canonical root of the repository that contains a directory.
   * Git reports the spelling of the path it was given; the worktree service
   * publishes canonical paths, so both halves must agree on one spelling.
   * @param directory - absolute directory inside the project.
   * @param signal - caller cancellation.
   * @returns the canonical repository root.
   */
  const repositoryOf = async (directory: string, signal?: AbortSignal): Promise<string> =>
    canonicalPath(await repositoryRoot(ctx, directory, signal))

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
      root = await repositoryOf(startDirectory, signal)
    } catch (error) {
      if (error instanceof GitFailure) {
        return { supported: false, reason: 'not-a-git-repository', defaultEnabled: options.defaultEnabled }
      }
      throw error
    }
    const current = ctx.workingDirectory.get(agent.session)
    signal?.throwIfAborted()
    const sourceDirty = await changedFileCount(ctx, root, signal)
    return {
      supported: true,
      repositoryRoot: root,
      sessionWorktree: await worktreeAt(current, root),
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
    const workingProject = await repositoryOf(working, signal)
    if (workingProject !== current.repositoryRoot) {
      throw new WorktreeToggleError(
        'session-moved',
        `this session now works in ${workingProject}, not in its project ${current.repositoryRoot}`,
        { repositoryRoot: current.repositoryRoot, workingProject },
      )
    }
    let lastFailure: unknown
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      const name = worktreeName()
      try {
        const created = await ctx.worktrees.create(agent, { name, from: 'HEAD' }, signal)
        const worktree: WorktreeRef = { name: created.branch, path: created.path, branch: created.branch }
        createdBySession.set(request.sessionId, worktree)
        return {
          state: 'created',
          worktree,
          repositoryRoot: created.repositoryRoot,
          sourceDirty: current.sourceDirty,
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

  const list = async (
    request: { readonly path: string },
    signal?: AbortSignal,
  ): Promise<ListValue> => {
    const directory = absolutePath(request.path)
    let root: string
    try {
      root = await repositoryOf(directory, signal)
    } catch (error) {
      if (error instanceof GitFailure) return { supported: false, reason: 'not-a-git-repository' }
      throw error
    }
    const records = await listWorktreeRecords(ctx, root, signal)
    const items: WorktreeItem[] = []
    for (const record of records) {
      signal?.throwIfAborted()
      const path = await canonicalPath(record.path)
      // The repository's own checkout is the source, never a copy.
      if (path === root) continue
      const name = basename(path)
      if (!isWorktreeName(name)) continue
      const branch = record.branch ?? name
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
      items.push({ name, path, branch, createdAt, changedFiles, prunable })
    }
    items.sort((left, right) => right.createdAt - left.createdAt || left.name.localeCompare(right.name))
    return { supported: true, repositoryRoot: root, items }
  }

  /**
   * Delete one clean copy and its branch. Both the panel's discard and the
   * switch's own undo go through here, so the dirty guard has one home.
   * @param root - canonical repository root.
   * @param name - copy name; already validated by the caller.
   * @param signal - caller cancellation.
   * @returns the removed copy's identity.
   */
  const removeCopy = async (root: string, name: string, signal?: AbortSignal): Promise<DiscardValue> => {
    const listed = await list({ path: root }, signal)
    if (!listed.supported) {
      throw new WorktreeToggleError('not-a-git-repository', 'the project is not inside a Git working tree')
    }
    const item = listed.items.find(entry => entry.name === name)
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
      await runGit(ctx, root, ['worktree', 'prune'], { signal })
    } else {
      const removed = await runGit(ctx, root, ['worktree', 'remove', item.path], {
        signal,
        allowedExitCodes: [0, 128],
      })
      if (removed.exitCode !== 0) {
        throw new WorktreeToggleError(
          'worktree-remove-failed',
          new GitFailure(['worktree', 'remove', item.path], removed).message,
          { name: item.name, path: item.path },
        )
      }
    }
    const deleted = await runGit(ctx, root, ['branch', '-D', '--', item.branch], {
      signal,
      allowedExitCodes: [0, 1],
    })
    // Status 1 with "not found" is the branch already being gone (removed by
    // hand between the read and the click); that is not a failed discard.
    const branchGone = deleted.exitCode === 1 && /not found/i.test(deleted.stderr)
    if (deleted.exitCode !== 0 && !branchGone) {
      throw new WorktreeToggleError(
        'worktree-remove-failed',
        new GitFailure(['branch', '-D', item.branch], deleted).message,
        { name: item.name, branch: item.branch },
      )
    }
    for (const [sessionId, copy] of createdBySession) {
      if (copy.path === item.path) createdBySession.delete(sessionId)
    }
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
    const root = await repositoryOf(directory, signal)
    return await removeCopy(root, request.name, signal)
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
      root = await repositoryOf(anchor, signal)
    } catch (error) {
      if (error instanceof GitFailure) {
        throw new WorktreeToggleError(
          'not-a-git-repository',
          'the session project is not inside a Git working tree',
        )
      }
      throw error
    }
    const listed = await list({ path: anchor }, signal)
    if (!listed.supported) return { directory: current, removed: null, kept: null }
    const path = await canonicalPath(current)
    const item = listed.items.find(entry => contains(entry.path, path))
    if (item === undefined) return { directory: current, removed: null, kept: null }
    const copy: WorktreeRef = { name: item.name, path: item.path, branch: item.branch }
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
    const mine = createdBySession.get(request.sessionId)
    if (mine === undefined || mine.path !== copy.path) {
      // Not the switch's own copy: leave it, the panel can discard it by hand.
      return { directory, removed: null, kept: copy }
    }
    try {
      const removed = await removeCopy(root, copy.name, signal)
      return {
        directory,
        removed: { name: removed.name, path: removed.path, branch: removed.branch },
        kept: null,
      }
    } catch (error) {
      if (signal?.aborted === true) throw error
      // Dirty or refused by Git: the session is still back in the project, so
      // the switch keeps its promise; the copy stays for the panel to handle.
      return { directory, removed: null, kept: copy }
    }
  }

  return { status, prepare, release, list, discard }
}
