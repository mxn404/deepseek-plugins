/**
 * Integration spec for the observe-only events: `tool.result`, `session.end`,
 * and `notification`.
 *
 * Every case mounts the real Context, agent loop, tools, and shell executor in
 * a temporary project whose `.dsh/hooks.json` runs a real command observer.
 * Assertions read only what the model received, whether the tool executed, the
 * files the hook wrote, the plugin's warnings, and the plugin's audit trail:
 * a Session record while the Session is live, the file fallback afterwards.
 * The point of every case is the same: an observer runs, leaves its audit row,
 * and changes nothing the agent does.
 */

import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { describeBash, requestText, textResponse } from './support/harness.ts'
import {
  bashToolCall,
  commandHook,
  fallbackAuditPath,
  hookRunFallbackRecords,
  hookRunRecords,
  lastSessionEvent,
  nodeScript,
  runTurn,
  waitFor,
  writeHookScript,
  writeHooks,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

/** Read a JSON-lines file one hook appended to. */
async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8')
  return text.trim().split('\n').filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Whether a path exists, for polling a file a hook is expected to write. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Flatten the model-visible text blocks of a tool result content array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => typeof block === 'object' && block !== null && block.type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : '')
    .join('\n')
}

describeBash('observing a final tool result on tool.result', () => {
  it('runs after the result is final, cannot rewrite it, and records the run', async () => {
    const root = await fixture.repo()
    // The observer records the exact payload it was handed, then tries to
    // rewrite the result: an observe-only event must ignore that outcome.
    await writeHookScript(root, '.dsh/hooks/observe.mjs', nodeScript(`
const { appendFileSync } = await import('node:fs')
appendFileSync('observed.jsonl', JSON.stringify(payload) + '\\n')
emit({ replace: { text: 'OBSERVER REWROTE THIS' } })
`))
    await writeHooks(root, [
      commandHook('observe-result', 'node .dsh/hooks/observe.mjs', {
        on: 'tool.result',
        match: { tool: 'bash' },
      }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo FINAL-TOOL-OUTPUT'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The observer really ran and left its audit row.
    await waitFor(() => hookRunRecords(agent.session).length === 1)
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      event: 'tool.result',
      hook_id: 'observe-result',
      handler: 'command',
      exit_code: 0,
    })
    // The model reads the tool's own output, not the observer's replacement.
    expect(adapter.requests).toHaveLength(2)
    const request = adapter.requests[1]!
    expect(requestText(request)).toContain('FINAL-TOOL-OUTPUT')
    expect(requestText(request)).not.toContain('OBSERVER REWROTE THIS')
    // The payload carried the final result, not the tool arguments.
    const observed = (await readJsonLines(join(root, 'observed.jsonl')))[0]!
    expect(observed).toMatchObject({
      event: 'tool.result',
      tool: { name: 'bash', call_id: 'bash-1' },
      result: { is_error: false },
    })
    expect(contentText((observed.result as { content: unknown }).content)).toContain('FINAL-TOOL-OUTPUT')
    // The outcome fields were ignored with one warning that names the event.
    expect(harness.pluginWarnings.some(
      warning => warning.includes('tool.result') && warning.includes('observes'),
    )).toBe(true)
  })
})

describeBash('observing session end on session.end', () => {
  it('runs after the agent is disposed, without blocking disposal, and records the turn', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/on-end.mjs', nodeScript(`
const { writeFileSync } = await import('node:fs')
writeFileSync('session-end.json', JSON.stringify(payload))
`))
    // No `async: true`: an observe-only event forces the command detached.
    await writeHooks(root, [
      commandHook('on-end', 'node .dsh/hooks/on-end.mjs', { on: 'session.end' }),
    ])
    // The observer is a command hook: the harness needs a real shell service.
    const harness = await fixture.harness(root, {}, { bash: true })
    harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    expect(hookRunRecords(agent.session)).toHaveLength(0)

    // Disposal itself must not wait for the observer; the audit row and the
    // side effect land afterwards, bounded by the plugin's detached tracker.
    await harness.disposeAgents()
    await waitFor(async () => (await hookRunFallbackRecords(root)).length === 1)

    // dsh 0.2.2 removes the Session from the SessionStore as disposal
    // completes, and a store-owned Session that left the store rejects plugin
    // records. The row therefore lands in the plugin's file fallback on this
    // host version; the plugin warns once per file that it moved there, so a
    // run is never silently lost.
    expect(hookRunRecords(agent.session)).toHaveLength(0)
    expect((await hookRunFallbackRecords(root))[0]).toMatchObject({
      event: 'session.end',
      hook_id: 'on-end',
      handler: 'command',
      exit_code: 0,
    })
    expect(harness.pluginWarnings.some(
      warning => warning.includes(fallbackAuditPath(root)) && warning.includes('not recorded'),
    )).toBe(true)
    const observed = JSON.parse(await readFile(join(root, 'session-end.json'), 'utf8')) as Record<string, unknown>
    expect(observed).toMatchObject({
      event: 'session.end',
      session_id: agent.session.header.id,
      turn: 1,
      reason: 'completed',
    })
  })
})

describeBash('deriving notifications from approval asks and agent errors', () => {
  it('notifies asynchronously when the host appends approval/asked', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/notify.mjs', nodeScript(`
const { appendFileSync } = await import('node:fs')
appendFileSync('notifications.jsonl', JSON.stringify(payload) + '\\n')
`))
    await writeHooks(root, [
      commandHook('notify', 'node .dsh/hooks/notify.mjs', { on: 'notification' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true, approval: true })
    // Answer the ask so the tool call can proceed, then ask from inside the
    // turn the way a `tool.pre` policy would.
    harness.ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    harness.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'bash' && exec.agent !== undefined) {
        await harness.ctx.approval.request({
          agent: exec.agent,
          toolName: exec.name,
          reason: 'needs a human decision',
        })
      }
      return next()
    })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo approved'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The durable ask is the source of truth the notification is derived from.
    expect(lastSessionEvent(agent.session, 'approval/asked')).toMatchObject({ toolName: 'bash' })
    await waitFor(() => hookRunRecords(agent.session).length === 1)
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      event: 'notification',
      hook_id: 'notify',
      handler: 'command',
      exit_code: 0,
    })
    const observed = (await readJsonLines(join(root, 'notifications.jsonl')))[0]!
    expect(observed).toMatchObject({
      event: 'notification',
      type: 'approval',
      message: 'needs a human decision',
      tool_name: 'bash',
    })
    // The ask did not get in the way: the approved call really ran.
    expect(requestText(adapter.requests[1]!)).toContain('approved')
  })

  it('notifies asynchronously when the loop reports agent/error', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/notify-error.mjs', nodeScript(`
const { writeFileSync } = await import('node:fs')
writeFileSync('error-notification.json', JSON.stringify(payload))
`))
    await writeHooks(root, [
      commandHook('notify-error', 'node .dsh/hooks/notify-error.mjs', { on: 'notification' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    harness.registerAdapter('mock', [() => { throw new Error('provider exploded') }])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The turn really failed; the notification reports that failure.
    expect(lastSessionEvent(agent.session, 'turn/end')).toMatchObject({ reason: { kind: 'error' } })
    await waitFor(() => hookRunRecords(agent.session).length === 1)
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      event: 'notification',
      hook_id: 'notify-error',
      handler: 'command',
      exit_code: 0,
    })
    const observed = JSON.parse(
      await readFile(join(root, 'error-notification.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(observed).toMatchObject({
      event: 'notification',
      type: 'error',
      message: expect.stringContaining('provider exploded'),
    })
    expect(observed).not.toHaveProperty('tool_name')
  })
})

describeBash('failure containment and silence', () => {
  it('contains a failing observer: the agent proceeds and the failure is recorded and warned', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/broken.mjs', nodeScript(`
process.exitCode = 1
`))
    await writeHooks(root, [
      commandHook('broken', 'node .dsh/hooks/broken.mjs', { on: 'tool.result', match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo STILL-RUNNING'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The failed observer changed nothing: the turn completed and the model
    // read the tool's own output.
    expect(lastSessionEvent(agent.session, 'turn/end')).toMatchObject({ reason: { kind: 'completed' } })
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).toContain('STILL-RUNNING')
    // Its failure is visible the only two ways an observer can be: one warning
    // and one audit row carrying the error.
    await waitFor(() => hookRunRecords(agent.session).length === 1)
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      event: 'tool.result',
      hook_id: 'broken',
      exit_code: 1,
      error: expect.stringContaining('exited with code 1'),
    })
    expect(harness.pluginWarnings.some(
      warning => warning.includes('"broken"') && warning.includes('failed'),
    )).toBe(true)
    // A failing observer is not an outcome: no action was applied.
    expect(adapter.requests[1]!.messages.some(
      message => message.role === 'tool' && message.isError,
    )).toBe(false)
  })

  it('does not make agent disposal wait for a still-running observer', async () => {
    const root = await fixture.repo()
    // The observer blocks until the test releases it, so disposal can only
    // resolve if the listener hands the run off instead of awaiting it.
    await writeHookScript(root, '.dsh/hooks/slow-end.mjs', nodeScript(`
const { existsSync, writeFileSync } = await import('node:fs')
writeFileSync('end-started.txt', 'started')
while (!existsSync('release-end.txt')) await new Promise(resolve => setTimeout(resolve, 20))
writeFileSync('end-finished.txt', 'finished')
`))
    await writeHooks(root, [
      commandHook('slow-end', 'node .dsh/hooks/slow-end.mjs', { on: 'session.end' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    await harness.disposeAgents()
    // Disposal returned while the observer is still blocked.
    await waitFor(() => exists(join(root, 'end-started.txt')))
    await expect(exists(join(root, 'end-finished.txt'))).resolves.toBe(false)

    await writeFile(join(root, 'release-end.txt'), 'go')
    // Same post-disposal path as above: the audit row reaches the file
    // fallback, not the Session log that left the store during disposal.
    await waitFor(async () => (await hookRunFallbackRecords(root)).length === 1)
    expect(hookRunRecords(agent.session)).toHaveLength(0)
    expect((await hookRunFallbackRecords(root))[0]).toMatchObject({
      event: 'session.end',
      hook_id: 'slow-end',
      exit_code: 0,
    })
  })

  it('stays silent when no hooks file configures these events', async () => {
    const root = await fixture.repo()
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo NO-HOOKS'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    await harness.disposeAgents()
    // Give any detached observer a chance to surprise us.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(hookRunRecords(agent.session)).toEqual([])
    expect(harness.pluginWarnings).toEqual([])
    // No extra model messages: the tool result and the final answer only.
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).not.toContain('<system-reminder>')
  })
})
