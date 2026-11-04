/**
 * The one reminder message every event this plugin injects.
 *
 * Hooks contribute plain reminder lines; the model reads one user-role
 * `<system-reminder>` block per event, with the lines in configuration order.
 * The message's source is this plugin's own kind, which is the only attribution
 * the model surface keeps — a consumer (or a later hook) can tell a lifecycle
 * reminder apart from something the user typed.
 *
 * The declaration lives here and nowhere else: the plugin owns exactly one
 * `MessageSourceMap` entry, and every event shares it.
 *
 * @module dsh-lifecycle-hooks/context
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

// The plugin's own message source: an injected reminder is attributable to
// this plugin and to nothing else, which is the only attribution the model
// surface keeps. The host treats an unknown kind as an ordinary user message,
// so this declaration only has to hold for this package's own typecheck.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-lifecycle-hooks': { kind: 'dsh-lifecycle-hooks' }
  }
}

/** Source stamped on every context message this plugin injects. */
export const CONTEXT_SOURCE: MessageSource = { kind: 'dsh-lifecycle-hooks' }

/** Model-facing wrapper that marks a message as hook-contributed context. */
const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/**
 * Fold every hook's context into the one reminder message the model sees.
 * @param context - the lines, already in configuration order.
 * @returns the user-role message to inject or fold into a step.
 */
export function contextMessage(context: readonly string[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `${REMINDER_OPEN}\n${context.join('\n')}\n${REMINDER_CLOSE}` }],
    source: CONTEXT_SOURCE,
  })
}
