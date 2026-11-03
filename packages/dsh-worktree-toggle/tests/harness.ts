/**
 * Real-service harness for the Worktree toggle host half.
 *
 * Adapted from the harness behind `packages/experimental/worktree` in
 * deepseek-harness: a real Cordis Context, real temp Git repositories, and the
 * production working-directory, filesystem, subprocess, sandbox-policy, and
 * worktree services. No service seam is mocked. The only stand-ins are the
 * Agent handle and the unconfined sandbox provider, both of which the plugin
 * treats as opaque services.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'

const execute = promisify(execFile)

/** Keep fixture Git off the caller's global and system configuration. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '',
  GIT_CONFIG_PARAMETERS: '',
  GIT_CONFIG_COUNT: '0',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
}

/**
 * Run one fixture Git command.
 * @param cwd - directory the command runs in.
 * @param args - arguments after the executable.
 * @returns trimmed stdout.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: GIT_ENV })
  return result.stdout.trim()
}

/**
 * Unconfined fixtures must never accidentally exercise the confined branch.
 * @public
 */
export class UnusedSandbox extends SandboxProvider {
  /**
   * @throws always; a danger-full-access fixture has no runner to confine with.
   */
  async confine(_argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    throw new Error('unexpected confinement in a danger-full-access fixture')
  }
}

/**
 * Register a live Agent over a real Session so `ctx.agents.get(sessionId)`
 * resolves the way it does in production.
 * @param ctx - host context that owns the Agent registry.
 * @param cwd - immutable creation directory recorded in the Session header.
 * @param name - Agent and Session identity; defaults to one per test.
 * @returns the registered Agent.
 */
export function testAgent(ctx: Context, cwd: string, name = 'worktree-toggle-test'): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(name)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd,
  })
  const agent: Agent = {
    id,
    session,
    options: {},
    status: 'idle',
    ctx: scope.ctx,
    inbox: unsupportedInbox(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
  }
  ctx.agents.register(agent)
  return agent
}

/** Options for {@link repository}. */
export interface RepositoryOptions {
  /** Create the initial commit; false leaves a `git init`-only repository. */
  readonly commits?: boolean
}

/**
 * Create a real temporary Git repository with `main` checked out.
 * @param options - whether to create the initial commit.
 * @param parent - directory the fixture is created under; defaults to the OS temp dir.
 * @returns the canonical repository root.
 */
export async function repository(options: RepositoryOptions = {}, parent = tmpdir()): Promise<string> {
  const path = await realpath(await mkdtemp(join(parent, 'dsh-worktree-toggle-')))
  try {
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'core.autocrlf', 'false')
    await git(path, 'config', 'user.name', 'Worktree toggle fixture')
    await git(path, 'config', 'user.email', 'worktree-toggle@example.invalid')
    await git(path, 'config', 'commit.gpgSign', 'false')
    if (options.commits === false) return path
    await writeFile(join(path, 'tracked.txt'), 'initial\n')
    await git(path, 'add', 'tracked.txt')
    await git(path, 'commit', '-m', 'initial')
    return path
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
}

/**
 * Create a real temporary directory that is not a Git working tree.
 * @param parent - directory the fixture is created under; defaults to the OS temp dir.
 * @returns the canonical directory.
 */
export async function temporaryDirectory(parent = tmpdir()): Promise<string> {
  return realpath(await mkdtemp(join(parent, 'dsh-worktree-toggle-')))
}

/**
 * Mount the production services the toggle verbs run against.
 * @param root - workspace directory the filesystem provider starts in.
 * @returns the live context; the caller owns its disposal.
 */
export async function harness(root: string): Promise<Context> {
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(UnusedSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
    await ctx.plugin(WorkingDirectoryService)
    await ctx.plugin(WorktreeService, { directory: '.agents/worktrees' })
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
