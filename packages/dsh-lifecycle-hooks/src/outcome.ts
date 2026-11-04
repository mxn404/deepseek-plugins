/**
 * Merging one event's hook runs into the decision the host seam applies.
 *
 * Hooks run in configuration order, and every hook gets to speak unless one
 * halted. The precedence is fixed here and nowhere else:
 *
 * 1. `halt` — the turn is cancelled, whatever else said.
 * 2. `deny` — the first denial wins its reason; a later one cannot soften it.
 * 3. `continue` — every continue joins one message, in configuration order;
 *    only an event with no blocking action can reach it.
 * 4. `context` — never a reason to stop, always concatenated in configuration
 *    order so the model reads the hooks in the order the file lists them.
 *
 * Actions that a later ticket adds (`ask`, `block`, `replace`) join the ranking
 * here. An action the event does not support is not merged at all:
 * {@link allowedDecisions} drops it with a warning first, keeping any context
 * the hook also contributed.
 *
 * @module dsh-lifecycle-hooks/outcome
 */

import type { HookRun } from './handler.ts'
import type { HookAction, HookDecision, HookEvent } from './hook.ts'

/** Reason used when a merge has to deny without one from a hook run. */
const FALLBACK_REASON = 'denied by a lifecycle hook'

/** The decision an event applies after every matching hook ran. */
export interface MergedDecision {
  /** The action to apply; `halt` outranks `deny`, and both outrank `continue`. */
  readonly action?: Extract<HookAction, 'halt' | 'deny' | 'continue'>
  /**
   * Reason for {@link MergedDecision.action}. For a blocking action it is never
   * empty; for `continue` it is absent when no hook gave one.
   */
  readonly reason?: string
  /** Context lines from every hook, in configuration order. */
  readonly context: readonly string[]
}

/**
 * Drop a run's action when the event does not support it, keeping its context.
 *
 * An illegal action is a hook author's mistake, not an event failure: it is
 * warned about, ignored, and the rest of the hook's outcome still counts. The
 * action's reason is dropped with it — a reason without an action has nothing
 * to explain.
 * @param runs - the runs of every matched hook, in configuration order.
 * @param allowed - the actions the event supports.
 * @param warn - sink for the one-line notice naming the hook and the event.
 * @returns the runs, with unsupported actions removed.
 */
export function allowedDecisions(
  runs: readonly HookRun[],
  allowed: readonly HookAction[],
  warn: (message: string) => void,
): readonly HookRun[] {
  return runs.map((run) => {
    const decision = run.decision
    const action = decision?.action
    if (decision === undefined || action === undefined || allowed.includes(action)) return run
    warn(`hook "${run.hook.id}" reported action "${action}", which ${run.event} does not support; ignored`)
    const kept: HookDecision = {
      ...decision.context === undefined ? {} : { context: decision.context },
    }
    return { ...run, decision: kept }
  })
}

/**
 * The decision a failed run synthesizes under `onFailure: "block"`.
 *
 * `tool.pre` denies the call: a broken safety hook must not let the call
 * through. `turn.stop` deliberately synthesizes nothing: its only legal action
 * is `continue`, and a hook that failed has no evidence that more work is
 * needed, so it fails open instead of forcing another step. The events a later
 * ticket adds map their own blocking outcome here, beside the merge ranking, so
 * failure policy stays one decision per event.
 * @param event - the event the failed run belongs to.
 * @param hookId - the entry's id, named in the reason so the model can act on it.
 * @param error - the failure detail.
 * @returns the synthesized decision, or `undefined` for an event with no blocking action.
 */
export function failureDecision(
  event: HookEvent,
  hookId: string,
  error: string,
): HookDecision | undefined {
  if (event !== 'tool.pre') return undefined
  return { action: 'deny', reason: `hook "${hookId}" failed: ${error}` }
}

/**
 * Merge one event's runs into the single decision the seam applies.
 * @param runs - the runs of every matched hook, in configuration order.
 * @returns the merged decision, or `undefined` when no run contributed anything.
 */
export function mergeDecisions(runs: readonly HookRun[]): MergedDecision | undefined {
  let halt: HookDecision | undefined
  let deny: HookDecision | undefined
  let continued = false
  const continueReasons: string[] = []
  const context: string[] = []
  for (const run of runs) {
    // The runner leaves `decision` unset on a failed run; the only failure that
    // carries one is the dispatcher's `onFailure: "block"` synthesis, which is
    // a decision on purpose and must merge like any other.
    const decision = run.decision
    if (decision === undefined) continue
    if (decision.action === 'halt') halt ??= decision
    else if (decision.action === 'deny') deny ??= decision
    else if (decision.action === 'continue') {
      // A continue with no reason still asks the turn to go on; the plan
      // supplies the model-facing fallback line for it.
      continued = true
      const reason = (decision.reason ?? '').trim()
      if (reason.length > 0) continueReasons.push(reason)
    }
    if (decision.context !== undefined) context.push(...decision.context)
  }
  const blocking = halt ?? deny
  if (blocking !== undefined) {
    const reason = (blocking.reason ?? '').trim()
    return {
      action: halt === undefined ? 'deny' : 'halt',
      reason: reason.length === 0 ? FALLBACK_REASON : reason,
      context,
    }
  }
  if (continued) {
    const reason = continueReasons.join('\n')
    return {
      action: 'continue',
      ...reason.length === 0 ? {} : { reason },
      context,
    }
  }
  return context.length === 0 ? undefined : { context }
}
