/**
 * Executing one matched hook.
 *
 * The runner owns the parts every handler kind shares: the wall-clock
 * measurement every audit row carries, and the containment rule that a failing
 * hook becomes a recorded `error` instead of an exception thrown into the host
 * pipeline. A `builtin` action settles synchronously, so the timeout an entry
 * declares cannot be reached there; a `command` run hands it to `ctx.shell`,
 * which kills the process group at expiry.
 *
 * @module dsh-lifecycle-hooks/handler
 */

import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { CommandResult } from './command.ts'
import { runCommand } from './command.ts'
import type { Hook, HookDecision, HookEvent, HookHandlerKind } from './hook.ts'

/** The shell surface a command run needs; absent when the deployment has none. */
export type HandlerShell = Pick<ShellExecutor, 'resolve' | 'execute'> | undefined

/** The per-run input every handler kind receives. */
export interface HookEnvironment {
  /** The host shell service, read through `ctx.get('shell')`. */
  readonly shell: HandlerShell
  /** Event payload serialized onto a command's stdin. */
  readonly payload: unknown
  /** `DSH_HOOK_*` facts handed to a command. */
  readonly env: Record<string, string>
  /** Session working directory a command runs in. */
  readonly workdir: string
  /** Cancels the run when the event it belongs to is abandoned. */
  readonly signal: AbortSignal
}

/** What one executed hook did, for the decision merge and the audit row. */
export interface HookRun {
  readonly hook: Hook
  /** Absolute path of the hooks file the hook came from. */
  readonly source: string
  readonly event: HookEvent
  readonly handler: HookHandlerKind
  /**
   * Its decision, or `undefined` when it only observed or failed. A failed run
   * is left without one by {@link executeHook}; the dispatcher's
   * `onFailure: "block"` synthesis is the only decision that accompanies an
   * `error`.
   */
  readonly decision: HookDecision | undefined
  /** Failure detail when the handler threw or its process failed; a failed run contributes no decision. */
  readonly error: string | undefined
  /** Wall-clock milliseconds this run took. */
  readonly durationMs: number
  /** Exit code of a command run; absent for builtins, timeouts, and signal deaths. */
  readonly exitCode: number | undefined
}

/**
 * Run one matched hook.
 *
 * A throwing handler never propagates: its run carries `error` instead, so one
 * broken hook cannot break the event's host seam.
 * @param hook - the validated entry to execute.
 * @param source - absolute path of the file it came from, for the audit row.
 * @param environment - the payload, environment, and execution facts.
 * @returns the measured run.
 */
export async function executeHook(
  hook: Hook,
  source: string,
  environment: HookEnvironment,
): Promise<HookRun> {
  const started = performance.now()
  const run = hook.run
  try {
    if (run.type === 'builtin') {
      return {
        hook,
        source,
        event: hook.on,
        handler: run.type,
        decision: { action: run.action, reason: run.reason },
        error: undefined,
        durationMs: Math.round(performance.now() - started),
        exitCode: undefined,
      }
    }
    const result: CommandResult = await runCommand({
      shell: environment.shell,
      command: run.command,
      payload: environment.payload,
      env: environment.env,
      workdir: environment.workdir,
      timeoutMs: hook.timeoutMs,
      signal: environment.signal,
    })
    return {
      hook,
      source,
      event: hook.on,
      handler: run.type,
      decision: result.decision,
      error: result.error,
      durationMs: Math.round(performance.now() - started),
      exitCode: result.exitCode,
    }
  } catch (error) {
    return {
      hook,
      source,
      event: hook.on,
      handler: run.type,
      decision: undefined,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - started),
      exitCode: undefined,
    }
  }
}
