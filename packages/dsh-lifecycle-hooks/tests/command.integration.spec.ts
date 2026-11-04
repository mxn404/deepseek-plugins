/**
 * Integration spec for the `command` handler.
 *
 * Each case mounts the real Context, agent loop, tools, and shell executor in a
 * temporary project whose `.dsh/hooks.json` runs a real script. Assertions read
 * only what the model received, whether the tool executed, the plugin's
 * warnings, and the Session plugin records. The script itself proves the
 * stdin/env contract by denying only when every payload field is right.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { requestText, textResponse, toolCallResponse } from './support/harness.ts'
import {
  bashToolCall,
  commandHook,
  hookRunRecords,
  lastSessionEvent,
  nodeScript,
  runTurn,
  waitFor,
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

/** Flatten every text block of the messages that carry a system reminder. */
function reminderText(request: GenerateOptions): string {
  return reminderMessages(request)
    .flatMap(message => message.content)
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

describe('a command hook on tool.pre', () => {
  it('denies the call, tells the model why, and carries its context to the next request', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'target.txt', 'KEEP-ME\n')
    // The script denies only when the whole command contract holds: one JSON
    // payload on stdin, the DSH_HOOK_* facts in the environment, the tool facts
    // in the payload. A contract break shows up in the model-visible reason.
    await writeHookScript(root, '.dsh/hooks/gate.mjs', nodeScript(`
const facts = {
  event: payload.event === 'tool.pre' && process.env.DSH_HOOK_EVENT === 'tool.pre',
  time: typeof payload.time === 'number',
  session: payload.session_id === process.env.DSH_HOOK_SESSION_ID && payload.session_id.length > 0,
  cwd: payload.cwd === process.env.DSH_HOOK_CWD && payload.cwd.length > 0,
  agent: payload.agent_id === payload.session_id,
  turn: payload.turn === Number(process.env.DSH_HOOK_TURN) && payload.turn > 0,
  step: payload.step === Number(process.env.DSH_HOOK_STEP) && payload.step > 0,
  source: payload.source.endsWith('/.dsh/hooks.json'),
  hook: payload.hook_id === 'gate' && process.env.DSH_HOOK_ID === 'gate',
  tool: payload.tool.name === 'bash'
    && payload.tool.call_id === 'bash-1'
    && payload.tool.input.command === 'rm -rf target.txt',
}
const broken = Object.entries(facts).filter(([, ok]) => !ok).map(([name]) => name)
if (broken.length > 0) {
  emit({ action: 'deny', reason: 'PAYLOAD CONTRACT BROKEN: ' + broken.join(',') })
} else {
  emit({
    action: 'deny',
    reason: 'rm -rf is blocked by a command hook',
    context: ['this repository forbids recursive deletes'],
  })
}
`))
    await writeHooks(root, [commandHook('gate', 'node .dsh/hooks/gate.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'rm -rf target.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool never ran: the file the command would have deleted is intact.
    await expect(access(join(root, 'target.txt'))).resolves.toBeUndefined()
    // The model received the script's reason as the tool result.
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).toContain('rm -rf is blocked by a command hook')
    // The context arrived as one user-role system reminder on the next request.
    const reminders = reminderMessages(adapter.requests[1]!)
    expect(reminders).toHaveLength(1)
    expect(reminderText(adapter.requests[1]!)).toContain('this repository forbids recursive deletes')
    // One audit row: the handler, its clean exit, and the measured duration.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'tool.pre',
      source: join(root, '.dsh/hooks.json'),
      hook_id: 'gate',
      handler: 'command',
      action: 'deny',
      exit_code: 0,
    })
    expect(typeof records[0]!.duration_ms).toBe('number')
    expect(records[0]!.error).toBeUndefined()
    expect(harness.pluginWarnings).toEqual([])
  })

  it('carries the meta document into the audit record, not the model surface', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/meta.mjs', nodeScript(`
emit({
  action: 'deny',
  reason: 'blocked with metadata',
  meta: { rule: 'no-read', severity: 2 },
})
`))
    await writeHooks(root, [
      commandHook('meta', 'node .dsh/hooks/meta.mjs', { match: { tool: 'read' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('blocked with metadata')
    // Meta is audit-only: it never becomes part of the model-visible reason.
    expect(requestText(adapter.requests[1]!)).not.toContain('no-read')
    const [record] = hookRunRecords(agent.session)
    expect(record).toMatchObject({
      event: 'tool.pre',
      hook_id: 'meta',
      handler: 'command',
      action: 'deny',
      meta: { rule: 'no-read', severity: 2 },
    })
    expect(record!.error).toBeUndefined()
  })
})

describe('a failing command hook', () => {
  /** A script that would finish far too late, so a short timeout is observable. */
  const SLOW = nodeScript(`
await new Promise(resolve => setTimeout(resolve, 5000))
emit({ action: 'deny', reason: 'the slow hook denies' })
`)

  it('times out, fails open, and reports the timeout', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/slow.mjs', SLOW)
    await writeHooks(root, [commandHook('slow', 'node .dsh/hooks/slow.mjs', { timeoutMs: 200 })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Fail open: the tool ran, and the late deny never reached the model.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(requestText(adapter.requests[1]!)).not.toContain('the slow hook denies')
    // The run ended at the timeout, not when the script would have finished:
    // the shell executor killed it instead of waiting out its 5 s.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ hook_id: 'slow', handler: 'command' })
    expect(String(records[0]!.error)).toContain('timed out after 200 ms')
    expect(records[0]!.exit_code).toBeUndefined()
    expect(Number(records[0]!.duration_ms)).toBeLessThan(1_500)
    expect(harness.pluginWarnings.some(warning => warning.includes('timed out after 200 ms'))).toBe(true)
  })

  it('uses the row default timeout when the entry declares none', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/slow.mjs', SLOW)
    await writeHooks(root, [commandHook('slow', 'node .dsh/hooks/slow.mjs')])
    const harness = await fixture.harness(root, { defaultTimeoutMs: 200 }, { bash: true })
    harness.registerAdapter('mock', [bashToolCall('bash-1', 'touch ran.txt'), textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const records = hookRunRecords(agent.session)
    expect(String(records[0]!.error)).toContain('timed out after 200 ms')
  })

  it('blocks the call when the entry says onFailure: block', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/slow.mjs', SLOW)
    await writeHooks(root, [
      commandHook('slow', 'node .dsh/hooks/slow.mjs', { timeoutMs: 200, onFailure: 'block' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The synthesized denial is what the model reads, and the tool never ran.
    await expect(access(join(root, 'ran.txt'))).rejects.toThrow()
    const text = requestText(adapter.requests[1]!)
    expect(text).toContain('hook "slow" failed')
    expect(text).toContain('timed out after 200 ms')
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ hook_id: 'slow', action: 'deny' })
    expect(records[0]!.error).toBeDefined()
  })

  it('fails open on a non-zero exit and records the code', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/broken.mjs', nodeScript(`
process.stderr.write('gate crashed\\n')
process.exit(3)
`))
    await writeHooks(root, [commandHook('broken', 'node .dsh/hooks/broken.mjs')])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(requestText(adapter.requests[1]!)).not.toContain('failed')
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ hook_id: 'broken', handler: 'command', exit_code: 3 })
    expect(records[0]!.action).toBeUndefined()
    expect(String(records[0]!.error)).toContain('exited with code 3')
    expect(String(records[0]!.error)).toContain('gate crashed')
    expect(harness.pluginWarnings.some(warning => warning.includes('exited with code 3'))).toBe(true)
  })

  it('treats empty stdout as no action and malformed stdout as a failure', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/silent.mjs', nodeScript(''))
    await writeHookScript(root, '.dsh/hooks/garbage.mjs', nodeScript(`
process.stdout.write('not a json outcome')
`))
    await writeHooks(root, [
      commandHook('silent', 'node .dsh/hooks/silent.mjs'),
      commandHook('garbage', 'node .dsh/hooks/garbage.mjs'),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ hook_id: 'silent', exit_code: 0 })
    expect(records[0]!.action).toBeUndefined()
    expect(records[0]!.error).toBeUndefined()
    expect(records[1]).toMatchObject({ hook_id: 'garbage', exit_code: 0 })
    expect(records[1]!.action).toBeUndefined()
    expect(String(records[1]!.error)).toContain('not a single JSON outcome')
    expect(harness.pluginWarnings.some(warning => warning.includes('not a single JSON outcome'))).toBe(true)
  })
})

describe('several command hooks', () => {
  it('runs them in configuration order and applies the denial over the context', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'target.txt', 'KEEP-ME\n')
    await writeHookScript(root, '.dsh/hooks/first.mjs', nodeScript(`
import { appendFileSync } from 'node:fs'
appendFileSync('order.txt', 'first\\n')
emit({ context: ['first context'] })
`))
    await writeHookScript(root, '.dsh/hooks/second.mjs', nodeScript(`
import { appendFileSync } from 'node:fs'
appendFileSync('order.txt', 'second\\n')
emit({ action: 'deny', reason: 'the second hook denies', context: ['second context'] })
`))
    await writeHooks(root, [
      commandHook('first', 'node .dsh/hooks/first.mjs'),
      commandHook('second', 'node .dsh/hooks/second.mjs'),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'rm -rf target.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Configuration order, on disk and in the audit trail.
    expect(await readFile(join(root, 'order.txt'), 'utf8')).toBe('first\nsecond\n')
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['first', 'second'])
    // The tool did not run, and both contexts arrived as one reminder in order.
    await expect(access(join(root, 'target.txt'))).resolves.toBeUndefined()
    expect(requestText(adapter.requests[1]!)).toContain('the second hook denies')
    const reminders = reminderText(adapter.requests[1]!)
    expect(reminders).toContain('first context')
    expect(reminders).toContain('second context')
    expect(reminders.indexOf('first context')).toBeLessThan(reminders.indexOf('second context'))
  })

  it('halts the turn and stops the hooks after it', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'target.txt', 'KEEP-ME\n')
    await writeHookScript(root, '.dsh/hooks/note.mjs', nodeScript(`
import { appendFileSync } from 'node:fs'
appendFileSync('order.txt', 'note\\n')
emit({ context: ['note context'] })
`))
    await writeHookScript(root, '.dsh/hooks/stop.mjs', nodeScript(`
emit({ action: 'halt', reason: 'emergency stop' })
`))
    await writeHookScript(root, '.dsh/hooks/late.mjs', nodeScript(`
import { appendFileSync } from 'node:fs'
appendFileSync('order.txt', 'late\\n')
emit({ action: 'deny', reason: 'the late hook denies' })
`))
    await writeHooks(root, [
      commandHook('note', 'node .dsh/hooks/note.mjs'),
      commandHook('stop', 'node .dsh/hooks/stop.mjs'),
      commandHook('late', 'node .dsh/hooks/late.mjs'),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'rm -rf target.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The hook after the halt never ran; the tool never ran.
    expect(await readFile(join(root, 'order.txt'), 'utf8')).toBe('note\n')
    await expect(access(join(root, 'target.txt'))).resolves.toBeUndefined()
    // The turn ended through the host's own hook cancellation cause.
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: 'emergency stop' },
    })
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['note', 'stop'])
  })
})

describe('a detached command hook', () => {
  it('never decides the event, while its side effect still happens and is audited', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/notify.mjs', nodeScript(`
import { writeFileSync } from 'node:fs'
await new Promise(resolve => setTimeout(resolve, 600))
writeFileSync('notified.txt', 'notified')
emit({ action: 'deny', reason: 'the detached hook denies' })
`))
    await writeHooks(root, [
      commandHook('notify', 'node .dsh/hooks/notify.mjs', { async: true }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool ran: a detached hook's outcome is not part of the decision.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(requestText(adapter.requests[1]!)).not.toContain('the detached hook denies')
    // The turn finished before the detached run did.
    await expect(access(join(root, 'notified.txt'))).rejects.toThrow()
    // The side effect arrives anyway, and the run is audited without an action.
    await waitFor(async () => {
      try {
        await access(join(root, 'notified.txt'))
        return true
      } catch {
        return false
      }
    })
    await waitFor(() => hookRunRecords(agent.session).length === 1)
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      hook_id: 'notify',
      handler: 'command',
      exit_code: 0,
    })
    // The record keeps what the run produced, even though the event ignored it.
    expect(hookRunRecords(agent.session)[0]!.action).toBe('deny')
    expect(hookRunRecords(agent.session)[0]!.error).toBeUndefined()
  })

  it('is aborted when the plugin is disposed', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/long.mjs', nodeScript(`
import { writeFileSync } from 'node:fs'
writeFileSync('started.txt', 'started')
await new Promise(resolve => setTimeout(resolve, 5000))
writeFileSync('finished.txt', 'finished')
`))
    await writeHooks(root, [commandHook('long', 'node .dsh/hooks/long.mjs', { async: true })])
    const harness = await fixture.harness(root, {}, { bash: true })
    harness.registerAdapter('mock', [bashToolCall('bash-1', 'touch ran.txt'), textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    await waitFor(async () => {
      try {
        await access(join(root, 'started.txt'))
        return true
      } catch {
        return false
      }
    })

    // Disposal drains the detached run: it aborts the process instead of
    // waiting out the script's five seconds.
    const started = performance.now()
    await harness.ctx.fiber.dispose()
    expect(performance.now() - started).toBeLessThan(2_000)
    await new Promise(resolve => setTimeout(resolve, 150))
    await expect(access(join(root, 'finished.txt'))).rejects.toThrow()
  })
})

describe('a command hook in a deployment without a shell', () => {
  it('fails the run instead of crashing the plugin', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooks(root, [commandHook('gate', 'true', { match: { tool: 'read' } })])
    // No bash stack: `ctx.get('shell')` is undefined.
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Fail open: the read ran and its content reached the model.
    expect(requestText(adapter.requests[1]!)).toContain('NOTE-CONTENT')
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ hook_id: 'gate', handler: 'command' })
    expect(records[0]!.exit_code).toBeUndefined()
    expect(String(records[0]!.error)).toContain('shell service is not available')
    expect(harness.pluginWarnings.some(warning => warning.includes('shell service is not available'))).toBe(true)
  })
})

describe('a command hook naming an action the event does not support', () => {
  it('warns, ignores the action, and lets the tool run', async () => {
    const root = await fixture.repo()
    // `block` applies to a tool result, never to a call before it runs.
    await writeHookScript(root, '.dsh/hooks/block.mjs', nodeScript(`
emit({ action: 'block', reason: 'may I?' })
`))
    await writeHooks(root, [commandHook('blocker', 'node .dsh/hooks/block.mjs')])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(requestText(adapter.requests[1]!)).not.toContain('may I?')
    expect(harness.pluginWarnings.some(warning => warning.includes('does not support; ignored'))).toBe(true)
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ hook_id: 'blocker', handler: 'command', exit_code: 0, action: 'block' })
  })
})
