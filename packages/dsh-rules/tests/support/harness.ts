/**
 * Real-service harness for the `dsh-rules` integration seam.
 *
 * Real Cordis Context, real agent loop, real filesystem tools, and a scripted
 * mock LLM adapter. Nothing in the plugin's own seams is mocked; assertions
 * read the messages the model actually received and the process log.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import * as DshRules from '../../src/index.ts'
import { MockAdapter } from './mock-adapter.ts'

/** One mounted host context and the adapters/agents created in it. */
export interface RulesHarness {
  readonly ctx: Context
  /** Warnings the plugin emitted, in order. */
  readonly warnings: string[]
  /** Register one mock model route and return its adapter. */
  registerAdapter(route: string, script: ConstructorParameters<typeof MockAdapter>[0]): MockAdapter
  /** Create a production Agent on one registered route. */
  createAgent(route: string, cwd?: string): Promise<Agent>
}

/**
 * Mount the real loop, filesystem tools, the rules plugin, and an AgentLoop.
 * @param root - project root the mounted filesystem starts in.
 * @param config - row config overrides; every omitted field takes its schema default.
 * @returns the harness.
 */
export async function createRulesHarness(
  root: string,
  config: Partial<DshRules.Config> = {},
): Promise<RulesHarness> {
  const ctx = new CordisContext()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(ToolFs)
  // The Loader/schema supplies every default, so the harness only passes overrides.
  await ctx.plugin(DshRules, config as DshRules.Config)
  await ctx.plugin(AgentLoop, { agents: [] })
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(value => String(value)).join(' '))
  })
  let sessions = 0
  return {
    ctx,
    warnings,
    registerAdapter(route, script) {
      const adapter = new MockAdapter(script)
      ctx.llm.registerAdapter([route], adapter)
      return adapter
    },
    async createAgent(route, cwd = root) {
      sessions += 1
      return ctx.agentLoop.create(
        SessionId(`dsh-rules-${String(sessions)}`),
        { provider: route, model: 'mock' },
        { cwd },
      )
    },
  }
}

/** Flatten every text block of every message in one model request. */
export function requestText(request: GenerateOptions): string {
  return request.messages
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
    .join('\n')
}

/** Count non-overlapping occurrences of one probe in a request. */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Extract the first `<system-reminder>` block from a model request. */
export function reminderText(request: GenerateOptions): string | undefined {
  return /<system-reminder>[\s\S]*?<\/system-reminder>/.exec(requestText(request))?.[0]
}

/**
 * A response that issues several tool calls in one step.
 * @param calls - calls to issue, in order.
 * @returns model stream chunks.
 */
export function toolCallBatch(calls: readonly { id: string; name: string; arguments: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(call.id),
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

export { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
