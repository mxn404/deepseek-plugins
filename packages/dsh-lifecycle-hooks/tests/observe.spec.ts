/**
 * Contract spec for the observe-only events: `tool.result`, `session.end`, and
 * `notification`.
 *
 * These events have no decision to apply, so their whole format contract is
 * "a command observer, never a builtin action": a command is detached whether
 * or not it says `async: true`, and a builtin entry is skipped at load time
 * with a warning. The payloads and what a command does with them are covered
 * by `observe.integration.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import { parseHooks } from '../src/hooks-file.ts'
import { approvalNotification, errorNotification } from '../src/notification.ts'

const DEFAULTS = 30_000

/** Expand a successful parse, failing the test with the file-level error otherwise. */
function hooksOf(text: string, defaultTimeoutMs = DEFAULTS) {
  const parsed = parseHooks(text, defaultTimeoutMs)
  if (!parsed.ok) throw new Error(`expected a parsed file, got: ${parsed.error}`)
  return parsed
}

/** Parse a one-entry file. */
function parseEntry(entry: Record<string, unknown>) {
  return hooksOf(JSON.stringify({ version: 1, hooks: [entry] }))
}

/** A command entry bound to one observe event. */
function commandEntry(on: string, async?: boolean): Record<string, unknown> {
  return {
    id: 'observer',
    on,
    run: {
      type: 'command',
      command: 'node observer.mjs',
      ...async === undefined ? {} : { async },
    },
  }
}

describe('the observe-only event vocabulary', () => {
  it.each(['tool.result', 'session.end', 'notification'] as const)(
    'forces a %s command to run detached even without async: true',
    (on) => {
      const parsed = parseEntry(commandEntry(on))
      expect(parsed.warnings).toEqual([])
      expect(parsed.hooks).toHaveLength(1)
      expect(parsed.hooks[0]!.run).toMatchObject({ type: 'command', async: true })
    },
  )

  it.each(['tool.result', 'session.end', 'notification'] as const)(
    'leaves a %s command detached when it explicitly says async: false',
    (on) => {
      expect(parseEntry(commandEntry(on, false)).hooks[0]!.run).toMatchObject({ async: true })
    },
  )

  it.each(['tool.result', 'session.end', 'notification'] as const)(
    'skips a %s builtin action with a warning, because there is no decision to apply',
    (on) => {
      const parsed = parseEntry({
        id: 'observer',
        on,
        run: { type: 'builtin', action: 'context', text: 'not observed' },
      })
      expect(parsed.hooks).toEqual([])
      expect(parsed.warnings).toHaveLength(1)
      expect(parsed.warnings[0]).toContain(`on ${on}`)
      expect(parsed.warnings[0]).toContain('observe')
    },
  )

  it('accepts a tool match on tool.result and rejects one on session.end', () => {
    const matched = parseEntry({
      id: 'observer',
      on: 'tool.result',
      match: { tool: 'bash' },
      run: { type: 'command', command: 'node observer.mjs' },
    })
    expect(matched.warnings).toEqual([])
    expect(matched.hooks[0]!.match).toMatchObject({ tool: { kind: 'exact', name: 'bash' } })

    const rejected = parseEntry({
      id: 'observer',
      on: 'session.end',
      match: { tool: 'bash' },
      run: { type: 'command', command: 'node observer.mjs' },
    })
    expect(rejected.hooks).toEqual([])
    expect(rejected.warnings[0]).toContain('"match" is not supported on session.end')
  })

  it('rejects a match clause on notification, which selects nothing', () => {
    const parsed = parseEntry({
      id: 'observer',
      on: 'notification',
      match: { tool: 'bash' },
      run: { type: 'command', command: 'node observer.mjs' },
    })
    expect(parsed.hooks).toEqual([])
    expect(parsed.warnings[0]).toContain('"match" is not supported on notification')
  })
})

describe('the notification payload', () => {
  it('names the tool when an approval has no reason of its own', () => {
    expect(approvalNotification({ toolName: 'bash' })).toEqual({
      type: 'approval',
      message: 'approval requested for tool "bash"',
      tool_name: 'bash',
    })
  })

  it('uses the asker reason as the message when one is given', () => {
    expect(approvalNotification({ toolName: 'bash', reason: 'needs a human' })).toEqual({
      type: 'approval',
      message: 'needs a human',
      tool_name: 'bash',
    })
  })

  it('keeps the error text and carries no tool name', () => {
    expect(errorNotification(new Error('provider exploded'))).toEqual({
      type: 'error',
      message: 'provider exploded',
    })
    expect(errorNotification('plain failure')).toEqual({
      type: 'error',
      message: 'plain failure',
    })
  })
})
