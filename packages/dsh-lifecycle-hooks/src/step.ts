/**
 * The step number a tool call belongs to.
 *
 * The `turnBoundary` projection carries a turn number and the sequence of the
 * latest `step/start`, but not the step number, and new production code must
 * not read Session history (arbitrary synchronous history reads are
 * deprecated). So the plugin follows the committed `session/event` feed and
 * remembers the latest `step/start` per Session: cheap (one WeakMap write per
 * step) and exact for every step that opens while the plugin is mounted.
 *
 * A Session resumed before this plugin instance mounted has no observed
 * boundary until its next `step/start`; a payload built in that window reports
 * step 0 rather than an invented number.
 *
 * @module dsh-lifecycle-hooks/step
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Per-Session latest step, fed from the Session's committed event stream. */
export class StepTracker {
  private readonly steps = new WeakMap<Session, number>()

  /**
   * Record one committed Session event.
   * @param session - the Session the event belongs to.
   * @param event - the appended event.
   */
  observe(session: Session, event: SessionEvent): void {
    if (event.type !== 'step/start') return
    this.steps.set(session, event.data.step)
  }

  /**
   * The latest step observed for one Session.
   * @param session - the Session to read.
   * @returns the step number, or 0 when no step has been observed yet.
   */
  of(session: Session): number {
    return this.steps.get(session) ?? 0
  }
}
