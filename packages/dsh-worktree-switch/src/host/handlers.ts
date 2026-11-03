/**
 * The plugin's host Remote face: the four verbs the browser half can call,
 * expressed against a live session and the checkouts on disk.
 *
 * This module is the seam the host tests drive directly. Everything below it —
 * Git, the worktree service, the sandbox policy it applies, and session
 * working-directory publication — belongs to the harness and is exercised by
 * its own tests.
 * @module dsh-worktree-switch/host/handlers
 */

import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
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

/** Relative pool inside the source repository; the harness service default. */
export const POOL_DIRECTORY = '.agents/worktrees'

/** Attempts at a fresh name before a creation failure becomes an error. */
const CREATE_ATTEMPTS = 3

export type {
  DiscardValue,
  ListValue,
  PrepareValue,
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
  /** Relative pool directory; defaults to {@link POOL_DIRECTORY}. */
  readonly poolDirectory?: string | undefined
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
 * The copy a session already runs in, when its working directory is one pool
 * entry below the pool.
 * @param current - the session's committed working directory.
 * @param poolPath - absolute pool directory.
 * @returns the copy's identity, or null when the directory is elsewhere.
 */
function worktreeAt(current: string, poolPath: string): WorktreeRef | null {
  if (dirname(current) !== poolPath) return null
  const name = basename(current)
  if (!isWorktreeName(name)) return null
  return { name, path: current, branch: name }
}

/**
 * Build the host face.
 * @param ctx - Host context with `agents`, `worktrees`, `workingDirectory`, and `subprocess`.
 * @param options - resolved row config.
 * @returns the four verbs.
 */
export function createWorktreeToggle(ctx: Context, options: WorktreeToggleOptions): WorktreeToggle {
  const poolDirectory = options.poolDirectory ?? POOL_DIRECTORY
  /** One in-flight preparation per session, so a double mount cannot create twice. */
  const pending = new Map<string, Promise<PrepareValue>>()

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

  const projectOf = async (
    directory: string,
    signal?: AbortSignal,
  ): Promise<{ repositoryRoot: string; poolPath: string }> => {
    // Git reports the spelling of the path it was given; the worktree service
    // publishes canonical paths, so both halves must agree on one spelling or a
    // session already inside a copy would not be recognised as such.
    const root = await canonicalPath(await repositoryRoot(ctx, directory, signal))
    return { repositoryRoot: root, poolPath: join(root, poolDirectory) }
  }

  const status = async (
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<StatusValue> => {
    const agent = await sessionOf(request.sessionId, signal)
    // The immutable creation directory is the project anchor; the committed
    // working directory may already be a copy this session entered.
    const startDirectory = agent.session.header.cwd ?? ctx.workingDirectory.get(agent.session)
    let project: { repositoryRoot: string; poolPath: string }
    try {
      project = await projectOf(startDirectory, signal)
    } catch (error) {
      if (error instanceof GitFailure) {
        return { supported: false, reason: 'not-a-git-repository', defaultEnabled: options.defaultEnabled }
      }
      throw error
    }
    const current = ctx.workingDirectory.get(agent.session)
    signal?.throwIfAborted()
    const sourceDirty = await changedFileCount(ctx, project.repositoryRoot, signal)
    return {
      supported: true,
      repositoryRoot: project.repositoryRoot,
      poolPath: project.poolPath,
      sessionWorktree: worktreeAt(current, project.poolPath),
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
        poolPath: current.poolPath,
        sourceDirty: current.sourceDirty,
      }
    }
    // Status anchors on the immutable creation directory, while the worktree
    // service creates relative to the session's CURRENT directory. Refuse to
    // create when the two name different repositories: a copy in the wrong
    // project would look like success and be worse than no copy.
    const working = ctx.workingDirectory.get(agent.session)
    const workingProject = await projectOf(working, signal)
    if (workingProject.repositoryRoot !== current.repositoryRoot) {
      throw new WorktreeToggleError(
        'session-moved',
        `this session now works in ${workingProject.repositoryRoot}, not in its project ${current.repositoryRoot}`,
        { repositoryRoot: current.repositoryRoot, workingProject: workingProject.repositoryRoot },
      )
    }
    let lastFailure: unknown
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      const name = worktreeName()
      try {
        const created = await ctx.worktrees.create(agent, { name, from: 'HEAD' }, signal)
        return {
          state: 'created',
          worktree: { name: created.branch, path: created.path, branch: created.branch },
          repositoryRoot: created.repositoryRoot,
          poolPath: join(created.repositoryRoot, poolDirectory),
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
    let project: { repositoryRoot: string; poolPath: string }
    try {
      project = await projectOf(directory, signal)
    } catch (error) {
      if (error instanceof GitFailure) return { supported: false, reason: 'not-a-git-repository' }
      throw error
    }
    const records = await listWorktreeRecords(ctx, project.repositoryRoot, signal)
    const items: WorktreeItem[] = []
    for (const record of records) {
      signal?.throwIfAborted()
      if (await canonicalPath(dirname(record.path)) !== project.poolPath) continue
      const name = basename(record.path)
      if (!isWorktreeName(name)) continue
      const branch = record.branch ?? name
      let createdAt = 0
      let prunable = true
      try {
        const info = await stat(record.path)
        createdAt = Math.trunc(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs)
        prunable = false
      } catch {
        // The checkout directory is gone; Git still lists it until pruned.
      }
      const changedFiles = prunable ? 0 : await changedFileCount(ctx, record.path, signal)
      items.push({ name, path: record.path, branch, createdAt, changedFiles, prunable })
    }
    items.sort((left, right) => right.createdAt - left.createdAt || left.name.localeCompare(right.name))
    return {
      supported: true,
      repositoryRoot: project.repositoryRoot,
      poolPath: project.poolPath,
      items,
    }
  }

  const discard = async (
    request: { readonly path: string; readonly name: string },
    signal?: AbortSignal,
  ): Promise<DiscardValue> => {
    const directory = absolutePath(request.path)
    if (!isWorktreeName(request.name)) {
      throw new WorktreeToggleError('worktree-name-invalid', `not a worktree name: ${request.name}`)
    }
    const project = await projectOf(directory, signal)
    const listed = await list({ path: directory }, signal)
    if (!listed.supported) {
      throw new WorktreeToggleError('not-a-git-repository', 'the project is not inside a Git working tree')
    }
    const item = listed.items.find(entry => entry.name === request.name)
    if (item === undefined) {
      throw new WorktreeToggleError(
        'worktree-not-found',
        `no worktree named ${request.name} under ${project.poolPath}`,
        { name: request.name, poolPath: project.poolPath },
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
      await runGit(ctx, project.repositoryRoot, ['worktree', 'prune'], { signal })
    } else {
      const removed = await runGit(ctx, project.repositoryRoot, ['worktree', 'remove', item.path], {
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
    const deleted = await runGit(ctx, project.repositoryRoot, ['branch', '-D', '--', item.branch], {
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
    return { removed: true, name: item.name, branch: item.branch, path: item.path }
  }

  return { status, prepare, list, discard }
}
