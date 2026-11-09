/**
 * Integration spec for `turn.stop`.
 *
 * Every case mounts the real Context, agent loop, and tools in a temporary
 * project whose `.dsh/hooks.json` binds hooks to `agent/turn-stopping`.
 * Assertions read only what the model actually received, how many steps the
 * turn ran, the plugin's warnings, and the Session plugin records.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { describeBash, requestText, textResponse } from './support/harness.ts'
import {
  commandHook,
  hook,
  hookRunRecords,
  keepGoing,
  lastSessionEvent,
  nodeScript,
  runTurn,
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

/** Flatten every text block of the messages that carry a system reminder. */
function reminderText(request: GenerateOptions): string {
  return reminderMessages(request)
    .flatMap(message => message.content)
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

/** The continue runs among the audit records, in order. */
function continueRecords(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter(record => record.action === 'continue')
}

describeBash('a command hook on turn.stop', () => {
  it('continues a turn whose tests failed, and the model sees why', async () => {
    const root = await fixture.repo()
    // The hook runs a real failing process, then asks for another step only on
    // the first stop: the second stop is a normal completion.
    await writeHookScript(root, '.dsh/hooks/run-tests.mjs', nodeScript(`
if (payload.continued_count !== 0) process.exit(0)
const { spawnSync } = await import('node:child_process')
const failed = spawnSync(process.execPath, ['-e', 'process.exit(1)']).status === 1
const facts = {
  event: payload.event === 'turn.stop' && process.env.DSH_HOOK_EVENT === 'turn.stop',
  time: typeof payload.time === 'number',
  session: payload.session_id === process.env.DSH_HOOK_SESSION_ID && payload.session_id.length > 0,
  cwd: payload.cwd === process.env.DSH_HOOK_CWD && payload.cwd.length > 0,
  agent: payload.agent_id === payload.session_id,
  turn: payload.turn === Number(process.env.DSH_HOOK_TURN) && payload.turn > 0,
  step: payload.step === Number(process.env.DSH_HOOK_STEP) && payload.step > 0,
  source: payload.source.endsWith('/.dsh/hooks.json'),
  hook: payload.hook_id === 'run-tests' && process.env.DSH_HOOK_ID === 'run-tests',
  count: payload.continued_count === 0,
}
const broken = Object.entries(facts).filter(([, ok]) => !ok).map(([name]) => name)
if (broken.length > 0) {
  emit({ action: 'continue', reason: 'PAYLOAD CONTRACT BROKEN: ' + broken.join(',') })
} else {
  emit({
    action: 'continue',
    reason: failed
      ? 'the test suite failed; fix the failing test before stopping'
      : 'TEST SCRIPT DID NOT FAIL',
  })
}
`))
    await writeHooks(root, [
      commandHook('run-tests', 'node .dsh/hooks/run-tests.mjs', { on: 'turn.stop' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      textResponse('first stop'),
      textResponse('fixed and finished'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The failed test bought exactly one more model request, and only that
    // request carries the hook's reason.
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[0]!)).not.toContain('the test suite failed')
    expect(requestText(adapter.requests[1]!)).toContain('the test suite failed; fix the failing test before stopping')
    expect(reminderMessages(adapter.requests[1]!)).toHaveLength(1)
    // The continued turn ended naturally on its second stop.
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'completed' })
    // Both stops are audited: the run that continued, and the observing run.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      event: 'turn.stop',
      source: join(root, '.dsh/hooks.json'),
      hook_id: 'run-tests',
      handler: 'command',
      action: 'continue',
      continued_count: 0,
      exit_code: 0,
    })
    expect(records[1]).toMatchObject({ hook_id: 'run-tests', continued_count: 1, exit_code: 0 })
    expect(records[1]!.action).toBeUndefined()
    expect(harness.pluginWarnings).toEqual([])
  })
})

describe('the turn.stop loop guard', () => {
  it('stops after maxStopContinues continuations and records the count', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [
      hook({ id: 'always', on: 'turn.stop', run: keepGoing('keep going') }),
    ])
    const harness = await fixture.harness(root, { maxStopContinues: 2 })
    const adapter = harness.registerAdapter('mock', [
      textResponse('one'),
      textResponse('two'),
      textResponse('three'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Initial step + two continuations; the third stop closes the turn.
    expect(adapter.requests).toHaveLength(3)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'completed' })
    expect(hookRunRecords(agent.session).map(record => record.continued_count)).toEqual([0, 1, 2])
    expect(hookRunRecords(agent.session).every(record => record.action === 'continue')).toBe(true)
    expect(harness.pluginWarnings.some(warning => warning.includes('maxStopContinues is 2'))).toBe(true)
    expect(harness.pluginWarnings.some(warning => warning.includes('continue ignored'))).toBe(true)
  })

  it('resets the count when a new turn starts', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [
      hook({ id: 'always', on: 'turn.stop', run: keepGoing('keep going') }),
    ])
    const harness = await fixture.harness(root, { maxStopContinues: 1 })
    const adapter = harness.registerAdapter('mock', [
      textResponse('turn one, first stop'),
      textResponse('turn one, continued'),
      textResponse('turn two, first stop'),
      textResponse('turn two, continued'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, 'first')
    await runTurn(agent, 'second')

    expect(adapter.requests).toHaveLength(4)
    // Each turn grants one continue and then hits the cap, so the second
    // turn's first stop starts from 0 again.
    expect(hookRunRecords(agent.session).map(record => record.continued_count)).toEqual([0, 1, 0, 1])
    // Both turns hit the cap at count 1, so the second turn's warning names the
    // same count: the guard started over.
    expect(harness.pluginWarnings.filter(warning => warning.includes('after 1 consecutive continues')))
      .toHaveLength(2)
  })
})

describeBash('a normal stop', () => {
  it('does not steer when the turn.stop hook reports no action', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/silent.mjs', nodeScript(''))
    await writeHooks(root, [
      commandHook('silent', 'node .dsh/hooks/silent.mjs', { on: 'turn.stop' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(reminderMessages(adapter.requests[0]!)).toHaveLength(0)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'completed' })
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'turn.stop', hook_id: 'silent', continued_count: 0 })
    expect(records[0]!.action).toBeUndefined()
    expect(harness.pluginWarnings).toEqual([])
  })
})

describeBash('several continue hooks on one stop', () => {
  it('merges into exactly one steer message', async () => {
    const root = await fixture.repo()
    const stopsOnFirstStop = `
if (payload.continued_count !== 0) process.exit(0)
`
    await writeHookScript(root, '.dsh/hooks/first.mjs', nodeScript(`${stopsOnFirstStop}
emit({ action: 'continue', reason: 'the first hook says fix the tests' })
`))
    await writeHookScript(root, '.dsh/hooks/second.mjs', nodeScript(`${stopsOnFirstStop}
emit({ action: 'continue', reason: 'the second hook says run the suite again' })
`))
    await writeHooks(root, [
      commandHook('first', 'node .dsh/hooks/first.mjs', { on: 'turn.stop' }),
      commandHook('second', 'node .dsh/hooks/second.mjs', { on: 'turn.stop' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      textResponse('stop'),
      textResponse('continued'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    // One message, both hooks' reasons, in configuration order.
    const reminders = reminderMessages(adapter.requests[1]!)
    expect(reminders).toHaveLength(1)
    const text = reminderText(adapter.requests[1]!)
    expect(text).toContain('the first hook says fix the tests')
    expect(text).toContain('the second hook says run the suite again')
    expect(text.indexOf('the first hook says')).toBeLessThan(text.indexOf('the second hook says'))
    expect(continueRecords(hookRunRecords(agent.session)).map(record => record.hook_id))
      .toEqual(['first', 'second'])
  })
})

describeBash('an action turn.stop does not support', () => {
  it('warns about halt, ignores it, and lets the turn end', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/halt.mjs', nodeScript(`
emit({ action: 'halt', reason: 'emergency stop' })
`))
    await writeHooks(root, [
      commandHook('halter', 'node .dsh/hooks/halt.mjs', { on: 'turn.stop' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // No second step, and no turn cancellation either: halt is not legal here.
    expect(adapter.requests).toHaveLength(1)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'completed' })
    expect(harness.pluginWarnings.some(warning => warning.includes('does not support; ignored'))).toBe(true)
    expect(harness.pluginWarnings.some(warning => warning.includes('"halt"'))).toBe(true)
    // The record keeps what the run produced even though the event ignored it.
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      hook_id: 'halter',
      action: 'halt',
      continued_count: 0,
    })
  })

  it('fails open when an onFailure: block hook breaks at turn.stop', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/broken.mjs', nodeScript(`
process.stderr.write('stop hook crashed\\n')
process.exit(3)
`))
    await writeHooks(root, [
      commandHook('broken', 'node .dsh/hooks/broken.mjs', { on: 'turn.stop', onFailure: 'block' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // No continue is synthesized for a failed turn.stop hook.
    expect(adapter.requests).toHaveLength(1)
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({ kind: 'completed' })
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ hook_id: 'broken', exit_code: 3, continued_count: 0 })
    expect(records[0]!.action).toBeUndefined()
    expect(String(records[0]!.error)).toContain('exited with code 3')
    expect(harness.pluginWarnings.some(warning => warning.includes('exited with code 3'))).toBe(true)
  })
})
