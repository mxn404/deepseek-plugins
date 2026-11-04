/**
 * The source-checkout guard: while a session runs in a worktree copy, shell
 * commands that would run Git against the project checkout are refused before
 * dispatch.
 *
 * The prompt context (`worktree-switch:scope`) explains where the workspace
 * is, but it cannot stop a model that still reaches for the checkout it can
 * see — and the sandbox deliberately grants writes there. This guard is the
 * enforcement half that needs no harness change: `tools/pre-execute` can deny
 * one call, and the model reads the reason as that call's error result.
 *
 * The pattern is deliberately narrow. Only a shell call that mentions `git`
 * is considered, and only when it names the project checkout either as an
 * explicit `workdir` or as a literal absolute path in the command text.
 * `cd ..`-style relative escapes and shell variables are not resolved; the
 * guard is a net, not the sandbox boundary.
 * @module dsh-worktree-switch/host/guard
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionScope } from '../types.ts'
import { contains } from './paths.ts'
import type { SessionScopeRegistry } from './scope.ts'

/** Tool names whose `command` argument is executed by a shell. */
const SHELL_TOOLS = new Set(['bash'])

/** The arguments the guard reads from one shell call. */
interface ShellArguments {
  /** Command text as the model wrote it. */
  readonly command: string
  /** Explicit working directory, when the call carried one. */
  readonly workdir?: string
}

/**
 * Read a shell call's command and explicit directory, if this is one.
 * @param exec - the pending tool call.
 * @returns the fields the guard needs, or null for every other tool.
 */
function shellArguments(exec: ToolExecution): ShellArguments | null {
  if (!SHELL_TOOLS.has(exec.name)) return null
  if (exec.arguments === null || typeof exec.arguments !== 'object') return null
  const args = exec.arguments as Record<string, unknown>
  const command = args['command']
  if (typeof command !== 'string' || command.trim() === '') return null
  const workdir = args['workdir']
  const explicit = typeof workdir === 'string' && workdir.trim() !== '' ? workdir : undefined
  return explicit === undefined ? { command } : { command, workdir: explicit }
}

/**
 * The model-facing denial for one shell command.
 * @param command - shell command text as the model wrote it.
 * @param workdir - explicit working directory, when the call carried one.
 * @param cwd - the session's committed working directory.
 * @param scope - the copy the session runs in.
 * @returns the denial reason, or null when the call may run.
 */
export function sourceCheckoutDenial(
  command: string,
  workdir: string | undefined,
  cwd: string,
  scope: SessionScope,
): string | null {
  // Non-Git commands are out of scope: this guard is about the checkout's Git
  // state, not about every write the sandbox already allows.
  if (!/\bgit\b/.test(command)) return null
  const checkout = scope.worktree.path
  const project = scope.repositoryRoot
  if (workdir !== undefined) {
    const target = isAbsolute(workdir) ? workdir : resolve(cwd, workdir)
    if (contains(project, target) && !contains(checkout, target)) return denial(scope)
  }
  // The copy lives inside the project, so mention of the copy path must not
  // count as naming the checkout; strip it before looking for the project.
  if (command.split(checkout).join('').includes(project)) return denial(scope)
  return null
}

/** The one explanation every denial carries, including the way to get main. */
function denial(scope: SessionScope): string {
  return `Denied: this session runs in the worktree copy ${JSON.stringify(scope.worktree.path)}, so Git commands targeting the project checkout ${JSON.stringify(scope.repositoryRoot)} are blocked. Run Git in the current working directory instead; to bring main's latest into this copy, use \`git fetch origin main\` and then \`git merge origin/main\` (or \`git rebase origin/main\`).`
}

/**
 * Refuse shell calls that run Git against the project checkout while the
 * session is inside a copy.
 *
 * The registry is the same one the prompt context reads, so the guard is
 * active exactly while the model has been told it is in a copy.
 * @param ctx - host context carrying `workingDirectory` and the tool runtime.
 * @param registry - sessions' confirmed copies.
 */
export function installSourceCheckoutGuard(ctx: Context, registry: SessionScopeRegistry): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const scope = registry.get(String(agent.session.id))
    if (scope === null) return next()
    const args = shellArguments(exec)
    if (args === null) return next()
    const denial = sourceCheckoutDenial(args.command, args.workdir, ctx.workingDirectory.get(agent.session), scope)
    return denial === null ? next() : { kind: 'deny', reason: denial }
  })
}
