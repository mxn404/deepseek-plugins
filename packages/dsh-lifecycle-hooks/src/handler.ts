/**
 * Executing one matched hook.
 *
 * The runner owns the parts every handler kind shares: the wall-clock
 * measurement every audit row carries, and the containment rule that a failing
 * hook becomes a recorded `error` instead of an exception thrown into the host
 * pipeline. A `builtin` action settles synchronously, so the timeout an entry
 * declares cannot be reached there; a `command` run hands it to `ctx.shell`,
 * which kills the process group at expiry; a `module` run races its own promise
 * against it and disables the module's helpers afterwards (`module.ts`).
 *
 * @module dsh-lifecycle-hooks/handler
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { CommandResult } from './command.ts'
import { runCommand } from './command.ts'
import type { BuiltinRun, Hook, HookEvent, HookHandlerKind, HookOutcome } from './hook.ts'
import { messageOf } from './message.ts'
import { resolveModulePath, runModule } from './module.ts'

/** The shell surface a command run needs; absent when the deployment has none. */
export type HandlerShell = Pick<ShellExecutor, 'resolve' | 'execute'> | undefined

/** The per-run input every handler kind receives. */
export interface HookEnvironment {
  /** The host shell service, read through `ctx.get('shell')`. */
  readonly shell: HandlerShell
  /** The agent the event belongs to; a module handler may act on it directly. */
  readonly agent: Agent
  /** Event payload serialized onto a command's stdin and handed to a module. */
  readonly payload: Record<string, unknown>
  /** `DSH_HOOK_*` facts handed to a command. */
  readonly env: Record<string, string>
  /** Session working directory a command runs in. */
  readonly workdir: string
  /** Cancels the run when the event it belongs to is abandoned. */
  readonly signal: AbortSignal
  /** Logger sink a module's `log` helper writes through. */
  readonly log: (message: string) => void
}

/** What one executed hook did, for the outcome merge and the audit row. */
export interface HookRun {
  readonly hook: Hook
  /** Absolute path of the hooks file the hook came from. */
  readonly source: string
  readonly event: HookEvent
  readonly handler: HookHandlerKind
  /**
   * Its outcome, or `undefined` when it only observed or failed. A failed run
   * is left without one by {@link executeHook}; the dispatcher's
   * `onFailure: "block"` synthesis is the only outcome that accompanies an
   * `error`.
   */
  readonly outcome: HookOutcome | undefined
  /** Failure detail when the handler threw or its process failed; a failed run contributes no outcome. */
  readonly error: string | undefined
  /** Wall-clock milliseconds this run took. */
  readonly durationMs: number
  /** Exit code of a command run; absent for builtins, timeouts, and signal deaths. */
  readonly exitCode: number | undefined
}

/**
 * The outcome one `builtin` run contributes.
 *
 * A blocking action carries the reason the loader already defaulted;
 * `context` and `inject` carry their reminder line, but only `context` keeps
 * the action (the merge still has to see it, and the audit row names it),
 * while `inject` is the spec's builtin spelling of plain extra context;
 * `replace` carries the text the event puts in front of the model; `continue`
 * is the one action whose reason is optional, and an explicit `undefined` is
 * not lossless JSON for the audit row, so it is omitted. Every one is filtered
 * by the event's own plan like any other outcome.
 * @param run - the validated builtin run.
 * @returns its contribution to the event's merge.
 */
function builtinOutcome(run: BuiltinRun): HookOutcome {
  switch (run.action) {
    case 'deny':
    case 'ask':
    case 'block':
    case 'halt':
      return { action: run.action, reason: run.reason }
    case 'context':
      return { action: 'context', context: [run.text] }
    case 'inject':
      return { context: [run.text] }
    case 'replace':
      return { action: 'replace', replace: { text: run.text } }
    case 'continue':
      return { action: 'continue', ...run.reason === undefined ? {} : { reason: run.reason } }
  }
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
        outcome: builtinOutcome(run),
        error: undefined,
        durationMs: Math.round(performance.now() - started),
        exitCode: undefined,
      }
    }
    if (run.type === 'module') {
      const result = await runModule({
        file: resolveModulePath(source, run.path),
        timeoutMs: hook.timeoutMs,
        signal: environment.signal,
        payload: environment.payload,
        handler: { id: hook.id, event: hook.on, source },
        agent: environment.agent,
        workdir: environment.workdir,
        shell: environment.shell,
        log: environment.log,
      })
      return {
        hook,
        source,
        event: hook.on,
        handler: run.type,
        outcome: result.outcome,
        error: result.error,
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
      outcome: result.outcome,
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
      outcome: undefined,
      error: messageOf(error),
      durationMs: Math.round(performance.now() - started),
      exitCode: undefined,
    }
  }
}
