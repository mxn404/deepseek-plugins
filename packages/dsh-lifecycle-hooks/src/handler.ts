/**
 * Executing one matched hook.
 *
 * The runner owns the parts later handler kinds also need: the wall-clock
 * measurement every audit row carries, and the containment rule that a failing
 * hook becomes a recorded `error` instead of an exception thrown into the host
 * pipeline. For a `builtin` action the work is synchronous, so the timeout a
 * hook entry declares cannot be reached; the asynchronous kinds a later ticket
 * adds consume it.
 *
 * @module dsh-lifecycle-hooks/handler
 */

import type { Hook, HookEvent, HookHandlerKind } from './hook.ts'

/** The decision one hook run contributes to its event. */
export interface HookDecision {
  readonly action: 'deny'
  /** Model-facing reason, never empty. */
  readonly reason: string
}

/** What one executed hook did, for the decision merge and the audit row. */
export interface HookRun {
  readonly hook: Hook
  /** Absolute path of the hooks file the hook came from. */
  readonly source: string
  readonly event: HookEvent
  readonly handler: HookHandlerKind
  /** Its decision, or `undefined` when it only observed or failed. */
  readonly decision: HookDecision | undefined
  /** Failure detail when the handler threw; a failed run contributes no decision. */
  readonly error: string | undefined
  /** Wall-clock milliseconds this run took. */
  readonly durationMs: number
}

/**
 * Run one matched hook.
 *
 * A throwing handler never propagates: its run carries `error` instead, so one
 * broken hook cannot break the tool pipeline.
 * @param hook - the validated entry to execute.
 * @param source - absolute path of the file it came from, for the audit row.
 * @returns the measured run.
 */
export async function executeHook(hook: Hook, source: string): Promise<HookRun> {
  const started = performance.now()
  try {
    const decision = executeBuiltin(hook.run)
    return {
      hook,
      source,
      event: hook.on,
      handler: hook.run.type,
      decision,
      error: undefined,
      durationMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    return {
      hook,
      source,
      event: hook.on,
      handler: hook.run.type,
      decision: undefined,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - started),
    }
  }
}

/**
 * Turn a builtin run into its decision.
 * @param run - the validated builtin description.
 * @returns the decision the host seam applies.
 */
function executeBuiltin(run: Hook['run']): HookDecision {
  return { action: run.action, reason: run.reason }
}
