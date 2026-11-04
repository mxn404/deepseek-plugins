/**
 * The `tool.pre` dispatch plan: deny the call, add context, or halt the turn.
 *
 * The host seam is `tools/pre-execute`; a `deny` never runs the tool and the
 * model sees the reason as that call's error result. Context cannot ride on a
 * pre-execute decision, so it is injected with `agent.inject`: the loop parks
 * it in the next-step inbox and the model reads it on the following request.
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
import type { MergedDecision } from './outcome.ts'

/** Reason used when a hook blocked the call without naming one. */
const FALLBACK_DENY = 'denied by a lifecycle hook'

/** Reason used when a hook halted the turn without naming one. */
const FALLBACK_HALT = 'halted by a lifecycle hook'

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
    apply(decision: MergedDecision): PreToolDecision | undefined {
      if (decision.action === 'halt') {
        const reason = decision.reason ?? FALLBACK_HALT
        agent.cancel({ kind: 'hook', reason })
        return { kind: 'deny', reason }
      }
      if (decision.context.length > 0) agent.inject(contextMessage(decision.context))
      if (decision.action === 'deny') return { kind: 'deny', reason: decision.reason ?? FALLBACK_DENY }
      return undefined
    },
  }
}
