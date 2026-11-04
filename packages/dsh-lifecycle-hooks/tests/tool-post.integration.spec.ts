/**
 * Integration spec for `tool.post`: block, replace, and context.
 *
 * Each case mounts the real Context, agent loop, tools, and shell executor in a
 * temporary project whose `.dsh/hooks.json` runs a real hook. Assertions read
 * only what the model received, whether the tool executed, the plugin's
 * warnings, and the Session plugin records. The tool has already run by the
 * time a `tool.post` hook sees it, so every case proves the side effect on disk
 * as well as the model-visible rewrite.
 */

import type { GenerateOptions, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { requestText, textResponse, toolCallBatch, toolCallResponse } from './support/harness.ts'
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
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

/** Every tool-result message in one model request, in order. */
function toolResults(request: GenerateOptions): ToolResultMessage[] {
  return request.messages.flatMap(message => message.role === 'tool' ? [message] : [])
}

/** The single tool result of a one-call turn. */
function onlyToolResult(request: GenerateOptions): ToolResultMessage {
  const results = toolResults(request)
  expect(results).toHaveLength(1)
  return results[0]!
}

describe('replacing a tool result on tool.post', () => {
  it('replaces the model-visible output of a successful call, after the tool ran', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/redact.mjs', nodeScript(`
emit({ replace: { text: 'TOKEN=[REDACTED]' } })
`))
    await writeHooks(root, [
      commandHook('redact', 'node .dsh/hooks/redact.mjs', { on: 'tool.post', match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo TOKEN=abc123 && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool really executed: its side effect is on disk.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    // The model reads the replacement instead of the raw output.
    expect(adapter.requests).toHaveLength(2)
    const request = adapter.requests[1]!
    expect(requestText(request)).toContain('TOKEN=[REDACTED]')
    expect(requestText(request)).not.toContain('TOKEN=abc123')
    // The call stays successful; only its content changed.
    expect(onlyToolResult(request).isError).toBe(false)
    // One audit row: the action, handler, and measured duration.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'tool.post',
      hook_id: 'redact',
      handler: 'command',
      action: 'replace',
      exit_code: 0,
    })
    expect(typeof records[0]!.duration_ms).toBe('number')
    expect(harness.pluginWarnings).toEqual([])
  })

  it('replaces the content of a failed result and keeps it an error', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/redact.mjs', nodeScript(`
emit({ replace: { text: 'READ FAILED: the hook replaced this failure' } })
`))
    await writeHooks(root, [
      commandHook('redact', 'node .dsh/hooks/redact.mjs', { on: 'tool.post', match: { tool: 'read' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      // A read of a missing file is a failed result, not a thrown call.
      toolCallResponse('read-1', 'read', { file_path: 'missing.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The failure keeps its error status; only what the model reads changed.
    const request = adapter.requests[1]!
    const result = onlyToolResult(request)
    expect(result.isError).toBe(true)
    expect(requestText(request)).toContain('READ FAILED: the hook replaced this failure')
    expect(hookRunRecords(agent.session)[0]).toMatchObject({ action: 'replace', exit_code: 0 })
  })
})

describe('blocking a tool result on tool.post', () => {
  it('turns the result into an error carrying the feedback, after the tool ran', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/withhold.mjs', nodeScript(`
emit({ action: 'block', reason: 'this output is withheld by a redaction hook' })
`))
    await writeHooks(root, [
      commandHook('withhold', 'node .dsh/hooks/withhold.mjs', { on: 'tool.post', match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo SECRET-CONTENT > secret.txt && cat secret.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool executed (its side effect is on disk) — a post hook cannot undo that.
    await expect(access(join(root, 'secret.txt'))).resolves.toBeUndefined()
    // What the model reads is the feedback, as an error result.
    const request = adapter.requests[1]!
    const result = onlyToolResult(request)
    expect(result.isError).toBe(true)
    expect(requestText(request)).toContain('this output is withheld by a redaction hook')
    expect(requestText(request)).not.toContain('SECRET-CONTENT')
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'tool.post',
      hook_id: 'withhold',
      handler: 'command',
      action: 'block',
      exit_code: 0,
    })
  })
})

describe('adding context on tool.post', () => {
  it('leaves the result readable and ferries the reminder to the next request', async () => {
    const root = await fixture.repo()
    // The script proves the post payload contract too: the tool facts and the
    // result's error flag are what the hook matched on.
    await writeHookScript(root, '.dsh/hooks/note.mjs', nodeScript(`
const facts = {
  event: payload.event === 'tool.post' && process.env.DSH_HOOK_EVENT === 'tool.post',
  tool: payload.tool.name === 'bash' && payload.tool.call_id === 'bash-1',
  result: payload.result.is_error === false && Array.isArray(payload.result.content),
}
const broken = Object.entries(facts).filter(([, ok]) => !ok).map(([name]) => name)
emit({
  context: broken.length === 0
    ? ['this file is generated; edit the template instead']
    : ['PAYLOAD CONTRACT BROKEN: ' + broken.join(',')],
})
`))
    await writeHooks(root, [
      commandHook('note', 'node .dsh/hooks/note.mjs', { on: 'tool.post', match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo GENERATED-CONTENT'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const request = adapter.requests[1]!
    // The result is untouched: context alone is not a replacement.
    expect(requestText(request)).toContain('GENERATED-CONTENT')
    expect(onlyToolResult(request).isError).toBe(false)
    // One user-role reminder, on the next request, with the hook's line.
    const reminders = request.messages.filter(message => message.content.some(
      block => block.type === 'text' && block.text.includes('<system-reminder>'),
    ))
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.role).toBe('user')
    expect(requestText(request)).toContain('this file is generated; edit the template instead')
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ event: 'tool.post', hook_id: 'note', handler: 'command' })
    expect(records[0]!.action).toBeUndefined()
    expect(records[0]!.error).toBeUndefined()
  })
})

describe('merging several tool.post outcomes', () => {
  it('lets a block win over a replace while keeping every hook’s context', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/replace.mjs', nodeScript(`
emit({ replace: { text: 'CLEAN-CONTENT' }, context: ['first context'] })
`))
    await writeHookScript(root, '.dsh/hooks/block.mjs', nodeScript(`
emit({ action: 'block', reason: 'the block hook withheld this output', context: ['second context'] })
`))
    await writeHooks(root, [
      commandHook('replace', 'node .dsh/hooks/replace.mjs', { on: 'tool.post' }),
      commandHook('block', 'node .dsh/hooks/block.mjs', { on: 'tool.post' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo RAW-CONTENT && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const request = adapter.requests[1]!
    const result = onlyToolResult(request)
    expect(result.isError).toBe(true)
    const text = requestText(request)
    expect(text).toContain('the block hook withheld this output')
    // The losing replacement never reaches the model, and neither does the raw output.
    expect(text).not.toContain('CLEAN-CONTENT')
    expect(text).not.toContain('RAW-CONTENT')
    // Context from both hooks survives the block, in configuration order.
    expect(text).toContain('first context')
    expect(text).toContain('second context')
    expect(text.indexOf('first context')).toBeLessThan(text.indexOf('second context'))
    // Both runs are audited with their own action.
    expect(hookRunRecords(agent.session).map(record => record.action)).toEqual(['replace', 'block'])
  })

  it('applies the last replacement in configuration order', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/first.mjs', nodeScript(`
emit({ replace: { text: 'FIRST-TEXT' } })
`))
    await writeHookScript(root, '.dsh/hooks/second.mjs', nodeScript(`
emit({ replace: { text: 'SECOND-TEXT' } })
`))
    await writeHooks(root, [
      commandHook('first', 'node .dsh/hooks/first.mjs', { on: 'tool.post' }),
      commandHook('second', 'node .dsh/hooks/second.mjs', { on: 'tool.post' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo RAW-CONTENT'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const text = requestText(adapter.requests[1]!)
    expect(text).toContain('SECOND-TEXT')
    expect(text).not.toContain('FIRST-TEXT')
    expect(text).not.toContain('RAW-CONTENT')
  })
})

describe('a replace the host cannot honour', () => {
  it('rejects a run that tries to replace the canonical value instead of the content', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/value.mjs', nodeScript(`
emit({ replace: { value: 42 } })
`))
    await writeHooks(root, [
      commandHook('value', 'node .dsh/hooks/value.mjs', { on: 'tool.post' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo ORIGINAL-OUTPUT'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The model keeps the real output: a rejected run contributes nothing.
    expect(requestText(adapter.requests[1]!)).toContain('ORIGINAL-OUTPUT')
    // The run fails with the reason, is warned about, and is audited as a failure.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(String(records[0]!.error)).toContain('cannot replace "value"')
    expect(records[0]!.action).toBeUndefined()
    expect(harness.pluginWarnings.some(warning => warning.includes('cannot replace "value"'))).toBe(true)
  })
})

describe('an action tool.post does not support', () => {
  it('warns, ignores the action, and keeps the hook’s context', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/pre-only.mjs', nodeScript(`
emit({ action: 'deny', reason: 'deny belongs to tool.pre', context: ['kept although the action is illegal'] })
`))
    await writeHooks(root, [
      commandHook('pre-only', 'node .dsh/hooks/pre-only.mjs', { on: 'tool.post' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo VISIBLE-OUTPUT'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const text = requestText(adapter.requests[1]!)
    // The denial is not applied to a result the tool already produced…
    expect(onlyToolResult(adapter.requests[1]!).isError).toBe(false)
    expect(text).toContain('VISIBLE-OUTPUT')
    expect(text).not.toContain('deny belongs to tool.pre')
    // …its context still arrives, and the record keeps what the run produced.
    expect(text).toContain('kept although the action is illegal')
    expect(harness.pluginWarnings.some(warning => warning.includes('does not support; ignored'))).toBe(true)
    expect(hookRunRecords(agent.session)[0]).toMatchObject({ action: 'deny', exit_code: 0 })
  })
})

describe('a failing tool.post hook', () => {
  it('blocks the result when the entry says onFailure: block', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/slow.mjs', nodeScript(`
await new Promise(resolve => setTimeout(resolve, 5000))
emit({ replace: { text: 'never applied' } })
`))
    await writeHooks(root, [
      commandHook('slow', 'node .dsh/hooks/slow.mjs', { on: 'tool.post', timeoutMs: 200, onFailure: 'block' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo SECRET-OUTPUT && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool had already run; the broken sanitizer still withholds its output.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const request = adapter.requests[1]!
    expect(onlyToolResult(request).isError).toBe(true)
    const text = requestText(request)
    expect(text).toContain('hook "slow" failed')
    expect(text).toContain('timed out after 200 ms')
    expect(text).not.toContain('SECRET-OUTPUT')
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ event: 'tool.post', action: 'block' })
    expect(String(records[0]!.error)).toContain('timed out after 200 ms')
  })
})

describe('match on tool.post', () => {
  it('selects post hooks by tool arguments, like pre hooks', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/echo-only.mjs', nodeScript(`
emit({ replace: { text: 'ONLY-ECHO-REPLACED' } })
`))
    await writeHooks(root, [
      commandHook('echo-only', 'node .dsh/hooks/echo-only.mjs', {
        on: 'tool.post',
        match: { tool: 'bash', args: { command: '/^echo /' } },
      }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      toolCallBatch([
        { id: 'bash-1', name: 'bash', arguments: { command: 'echo FIRST', description: 'echo' } },
        { id: 'bash-2', name: 'bash', arguments: { command: 'printf SECOND', description: 'printf' } },
      ]),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const results = toolResults(adapter.requests[1]!)
    expect(results).toHaveLength(2)
    // The matched call is replaced; the other one keeps its real output.
    expect(requestText(adapter.requests[1]!)).toContain('ONLY-ECHO-REPLACED')
    expect(requestText(adapter.requests[1]!)).toContain('SECOND')
    expect(toolResults(adapter.requests[1]!).filter(result =>
      result.content.some(block => block.type === 'text' && block.text.includes('ONLY-ECHO-REPLACED')),
    )).toHaveLength(1)
    expect(hookRunRecords(agent.session)).toHaveLength(1)
  })
})

describe('builtin tool.post hooks', () => {
  it('replaces the content and injects context from one file', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [
      hook({
        id: 'clean',
        on: 'tool.post',
        run: { type: 'builtin', action: 'replace', text: 'BUILTIN-CLEAN' },
      }),
      hook({
        id: 'note',
        on: 'tool.post',
        run: { type: 'builtin', action: 'inject', text: 'builtin reminder line' },
      }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo RAW-CONTENT && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const text = requestText(adapter.requests[1]!)
    expect(text).toContain('BUILTIN-CLEAN')
    expect(text).not.toContain('RAW-CONTENT')
    expect(text).toContain('builtin reminder line')
    const records = hookRunRecords(agent.session)
    expect(records.map(record => record.hook_id)).toEqual(['clean', 'note'])
    expect(records[0]).toMatchObject({ handler: 'builtin', action: 'replace' })
    // An inject contributes context, not an action.
    expect(records[1]!.action).toBeUndefined()
  })

  it('blocks the result with its reason', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [
      hook({
        id: 'withhold',
        on: 'tool.post',
        run: { type: 'builtin', action: 'block', reason: 'builtin block reason' },
      }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo RAW-CONTENT && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const result = onlyToolResult(adapter.requests[1]!)
    expect(result.isError).toBe(true)
    expect(requestText(adapter.requests[1]!)).toContain('builtin block reason')
    expect(requestText(adapter.requests[1]!)).not.toContain('RAW-CONTENT')
  })
})

describe('halting from tool.post', () => {
  it('cancels the turn and withholds the result the hook saw', async () => {
    const root = await fixture.repo()
    await writeHookScript(root, '.dsh/hooks/stop.mjs', nodeScript(`
emit({ action: 'halt', reason: 'stop after this result' })
`))
    await writeHooks(root, [
      commandHook('stop', 'node .dsh/hooks/stop.mjs', { on: 'tool.post' }),
      // A later hook must not run once the turn is being stopped.
      commandHook('late', 'node .dsh/hooks/stop.mjs', { on: 'tool.post' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo RAW-CONTENT && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: 'stop after this result' },
    })
    // Only the halting run was executed; the one behind it never ran.
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['stop'])
    expect(hookRunRecords(agent.session)[0]).toMatchObject({ event: 'tool.post', action: 'halt' })
    // The turn was cancelled before the model could ask for another step, so
    // there is no second request to read the withheld result from.
    expect(adapter.requests).toHaveLength(1)
  })
})
