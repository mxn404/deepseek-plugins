/**
 * The `step.start` dispatch plan: deny the proposed step, add context to it, or
 * halt the turn.
 *
 * The host seam is the `agent/pre-step` waterfall. Each step proposes a batch of
 * claimed messages; only messages the user authored (`source.kind === 'user'`)
 * count as a prompt. A tool-continuation step proposes no user message, so its
 * prompt is `null` and `match.prompt` can tell the two apart.
 *
 * - `deny` returns `{kind:'reject'}` without delegating, so the turn ends
 *   blocked and the prompt never reaches the model.
 * - `context` delegates with `next()` first, then appends the single reminder
 *   message to the returned batch, preserving downstream messages and
 *   `startsRequestSeries`.
 * - `halt` cancels the turn with the host's own `{kind:'hook'}` cause. Nothing
 *   runs after it.
 *
 * A deny outranks context: the merged outcome carries both, and the applier
 * rejects the step, so a context line never reaches a model request from a
 * denied step.
 *
 * @module dsh-lifecycle-hooks/step-start
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { contextMessage } from './context.ts'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'
import type { MergedOutcome } from './outcome.ts'

/**
 * Extract the user prompt a step's claimed batch carries.
 *
 * Only a message the user authored is a prompt: a tool-continuation step's
 * batch is empty (or holds producer context), and treating that as a submitted
 * prompt would fire every prompt rule once per tool call.
 * @param messages - the messages the loop claimed for this step.
 * @returns the concatenated user text, or `null` when the step has no prompt.
 */
export function promptOf(messages: readonly UserMessage[]): string | null {
  const lines: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      if (block.text.trim().length === 0) continue
      lines.push(block.text)
    }
  }
  return lines.length === 0 ? null : lines.join('\n')
}

/**
 * Build the `step.start` plan for one proposed step.
 * @param agent - the agent about to take the step.
 * @param messages - the messages the loop claimed for it.
 * @param next - the rest of the waterfall; called only when context is folded.
 * @returns the plan the shared dispatcher executes.
 */
export function stepStartPlan(
  agent: Agent,
  messages: readonly UserMessage[],
  next: () => Promise<PreStepDecision>,
): DispatchPlan<PreStepDecision> {
  const prompt = promptOf(messages)
  return {
    event: 'step.start',
    actions: EVENT_ACTIONS['step.start'],
    subject: {
      match: { kind: 'prompt', prompt },
      fields: { prompt, message_count: messages.length },
    },
    async apply(outcome: MergedOutcome): Promise<PreStepDecision | undefined> {
      if (outcome.action === 'halt') {
        agent.cancel({ kind: 'hook', reason: outcome.reason })
        return { kind: 'reject' }
      }
      // Deny wins over context: the step is rejected, so no model request is
      // built from it and the context lines have nowhere to land.
      if (outcome.action === 'deny') return { kind: 'reject' }
      if (outcome.context.length === 0) return undefined
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      return { ...downstream, messages: [...downstream.messages, contextMessage(outcome.context)] }
    },
  }
}
