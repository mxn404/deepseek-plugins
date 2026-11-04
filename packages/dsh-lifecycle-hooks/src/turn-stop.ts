/**
 * The `turn.stop` dispatch plan: let a hook ask for one more step.
 *
 * The host seam is `agent/turn-stopping`, a serial event whose return value it
 * ignores. The only way to continue the turn is to put a message into the
 * next-step inbox before the serial dispatch settles, so the plan steers the
 * agent with the merged continue text. Every hook's continue merges into
 * exactly one steer message: {@link mergeOutcomes} joins their reasons and
 * contexts, and the plan steers once.
 *
 * `continue` is the only action this event supports. A `halt`, `deny`, `ask`,
 * or `block` reported by a command hook is warned about and ignored by
 * {@link allowedOutcomes}; a builtin naming one is skipped at load time.
 *
 * Because a hook that always continues would keep the turn alive forever, every
 * grant counts against `maxStopContinues`. The count is per Agent and turn: a
 * new turn number reads as 0, so the guard resets without observing
 * `turn/start`. Past the cap the plan warns, leaves the inbox empty, and the
 * host closes the turn; the run itself is still recorded.
 *
 * @module dsh-lifecycle-hooks/turn-stop
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { contextMessage } from './context.ts'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'
import { FALLBACK_CONTINUE } from './reasons.ts'
import type { MergedOutcome } from './outcome.ts'

/**
 * Consecutive continues granted per Agent, keyed by turn.
 *
 * The host hands `agent/turn-stopping` the current turn number, so a counter
 * that remembers the number it belongs to resets itself the moment a new turn
 * stops: the stored number no longer matches and the count reads as 0. No
 * `turn/start` subscription is needed, and a turn that never continued keeps
 * no state at all.
 */
export class StopContinues {
  private readonly granted = new WeakMap<Agent, { turn: number; count: number }>()

  /**
   * How many consecutive continues this Agent's turn has already granted.
   * @param agent - the agent stopping.
   * @param turn - the turn stopping.
   * @returns the granted count, or 0 for a turn with no grant yet.
   */
  of(agent: Agent, turn: number): number {
    const entry = this.granted.get(agent)
    return entry !== undefined && entry.turn === turn ? entry.count : 0
  }

  /**
   * Record one granted continue and return the new count.
   * @param agent - the agent stopping.
   * @param turn - the turn stopping.
   * @returns the granted count including this one.
   */
  grant(agent: Agent, turn: number): number {
    const count = this.of(agent, turn) + 1
    this.granted.set(agent, { turn, count })
    return count
  }
}

/** What the plan needs from the plugin instance that owns the event. */
export interface TurnStopOptions {
  /** The turn the host says is stopping; also the counter's reset key. */
  readonly turn: number
  /** Consecutive continues already granted in this turn, for the payload. */
  readonly continuedCount: number
  /** Shared per-agent continue counter. */
  readonly continues: StopContinues
  /** Cap on consecutive continues in one turn. */
  readonly maxStopContinues: number
  /** Warning sink; the owner adds the plugin-name prefix. */
  readonly warn: (message: string) => void
}

/**
 * Build the `turn.stop` plan for one stop.
 * @param agent - the agent whose turn is stopping.
 * @param options - the turn, its counter state, the cap, and the warning sink.
 * @returns the plan the shared dispatcher executes.
 */
export function turnStopPlan(agent: Agent, options: TurnStopOptions): DispatchPlan<void> {
  return {
    event: 'turn.stop',
    actions: EVENT_ACTIONS['turn.stop'],
    subject: {
      // No tool and no match dimensions: entries carrying a match are skipped
      // at load time.
      match: { kind: 'none' },
      fields: {
        turn: options.turn,
        continued_count: options.continuedCount,
      },
    },
    apply(outcome: MergedOutcome): void {
      if (outcome.action !== 'continue') return
      const already = options.continues.of(agent, options.turn)
      if (already >= options.maxStopContinues) {
        options.warn(
          `turn.stop: continue ignored after ${String(already)} consecutive continues`
          + ` (maxStopContinues is ${String(options.maxStopContinues)})`,
        )
        return
      }
      options.continues.grant(agent, options.turn)
      const lines = [
        ...outcome.reason === undefined ? [] : [outcome.reason],
        ...outcome.context,
      ]
      // Steer, not inject: the loop re-reads the next-step inbox when the
      // serial dispatch settles, and only a message already there keeps the
      // turn alive.
      agent.steer(contextMessage(lines.length === 0 ? [FALLBACK_CONTINUE] : lines))
    },
  }
}
