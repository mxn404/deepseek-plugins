/**
 * Integration spec for the `module` handler.
 *
 * Each case mounts the real Context, agent loop, tools, and shell executor in a
 * temporary project whose `.dsh/hooks.json` points at a real `.mjs` module.
 * Assertions read only what the model received, whether the tool executed, the
 * files a module wrote, the plugin's log lines, and the Session plugin records.
 * The module itself proves the curated context by acting on it.
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { requestText, textResponse, toolCallResponse } from './support/harness.ts'
import {
  bashToolCall,
  hookRunRecords,
  moduleHook,
  runTurn,
  waitFor,
  writeHookModule,
  writeHookScript,
  writeHooks,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

/** The text of the last tool result the model was shown. */
function lastToolResultText(request: GenerateOptions): string {
  const results = request.messages.filter(message => message.role === 'tool')
  const last = results[results.length - 1]
  if (last === undefined) throw new Error('the request carries no tool result')
  return last.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('a module hook on tool.pre', () => {
  it('denies the call with the outcome its default export returns', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/gate.mjs', `
export default (ctx) => ({
  action: 'deny',
  reason: 'blocked by a module hook: ' + ctx.tool.name,
})
`)
    // The module lives beside the hooks file (`.dsh/hooks.json`), so its path
    // is relative to `.dsh/`: `hooks/gate.mjs`, not `.dsh/hooks/gate.mjs`.
    await writeHooks(root, [moduleHook('gate', 'hooks/gate.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool never ran, and the model reads the module's reason.
    await expect(access(join(root, 'ran.txt'))).rejects.toThrow()
    expect(requestText(adapter.requests[1]!)).toContain('blocked by a module hook: bash')
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'tool.pre',
      hook_id: 'gate',
      handler: 'module',
      action: 'deny',
    })
    expect(records[0]!.error).toBeUndefined()
    expect(typeof records[0]!.duration_ms).toBe('number')
    expect(harness.pluginWarnings).toEqual([])
  })
})

describe('a module at tool.pre that asks for approval', () => {
  it('reaches the host approval flow through the shared outcome codec', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/confirm.mjs', `
export default (ctx) => ({
  action: 'ask',
  reason: 'the module wants confirmation',
  displayReason: { en: 'Run ' + ctx.tool.name + '?' },
})
`)
    await writeHooks(root, [moduleHook('confirm', 'hooks/confirm.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true, approval: true })
    harness.answerApprovals('allowed-once')
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo APPROVED-RAN'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // A module's outcome is validated by the same `decodeDecision` a command's
    // stdout is, so `ask` is legal here too: the host runs its own approval
    // flow, and the tool runs only because the answerer allowed it once.
    expect(harness.approvalRequests).toHaveLength(1)
    expect(harness.approvalRequests[0]).toMatchObject({
      toolName: 'bash',
      reason: 'the module wants confirmation',
    })
    expect(requestText(adapter.requests[1]!)).toContain('APPROVED-RAN')
    expect(hookRunRecords(agent.session)).toEqual([
      expect.objectContaining({ event: 'tool.pre', hook_id: 'confirm', handler: 'module', action: 'ask' }),
    ])
  })
})

describe('a module hook on tool.post', () => {
  it('runs a formatter through exec and injects a notice for the next request', async () => {
    const root = await fixture.repo()
    // A local stand-in for a formatter: it rewrites the file it is given, so
    // the test proves the module really ran a process instead of writing the
    // file itself.
    await writeHookScript(root, '.dsh/hooks/tidy.mjs', `
import { readFileSync, writeFileSync } from 'node:fs'
const [file] = process.argv.slice(2)
writeFileSync(file, readFileSync(file, 'utf8').replace('const x=1', 'const x = 1'))
`)
    await writeHookModule(root, '.dsh/hooks/format.mjs', `
export default async (ctx) => {
  const result = await ctx.exec('node .dsh/hooks/tidy.mjs notes.js')
  if (result.exitCode !== 0) {
    return { action: 'block', reason: 'the formatter failed: ' + result.stderr }
  }
  ctx.inject('the hook formatted ' + ctx.tool.input.file_path
    + ' with exit code ' + result.exitCode)
}
`)
    await writeHooks(root, [
      moduleHook('format', 'hooks/format.mjs', { on: 'tool.post', match: { tool: 'write' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'notes.js', content: 'const x=1\n' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The formatter the module exec'd changed the file on disk.
    expect(await readFile(join(root, 'notes.js'), 'utf8')).toBe('const x = 1\n')
    // Its inject reached the next request as the one system reminder.
    const request = adapter.requests[1]!
    expect(requestText(request)).toContain('the hook formatted notes.js with exit code 0')
    const reminders = request.messages.filter(message => message.content.some(
      block => block.type === 'text' && block.text.includes('<system-reminder>'),
    ))
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.role).toBe('user')
    // The run is audited as a module run with no failure.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'tool.post', hook_id: 'format', handler: 'module' })
    expect(records[0]!.action).toBeUndefined()
    expect(records[0]!.error).toBeUndefined()
    expect(harness.pluginWarnings).toEqual([])
  })
})

describe('a module that is edited between events', () => {
  it('loads the new version on the next event instead of the cached one', async () => {
    const root = await fixture.repo()
    const gate = (version: string): string => `
export default (ctx) => ({ action: 'deny', reason: 'gate version ${version} denied at ' + ctx.event })
`
    await writeHookModule(root, '.dsh/hooks/gate.mjs', gate('ONE'))
    await writeHooks(root, [moduleHook('gate', 'hooks/gate.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch first.txt'),
      textResponse('first done'),
      bashToolCall('bash-2', 'touch second.txt'),
      textResponse('second done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    // The first turn reads the version on disk when it started.
    expect(lastToolResultText(adapter.requests[1]!)).toContain('gate version ONE denied at tool.pre')
    await expect(access(join(root, 'first.txt'))).rejects.toThrow()

    // Rewrite the module file; the next event must read the new version.
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHookModule(root, '.dsh/hooks/gate.mjs', gate('TWO'))
    await runTurn(agent, 'again')

    // The second denial carries the new version, and the old one is history.
    expect(lastToolResultText(adapter.requests[3]!)).toContain('gate version TWO denied at tool.pre')
    expect(lastToolResultText(adapter.requests[3]!)).not.toContain('gate version ONE')
    await expect(access(join(root, 'second.txt'))).rejects.toThrow()
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['gate', 'gate'])
    expect(harness.pluginWarnings).toEqual([])
  })
})

describe('a module that outlives its timeout', () => {
  it('fails the run and disables inject, steer, and exec afterwards', async () => {
    const root = await fixture.repo()
    // The module ignores the timeout on purpose: it writes down what its
    // helpers answered after the run was already over, and touches a file
    // through exec that must never appear.
    await writeHookModule(root, '.dsh/hooks/slow.mjs', `
import { writeFileSync } from 'node:fs'
export default async (ctx) => {
  await new Promise(resolve => setTimeout(resolve, 400))
  const injected = ctx.inject('LATE-NOTICE')
  const steered = ctx.steer('LATE-STEER')
  const result = await ctx.exec('touch late-exec.txt')
  writeFileSync(ctx.payload.cwd + '/late-helpers.json', JSON.stringify({ injected, steered, result }))
  return { action: 'deny', reason: 'LATE-DENY' }
}
`)
    await writeHooks(root, [
      moduleHook('slow', 'hooks/slow.mjs', { match: { tool: 'bash' }, timeoutMs: 100 }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Fail open: the tool ran, and the late denial never reached the model.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    for (const request of adapter.requests) {
      expect(requestText(request)).not.toContain('LATE-NOTICE')
      expect(requestText(request)).not.toContain('LATE-STEER')
      expect(requestText(request)).not.toContain('LATE-DENY')
    }
    // The run is recorded as a timeout, with no action.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'tool.pre', hook_id: 'slow', handler: 'module' })
    expect(String(records[0]!.error)).toContain('timed out after 100 ms')
    expect(records[0]!.action).toBeUndefined()
    expect(harness.pluginWarnings.some(warning => warning.includes('timed out after 100 ms'))).toBe(true)

    // What the helpers answered after the timeout is on disk; the exec never ran.
    await waitFor(async () => {
      try {
        await access(join(root, 'late-helpers.json'))
        return true
      } catch {
        return false
      }
    })
    const late = JSON.parse(await readFile(join(root, 'late-helpers.json'), 'utf8')) as {
      injected: boolean
      steered: boolean
      result: { disabled: boolean; exitCode: number | null }
    }
    expect(late.injected).toBe(false)
    expect(late.steered).toBe(false)
    expect(late.result.disabled).toBe(true)
    expect(late.result.exitCode).toBeNull()
    await expect(access(join(root, 'late-exec.txt'))).rejects.toThrow()
  })
})

describe('a module that cannot be loaded', () => {
  it('treats a missing file as a run failure and applies onFailure: block', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [
      moduleHook('ghost', 'hooks/ghost.mjs', { match: { tool: 'bash' }, onFailure: 'block' }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The hook asked to block on failure, so the call is denied…
    await expect(access(join(root, 'ran.txt'))).rejects.toThrow()
    const text = requestText(adapter.requests[1]!)
    expect(text).toContain('hook "ghost" failed')
    expect(text).toContain('the module could not be read')
    // …and the run is audited as a module failure with the synthesized denial.
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ handler: 'module', action: 'deny' })
    expect(String(records[0]!.error)).toContain('the module could not be read')
    expect(harness.pluginWarnings.some(warning => warning.includes('the module could not be read'))).toBe(true)
  })

  it('fails a module with no default function, fail-open by default', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/not-a-hook.mjs', `
export const notTheHook = true
`)
    await writeHooks(root, [moduleHook('wrong', 'hooks/not-a-hook.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Fail open: the tool ran, and the failure is recorded for the author.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ event: 'tool.pre', hook_id: 'wrong', handler: 'module' })
    expect(String(records[0]!.error)).toContain('must export a default function')
    expect(harness.pluginWarnings.some(warning => warning.includes('must export a default function'))).toBe(true)
  })
})

describe('the curated module context', () => {
  it('exposes the hook API and the entry facts, and routes log through the host logger', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/inspect.mjs', `
import { writeFileSync } from 'node:fs'

export default async (ctx) => {
  writeFileSync(ctx.payload.cwd + '/context.json', JSON.stringify({
    keys: Object.keys(ctx).sort(),
    event: ctx.event,
    payload: { event: ctx.payload.event, hook_id: ctx.payload.hook_id, cwd: ctx.payload.cwd },
    tool: ctx.tool,
    result: ctx.result,
    handler: ctx.handler,
    agent: { live: typeof ctx.agent.inject === 'function', id: ctx.agent.id },
    session: { id: ctx.session.header.id },
    signal: ctx.signal instanceof AbortSignal,
  }))
  ctx.log('inspected ' + ctx.event)
  return { context: ['a context line the module returned'] }
}
`)
    await writeHooks(root, [
      moduleHook('inspect', 'hooks/inspect.mjs', { on: 'tool.post', match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo INSPECTED'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const seen = JSON.parse(await readFile(join(root, 'context.json'), 'utf8')) as {
      keys: string[]
      event: string
      payload: { event: string; hook_id: string; cwd: string }
      tool: { name: string; call_id: string }
      result: { is_error: boolean }
      handler: { id: string; event: string; source: string }
      agent: { live: boolean; id: string }
      session: { id: string }
      signal: boolean
    }
    // The curated surface, in full: nothing from the Cordis Context leaks in.
    expect(seen.keys).toEqual([
      'agent', 'event', 'exec', 'handler', 'inject', 'log',
      'payload', 'result', 'session', 'signal', 'steer', 'tool',
    ])
    expect(seen.event).toBe('tool.post')
    expect(seen.payload).toEqual({
      event: 'tool.post',
      hook_id: 'inspect',
      cwd: root,
    })
    expect(seen.tool).toMatchObject({ name: 'bash', call_id: 'bash-1' })
    expect(seen.result).toMatchObject({ is_error: false })
    expect(seen.handler).toEqual({
      id: 'inspect',
      event: 'tool.post',
      source: join(root, '.dsh/hooks.json'),
    })
    // A live agent and Session, not copies.
    expect(seen.agent).toEqual({ live: true, id: agent.id })
    expect(seen.session.id).toBe(agent.session.header.id)
    expect(seen.signal).toBe(true)
    // `log` went to the host logger under the plugin's name and never to the model.
    expect(harness.pluginLogs).toContain(
      'dsh-lifecycle-hooks: module "inspect" at tool.post: inspected tool.post',
    )
    expect(requestText(adapter.requests[1]!)).not.toContain('inspected tool.post')
    // A module's returned `context` follows the same path as any other outcome.
    expect(requestText(adapter.requests[1]!)).toContain('a context line the module returned')
  })
})

describe('a module handler on other outcome shapes', () => {
  it('blocks the tool result with the outcome a module returns', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/withhold.mjs', `
export default (ctx) => ({
  action: 'block',
  reason: 'module withheld the result of ' + ctx.tool.call_id,
})
`)
    await writeHooks(root, [
      moduleHook('withhold', 'hooks/withhold.mjs', { on: 'tool.post', match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'echo SECRET-CONTENT && touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool ran; the model reads the module's feedback as an error instead.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const result = adapter.requests[1]!.messages.filter(message => message.role === 'tool')[0]!
    expect(result.isError).toBe(true)
    expect(requestText(adapter.requests[1]!)).toContain('module withheld the result of bash-1')
    expect(requestText(adapter.requests[1]!)).not.toContain('SECRET-CONTENT')
    expect(hookRunRecords(agent.session)[0]).toMatchObject({
      event: 'tool.post',
      handler: 'module',
      action: 'block',
    })
  })

  it('runs a detached module without deciding the event, and still audits it', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/notify.mjs', `
import { writeFileSync } from 'node:fs'

export default async (ctx) => {
  await new Promise(resolve => setTimeout(resolve, 200))
  writeFileSync(ctx.payload.cwd + '/notified.txt', 'notified')
  return { action: 'deny', reason: 'DETACHED-DENY' }
}
`)
    await writeHooks(root, [
      moduleHook('notify', 'hooks/notify.mjs', { match: { tool: 'bash' }, async: true }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The event never waited for it, so its denial decided nothing.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    for (const request of adapter.requests) {
      expect(requestText(request)).not.toContain('DETACHED-DENY')
    }
    // Its side effect lands anyway, and the run is audited with what it produced.
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
      event: 'tool.pre',
      hook_id: 'notify',
      handler: 'module',
      action: 'deny',
    })
    expect(hookRunRecords(agent.session)[0]!.error).toBeUndefined()
  })
})

describe('a module that is created after its first failure', () => {
  it('starts working on the next event once the file exists', async () => {
    const root = await fixture.repo()
    await writeHooks(root, [moduleHook('late', 'hooks/late.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch first.txt'),
      textResponse('first done'),
      bashToolCall('bash-2', 'touch second.txt'),
      textResponse('second done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    // Missing file: the run fails, so the call goes through (fail open).
    await expect(access(join(root, 'first.txt'))).resolves.toBeUndefined()
    expect(String(hookRunRecords(agent.session)[0]!.error)).toContain('the module could not be read')

    // Create the module; the next event loads it.
    await writeHookModule(root, '.dsh/hooks/late.mjs', `
export default (ctx) => ({ action: 'deny', reason: 'late module denied ' + ctx.tool.call_id })
`)
    await runTurn(agent, 'again')

    await expect(access(join(root, 'second.txt'))).rejects.toThrow()
    expect(lastToolResultText(adapter.requests[3]!)).toContain('late module denied bash-2')
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ handler: 'module', action: 'deny' })
    expect(records[1]!.error).toBeUndefined()
  })
})

describe('a module timeout inherited from the row config', () => {
  it('uses defaultTimeoutMs when the entry declares no own timeout', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/slow.mjs', `
export default async () => {
  await new Promise(resolve => setTimeout(resolve, 400))
  return { action: 'deny', reason: 'TOO-LATE' }
}
`)
    await writeHooks(root, [moduleHook('slow', 'hooks/slow.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, { defaultTimeoutMs: 100 }, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    expect(requestText(adapter.requests[1]!)).not.toContain('TOO-LATE')
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ handler: 'module' })
    expect(String(records[0]!.error)).toContain('timed out after 100 ms')
  })
})

describe('a module outcome the event does not support', () => {
  it('warns, ignores the action, and keeps the module’s context', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/pre-only.mjs', `
export default () => ({
  action: 'block',
  reason: 'block belongs to tool.post',
  context: ['kept although the action is illegal'],
})
`)
    await writeHooks(root, [
      moduleHook('pre-only', 'hooks/pre-only.mjs', { match: { tool: 'bash' } }),
    ])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The action is ignored, so the tool runs and its result stays an error-free result…
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const text = requestText(adapter.requests[1]!)
    expect(text).not.toContain('block belongs to tool.post')
    // …while the context it also reported still reaches the model.
    expect(text).toContain('kept although the action is illegal')
    expect(harness.pluginWarnings.some(warning => warning.includes('does not support; ignored'))).toBe(true)
    // The record keeps what the run produced, before the event filtered it.
    expect(hookRunRecords(agent.session)[0]).toMatchObject({ handler: 'module', action: 'block' })
  })
})

describe('a module returning something that is not an outcome', () => {
  it('fails the run with the shared outcome-validation message', async () => {
    const root = await fixture.repo()
    await writeHookModule(root, '.dsh/hooks/bare.mjs', `
export default () => 'not an outcome object'
`)
    await writeHooks(root, [moduleHook('bare', 'hooks/bare.mjs', { match: { tool: 'bash' } })])
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch ran.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // Fail open: the tool ran, and the author learns what the module returned.
    await expect(access(join(root, 'ran.txt'))).resolves.toBeUndefined()
    const records = hookRunRecords(agent.session)
    expect(records[0]).toMatchObject({ handler: 'module' })
    expect(String(records[0]!.error)).toContain('module result must be a JSON object')
    expect(harness.pluginWarnings.some(warning => warning.includes('module result must be a JSON object')))
      .toBe(true)
  })
})
