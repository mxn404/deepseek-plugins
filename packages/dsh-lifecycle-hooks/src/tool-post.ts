/**
 * The `tool.post` dispatch plan: block the result, replace what the model
 * reads, or add context.
 *
 * The host seam is `tools/post-execute`, which runs after the tool has already
 * executed and produced a result. That timing is the whole point: a `tool.post`
 * hook can sanitize, redact, or reject output, but it can never prevent the
 * side effect. So:
 *
 * - `block` turns the result into an error (`isError: true`) whose content is
 *   the merged feedback; the tool really ran, and the model learns why its
 *   output was withheld.
 * - `replace` swaps only the model-visible `content` blocks for one text block.
 *   The result's canonical `value` is execution-local, schema-checked, and
 *   never durably logged, so it is not touched here; a run that tries to name
 *   it fails the stdout protocol instead (see `command.ts`).
 * - `context` rides on `additionalContexts`, which the loop ferries into the
 *   next step's inbox: the model reads it on the following request. Context
 *   survives a block, because the block's own contexts are the only ones the
 *   host keeps when a result becomes an error.
 *
 * A `halt` cancels the turn with the host's `{kind:'hook'}` cause and blocks
 * this result, so the model never reads output the hook was willing to stop the
 * turn over. The turn is over at that point, so the halt path injects no
 * context, exactly like `tool.pre`.
 *
 * @module dsh-lifecycle-hooks/tool-post
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { contextMessage } from './context.ts'
import type { DispatchPlan } from './dispatch.ts'
import { EVENT_ACTIONS } from './hook.ts'
import type { MergedOutcome } from './outcome.ts'

/**
 * Build the `tool.post` plan for one finished call.
 * @param exec - the call that already ran.
 * @param result - what it produced, as the host will hand it on.
 * @param agent - the agent that issued it.
 * @returns the plan the shared dispatcher executes.
 */
export function toolPostPlan(
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  agent: Agent,
): DispatchPlan<PostToolDecision> {
  return {
    event: 'tool.post',
    actions: EVENT_ACTIONS['tool.post'],
    subject: {
      match: { kind: 'tool', tool: exec.name, args: exec.arguments },
      fields: {
        tool: { name: exec.name, call_id: exec.callId, input: exec.arguments },
        result: { is_error: result.isError, content: result.content },
      },
    },
    apply(outcome: MergedOutcome): PostToolDecision | undefined {
      if (outcome.action === 'halt') {
        agent.cancel({ kind: 'hook', reason: outcome.reason })
        return { kind: 'block', feedback: textBlock(outcome.reason) }
      }
      // One message for every hook's lines, in configuration order, shared with
      // `tool.pre` so the model reads the same shape at every event.
      const contexts = outcome.context.length === 0
        ? undefined
        : [contextMessage(outcome.context)]
      if (outcome.action === 'block') {
        return {
          kind: 'block',
          feedback: textBlock(outcome.reason),
          ...contexts === undefined ? {} : { additionalContexts: contexts },
        }
      }
      if (outcome.action === 'replace') {
        return {
          // Content-only accept: the tool's `value` keeps whatever the tool
          // actually returned, which is the only shape the host re-validates.
          kind: 'accept',
          content: textBlock(outcome.replace.text),
          ...contexts === undefined ? {} : { additionalContexts: contexts },
        }
      }
      if (contexts === undefined) return undefined
      // Context-only accept: no `content` key at all, so the result keeps its
      // own blocks and the host only ferries the reminder to the next step.
      return { kind: 'accept', additionalContexts: contexts }
    },
  }
}

/**
 * The one text block a replacement or a block feedback is made of.
 * @param text - model-visible text, never empty in practice.
 * @returns a fresh content-block array.
 */
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}
