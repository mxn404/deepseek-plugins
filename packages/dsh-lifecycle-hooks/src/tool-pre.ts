/**
 * The `tool.pre` dispatch plan: deny the call, ask the user to confirm it, add
 * context, or halt the turn.
 *
 * The host seam is `tools/pre-execute`; a `deny` never runs the tool and the
 * model sees the reason as that call's error result. An `ask` does not decide
 * anything by itself: the host turns it into its own approval request and maps
 * the outcome (`allowed-once` runs the tool, every refusal becomes a deny with
 * the host's own reason), so this plugin must not call the approval service
 * itself. Context cannot ride on a pre-execute decision, so it is injected
 * with `agent.inject`: the loop parks it in the next-step inbox and the model
 * reads it on the following request.
 *
 * A `halt` cancels the turn with the host's own `{kind:'hook'}` cause and also
 * denies this call, so nothing scheduled behind the hook runs. The turn is
 * over at that point, so the halt path injects no context.
 *
 * @module dsh-lifecycle-hooks/tool-pre
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { contextMessage } from './context.ts'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'
import type { MergedOutcome } from './outcome.ts'

/**
 * Build the `tool.pre` plan for one call.
 * @param exec - the tool call the host is about to run.
 * @param agent - the agent that issued it.
 * @returns the plan the shared dispatcher executes.
 */
export function toolPrePlan(exec: ToolExecution, agent: Agent): DispatchPlan<PreToolDecision> {
  return {
    event: 'tool.pre',
    actions: EVENT_ACTIONS['tool.pre'],
    subject: {
      match: { kind: 'tool', tool: exec.name, args: exec.arguments },
      fields: {
        tool: { name: exec.name, call_id: exec.callId, input: exec.arguments },
      },
    },
    apply(outcome: MergedOutcome): PreToolDecision | undefined {
      if (outcome.action === 'halt') {
        agent.cancel({ kind: 'hook', reason: outcome.reason })
        return { kind: 'deny', reason: outcome.reason }
      }
      if (outcome.context.length > 0) agent.inject(contextMessage(outcome.context))
      if (outcome.action === 'deny') return { kind: 'deny', reason: outcome.reason }
      if (outcome.action === 'ask') {
        return {
          kind: 'ask',
          reason: outcome.reason,
          ...outcome.displayReason === undefined ? {} : { displayReason: outcome.displayReason },
        }
      }
      return undefined
    },
  }
}
