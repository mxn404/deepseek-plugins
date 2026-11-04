/**
 * Integration spec for `ask` at `tool.pre`.
 *
 * Every case mounts a real Context, agent loop, tools, the real approval
 * service, and a scripted mock model adapter in a temporary project whose
 * `.dsh/hooks.json` asks for confirmation. The plugin returns the host's own
 * `{kind:'ask'}` decision and never calls the approval service itself; the
 * assertions read what the model actually received, whether the tool really
 * ran, which approvals the host asked and decided, and the plugin records the
 * Session retained.
 */

import type {} from '@deepseek-ai/dsh-tools'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { requestText, textResponse, toolCallResponse } from './support/harness.ts'
import {
  bashToolCall,
  commandHook,
  hook,
  hookRunRecords,
  lastSessionEvent,
  nodeScript,
  runTurn,
  writeHookScript,
  writeHooks,
  writeHooksFile,
  writeFileIn,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

/** A `builtin` ask run with an optional model-facing reason. */
function ask(reason?: string): Record<string, unknown> {
  return { type: 'builtin', action: 'ask', ...reason === undefined ? {} : { reason } }
}

describe('a builtin ask on tool.pre', () => {
  it('asks the host, then runs the tool once the user allows it once', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({
        id: 'confirm-write',
        match: { tool: 'write' },
        run: ask('writing files needs confirmation'),
      })],
    })
    const harness = await fixture.harness(root, {}, { approval: true })
    harness.answerApprovals('allowed-once')
    harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool really ran: the file exists with the requested content.
    await expect(readFile(join(root, 'new.txt'), 'utf8')).resolves.toBe('NEW')
    // The host asked its answerers with the hook's own reason.
    expect(harness.approvalRequests).toHaveLength(1)
    expect(harness.approvalRequests[0]).toMatchObject({
      toolName: 'write',
      reason: 'writing files needs confirmation',
    })
    // The durable audit pair records the ask and its final outcome.
    const asked = lastSessionEvent(agent.session, 'approval/asked')
    expect(asked).toMatchObject({ toolName: 'write', reason: 'writing files needs confirmation' })
    expect(lastSessionEvent(agent.session, 'approval/decided'))
      .toMatchObject({ id: asked?.id, outcome: 'allowed-once' })
    // One run record, naming the action the hook produced.
    expect(hookRunRecords(agent.session)).toEqual([
      expect.objectContaining({ event: 'tool.pre', hook_id: 'confirm-write', action: 'ask' }),
    ])
  })

  it('denies the call when the user rejects the approval', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'confirm-write', match: { tool: 'write' }, run: ask('writing files needs confirmation') })],
    })
    const harness = await fixture.harness(root, {}, { approval: true })
    harness.answerApprovals('rejected')
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!)).toContain('the user rejected tool "write"')
    expect(lastSessionEvent(agent.session, 'approval/decided')).toMatchObject({ outcome: 'rejected' })
    expect(hookRunRecords(agent.session)).toEqual([
      expect.objectContaining({ event: 'tool.pre', hook_id: 'confirm-write', action: 'ask' }),
    ])
  })

  it('denies the call when the approval is cancelled', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'confirm-write', match: { tool: 'write' }, run: ask('writing files needs confirmation') })],
    })
    const harness = await fixture.harness(root, {}, { approval: true })
    harness.answerApprovals('cancelled')
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!)).toContain('approval for tool "write" was cancelled')
    expect(lastSessionEvent(agent.session, 'approval/decided')).toMatchObject({ outcome: 'cancelled' })
  })

  it('denies the call when no answerer is composed', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'confirm-write', match: { tool: 'write' }, run: ask('writing files needs confirmation') })],
    })
    // The real service is mounted; nothing answers its waterfall, so the
    // host's fail-closed outcome is 'unavailable'.
    const harness = await fixture.harness(root, {}, { approval: true })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!))
      .toContain('tool "write" requires approval, but no approval channel is available')
    expect(lastSessionEvent(agent.session, 'approval/decided')).toMatchObject({ outcome: 'unavailable' })
  })

  it('denies the call in a deployment with no approval service at all', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'confirm-write', match: { tool: 'write' }, run: ask('writing files needs confirmation') })],
    })
    // No approval service is mounted: the host degrades its own ask to a deny
    // carrying the ask's reason, and the plugin must keep working without the
    // service.
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!)).toContain('writing files needs confirmation')
    expect(harness.approvalRequests).toEqual([])
    expect(hookRunRecords(agent.session)).toEqual([
      expect.objectContaining({ event: 'tool.pre', hook_id: 'confirm-write', action: 'ask' }),
    ])
  })

  it.each([
    ['an ask before a deny', ['confirm-write', 'block-write']],
    ['a deny before an ask', ['block-write', 'confirm-write']],
  ])('lets a deny outrank %s without asking anyone', async (_label, order) => {
    const root = await fixture.repo()
    const runs: Record<string, Record<string, unknown>> = {
      'confirm-write': ask('writing files needs confirmation'),
      'block-write': { type: 'builtin', action: 'deny', reason: 'writes are forbidden here' },
    }
    await writeHooksFile(root, {
      version: 1,
      hooks: order.map(id => hook({ id, match: { tool: 'write' }, run: runs[id]! })),
    })
    // An answerer that would grant the tool: if the ask leaked past the deny,
    // the write would run and the approval list would not be empty.
    const harness = await fixture.harness(root, {}, { approval: true })
    harness.answerApprovals('allowed-once')
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!)).toContain('writes are forbidden here')
    expect(harness.approvalRequests).toEqual([])
    expect(lastSessionEvent(agent.session, 'approval/asked')).toBeUndefined()
    // Both hooks ran: only a halt short-circuits the hook loop.
    expect(hookRunRecords(agent.session).map(record => record.action).sort())
      .toEqual(['ask', 'deny'])
  })

  it('keeps context contributed alongside an ask', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/note.mjs', nodeScript(`
emit({ context: ['writing files is logged'] })`))
    await writeHooks(root, [
      hook({ id: 'confirm-write', match: { tool: 'write' }, run: ask('writing files needs confirmation') }),
      commandHook('note-write', 'node .dsh/hooks/note.mjs', { match: { tool: 'write' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true, approval: true })
    harness.answerApprovals('rejected')
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    const next = requestText(adapter.requests[1]!)
    expect(next).toContain('the user rejected tool "write"')
    expect(next).toContain('writing files is logged')
  })

  it('does not bypass a monotonic guard that denies after the ask', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'confirm-write', match: { tool: 'write' }, run: ask('writing files needs confirmation') })],
    })
    const harness = await fixture.harness(root, {}, { approval: true })
    harness.answerApprovals('allowed-once')
    // The deployment's own guard runs after every pre-execute listener and
    // cannot be turned back into permission: an ask must not bypass it.
    harness.ctx.tools.guard(exec => exec.name === 'write' ? 'writes are frozen by the deployment guard' : undefined)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'new.txt', content: 'NEW' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!)).toContain('writes are frozen by the deployment guard')
    // The approval itself was granted; the guard still denied the dispatch.
    expect(lastSessionEvent(agent.session, 'approval/decided')).toMatchObject({ outcome: 'allowed-once' })
  })
})

describe('a command hook on tool.pre', () => {
  it('asks with its reason and localized display copy, then runs the tool when allowed', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/ask.mjs', nodeScript(`
emit({
  action: 'ask',
  reason: 'the command looks destructive',
  displayReason: { en: 'Run the destructive command?', zh: '允许执行这条危险命令吗？' },
})`))
    await writeHooks(root, [
      commandHook('ask-command', 'node .dsh/hooks/ask.mjs', { match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true, approval: true })
    harness.answerApprovals('allowed-once')
    harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(harness.approvalRequests).toHaveLength(1)
    expect(harness.approvalRequests[0]).toMatchObject({
      toolName: 'bash',
      reason: 'the command looks destructive',
      displayReason: { en: 'Run the destructive command?', zh: '允许执行这条危险命令吗？' },
    })
    expect(lastSessionEvent(agent.session, 'approval/asked'))
      .toMatchObject({ toolName: 'bash', reason: 'the command looks destructive' })
    expect(hookRunRecords(agent.session)).toEqual([
      expect.objectContaining({ event: 'tool.pre', hook_id: 'ask-command', handler: 'command', action: 'ask' }),
    ])
  })
})

describe('an ask outside tool.pre', () => {
  it('is warned about and ignored, so the step proceeds', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHookScript(root, '.dsh/hooks/ask-step.mjs', nodeScript(`
emit({ action: 'ask', reason: 'should not stop the step' })`))
    await writeHooks(root, [
      commandHook('ask-step', 'node .dsh/hooks/ask-step.mjs', { on: 'step.start' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(harness.pluginWarnings).toEqual([
      'dsh-lifecycle-hooks: hook "ask-step" reported action "ask", which step.start does not support; ignored',
      'dsh-lifecycle-hooks: hook "ask-step" reported action "ask", which step.start does not support; ignored',
    ])
    // Ignoring the action kept the rest of the event intact: the step ran and
    // the model read the tool's real output.
    expect(requestText(adapter.requests[1]!)).toContain('NOTE-CONTENT')
    // No approval was requested: the host never saw an ask.
    expect(harness.approvalRequests).toEqual([])
    // The step.start seam fires once per step, and each record still names
    // what its run produced.
    expect(hookRunRecords(agent.session).map(record => record.action)).toEqual(['ask', 'ask'])
  })
})
