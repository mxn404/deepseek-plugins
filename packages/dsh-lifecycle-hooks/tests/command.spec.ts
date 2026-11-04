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
    expect(decodeOutcome('')).toEqual({ decision: undefined, error: undefined })
    expect(decodeOutcome('  \n\t\n')).toEqual({ decision: undefined, error: undefined })
  })

  it('reads a deny with its reason and context', () => {
    expect(decodeOutcome(JSON.stringify({
      action: 'deny',
      reason: 'rm -rf is blocked',
      context: ['the repository forbids recursive deletes'],
    }))).toEqual({
      decision: {
        action: 'deny',
        reason: 'rm -rf is blocked',
        context: ['the repository forbids recursive deletes'],
      },
      error: undefined,
    })
  })

  it('reads context without an action', () => {
    expect(decodeOutcome('{"context":["lint is configured for this repo"]}')).toEqual({
      decision: { context: ['lint is configured for this repo'] },
      error: undefined,
    })
  })

  it('reads every action the vocabulary knows, leaving event legality to the dispatcher', () => {
    expect(decodeOutcome('{"action":"ask","reason":"needs a human"}').decision)
      .toEqual({ action: 'ask', reason: 'needs a human' })
    expect(decodeOutcome('{"action":"halt","reason":"stop"}').decision)
      .toEqual({ action: 'halt', reason: 'stop' })
  })

  it('tolerates a JSON object with no decision fields', () => {
    expect(decodeOutcome('{"meta":{"took":3}}')).toEqual({ decision: undefined, error: undefined })
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
  ])('rejects %s', (_label, stdout, expected) => {
    const decoded = decodeOutcome(stdout)
    expect(decoded.decision).toBeUndefined()
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
      decision: undefined,
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
      decision: undefined,
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
      decision: undefined,
      exitCode: undefined,
      error: 'timed out after 1000 ms',
    })
  })
})
