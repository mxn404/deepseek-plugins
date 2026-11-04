/**
 * Real-service harness for the `dsh-lifecycle-hooks` integration seam.
 *
 * Real Cordis Context, real agent loop, real tools, and a scripted mock LLM
 * adapter. Nothing in the plugin's own seams is mocked; assertions read the
 * messages the model actually received, whether a tool really ran, and the
 * plugin records the Session retained.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { vi } from 'vitest'
import * as DshLifecycleHooks from '../../src/index.ts'
import { MockAdapter } from './mock-adapter.ts'
import { dshHomeOf } from './project.ts'

/** One mounted host context and the adapters/agents created in it. */
export interface HooksHarness {
  readonly ctx: Context
  /** `$DSH_HOME` the plugin resolves user-level hooks against. */
  readonly dshHome: string
  /** Every warning the context logged, in order. */
  readonly warnings: string[]
  /**
   * The subset of {@link HooksHarness.warnings} this plugin logged. Host
   * stacks warn about their own environment (process containment, for one), so
   * an assertion about plugin noise reads this list.
   */
  readonly pluginWarnings: string[]
  /** Register one mock model route and return its adapter. */
  registerAdapter(route: string, script: ConstructorParameters<typeof MockAdapter>[0]): MockAdapter
  /** Create a production Agent on one registered route. */
  createAgent(route: string, cwd?: string, meta?: AgentSessionMeta): Promise<Agent>
  /**
   * Dispose the AgentLoop fiber, which disposes every live Agent (and emits
   * `agent/disposed`) while the hooks plugin stays mounted.
   */
  disposeAgents(): Promise<void>
}

/** Fresh-session lineage a test may put on an Agent's Session header. */
export interface AgentSessionMeta {
  /** Durable parent lineage, for a Session standing in for a delegated child. */
  readonly parentSession?: SessionId
  /** Product classification of a delegated child. */
  readonly origin?: 'subagent'
  /** Delegation depth persisted on the child's header. */
  readonly delegationDepth?: number
}

/** Optional real-service stacks a test wants mounted next to the plugin. */
export interface HooksHarnessOptions {
  /** Mount the real bash tool stack (jobs, subprocess, shell env, executor, tool). */
  readonly bash?: boolean
  /**
   * Mount the real approval service, so a `tools/pre-execute` listener (or a
   * future `ask` outcome) produces the durable `approval/asked` event.
   */
  readonly approval?: boolean
  /**
   * Directory to use as the user's `$DSH_HOME`; defaults to `<root>/.dsh-home`.
   * Every harness stubs the env so a test never reads the developer's real home.
   */
  readonly dshHome?: string
}

/**
 * Mount the real loop, filesystem tools, the hooks plugin, and an AgentLoop.
 * @param root - project root the mounted filesystem starts in.
 * @param config - row config overrides; every omitted field takes its schema default.
 * @param options - optional extra real-service stacks.
 * @returns the harness.
 */
export async function createHooksHarness(
  root: string,
  config: Partial<DshLifecycleHooks.Config> = {},
  options: HooksHarnessOptions = {},
): Promise<HooksHarness> {
  const ctx = new CordisContext()
  // Discovery reads `DSH_HOME` on every resolve, so a stub here keeps the
  // developer's real `~/.dsh/hooks.json` out of every test.
  const dshHome = options.dshHome ?? dshHomeOf(root)
  vi.stubEnv('DSH_HOME', dshHome)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(ToolFs)
  if (options.bash === true) {
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(BashEnvPlugin, {})
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 20_000 })
    await ctx.plugin(ToolBash)
  }
  if (options.approval === true) await ctx.plugin(ApprovalService, { policy: 'ask' })
  // The Loader/schema supplies every default, so the harness only passes overrides.
  await ctx.plugin(DshLifecycleHooks, config as DshLifecycleHooks.Config)
  const agentLoopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const warnings: string[] = []
  const pluginWarnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    const message = args.map(value => String(value)).join(' ')
    warnings.push(message)
    if (message.startsWith(`${DshLifecycleHooks.name}:`)) pluginWarnings.push(message)
  })
  let sessions = 0
  return {
    ctx,
    dshHome,
    warnings,
    pluginWarnings,
    registerAdapter(route, script) {
      const adapter = new MockAdapter(script)
      ctx.llm.registerAdapter([route], adapter)
      return adapter
    },
    async createAgent(route, cwd = root, meta = {}) {
      sessions += 1
      // The loop's `create` types its meta as `Pick<SessionHeader, 'cwd'>`; a
      // variable carrying the extra lineage fields is assignable and reaches
      // the Session store's prepare(), which folds them into the header.
      const sessionMeta = { cwd, ...meta }
      return ctx.agentLoop.create(
        SessionId(`dsh-lifecycle-hooks-${String(sessions)}`),
        { provider: route, model: 'mock' },
        sessionMeta,
      )
    },
    async disposeAgents() {
      await agentLoopFiber.dispose()
    },
  }
}

/** Flatten every text block of every message in one model request. */
export function requestText(request: GenerateOptions): string {
  return request.messages
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
    .join('\n')
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
