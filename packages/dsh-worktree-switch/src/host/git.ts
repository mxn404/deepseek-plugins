/**
 * Unconfined Git calls behind the plugin's user-initiated verbs.
 *
 * Creation goes through `ctx.worktrees` (the harness service), which runs its
 * own Git under the calling session's sandbox policy. The list, status, and
 * discard verbs here belong to a person clicking in the UI rather than to a
 * model turn: they inspect and delete the copies the user can see, from a path
 * the same UI just listed. They therefore spawn Git directly, the same way the
 * installed `dsh-worktree-space` plugin does, instead of borrowing a session's
 * policy for an operation no session asked for.
 * @module dsh-worktree-switch/host/git
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Whole-command deadline for one Git call. */
export const GIT_TIMEOUT_MS = 20_000

/** Per-stream capture cap; worktree listings and status lines are small. */
const MAX_OUTPUT_BYTES = 1_048_576

/**
 * Clear inherited repository selectors and config so the command reads the
 * checkout named by `cwd`, never one inherited from the Host's environment.
 * One entry per key: `undefined` removes the variable for the child.
 */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/** One bounded Git invocation's captured result. */
export interface GitResult {
  /** Captured stdout. */
  readonly stdout: string
  /** Captured stderr. */
  readonly stderr: string
  /** Process exit status. */
  readonly exitCode: number
}

/** A Git invocation that exited with a status the caller did not allow. */
export class GitFailure extends Error {
  /**
   * @param args - arguments after the executable, for diagnostics.
   * @param result - the captured outcome.
   */
  constructor(readonly args: readonly string[], readonly result: GitResult) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()
    super(`git ${args.join(' ')} failed (exit ${result.exitCode})${detail === '' ? '' : `: ${detail}`}`)
    this.name = 'GitFailure'
  }
}

/** Options for {@link runGit}. */
export interface GitOptions {
  /** Caller cancellation, combined with the command deadline. */
  readonly signal?: AbortSignal | undefined
  /** Exit statuses that are not failures; defaults to `[0]`. */
  readonly allowedExitCodes?: readonly number[] | undefined
  /** Override for {@link GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined
}

/**
 * Run one Git command without a shell and await its termination.
 * @param ctx - Host context carrying the subprocess provider.
 * @param cwd - absolute directory the command runs in.
 * @param args - arguments after the executable.
 * @param options - cancellation, accepted exit statuses, and deadline.
 * @returns captured stdout, stderr, and exit status.
 * @throws {GitFailure} when the exit status is not allowed or the command was killed.
 */
export async function runGit(
  ctx: Context,
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? GIT_TIMEOUT_MS)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
  const allowed = options.allowedExitCodes ?? [0]
  const program = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  const argv = [program, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]
  const child = ctx.subprocess.spawn({
    argv,
    cwd,
    env: {
      ...GIT_ENV,
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_NO_LAZY_FETCH: '1',
    },
    signal,
    graceMs: 1_500,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_OUTPUT_BYTES },
    },
  })
  try {
    const outcome = await child.done
    const stdout = child.collected.stdout?.readFrom(0).text ?? ''
    const stderr = child.collected.stderr?.readFrom(0).text ?? ''
    const result: GitResult = { stdout, stderr, exitCode: outcome.exitCode ?? -1 }
    if (outcome.exitCode === null || !allowed.includes(outcome.exitCode)) throw new GitFailure(args, result)
    return result
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/**
 * Resolve the repository root that contains `directory`.
 * @param ctx - Host context carrying the subprocess provider.
 * @param directory - absolute directory inside (or at) the checkout.
 * @param signal - caller cancellation.
 * @returns the canonical top-level directory Git reports.
 * @throws {GitFailure} when the directory is not inside a Git working tree.
 */
export async function repositoryRoot(ctx: Context, directory: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(ctx, directory, ['rev-parse', '--show-toplevel'], {
    signal,
    allowedExitCodes: [0, 128],
  })
  if (result.exitCode !== 0) throw new GitFailure(['rev-parse', '--show-toplevel'], result)
  return result.stdout.replace(/\r?\n$/, '')
}

/**
 * Resolve symlinks in a path that exists, falling back to the path as given.
 * @param path - absolute path.
 * @returns the canonical spelling when the path exists.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** One checkout reported by `git worktree list --porcelain`. */
export interface WorktreeRecord {
  /** Absolute checkout directory. */
  readonly path: string
  /** Branch the checkout has checked out, when it has one. */
  readonly branch?: string | undefined
}

/**
 * Parse `git worktree list --porcelain` output into its records.
 * @param stdout - the command's stdout.
 * @returns one record per reported checkout, in Git's order.
 */
export function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let path: string | undefined
  let branch: string | undefined
  const flush = (): void => {
    if (path === undefined) return
    records.push(branch === undefined ? { path } : { path, branch })
    path = undefined
    branch = undefined
  }
  for (const line of stdout.split('\n')) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
  }
  flush()
  return records
}

/**
 * List the worktree checkouts of one repository.
 * @param ctx - Host context carrying the subprocess provider.
 * @param root - repository root the command runs in.
 * @param signal - caller cancellation.
 * @returns every checkout Git reports for the repository.
 */
export async function listWorktreeRecords(
  ctx: Context,
  root: string,
  signal?: AbortSignal,
): Promise<WorktreeRecord[]> {
  const result = await runGit(ctx, root, ['worktree', 'list', '--porcelain'], { signal })
  return parseWorktreeList(result.stdout)
}

/**
 * Count the changed and untracked files of one checkout.
 * @param ctx - Host context carrying the subprocess provider.
 * @param directory - checkout directory to inspect.
 * @param signal - caller cancellation.
 * @returns the number of `git status --porcelain` entries.
 */
export async function changedFileCount(
  ctx: Context,
  directory: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runGit(ctx, directory, ['status', '--porcelain', '--untracked-files=normal'], {
    signal,
  })
  return result.stdout.split('\n').filter(line => line.trim() !== '').length
}

/**
 * Resolve the whereabouts of one checkout's Git administration directory.
 *
 * A linked worktree's `.git` is a file pointing at
 * `<common>/worktrees/<name>`; this is the directory Git owns for that one
 * checkout, which is where the switch records its claim on the copy.
 * @param ctx - Host context carrying the subprocess provider.
 * @param checkout - absolute directory of the checkout to ask.
 * @param signal - caller cancellation.
 * @returns the absolute admin directory Git reports.
 * @throws {GitFailure} when the directory is not inside a Git working tree.
 */
export async function absoluteGitDir(ctx: Context, checkout: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(ctx, checkout, ['rev-parse', '--absolute-git-dir'], { signal })
  const path = result.stdout.replace(/\r?\n$/, '')
  if (path === '') throw new GitFailure(['rev-parse', '--absolute-git-dir'], result)
  return path
}

/**
 * Read the branch one checkout has checked out.
 * @param ctx - Host context carrying the subprocess provider.
 * @param checkout - absolute directory of the checkout to ask.
 * @param signal - caller cancellation.
 * @returns the branch name, or null when the checkout is on a detached HEAD.
 */
export async function currentBranch(
  ctx: Context,
  checkout: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(ctx, checkout, ['symbolic-ref', '--short', '--quiet', 'HEAD'], {
    signal,
    allowedExitCodes: [0, 1],
  })
  const name = result.stdout.replace(/\r?\n$/, '')
  return result.exitCode === 0 && name !== '' ? name : null
}

/**
 * Resolve one revision to the commit id it names.
 * @param ctx - Host context carrying the subprocess provider.
 * @param directory - checkout the command runs in.
 * @param revision - revision to resolve; `HEAD` or a full id are the usual values.
 * @param signal - caller cancellation.
 * @returns the commit id, or null when the revision does not resolve.
 */
export async function revParse(
  ctx: Context,
  directory: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(ctx, directory, ['rev-parse', '--verify', '--quiet', revision], {
    signal,
    allowedExitCodes: [0, 1, 128],
  })
  const id = result.stdout.replace(/\r?\n$/, '')
  return result.exitCode === 0 && id !== '' ? id : null
}

/**
 * Count the commits in one revision range.
 * @param ctx - Host context carrying the subprocess provider.
 * @param directory - checkout the command runs in.
 * @param range - the range to count, e.g. `HEAD..refs/heads/<branch>`.
 * @param signal - caller cancellation.
 * @returns the number of commits in the range.
 * @throws {GitFailure} when the range does not resolve.
 */
export async function revListCount(
  ctx: Context,
  directory: string,
  range: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runGit(ctx, directory, ['rev-list', '--count', range], { signal })
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(count) ? count : 0
}

/** One local branch, as `git for-each-ref` reports it. */
export interface BranchRef {
  /** Branch name without `refs/heads/`. */
  readonly name: string
  /** Commit the branch points at. */
  readonly commit: string
  /** Committer date of that commit, in milliseconds since the epoch. */
  readonly committedAt: number
  /** One-line subject of that commit. */
  readonly subject: string
}

/**
 * Parse `git for-each-ref` output produced with the NUL-separated format below.
 * @param stdout - the command's stdout.
 * @returns one entry per local branch, in Git's order.
 */
export function parseBranchRefs(stdout: string): BranchRef[] {
  const refs: BranchRef[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [name, commit, seconds, subject] = line.split('\u0000')
    if (name === undefined || commit === undefined || seconds === undefined || subject === undefined) continue
    const committedAt = Number.parseInt(seconds, 10) * 1000
    refs.push({
      name,
      commit,
      committedAt: Number.isFinite(committedAt) ? committedAt : 0,
      subject,
    })
  }
  return refs
}

/**
 * List the local branches of one repository.
 * @param ctx - Host context carrying the subprocess provider.
 * @param root - repository root the command runs in.
 * @param signal - caller cancellation.
 * @returns every local branch with its tip commit.
 */
export async function listBranchRefs(
  ctx: Context,
  root: string,
  signal?: AbortSignal,
): Promise<BranchRef[]> {
  const result = await runGit(
    ctx,
    root,
    [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(subject)',
      'refs/heads',
    ],
    { signal },
  )
  return parseBranchRefs(result.stdout)
}
