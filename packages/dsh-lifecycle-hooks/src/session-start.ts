/**
 * The `session.start` dispatch plan: add context the first model request sees.
 *
 * The host seam is the serial `agent/created` event. The listener is awaited
 * before the new agent is handed back, and `agent.inject` parks the reminder in
 * the next-step inbox, which the first `agent/pre-step` claims into its own
 * batch. That is why the injection is guaranteed rather than best-effort: there
 * is no later wake-up for the first request to miss.
 *
 * The event has no turn yet, so `context` is its only outcome; an entry naming
 * another action is dropped at load time, and a command handler that reports
 * one is warned about and ignored by the shared dispatcher.
 *
 * @module dsh-lifecycle-hooks/session-start
 */

import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { contextMessage } from './context.ts'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'
import type { MergedOutcome } from './outcome.ts'

/**
 * Build the `session.start` plan for one new agent.
 * @param agent - the agent the host has just created.
 * @param source - whether the session started fresh, resumed, cleared, or compacted.
 * @returns the plan the shared dispatcher executes.
 */
export function sessionStartPlan(agent: Agent, source: SessionStartSource): DispatchPlan<undefined> {
  return {
    event: 'session.start',
    actions: EVENT_ACTIONS['session.start'],
    subject: {
      match: { kind: 'none' },
      // The event's start source is named `source` in the format, so it takes
      // that payload key for this event; `hook_id` still identifies the entry.
      fields: { source },
    },
    apply(outcome: MergedOutcome): undefined {
      if (outcome.context.length === 0) return undefined
      // The first pre-step claims the next-step inbox, so this lands on the
      // first request instead of a later wake-up.
      agent.inject(contextMessage(outcome.context))
      return undefined
    },
  }
}
