/**
 * Shell-tool dispatch: which model-side tools count as shell reads, and which
 * single file a call provably read.
 *
 * dsh exposes a different shell tool per platform — `bash` on POSIX and `pwsh`
 * on Windows — and both report only the command text plus an optional
 * `workdir`. The two dialects need separate parsers, but the selection rule is
 * the same: only `bash` and `pwsh` are shell tools, both read `command`, and a
 * relative operand resolves against `workdir` (itself resolved against the
 * session directory), mirroring the tool's own rule. A tool that is not a shell
 * tool, or a command its parser cannot prove reads exactly one file, returns
 * `undefined`.
 *
 * @module dsh-path-rules/shell-tools
 */

import { isAbsolute, resolve } from 'node:path'
import { parsePwshSingleFileReadCommand } from './pwsh.ts'
import { parseSingleFileReadCommand } from './shell.ts'

/** One recognized shell read, before its path is resolved. */
interface ShellToolRead {
  /** File operand exactly as the model wrote it. */
  readonly path: string
}

/**
 * Recognize a shell tool call and return its raw file operand.
 *
 * The tool name selects the dialect; the bash parser stays untouched so the
 * POSIX trigger set cannot drift.
 * @param toolName - the model-side tool name.
 * @param args - the call's arguments.
 * @returns the operand as written, or `undefined` when not a provable read.
 */
function shellToolRead(toolName: string, args: unknown): ShellToolRead | undefined {
  if (toolName !== 'bash' && toolName !== 'pwsh') return undefined
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as Record<string, unknown>).command
  if (typeof command !== 'string') return undefined
  const read = toolName === 'bash'
    ? parseSingleFileReadCommand(command)
    : parsePwshSingleFileReadCommand(command)
  return read === undefined ? undefined : { path: read.path }
}

/**
 * Absolute path a successful shell call provably read, when it is one
 * conservative single-file read.
 *
 * Relative command paths resolve against the call's `workdir` (itself resolved
 * against the session directory). A command with no provable single file is not
 * a trigger, whichever shell tool ran it.
 * @param toolName - the model-side tool name.
 * @param args - the call's arguments.
 * @param sessionCwd - the agent's current directory.
 * @returns the absolute read path, or `undefined` when the call is not a
 * provable single-file read.
 */
export function shellReadPath(toolName: string, args: unknown, sessionCwd: string): string | undefined {
  const read = shellToolRead(toolName, args)
  if (read === undefined) return undefined
  const rawWorkdir = (args as Record<string, unknown>).workdir
  const workdir = typeof rawWorkdir === 'string' && rawWorkdir.trim().length > 0
    ? rawWorkdir.trim()
    : undefined
  const base = workdir === undefined
    ? sessionCwd
    : isAbsolute(workdir) ? resolve(workdir) : resolve(sessionCwd, workdir)
  return isAbsolute(read.path) ? resolve(read.path) : resolve(base, read.path)
}
