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
 *
 * Both shell tools the host can mount are covered: `bash` on POSIX and `pwsh`
 * on native Windows. The decision is a pure function of the call plus an
 * explicit platform, so the Windows table is tested on Linux.
 * @module dsh-worktree-switch/host/guard
 */

import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionScope } from '../types.ts'
import { contains } from './paths.ts'
import { hostPlatform } from './platform.ts'
import type { HostPlatform } from './platform.ts'
import type { SessionScopeRegistry } from './scope.ts'

/** Tool names whose `command` argument is executed by a shell. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** The arguments the guard reads from one shell call. */
export interface ShellCall {
  /** Command text as the model wrote it. */
  readonly command: string
  /** Explicit working directory, when the call carried one. */
  readonly workdir?: string
}

/**
 * Read a shell call's command and explicit directory, if this is one.
 *
 * The two shell tools take the same argument names; the platform decides which
 * of them the host mounts, not which fields the guard reads.
 * @param toolName - the pending tool's name.
 * @param args - that call's arguments, as the model supplied them.
 * @returns the fields the guard needs, or null for every other tool.
 */
export function shellCall(toolName: string, args: unknown): ShellCall | null {
  if (!SHELL_TOOLS.has(toolName)) return null
  if (args === null || typeof args !== 'object') return null
  const values = args as Record<string, unknown>
  const command = values['command']
  if (typeof command !== 'string' || command.trim() === '') return null
  const workdir = values['workdir']
  const explicit = typeof workdir === 'string' && workdir.trim() !== '' ? workdir : undefined
  return explicit === undefined ? { command } : { command, workdir: explicit }
}

/**
 * The model-facing denial for one shell command.
 * @param command - shell command text as the model wrote it.
 * @param workdir - explicit working directory, when the call carried one.
 * @param cwd - the session's committed working directory.
 * @param scope - the copy the session runs in.
 * @param platform - path dialect used by the command and directories; defaults
 * to the host's, and is passed explicitly by the Windows decision table.
 * @returns the denial reason, or null when the call may run.
 */
export function sourceCheckoutDenial(
  command: string,
  workdir: string | undefined,
  cwd: string,
  scope: SessionScope,
  platform: HostPlatform = hostPlatform(),
): string | null {
  // Non-Git commands are out of scope: this guard is about the checkout's Git
  // state, not about every write the sandbox already allows. The token is
  // matched the way the host's shell matches it: case-insensitively on win32
  // (where `Git` and `GIT.EXE` are the same executable), case-sensitively on
  // POSIX (where they are different programs).
  if (!mentionsGit(command, platform)) return null
  const checkout = scope.worktree.path
  const project = scope.repositoryRoot
  if (workdir !== undefined) {
    const api = platform === 'win32' ? win32 : posix
    const target = api.isAbsolute(workdir) ? workdir : api.resolve(cwd, workdir)
    if (contains(project, target, platform) && !contains(checkout, target, platform)) return denial(scope)
  }
  // The copy lives inside the project, so mention of the copy path must not
  // count as naming the checkout; strip it before looking for the project.
  // Windows accepts either separator and any case for the same directory, so
  // both sides are folded first. POSIX text is untouched: there a backslash is
  // an escape, not a separator, and the existing literal comparison stands.
  const remaining = foldPathText(command, platform).split(foldPathText(checkout, platform)).join('')
  if (remaining.includes(foldPathText(project, platform))) return denial(scope)
  return null
}

/**
 * Whether a command text names the Git executable.
 * @param command - shell command text as the model wrote it.
 * @param platform - the host's command-name dialect.
 * @returns true when the text carries a `git` token.
 */
function mentionsGit(command: string, platform: HostPlatform): boolean {
  return platform === 'win32' ? /\bgit\b/i.test(command) : /\bgit\b/.test(command)
}

/**
 * Fold the spellings Windows treats as the same path.
 * @param text - a command or a path, as it was written.
 * @param platform - the host's path dialect.
 * @returns lowercased forward-slash text on win32; the input unchanged on POSIX.
 */
function foldPathText(text: string, platform: HostPlatform): string {
  return platform === 'win32' ? text.replaceAll('\\', '/').toLowerCase() : text
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
    const args = shellCall(exec.name, exec.arguments)
    if (args === null) return next()
    const denial = sourceCheckoutDenial(args.command, args.workdir, ctx.workingDirectory.get(agent.session), scope)
    return denial === null ? next() : { kind: 'deny', reason: denial }
  })
}
