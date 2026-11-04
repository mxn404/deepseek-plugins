/**
 * Merging one event's hook runs into the decision the host seam applies.
 *
 * Hooks run in configuration order. `deny` is the only decision vocabulary this
 * build has, so the merge is "the first denial wins"; when the other actions
 * arrive, their fixed precedence goes here rather than at the call site, which
 * keeps the option ranking in exactly one place.
 *
 * @module dsh-lifecycle-hooks/outcome
 */

import type { HookDecision, HookRun } from './handler.ts'

/** Reason used when a merge has to deny without one from a hook run. */
const FALLBACK_REASON = 'denied by a lifecycle hook'

/**
 * Merge one event's runs into the single decision the seam applies.
 * @param runs - the runs of every matched hook, in configuration order.
 * @returns the merged decision, or `undefined` when no run blocked the event.
 */
export function mergeDecisions(runs: readonly HookRun[]): HookDecision | undefined {
  for (const run of runs) {
    if (run.decision === undefined) continue
    return { action: run.decision.action, reason: run.decision.reason || FALLBACK_REASON }
  }
  return undefined
}
