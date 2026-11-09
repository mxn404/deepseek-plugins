/**
 * Event-level spec for the source-checkout guard.
 *
 * The pure decision table lives in `guard.spec.ts`; this drives the real
 * `tools/pre-execute` waterfall that `installSourceCheckoutGuard` registers on
 * a real Cordis context, the same way the host tool registry would call it.
 * Only the pending call is a stand-in: the registry builds the real
 * identity-protected execution, and the guard reads nothing from it but the
 * tool name, the parsed arguments, and the calling agent.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { installSourceCheckoutGuard } from '../src/host/guard.ts'
import { SessionScopeRegistry } from '../src/host/scope.ts'
import type { SessionScope } from '../src/types.ts'
import { harness, testAgent } from './harness.ts'

const PROJECT = '/work/project'
const CHECKOUT = '/work/project/.dsh/worktrees/quiet-harbor-3fa9'
const SCOPE: SessionScope = {
  worktree: { name: 'quiet-harbor-3fa9', path: CHECKOUT, branch: 'quiet-harbor-3fa9' },
  repositoryRoot: PROJECT,
}

/** The command text every denial case uses: Git aimed at the checkout. */
const TARGETS_CHECKOUT = `git -C ${PROJECT} pull origin main`

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Mount a host context, register one agent, and install the guard for it.
 * @param recordScope - whether the session should be known to run in a copy.
 * @returns the live context and the agent whose calls it dispatches.
 */
async function guarded(recordScope = true): Promise<{ ctx: Context; agent: Agent }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-guard-event-'))
  const host = await harness(root)
  ctx = host
  const agent = testAgent(host, root)
  const registry = new SessionScopeRegistry()
  if (recordScope) registry.remember(String(agent.session.id), SCOPE)
  installSourceCheckoutGuard(host, registry)
  return { ctx: host, agent }
}

/**
 * One pending call carrying only the fields the guard reads.
 * @param name - tool name the model called.
 * @param args - parsed arguments.
 * @param agent - calling agent, when the call has one.
 * @returns the stand-in execution.
 */
function pending(name: string, args: unknown, agent?: Agent): ToolExecution {
  return {
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: AbortSignal.timeout(5_000),
  } as unknown as ToolExecution
}

/**
 * Run one call through the real pre-execute waterfall.
 * @param host - context the guard is installed on.
 * @param exec - the pending call to decide.
 * @returns the decision the waterfall settles on.
 */
async function decide(host: Context, exec: ToolExecution): Promise<PreToolDecision> {
  return await host.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
}

describe('source checkout guard event', () => {
  it('denies Git against the project checkout for bash and pwsh alike', async () => {
    const { ctx, agent } = await guarded()
    const decisions = [
      await decide(ctx, pending('bash', { command: TARGETS_CHECKOUT, workdir: CHECKOUT }, agent)),
      await decide(ctx, pending('pwsh', { command: TARGETS_CHECKOUT }, agent)),
    ]
    for (const decision of decisions) {
      expect(decision.kind).toBe('deny')
      if (decision.kind !== 'deny') continue
      expect(decision.reason).toContain(PROJECT)
      expect(decision.reason).toContain(CHECKOUT)
    }
  })

  it('denies Git whose explicit workdir is the project checkout for pwsh', async () => {
    const { ctx, agent } = await guarded()
    const decision = await decide(ctx, pending('pwsh', { command: 'git status', workdir: PROJECT }, agent))
    expect(decision.kind).toBe('deny')
  })

  it('allows non-Git commands and every other tool name', async () => {
    const { ctx, agent } = await guarded()
    await expect(decide(ctx, pending('bash', { command: `Get-ChildItem ${PROJECT}` }, agent)))
      .resolves.toEqual({ kind: 'allow' })
    await expect(decide(ctx, pending('read', { command: TARGETS_CHECKOUT }, agent)))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('allows Git that stays inside the copy', async () => {
    const { ctx, agent } = await guarded()
    await expect(decide(ctx, pending('pwsh', { command: `git -C ${CHECKOUT} log --oneline` }, agent)))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('leaves a session with no recorded copy alone', async () => {
    const { ctx, agent } = await guarded(false)
    await expect(decide(ctx, pending('pwsh', { command: TARGETS_CHECKOUT }, agent)))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('leaves a call with no agent alone', async () => {
    const { ctx } = await guarded()
    await expect(decide(ctx, pending('pwsh', { command: TARGETS_CHECKOUT })))
      .resolves.toEqual({ kind: 'allow' })
  })
})
