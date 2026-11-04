/**
 * The `tool.result` dispatch plan: observe the final result of one tool call.
 *
 * The host seam is `tools/result`, an emit that fires after the registry has
 * frozen both the execution and its completed result and after every decision
 * seam has been applied. That timing is the whole contract: the event reports
 * what actually happened, so a hook can audit or notify but can never rewrite
 * the output the model will read. The loader therefore forces every command
 * handler at this event detached, and {@link EVENT_ACTIONS} lists no action it
 * could apply.
 *
 * The payload carries the same `tool` block as `tool.pre` / `tool.post` plus
 * the final `result` block, so one script can be bound to both `tool.post` (to
 * rewrite) and `tool.result` (to audit) without translating shapes.
 *
 * @module dsh-lifecycle-hooks/tool-result
 */

import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'

/**
 * Build the `tool.result` plan for one finished call.
 * @param exec - the frozen call the host reports.
 * @param result - the frozen final result the host reports.
 * @returns the plan the shared dispatcher executes.
 */
export function toolResultPlan(
  exec: Readonly<ToolExecution>,
  result: Readonly<ToolExecutionResult>,
): DispatchPlan<undefined> {
  return {
    event: 'tool.result',
    actions: EVENT_ACTIONS['tool.result'],
    subject: {
      match: { kind: 'tool', tool: exec.name, args: exec.arguments },
      fields: {
        tool: { name: exec.name, call_id: exec.callId, input: exec.arguments },
        result: { is_error: result.isError, content: result.content },
      },
    },
  }
}
