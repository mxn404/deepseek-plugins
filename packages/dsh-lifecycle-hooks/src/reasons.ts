/**
 * The model-facing fallback lines a hook outcome can fall back to.
 *
 * Two places need the same strings and must never drift: the loader, which
 * defaults a builtin action's missing reason, and the merge, which fills a
 * blocking outcome that reached it without one. They live here so a builtin
 * rule and a command script produce the same sentence for the same action.
 *
 * `continue` is separate on purpose: it is not a blocking action, its reason is
 * optional, and the line is only used when neither a reason nor context exists.
 *
 * @module dsh-lifecycle-hooks/reasons
 */

/** Default reason per blocking action. */
export const FALLBACK_REASONS = {
  deny: 'denied by a lifecycle hook',
  ask: 'a lifecycle hook asked for confirmation',
  block: 'blocked by a lifecycle hook',
  halt: 'halted by a lifecycle hook',
} as const

/** Line the model reads when a continue hook gave neither a reason nor context. */
export const FALLBACK_CONTINUE = 'continue: a turn.stop hook asked the agent to keep going'
