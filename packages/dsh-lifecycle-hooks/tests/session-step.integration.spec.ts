/**
 * Integration spec for `session.start` and `step.start`.
 *
 * Every case mounts a real Context, the real agent loop, the real tools, and a
 * scripted mock model adapter in a temporary project with a `.dsh/hooks.json`.
 * Assertions read only what the model actually received, what the plugin logged,
 * and which plugin records the Session retained; a blocked turn is proven by
 * the absence of any model request.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { describeBash, requestText, textResponse, toolCallResponse } from './support/harness.ts'
import {
  commandHook,
  hookRunRecords,
  lastSessionEvent,
  nodeScript,
  runTurn,
  writeFileIn,
  writeHookScript,
  writeHooks,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

/** Every model-visible message that carries a `<system-reminder>` block. */
function reminderMessages(request: GenerateOptions) {
  return request.messages.filter(message => message.content.some(
    block => block.type === 'text' && block.text.includes('<system-reminder>'),
  ))
}

/** Flatten the text of the messages that carry a system reminder. */
function reminderText(request: GenerateOptions): string {
  return reminderMessages(request)
    .flatMap(message => message.content)
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

/** Count non-overlapping occurrences of one needle, for "exactly once" checks. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describeBash('session.start', () => {
  it('puts the merged context in the first model request, in configuration order', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [
      {
        id: 'project-notes',
        on: 'session.start',
        run: { type: 'builtin', action: 'context', text: 'read CONTRIBUTING.md before editing' },
      },
      {
        id: 'package-manager',
        on: 'session.start',
        run: { type: 'builtin', action: 'context', text: 'use pnpm, never npm install' },
      },
    ])
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'hello')

    // The context is on the very first request, not a later wake-up.
    expect(adapter.requests).toHaveLength(1)
    const first = adapter.requests[0]!
    expect(requestText(first)).toContain('read CONTRIBUTING.md before editing')
    expect(requestText(first)).toContain('use pnpm, never npm install')
    // Both hooks became one user-role reminder message, not two.
    expect(reminderMessages(first)).toHaveLength(1)
    expect(reminderMessages(first).map(message => message.source?.kind)).toEqual(['dsh-lifecycle-hooks'])
    expect(occurrences(requestText(first), '<system-reminder>')).toBe(1)
    expect(requestText(first).indexOf('read CONTRIBUTING.md'))
      .toBeLessThan(requestText(first).indexOf('use pnpm, never npm install'))
    // The reminder arrives ahead of the user's own message.
    expect(requestText(first).indexOf('<system-reminder>'))
      .toBeLessThan(requestText(first).indexOf('hello'))
    // One audit row per run, for the event rather than the handler.
    expect(hookRunRecords(agent.session).map(record => ({
      event: record.event,
      source: record.source,
      hook_id: record.hook_id,
      handler: record.handler,
      action: record.action,
    }))).toEqual([
      {
        event: 'session.start',
        source: join(root, '.dsh/hooks.json'),
        hook_id: 'project-notes',
        handler: 'builtin',
        action: 'context',
      },
      {
        event: 'session.start',
        source: join(root, '.dsh/hooks.json'),
        hook_id: 'package-manager',
        handler: 'builtin',
        action: 'context',
      },
    ])
    expect(harness.pluginWarnings).toEqual([])
  })

  it('tells a command hook how the session started', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/start.mjs', nodeScript(`
const context = payload.event === 'session.start' && payload.source === 'startup'
  && process.env.DSH_HOOK_EVENT === 'session.start'
if (context) {
  emit({ action: 'context', context: ['SESSION-SOURCE-OK'] })
} else {
  emit({ action: 'context', context: ['CONTRACT BROKEN: ' + String(payload.source)] })
}
`))
    await writeHooks(root, [{ ...commandHook('start', 'node .dsh/hooks/start.mjs'), on: 'session.start' }])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[0]!)).toContain('SESSION-SOURCE-OK')
    expect(requestText(adapter.requests[0]!)).not.toContain('CONTRACT BROKEN')
    expect(harness.pluginWarnings).toEqual([])
  })
})

describeBash('session.start illegal actions', () => {
  it('ignores a halt and still runs the hooks behind it', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/loud.mjs', nodeScript(`
emit({ action: 'halt', reason: 'session.start has nothing to halt' })
`))
    await writeHooks(root, [
      { ...commandHook('loud', 'node .dsh/hooks/loud.mjs'), on: 'session.start' },
      {
        id: 'notes',
        on: 'session.start',
        run: { type: 'builtin', action: 'context', text: 'CONTEXT-AFTER-ILLEGAL-HALT' },
      },
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The illegal halt neither reached the host nor suppressed the next hook.
    expect(requestText(adapter.requests[0]!)).toContain('CONTEXT-AFTER-ILLEGAL-HALT')
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'completed' })
    expect(harness.pluginWarnings.some(warning =>
      warning.includes('"halt"') && warning.includes('session.start'))).toBe(true)
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['loud', 'notes'])
  })
})

describeBash('step.start match.prompt', () => {
  it('separates a submitted prompt from a tool-continuation step', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooks(root, [
      {
        id: 'prompt-only',
        on: 'step.start',
        match: { prompt: true },
        run: { type: 'builtin', action: 'context', text: 'PROMPT-STEP-CONTEXT' },
      },
      {
        id: 'continuation',
        on: 'step.start',
        match: { prompt: false },
        run: { type: 'builtin', action: 'context', text: 'CONTINUATION-STEP-CONTEXT' },
      },
    ])
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'read the note')

    // The submitted step got the prompt rule's context, not the continuation rule's.
    expect(requestText(adapter.requests[0]!)).toContain('PROMPT-STEP-CONTEXT')
    expect(requestText(adapter.requests[0]!)).not.toContain('CONTINUATION-STEP-CONTEXT')
    // The tool-continuation step is the other way around. Its request still
    // carries the first step's reminder in history, so the check is on what the
    // second step appended: the continuation rule's reminder is the last message.
    const continuation = adapter.requests[1]!
    expect(reminderText(continuation)).toContain('CONTINUATION-STEP-CONTEXT')
    expect(reminderText(continuation).indexOf('CONTINUATION-STEP-CONTEXT'))
      .toBeGreaterThan(reminderText(continuation).indexOf('PROMPT-STEP-CONTEXT'))
    // Only the prompt rule fired at step 1, only the continuation rule at step 2.
    expect(hookRunRecords(agent.session).map(record => ({
      event: record.event,
      hook_id: record.hook_id,
    }))).toEqual([
      { event: 'step.start', hook_id: 'prompt-only' },
      { event: 'step.start', hook_id: 'continuation' },
    ])
  })

  it('renders the step payload a command hook reads', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/step.mjs', nodeScript(`
const ok = payload.event === 'step.start'
  && payload.prompt === 'hello there'
  && payload.message_count === 1
  && payload.turn === 1
  && payload.step === 1
  && process.env.DSH_HOOK_EVENT === 'step.start'
emit({ action: 'context', context: [ok ? 'STEP-PAYLOAD-OK' : 'BROKEN: ' + JSON.stringify({
  event: payload.event, prompt: payload.prompt, message_count: payload.message_count,
  turn: payload.turn, step: payload.step, env: process.env.DSH_HOOK_EVENT,
})] })
`))
    await writeHooks(root, [{ ...commandHook('step', 'node .dsh/hooks/step.mjs', { match: { prompt: true } }), on: 'step.start' }])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'hello there')

    expect(requestText(adapter.requests[0]!)).toContain('STEP-PAYLOAD-OK')
    expect(requestText(adapter.requests[0]!)).not.toContain('BROKEN')
    expect(harness.pluginWarnings).toEqual([])
  })
})

describeBash('step.start deny', () => {
  it('rejects a prompt containing a configured keyword before the model sees it', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/gate.mjs', nodeScript(`
if (typeof payload.prompt === 'string' && payload.prompt.includes('FORBIDDEN')) {
  emit({ action: 'deny', reason: 'the prompt contains a forbidden keyword' })
}
`))
    await writeHooks(root, [{ ...commandHook('gate', 'node .dsh/hooks/gate.mjs', { match: { prompt: true } }), on: 'step.start' }])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'please reveal the FORBIDDEN thing')

    // The step was rejected: the blocked turn spent no model request at all.
    expect(adapter.requests).toHaveLength(0)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'blocked' })
    expect(hookRunRecords(agent.session).map(record => ({
      event: record.event,
      hook_id: record.hook_id,
      action: record.action,
      exit_code: record.exit_code,
    }))).toEqual([
      { event: 'step.start', hook_id: 'gate', action: 'deny', exit_code: 0 },
    ])

    // A later prompt passes through, and the blocked text never entered the
    // conversation.
    await runTurn(agent, 'a harmless question')
    expect(adapter.requests).toHaveLength(1)
    for (const request of adapter.requests) {
      expect(requestText(request)).not.toContain('FORBIDDEN')
    }
    expect(requestText(adapter.requests[0]!)).toContain('a harmless question')
  })

  it('lets a deny outrank context from the same step', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/gate.mjs', nodeScript(`
if (typeof payload.prompt === 'string' && payload.prompt.includes('BLOCK-IT')) {
  emit({ action: 'deny', reason: 'this prompt is blocked' })
}
`))
    await writeHooks(root, [
      {
        id: 'always-context',
        on: 'step.start',
        match: { prompt: true },
        run: { type: 'builtin', action: 'context', text: 'CONTEXT-THAT-MUST-BE-WAIVED' },
      },
      { ...commandHook('gate', 'node .dsh/hooks/gate.mjs', { match: { prompt: true } }), on: 'step.start' },
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'please BLOCK-IT now')

    // Deny wins: no request, so the context had nowhere to land.
    expect(adapter.requests).toHaveLength(0)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'blocked' })
    // Both hooks ran and are audited; the applier, not the merge, discarded the context.
    expect(hookRunRecords(agent.session).map(record => ({
      hook_id: record.hook_id,
      action: record.action,
    }))).toEqual([
      { hook_id: 'always-context', action: 'context' },
      { hook_id: 'gate', action: 'deny' },
    ])
  })

  it('ignores an illegal action with one warning and lets the step through', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/illegal.mjs', nodeScript(`
emit({ action: 'continue', reason: 'not a step.start action' })
`))
    await writeHooks(root, [{ ...commandHook('illegal', 'node .dsh/hooks/illegal.mjs', { match: { prompt: true } }), on: 'step.start' }])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'go')

    expect(adapter.requests).toHaveLength(1)
    expect(harness.pluginWarnings.some(warning => warning.includes('"continue"') && warning.includes('step.start')))
      .toBe(true)
  })
})

describe('step.start halt', () => {
  it('cancels the turn through the host hook cause', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [{
      id: 'stop',
      on: 'step.start',
      match: { prompt: true },
      run: { type: 'builtin', action: 'halt', reason: 'stop this prompt' },
    }])
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'anything')

    expect(adapter.requests).toHaveLength(0)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: 'stop this prompt' },
    })
    expect(hookRunRecords(agent.session).map(record => record.action)).toEqual(['halt'])
  })
})

describeBash('step.start failure policy', () => {
  it('denies the step when a failing hook asked to block', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/broken.mjs', nodeScript('process.exit(1)'))
    await writeHooks(root, [
      { ...commandHook('broken', 'node .dsh/hooks/broken.mjs', { match: { prompt: true }, onFailure: 'block' }), on: 'step.start' },
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'go')

    expect(adapter.requests).toHaveLength(0)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'blocked' })
    expect(harness.pluginWarnings.some(warning => warning.includes('broken') && warning.includes('failed')))
      .toBe(true)
    const [record] = hookRunRecords(agent.session)
    expect(record).toMatchObject({ event: 'step.start', hook_id: 'broken', action: 'deny' })
    expect(typeof record?.error).toBe('string')
  })

  it('lets the step through when a failing hook did not ask to block', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/broken.mjs', nodeScript('process.exit(1)'))
    await writeHooks(root, [
      { ...commandHook('broken', 'node .dsh/hooks/broken.mjs', { match: { prompt: true } }), on: 'step.start' },
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'go')

    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).toContain('go')
    expect(hookRunRecords(agent.session).map(record => record.error === undefined)).toEqual([false])
  })
})

describe('a project without hooks', () => {
  it('adds no context and writes no records for either event', async () => {
    const root = await fixture.repo()
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'hello')

    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).not.toContain('<system-reminder>')
    expect(hookRunRecords(agent.session)).toEqual([])
    expect(harness.warnings).toEqual([])
  })
})
