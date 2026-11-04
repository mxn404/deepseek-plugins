/**
 * Contract spec for the `session.start` and `step.start` vocabulary.
 *
 * These are the pure parts of the two events later tickets build on: the
 * per-event `match` dimensions, the builtin actions each event accepts, the
 * prompt a claimed batch carries, and the blocking outcome a failed run
 * synthesizes. They are table-tested without a host; what the model actually
 * receives is covered by `session-step.integration.spec.ts`.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { parseHooks } from '../src/hooks-file.ts'
import { failureOutcome } from '../src/outcome.ts'
import { promptOf } from '../src/step-start.ts'

const DEFAULTS = 30_000

/** Expand a successful parse, failing the test with the file-level error otherwise. */
function hooksOf(text: string, defaultTimeoutMs = DEFAULTS) {
  const parsed = parseHooks(text, defaultTimeoutMs)
  if (!parsed.ok) throw new Error(`expected a parsed file, got: ${parsed.error}`)
  return parsed
}

/** Parse a one-entry file and return its warnings (the entry is expected to be skipped). */
function warningsOf(entry: Record<string, unknown>): string[] {
  const parsed = hooksOf(JSON.stringify({ version: 1, hooks: [entry] }))
  return [...parsed.warnings]
}

describe('the prompt of a claimed batch', () => {
  it('is null when the batch is empty', () => {
    expect(promptOf([])).toBeNull()
  })

  it('concatenates the text blocks of user messages', () => {
    expect(promptOf([
      createUserMessage({
        content: [{ type: 'text', text: 'first line' }],
        source: { kind: 'user' },
      }),
      createUserMessage({
        content: [
          { type: 'text', text: 'second line' },
          { type: 'text', text: 'third line' },
        ],
        source: { kind: 'user' },
      }),
    ])).toBe('first line\nsecond line\nthird line')
  })

  it('ignores messages a producer other than the user contributed', () => {
    expect(promptOf([
      createUserMessage({
        content: [{ type: 'text', text: 'tool output' }],
        source: { kind: 'dsh-lifecycle-hooks' },
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'the actual prompt' }],
        source: { kind: 'user' },
      }),
    ])).toBe('the actual prompt')
  })

  it('is null when only non-user sources contributed', () => {
    expect(promptOf([
      createUserMessage({
        content: [{ type: 'text', text: 'tool output' }],
        source: { kind: 'dsh-lifecycle-hooks' },
      }),
    ])).toBeNull()
  })

  it('is null when the user messages carry no text', () => {
    expect(promptOf([
      createUserMessage({ content: [], source: { kind: 'user' } }),
    ])).toBeNull()
    expect(promptOf([
      createUserMessage({
        content: [{ type: 'text', text: '   ' }],
        source: { kind: 'user' },
      }),
    ])).toBeNull()
  })
})

describe('the step.start match vocabulary', () => {
  it('accepts a prompt clause on step.start', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'submit-only',
        on: 'step.start',
        match: { prompt: true },
        run: { type: 'builtin', action: 'context', text: 'a prompt arrived' },
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]?.match).toEqual({ tool: undefined, args: undefined, prompt: true })
    expect(parsed.hooks[0]?.run).toEqual({ type: 'builtin', action: 'context', text: 'a prompt arrived' })
  })

  it('accepts a false prompt clause and a missing match clause', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [
        { id: 'continuation', on: 'step.start', match: { prompt: false }, run: { type: 'builtin', action: 'halt' } },
        { id: 'every-step', on: 'step.start', run: { type: 'builtin', action: 'context', text: 'always' } },
      ],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]?.match?.prompt).toBe(false)
    expect(parsed.hooks[1]?.match).toBeUndefined()
  })

  it.each([
    [
      'a non-boolean prompt clause',
      { id: 'a', on: 'step.start', match: { prompt: 'yes' }, run: { type: 'builtin', action: 'context', text: 'x' } },
      '"match.prompt"',
    ],
    [
      'a tool dimension on step.start',
      { id: 'a', on: 'step.start', match: { tool: 'bash' }, run: { type: 'builtin', action: 'context', text: 'x' } },
      '"match.tool"',
    ],
    [
      'an args dimension on step.start',
      { id: 'a', on: 'step.start', match: { args: { command: 'ls' } }, run: { type: 'builtin', action: 'context', text: 'x' } },
      '"match.args"',
    ],
  ])('skips an entry with %s', (_label, entry, expected) => {
    const warnings = warningsOf(entry)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(expected)
    expect(warnings[0]).toContain('step.start')
  })

  it('rejects a prompt clause on tool.pre at load time', () => {
    const warnings = warningsOf({
      id: 'a',
      on: 'tool.pre',
      match: { prompt: true },
      run: { type: 'builtin', action: 'deny' },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"match.prompt"')
    expect(warnings[0]).toContain('step.start')
  })
})

describe('the session.start vocabulary', () => {
  it('accepts a context action and no match clause', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'project-notes',
        on: 'session.start',
        run: { type: 'builtin', action: 'context', text: 'read CONTRIBUTING.md first' },
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]).toEqual({
      id: 'project-notes',
      on: 'session.start',
      match: undefined,
      run: { type: 'builtin', action: 'context', text: 'read CONTRIBUTING.md first' },
      timeoutMs: DEFAULTS,
      onFailure: 'open',
    })
  })

  it.each([
    [
      'any match clause',
      { id: 'a', on: 'session.start', match: { prompt: true }, run: { type: 'builtin', action: 'context', text: 'x' } },
      '"match"',
    ],
    [
      'an empty match clause',
      { id: 'a', on: 'session.start', match: {}, run: { type: 'builtin', action: 'context', text: 'x' } },
      '"match"',
    ],
    [
      'a deny action',
      { id: 'a', on: 'session.start', run: { type: 'builtin', action: 'deny' } },
      'not supported by this build',
    ],
    [
      'a halt action',
      { id: 'a', on: 'session.start', run: { type: 'builtin', action: 'halt' } },
      'not supported by this build',
    ],
  ])('skips an entry with %s', (_label, entry, expected) => {
    const warnings = warningsOf(entry)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(expected)
  })
})

describe('the builtin action vocabulary', () => {
  it.each([
    ['deny', { type: 'builtin', action: 'deny', reason: 'no' }, 'deny'],
    ['halt', { type: 'builtin', action: 'halt', reason: 'stop' }, 'halt'],
  ])('accepts a %s action on step.start', (_label, run, action) => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{ id: 'a', on: 'step.start', run }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]?.run).toMatchObject({ action })
  })

  it('requires text for a context action', () => {
    const warnings = warningsOf({
      id: 'a',
      on: 'step.start',
      run: { type: 'builtin', action: 'context' },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"run.text"')
  })

  it('rejects an action the event does not support', () => {
    const warnings = warningsOf({
      id: 'a',
      on: 'step.start',
      run: { type: 'builtin', action: 'ask' },
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not supported by this build')
  })
})

describe('failure policy', () => {
  it('synthesizes a denial for a failed step.start hook', () => {
    expect(failureOutcome('step.start', 'gate', 'boom')).toEqual({
      action: 'deny',
      reason: 'hook "gate" failed: boom',
    })
  })

  it('has no blocking outcome for session.start', () => {
    expect(failureOutcome('session.start', 'notes', 'boom')).toBeUndefined()
  })

  it('still denies tool.pre', () => {
    expect(failureOutcome('tool.pre', 'gate', 'boom')).toEqual({
      action: 'deny',
      reason: 'hook "gate" failed: boom',
    })
  })
})
