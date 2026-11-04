/**
 * The `session.end` dispatch plan: observe an Agent after it is disposed.
 *
 * The host reports disposal through the emit `agent/disposed`. Nothing may
 * wait at an emit, and a hook must never delay teardown, so the listener hands
 * the run to the detached tracker and returns: the Session's own log still
 * receives the audit row, and the plugin's disposer drains the run if teardown
 * continues into plugin disposal.
 *
 * The payload reports the Session's last closed turn and, when one was
 * observed, the reason that turn ended (`completed`, `aborted`, `error`, …).
 * The loop does not hand a reason to `agent/disposed`, so {@link TurnEndTracker}
 * reads it from the committed `turn/end` events: the same append feed that
 * already tracks steps, no deprecated history reads.
 *
 * @module dsh-lifecycle-hooks/session-end
 */

import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'

/** Per-Session turn number and reason, fed from the committed event stream. */
export class TurnEndTracker {
  private readonly ended = new WeakMap<Session, { readonly turn: number; readonly reason: TurnEndReason }>()

  /**
   * Record one committed Session event.
   * @param session - the Session the event belongs to.
   * @param event - the appended event.
   */
  observe(session: Session, event: SessionEvent): void {
    if (event.type !== 'turn/end') return
    this.ended.set(session, { turn: event.data.turn, reason: event.data.reason })
  }

  /**
   * The last turn this Session closed.
   * @param session - the Session to read.
   * @returns the turn number, or 0 when no turn has ended while observing.
   */
  turnOf(session: Session): number {
    return this.ended.get(session)?.turn ?? 0
  }

  /**
   * Why the last turn this Session closed ended.
   * @param session - the Session to read.
   * @returns the reason's discriminant, or `undefined` when none was observed.
   */
  reasonOf(session: Session): string | undefined {
    return this.ended.get(session)?.reason.kind
  }
}

/** What the plan reports about the Session being disposed. */
export interface SessionEndFacts {
  /** The last turn the Session closed, or 0 when none was observed. */
  readonly turn: number
  /** The reason that turn ended; absent when the plugin saw no `turn/end`. */
  readonly reason?: string
}

/**
 * Build the `session.end` plan for one disposed Agent.
 * @param facts - the turn and reason to report.
 * @returns the plan the shared dispatcher executes.
 */
export function sessionEndPlan(facts: SessionEndFacts): DispatchPlan<undefined> {
  return {
    event: 'session.end',
    actions: EVENT_ACTIONS['session.end'],
    subject: {
      // No match dimension: disposal is not a call, so one entry observes
      // every Session that ends.
      match: { kind: 'none' },
      fields: {
        turn: facts.turn,
        ...facts.reason === undefined ? {} : { reason: facts.reason },
      },
    },
  }
}
