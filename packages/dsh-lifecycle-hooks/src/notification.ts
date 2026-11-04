/**
 * The `notification` dispatch plan: observe an approval ask or an agent error
 * without touching either.
 *
 * `notification` is not a first-class host event: the host's seams are the
 * durable `approval/asked` Session event and the Cordis `agent/error` emit.
 * This module owns the payload derived from each — the `type`, a one-line
 * `message`, and the tool name for an approval — so the two derivations stay
 * testable without mounting a host, and the plugin's listeners only have to
 * hand the shared dispatcher the plan.
 *
 * A notification hook never decides anything: {@link EVENT_ACTIONS} has no
 * action for this event, so the loader forces command handlers detached and
 * skips builtin entries, and the dispatcher records each run without waiting
 * for it.
 *
 * @module dsh-lifecycle-hooks/notification
 */

import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'

/** What produced a notification. */
export type NotificationType = 'approval' | 'error'

/** The payload every notification hook receives. */
export interface NotificationPayload {
  /** Which seam produced it: an approval ask or an agent error. */
  readonly type: NotificationType
  /** One-line human-readable description; never empty. */
  readonly message: string
  /**
   * Tool whose call raised the approval, present only on an `approval`
   * notification: an error is not tied to a tool call.
   */
  readonly tool_name?: string
}

/**
 * Build the payload for an `approval/asked` Session event.
 *
 * The asker's reason is the most useful line when it gave one; otherwise the
 * tool name is the only fact a notifier can act on. The tool name is always
 * reported, so a hook can route on it even when the reason is present.
 * @param ask - the durable event's `toolName` and optional `reason`.
 * @returns the notification payload.
 */
export function approvalNotification(
  ask: { readonly toolName: string; readonly reason?: string },
): NotificationPayload {
  const reason = ask.reason?.trim() ?? ''
  return {
    type: 'approval',
    message: reason.length > 0 ? reason : `approval requested for tool "${ask.toolName}"`,
    tool_name: ask.toolName,
  }
}

/**
 * Build the payload for an `agent/error` emit.
 *
 * The error is whatever the loop caught, so the message is read defensively: an
 * `Error`, a structured failure object with a `message`, or an arbitrary thrown
 * value all become one line.
 * @param error - the failed turn's error.
 * @returns the notification payload, without a tool name.
 */
export function errorNotification(error: unknown): NotificationPayload {
  return { type: 'error', message: messageOf(error) }
}

/**
 * Build the `notification` plan for one derived notification.
 * @param payload - the event's own fields.
 * @returns the plan the shared dispatcher executes.
 */
export function notificationPlan(payload: NotificationPayload): DispatchPlan<undefined> {
  return {
    event: 'notification',
    actions: EVENT_ACTIONS.notification,
    subject: {
      // No match dimension: one entry observes every approval and every error,
      // and the script branches on the payload's `type` and `tool_name`.
      match: { kind: 'none' },
      fields: {
        type: payload.type,
        message: payload.message,
        ...payload.tool_name === undefined ? {} : { tool_name: payload.tool_name },
      },
    },
    // No run can contribute a decision at an observe-only event; this applier
    // exists only to satisfy the plan shape and never reaches the host.
    apply(): undefined {
      return undefined
    },
  }
}

/**
 * Render one caught value for the payload's message.
 * @param error - anything thrown or reported.
 * @returns a single-line description, never empty.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  const text = String(error)
  return text.length > 0 ? text : 'the agent reported an error'
}
