/**
 * Merging one event's hook runs into the outcome the host seam applies.
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
 *    {@link allowedOutcomes}. An `ask` never outranks a `deny` or a `block`.
 * 4. `continue` — every continue joins one reason list, in configuration
 *    order; only an event with no blocking action can reach it.
 * 5. `replace` — the last replacement in configuration order wins, so a hook
 *    later in the file can refine an earlier one.
 * 6. `context` — never a reason to stop, always concatenated in configuration
 *    order so the model reads the hooks in the order the file lists them, even
 *    when a block wins.
 * 7. `meta` — never ranked; the last document in configuration order is the
 *    one the merged outcome carries, and every run keeps its own in the audit
 *    record.
 *
 * An action the event does not support is not merged at all:
 * {@link allowedOutcomes} drops it with a warning first, keeping any context
 * and meta the hook also contributed.
 *
 * @module dsh-lifecycle-hooks/outcome
 */

import type { HookRun } from './handler.ts'
import type { ApprovalDisplayReason, HookAction, HookEvent, HookOutcome } from './hook.ts'
import { FALLBACK_REASONS } from './reasons.ts'

/** What every merged outcome carries, whatever its action. */
interface MergedBase {
  /** Context lines from every hook, in configuration order. */
  readonly context: readonly string[]
  /**
   * Free-form audit metadata the last contributing hook passed through. The
   * merge ranks no action for it: it is carried so the merged outcome has the
   * same document shape as a single run's.
   */
  readonly meta?: Record<string, unknown>
}

/**
 * The outcome an event applies after every matching hook ran.
 *
 * A discriminated union: a blocking or asking outcome always has a non-empty
 * reason (the merge fills one), a `replace` always has its replacement, and a
 * context-only outcome has no action at all. Every plan can therefore narrow on
 * `action` and use the payload without a fallback branch of its own.
 */
export type MergedOutcome =
  | MergedBase & {
      readonly action: 'continue'
      /** Joined reasons of the continuing hooks, absent when none gave one. */
      readonly reason?: string
    }
  | MergedBase & {
      readonly action: Extract<HookAction, 'halt' | 'deny' | 'block'>
      /** Never empty: the merge fills a missing reason with its action's default. */
      readonly reason: string
    }
  | MergedBase & {
      readonly action: 'ask'
      /** Never empty: the merge fills a missing reason with the ask default. */
      readonly reason: string
      /**
       * Localized approval prompt copy, present exactly when the winning ask
       * supplied it. Only `tool.pre` consumes it.
       */
      readonly displayReason?: ApprovalDisplayReason
    }
  | MergedBase & {
      readonly action: 'replace'
      /** The winning replacement: only the model-visible content is ever replaced. */
      readonly replace: { readonly text: string }
    }
  | MergedBase & {
      readonly action?: undefined
    }

/**
 * Drop a run's action when the event does not support it, keeping its context
 * and meta.
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
export function allowedOutcomes(
  runs: readonly HookRun[],
  allowed: readonly HookAction[],
  warn: (message: string) => void,
): readonly HookRun[] {
  return runs.map((run) => {
    const outcome = run.outcome
    const action = outcome?.action
    if (outcome === undefined || action === undefined || allowed.includes(action)) return run
    warn(`hook "${run.hook.id}" reported action "${action}", which ${run.event} does not support; ignored`)
    const kept: HookOutcome = {
      ...outcome.context === undefined ? {} : { context: outcome.context },
      ...outcome.meta === undefined ? {} : { meta: outcome.meta },
    }
    return { ...run, outcome: kept }
  })
}

/**
 * The outcome a failed run synthesizes under `onFailure: "block"`.
 *
 * `tool.pre` denies the call and `step.start` denies the step: a broken safety
 * hook must not let either through. `tool.post` blocks the result: a broken
 * sanitizer must not let the model read output it was supposed to rewrite.
 * `session.start` has no blocking outcome — it can only add context, so a
 * failure there stays fail-open. `turn.stop` deliberately synthesizes nothing
 * either: its only legal action is `continue`, and a hook that failed has no
 * evidence that more work is needed, so it fails open instead of forcing
 * another step. The events a later ticket adds map their own blocking outcome
 * here, beside the merge ranking, so failure policy stays one outcome per
 * event.
 * @param event - the event the failed run belongs to.
 * @param hookId - the entry's id, named in the reason so the model can act on it.
 * @param error - the failure detail.
 * @returns the synthesized outcome, or `undefined` for an event with no blocking action.
 */
export function failureOutcome(
  event: HookEvent,
  hookId: string,
  error: string,
): HookOutcome | undefined {
  const reason = `hook "${hookId}" failed: ${error}`
  if (event === 'tool.pre' || event === 'step.start') return { action: 'deny', reason }
  if (event === 'tool.post') return { action: 'block', reason }
  return undefined
}

/**
 * Merge one event's runs into the single outcome the seam applies.
 * @param runs - the runs of every matched hook, in configuration order.
 * @returns the merged outcome, or `undefined` when no run contributed anything.
 */
export function mergeOutcomes(runs: readonly HookRun[]): MergedOutcome | undefined {
  let halt: HookOutcome | undefined
  let deny: HookOutcome | undefined
  let block: HookOutcome | undefined
  let ask: HookOutcome | undefined
  let replace: { readonly text: string } | undefined
  let meta: Record<string, unknown> | undefined
  let continued = false
  const continueReasons: string[] = []
  const context: string[] = []
  for (const run of runs) {
    // The runner leaves `outcome` unset on a failed run; the only failure that
    // carries one is the dispatcher's `onFailure: "block"` synthesis, which is
    // an outcome on purpose and must merge like any other.
    const outcome = run.outcome
    if (outcome === undefined) continue
    // Meta is last-wins, like replace: a later hook's document is the one the
    // merged outcome names, while every run keeps its own audit record.
    if (outcome.meta !== undefined) meta = outcome.meta
    if (outcome.action === 'halt') halt ??= outcome
    else if (outcome.action === 'deny') deny ??= outcome
    else if (outcome.action === 'block') block ??= outcome
    else if (outcome.action === 'ask') ask ??= outcome
    else if (outcome.action === 'continue') {
      // A continue with no reason still asks the turn to go on; the plan
      // supplies the model-facing fallback line for it.
      continued = true
      const reason = (outcome.reason ?? '').trim()
      if (reason.length > 0) continueReasons.push(reason)
    }
    // Replace is last-wins: a later hook refines the result the model reads,
    // while `replace` without the action is an incomplete outcome and ignored.
    else if (outcome.action === 'replace' && outcome.replace !== undefined) {
      replace = outcome.replace
    }
    if (outcome.context !== undefined) context.push(...outcome.context)
  }
  const metaField = meta === undefined ? {} : { meta }
  if (halt !== undefined) {
    return { action: 'halt', reason: blockingReason(halt, 'halt'), context, ...metaField }
  }
  if (deny !== undefined) {
    return { action: 'deny', reason: blockingReason(deny, 'deny'), context, ...metaField }
  }
  if (block !== undefined) {
    return { action: 'block', reason: blockingReason(block, 'block'), context, ...metaField }
  }
  if (ask !== undefined) {
    return {
      action: 'ask',
      reason: blockingReason(ask, 'ask'),
      ...ask.displayReason === undefined ? {} : { displayReason: ask.displayReason },
      context,
      ...metaField,
    }
  }
  if (continued) {
    const reason = continueReasons.join('\n')
    return {
      action: 'continue',
      ...reason.length === 0 ? {} : { reason },
      context,
      ...metaField,
    }
  }
  if (replace !== undefined) return { action: 'replace', replace, context, ...metaField }
  return context.length === 0 && meta === undefined ? undefined : { context, ...metaField }
}

/**
 * The reason a blocking outcome carries, defaulted when the run gave none.
 * @param outcome - the winning blocking outcome.
 * @param action - its action, selecting the default sentence.
 * @returns the trimmed reason, never empty.
 */
function blockingReason(
  outcome: HookOutcome,
  action: keyof typeof FALLBACK_REASONS,
): string {
  const reason = (outcome.reason ?? '').trim()
  return reason.length === 0 ? FALLBACK_REASONS[action] : reason
}
