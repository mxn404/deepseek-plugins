/**
 * Contract spec for the command handler's stdout protocol.
 *
 * A command hook writes exactly one JSON outcome to stdout; that text is the
 * user-visible half of the `command` handler, so it is pinned here without a
 * process. Running a real command through `ctx.shell` (stdin, env, timeout,
 * exit codes) is covered from the model's side in `command.integration.spec.ts`.
 */

import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { describe, expect, it } from 'vitest'
import { decodeOutcome, runCommand } from '../src/command.ts'

describe('the command stdout contract', () => {
  it('treats empty output as no action', () => {
    expect(decodeOutcome('')).toEqual({ outcome: undefined, error: undefined })
    expect(decodeOutcome('  \n\t\n')).toEqual({ outcome: undefined, error: undefined })
  })

  it('reads a deny with its reason and context', () => {
    expect(decodeOutcome(JSON.stringify({
      action: 'deny',
      reason: 'rm -rf is blocked',
      context: ['the repository forbids recursive deletes'],
    }))).toEqual({
      outcome: {
        action: 'deny',
        reason: 'rm -rf is blocked',
        context: ['the repository forbids recursive deletes'],
      },
      error: undefined,
    })
  })

  it('reads context without an action', () => {
    expect(decodeOutcome('{"context":["lint is configured for this repo"]}')).toEqual({
      outcome: { context: ['lint is configured for this repo'] },
      error: undefined,
    })
  })

  it('reads a bare replace as replacing the model-visible text', () => {
    expect(decodeOutcome('{"replace":{"text":"REDACTED"}}')).toEqual({
      outcome: { action: 'replace', replace: { text: 'REDACTED' } },
      error: undefined,
    })
  })

  it('reads a replace that also carries context', () => {
    expect(decodeOutcome(JSON.stringify({
      replace: { text: 'token=[REDACTED]' },
      context: ['secrets are redacted before the model reads tool output'],
    }))).toEqual({
      outcome: {
        action: 'replace',
        replace: { text: 'token=[REDACTED]' },
        context: ['secrets are redacted before the model reads tool output'],
      },
      error: undefined,
    })
  })

  it('reads an explicit replace action with its text', () => {
    expect(decodeOutcome('{"action":"replace","replace":{"text":"clean"}}').outcome)
      .toEqual({ action: 'replace', replace: { text: 'clean' } })
  })

  it('reads every action the vocabulary knows, leaving event legality to the dispatcher', () => {
    expect(decodeOutcome('{"action":"ask","reason":"needs a human"}').outcome)
      .toEqual({ action: 'ask', reason: 'needs a human' })
    expect(decodeOutcome('{"action":"halt","reason":"stop"}').outcome)
      .toEqual({ action: 'halt', reason: 'stop' })
  })

  it('reads an ask with localized display copy', () => {
    expect(decodeOutcome(JSON.stringify({
      action: 'ask',
      reason: 'the command deletes files',
      displayReason: { en: 'Allow this command?', zh: '允许执行这条命令吗？' },
    }))).toEqual({
      outcome: {
        action: 'ask',
        reason: 'the command deletes files',
        displayReason: { en: 'Allow this command?', zh: '允许执行这条命令吗？' },
      },
      error: undefined,
    })
  })

  it('reads an outcome that carries a meta document', () => {
    expect(decodeOutcome(JSON.stringify({
      action: 'deny',
      reason: 'rm -rf is blocked',
      meta: { rule: 'no-rm', severity: 2, tags: ['safety', null] },
    }))).toEqual({
      outcome: {
        action: 'deny',
        reason: 'rm -rf is blocked',
        meta: { rule: 'no-rm', severity: 2, tags: ['safety', null] },
      },
      error: undefined,
    })
  })

  it('reads a meta-only outcome instead of dropping it', () => {
    expect(decodeOutcome('{"meta":{"took":3}}')).toEqual({
      outcome: { meta: { took: 3 } },
      error: undefined,
    })
  })

  it('tolerates a JSON object with no outcome fields', () => {
    expect(decodeOutcome('{}')).toEqual({ outcome: undefined, error: undefined })
  })

  it.each([
    ['plain text', 'blocked!', 'not a single JSON outcome'],
    ['a truncated object', '{"action":"deny"', 'not a single JSON outcome'],
    ['two JSON documents', '{"action":"deny"}\n{"action":"deny"}', 'not a single JSON outcome'],
    ['a JSON array', '[]', 'must be a JSON object'],
    ['a JSON string', '"deny"', 'must be a JSON object'],
    ['a non-string action', '{"action":1}', '"action" must be a string'],
    ['an unknown action', '{"action":"explode"}', 'unknown action "explode"'],
    ['a non-string reason', '{"reason":7}', '"reason" must be a string'],
    ['a non-array context', '{"action":"deny","context":"one"}', '"context" must be an array'],
    ['a non-string context entry', '{"action":"deny","context":["one",2]}', '"context" entries must be strings'],
    ['a non-object meta', '{"meta":["took",3]}', '"meta" must be a JSON object'],
    ['a non-record meta', '{"meta":"took"}', '"meta" must be a JSON object'],
    ['a non-object replace', '{"replace":"REDACTED"}', '"replace" must be an object'],
    ['a replace without text', '{"replace":{}}', '"replace.text" must be a string'],
    ['a non-string replace text', '{"replace":{"text":7}}', '"replace.text" must be a string'],
    ['a replace of the canonical value', '{"replace":{"value":42}}', 'cannot replace "value"'],
    ['a replace action without a replace object', '{"action":"replace"}', '"action":"replace" needs'],
    ['a non-object display reason', '{"action":"ask","displayReason":"yes"}', '"displayReason" must be an object'],
    ['a display reason with no English copy', '{"action":"ask","displayReason":{"zh":"是"}}', '"displayReason.en"'],
    ['a non-string English display reason', '{"action":"ask","displayReason":{"en":7}}', '"displayReason.en"'],
    ['a non-string localized display reason', '{"action":"ask","displayReason":{"en":"yes","zh":2}}', '"displayReason"'],
  ])('rejects %s', (_label, stdout, expected) => {
    const decoded = decodeOutcome(stdout)
    expect(decoded.outcome).toBeUndefined()
    expect(decoded.error).toContain(expected)
  })
})

describe('running a command through the shell seam', () => {
  const signal = new AbortController().signal

  /** A shell stand-in whose `execute` behaves as the test scripts. */
  function shellOf(execute: () => Promise<never> | Promise<unknown>) {
    return {
      resolve: (request: Record<string, unknown>) => ({
        workdir: '/repo',
        timeoutMs: 1_000,
        onExpiry: 'kill',
        stdoutMaxBytes: 1_000,
        sandboxPolicy: undefined,
        ...request,
      }),
      execute,
    } as unknown as Pick<ShellExecutor, 'resolve' | 'execute'>
  }

  it('fails the run when the deployment has no shell service', async () => {
    expect(await runCommand({
      shell: undefined,
      command: 'true',
      payload: {},
      env: {},
      workdir: '/repo',
      timeoutMs: 1_000,
      signal,
    })).toEqual({
      outcome: undefined,
      exitCode: undefined,
      error: 'the shell service is not available',
    })
  })

  it('fails the run when the shell rejects the spawn', async () => {
    // `resolve` validating workdir or the spawn itself rejecting are the
    // executor's only rejection paths; both mean "this hook could not run".
    const shell = shellOf(() => Promise.reject(new Error('spawn ENOENT: no such directory')))
    expect(await runCommand({
      shell,
      command: 'true',
      payload: {},
      env: {},
      workdir: '/gone',
      timeoutMs: 1_000,
      signal,
    })).toEqual({
      outcome: undefined,
      exitCode: undefined,
      error: 'the command could not be started: spawn ENOENT: no such directory',
    })
  })

  it('fails the run when the result reports a timeout', async () => {
    const shell = shellOf(() => Promise.resolve({
      result: () => Promise.resolve({
        exitCode: null,
        signal: null,
        timedOut: true,
        aborted: false,
        timeoutMs: 1_000,
        stdout: { text: '', truncated: false },
        stderr: { text: 'partial', truncated: false },
      }),
    }))
    expect(await runCommand({
      shell,
      command: 'true',
      payload: {},
      env: {},
      workdir: '/repo',
      timeoutMs: 1_000,
      signal,
    })).toEqual({
      outcome: undefined,
      exitCode: undefined,
      error: 'timed out after 1000 ms',
    })
  })
})
