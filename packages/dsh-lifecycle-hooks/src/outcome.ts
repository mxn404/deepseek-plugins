/**
 * Merging one event's hook runs into the decision the host seam applies.
 *
 * Hooks run in configuration order, and every hook gets to speak unless one
 * halted. The precedence is fixed here and nowhere else:
 *
 * 1. `halt` — the turn is cancelled, whatever else said. Only the events that
 *    can block anything support it.
 * 2. `deny` / `block` — the first one wins its reason; a later one cannot
 *    soften it, and a `deny` or `block` outranks a `replace` with no relation
 *    to order. `deny` is the blocking outcome of an event that gates input,
 *    `block` of one that withholds output.
 * 3. `ask` — a confirmation stop between blocking and continuing. Only
 *    `tool.pre` lists it, and only its host seam can run an approval flow; an
 *    event that does not support the action has already had it removed by
 *    {@link allowedDecisions}. An `ask` never outranks a `deny` or a `block`.
 * 4. `continue` — every continue joins one reason list, in configuration
 *    order; only an event with no blocking action can reach it.
 * 5. `replace` — the last replacement in configuration order wins, so a hook
 *    later in the file can refine an earlier one.
 * 6. `context` — never a reason to stop, always concatenated in configuration
 *    order so the model reads the hooks in the order the file lists them, even
 *    when a block wins.
 *
 * An action the event does not support is not merged at all:
 * {@link allowedDecisions} drops it with a warning first, keeping any context
 * the hook also contributed.
 *
 * @module dsh-lifecycle-hooks/outcome
 */

import type { HookRun } from './handler.ts'
import type { ApprovalDisplayReason, HookAction, HookDecision, HookEvent } from './hook.ts'

/** Reason used when a merge has to deny without one from a hook run. */
const FALLBACK_DENY = 'denied by a lifecycle hook'

/** Reason used when a merge has to block a tool result without one from a hook run. */
const FALLBACK_BLOCK = 'blocked by a lifecycle hook'

/** Reason used when a merge has to halt without one from a hook run. */
const FALLBACK_HALT = 'halted by a lifecycle hook'

/** Reason used when a merge has to ask without one from a hook run. */
const FALLBACK_ASK = 'a lifecycle hook asked for confirmation'

/** The decision an event applies after every matching hook ran. */
export interface MergedDecision {
  /**
   * The action to apply, ranked `halt` > `deny` / `block` > `ask` > `continue`
   * > `replace`. Absent when the hooks only added context.
   */
  readonly action?: Extract<HookAction, 'halt' | 'deny' | 'block' | 'ask' | 'continue' | 'replace'>
  /**
   * Reason for a blocking action, never empty when the action is set. For a
   * `continue` it is the joined reasons of every continuing hook, absent when
   * none gave one. A `replace` has no reason of its own.
   */
  readonly reason?: string
  /**
   * Localized approval prompt copy, present exactly when the winning action is
   * the `ask` that supplied it. Only `tool.pre` consumes it.
   */
  readonly displayReason?: ApprovalDisplayReason
  /** Context lines from every hook, in configuration order. */
  readonly context: readonly string[]
  /**
   * The winning replacement, present exactly when {@link MergedDecision.action}
   * is `replace`: only the model-visible content is ever replaced.
   */
  readonly replace?: { readonly text: string }
}

/** Reason a blocking action falls back to when no hook gave one. */
const FALLBACKS: Readonly<Record<'halt' | 'deny' | 'block' | 'ask', string>> = {
  halt: FALLBACK_HALT,
  deny: FALLBACK_DENY,
  block: FALLBACK_BLOCK,
  ask: FALLBACK_ASK,
}

/**
 * Drop a run's action when the event does not support it, keeping its context.
 *
 * An illegal action is a hook author's mistake, not an event failure: it is
 * warned about, ignored, and the rest of the hook's outcome still counts. The
 * action's reason and replacement are dropped with it — neither means anything
 * without the action that applies it.
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
 * `tool.pre` denies the call and `step.start` denies the step: a broken safety
 * hook must not let either through. `tool.post` blocks the result: a broken
 * sanitizer must not let the model read output it was supposed to rewrite.
 * `session.start` has no blocking outcome — it can only add context, so a
 * failure there stays fail-open. `turn.stop` deliberately synthesizes nothing
 * either: its only legal action is `continue`, and a hook that failed has no
 * evidence that more work is needed, so it fails open instead of forcing
 * another step. The events a later ticket adds map their own blocking outcome
 * here, beside the merge ranking, so failure policy stays one decision per
 * event.
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
  const reason = `hook "${hookId}" failed: ${error}`
  if (event === 'tool.pre' || event === 'step.start') return { action: 'deny', reason }
  if (event === 'tool.post') return { action: 'block', reason }
  return undefined
}

/**
 * Merge one event's runs into the single decision the seam applies.
 * @param runs - the runs of every matched hook, in configuration order.
 * @returns the merged decision, or `undefined` when no run contributed anything.
 */
export function mergeDecisions(runs: readonly HookRun[]): MergedDecision | undefined {
  let halt: HookDecision | undefined
  let deny: HookDecision | undefined
  let block: HookDecision | undefined
  let ask: HookDecision | undefined
  let replace: { readonly text: string } | undefined
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
    else if (decision.action === 'block') block ??= decision
    else if (decision.action === 'ask') ask ??= decision
    else if (decision.action === 'continue') {
      // A continue with no reason still asks the turn to go on; the plan
      // supplies the model-facing fallback line for it.
      continued = true
      const reason = (decision.reason ?? '').trim()
      if (reason.length > 0) continueReasons.push(reason)
    }
    // Replace is last-wins: a later hook refines the result the model reads,
    // while `replace` without the action is an incomplete outcome and ignored.
    else if (decision.action === 'replace' && decision.replace !== undefined) {
      replace = decision.replace
    }
    if (decision.context !== undefined) context.push(...decision.context)
  }
  const blocking = halt ?? deny ?? block ?? ask
  if (blocking !== undefined) {
    const action = halt !== undefined
      ? 'halt'
      : deny !== undefined
        ? 'deny'
        : block !== undefined
          ? 'block'
          : 'ask'
    const reason = (blocking.reason ?? '').trim()
    return {
      action,
      reason: reason.length === 0 ? FALLBACKS[action] : reason,
      ...action === 'ask' && ask?.displayReason !== undefined ? { displayReason: ask.displayReason } : {},
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
  if (replace !== undefined) return { action: 'replace', replace, context }
  return context.length === 0 ? undefined : { context }
}
