/**
 * Contract spec for the `.dsh/hooks.json` format.
 *
 * These are the parts of the plugin that users write and that later tickets
 * build on: the file schema (version, hooks array, per-entry fields), the
 * `match` vocabulary, and the outcome merge. They are pure functions, so the
 * format is pinned without mounting a host; everything a user observes through
 * a Session is covered by `hooks.integration.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import type { HookRun } from '../src/handler.ts'
import { parseHooks } from '../src/hooks-file.ts'
import {
  compileToolPattern,
  invalidArgPattern,
  matchesArgs,
  matchesHook,
  matchesToolName,
  type ToolPattern,
} from '../src/match.ts'
import { mergeDecisions } from '../src/outcome.ts'

const DEFAULTS = 30_000

/** Expand a successful parse, failing the test with the file-level error otherwise. */
function hooksOf(text: string, defaultTimeoutMs = DEFAULTS) {
  const parsed = parseHooks(text, defaultTimeoutMs)
  if (!parsed.ok) throw new Error(`expected a parsed file, got: ${parsed.error}`)
  return parsed
}

describe('the hooks file schema', () => {
  it('accepts an empty hooks array', () => {
    const parsed = hooksOf(JSON.stringify({ version: 1, hooks: [] }))
    expect(parsed.hooks).toEqual([])
    expect(parsed.warnings).toEqual([])
  })

  it('rejects text that is not JSON, naming the problem', () => {
    const parsed = parseHooks('{ "version": 1, "hooks": [', DEFAULTS)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('not valid JSON')
  })

  it.each([
    ['a non-object document', JSON.stringify([]), 'must be a JSON object'],
    ['a missing version', JSON.stringify({ hooks: [] }), 'has no version'],
    ['an unknown version', JSON.stringify({ version: 2, hooks: [] }), 'understands 1'],
    ['a non-array hooks field', JSON.stringify({ version: 1, hooks: {} }), 'must be an array'],
  ])('rejects %s', (_label, text, expected) => {
    const parsed = parseHooks(text, DEFAULTS)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain(expected)
  })

  it('defaults every optional entry field and ignores unknown ones', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      extra: true,
      hooks: [{
        id: 'a',
        on: 'tool.pre',
        note: 'not part of the format',
        run: { type: 'builtin', action: 'deny' },
      }],
    }))
    expect(parsed.hooks).toEqual([{
      id: 'a',
      on: 'tool.pre',
      match: undefined,
      run: { type: 'builtin', action: 'deny', reason: 'denied by a lifecycle hook' },
      timeoutMs: DEFAULTS,
      onFailure: 'open',
    }])
    expect(parsed.warnings).toEqual([])
  })

  it('keeps an explicit reason, timeout, and failure policy', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'a',
        on: 'tool.pre',
        run: { type: 'builtin', action: 'deny', reason: 'nope' },
        timeoutMs: 1500,
        onFailure: 'block',
      }],
    }), 30_000)
    expect(parsed.hooks[0]).toMatchObject({ timeoutMs: 1500, onFailure: 'block' })
    expect(parsed.hooks[0]?.run.reason).toBe('nope')
  })

  it.each([
    ['a non-object entry', 7, 'not an object'],
    ['an empty id', { id: '', on: 'tool.pre', run: { type: 'builtin', action: 'deny' } }, '"id"'],
    ['a non-string event', { id: 'a', on: 1, run: { type: 'builtin', action: 'deny' } }, '"on"'],
    ['an unknown event', { id: 'a', on: 'nope', run: { type: 'builtin', action: 'deny' } }, 'unknown event'],
    [
      'an event a later ticket owns',
      { id: 'a', on: 'tool.post', run: { type: 'builtin', action: 'deny' } },
      'not supported by this build',
    ],
    [
      'a non-object match',
      { id: 'a', on: 'tool.pre', match: 'bash', run: { type: 'builtin', action: 'deny' } },
      '"match"',
    ],
    [
      'an invalid tool regex',
      { id: 'a', on: 'tool.pre', match: { tool: '/[/' }, run: { type: 'builtin', action: 'deny' } },
      'not a valid regular expression',
    ],
    [
      'an invalid argument regex',
      { id: 'a', on: 'tool.pre', match: { tool: 'bash', args: { command: '/[/' } }, run: { type: 'builtin', action: 'deny' } },
      'invalid regular expression',
    ],
    ['a missing run', { id: 'a', on: 'tool.pre' }, '"run"'],
    [
      'a command handler',
      { id: 'a', on: 'tool.pre', run: { type: 'command', command: 'true' } },
      'not supported by this build',
    ],
    [
      'an unknown handler type',
      { id: 'a', on: 'tool.pre', run: { type: 'wat' } },
      'unknown handler type',
    ],
    [
      'an action a later ticket owns',
      { id: 'a', on: 'tool.pre', run: { type: 'builtin', action: 'ask' } },
      'not supported by this build',
    ],
    [
      'an unknown action',
      { id: 'a', on: 'tool.pre', run: { type: 'builtin', action: 'wat' } },
      'unknown action',
    ],
    [
      'a non-positive timeout',
      { id: 'a', on: 'tool.pre', run: { type: 'builtin', action: 'deny' }, timeoutMs: 0 },
      '"timeoutMs"',
    ],
    [
      'an unknown failure policy',
      { id: 'a', on: 'tool.pre', run: { type: 'builtin', action: 'deny' }, onFailure: 'explode' },
      '"onFailure"',
    ],
  ])('skips an entry with %s', (_label, entry, expected) => {
    const parsed = hooksOf(JSON.stringify({ version: 1, hooks: [entry] }))
    expect(parsed.hooks).toEqual([])
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain(expected)
  })

  it('keeps valid siblings in file order around a skipped entry', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [
        { id: 'first', on: 'tool.pre', run: { type: 'builtin', action: 'deny', reason: 'one' } },
        { id: '', on: 'tool.pre', run: { type: 'builtin', action: 'deny' } },
        { id: 'last', on: 'tool.pre', run: { type: 'builtin', action: 'deny', reason: 'two' } },
      ],
    }))
    expect(parsed.hooks.map(hook => hook.id)).toEqual(['first', 'last'])
    expect(parsed.warnings).toHaveLength(1)
  })
})

describe('the match vocabulary', () => {
  it.each([
    ['an exact name', 'bash', 'bash', true],
    ['an exact name, other tool', 'bash', 'read', false],
    ['an either-or set, first', 'write|edit', 'write', true],
    ['an either-or set, second', 'write|edit', 'edit', true],
    ['an either-or set, other tool', 'write|edit', 'read', false],
    ['a regex, match', '/^(write|edit)$/', 'write', true],
    ['a regex, partial is enough', '/write/', 'write_file', true],
    ['a regex, miss', '/^(write|edit)$/', 'read', false],
  ])('tool pattern %s', (_label, pattern, toolName, expected) => {
    const compiled = compileToolPattern(pattern)
    expect(compiled).toBeDefined()
    expect(matchesToolName(compiled!, toolName)).toBe(expected)
  })

  it('rejects an invalid tool regex at compile time', () => {
    expect(compileToolPattern('/[/')).toBeUndefined()
  })

  it('treats a lone slash as an exact name', () => {
    expect(compileToolPattern('/')).toEqual({ kind: 'exact', name: '/' })
  })

  it.each([
    ['equal strings', { command: 'ls' }, { command: 'ls' }, true],
    ['different strings', { command: 'ls' }, { command: 'rm' }, false],
    ['a string leaf regex', { command: '/^rm /' }, { command: 'rm -rf /' }, true],
    ['a string leaf regex miss', { command: '/^rm /' }, { command: 'echo rm -rf' }, false],
    ['a regex against a non-string', { command: '/^rm /' }, { command: ['rm', '-rf'] }, false],
    ['an extra actual key', { command: 'ls' }, { command: 'ls', workdir: '/tmp' }, true],
    ['a missing expected key', { command: 'ls', workdir: '/tmp' }, { command: 'ls' }, false],
    ['a nested object subset', { a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }, true],
    ['a nested object miss', { a: { b: 1 } }, { a: { b: 2 } }, false],
    ['an array prefix', { a: [1, 2] }, { a: [1, 2, 3] }, true],
    ['a short array', { a: [1, 2] }, { a: [1] }, false],
    ['a non-object actual', { a: 1 }, 'not an object', false],
    ['a number leaf', { n: 2 }, { n: 2 }, true],
    ['a boolean leaf', { flag: true }, { flag: false }, false],
    ['a null leaf', { value: null }, { value: null }, true],
  ])('args match: %s', (_label, expected, actual, matches) => {
    expect(matchesArgs(expected, actual)).toBe(matches)
  })

  it('reports the first invalid argument regex', () => {
    expect(invalidArgPattern({ a: 'ok', b: '/[/' })).toBe('/[/')
    expect(invalidArgPattern({ a: ['/[/'] })).toBe('/[/')
    expect(invalidArgPattern({ a: '/fine/' })).toBeUndefined()
  })

  it('matches every call when the clause is omitted', () => {
    expect(matchesHook(undefined, 'bash', { command: 'rm -rf /' })).toBe(true)
  })

  it('requires both dimensions when both are present', () => {
    const match = {
      tool: compileToolPattern('bash'),
      args: { command: '/^rm /' },
    }
    expect(matchesHook(match, 'bash', { command: 'rm -rf /' })).toBe(true)
    expect(matchesHook(match, 'bash', { command: 'ls' })).toBe(false)
    expect(matchesHook(match, 'read', { command: 'rm -rf /' })).toBe(false)
  })
})

describe('merging one event’s decisions', () => {
  const run = (id: string, action: 'deny' | undefined, reason = 'because'): HookRun => ({
    hook: {
      id,
      on: 'tool.pre',
      match: undefined,
      run: { type: 'builtin', action: 'deny', reason },
      timeoutMs: DEFAULTS,
      onFailure: 'open',
    },
    source: '/repo/.dsh/hooks.json',
    event: 'tool.pre',
    handler: 'builtin',
    decision: action === undefined ? undefined : { action, reason },
    error: undefined,
    durationMs: 1,
  })

  it('is undefined when no run decided anything', () => {
    expect(mergeDecisions([])).toBeUndefined()
    expect(mergeDecisions([run('observer', undefined)])).toBeUndefined()
  })

  it('takes the first denial in configuration order', () => {
    expect(mergeDecisions([run('first', 'deny', 'one'), run('second', 'deny', 'two')]))
      .toEqual({ action: 'deny', reason: 'one' })
  })

  it('ignores runs that failed', () => {
    const failed: HookRun = { ...run('broken', undefined), error: 'boom' }
    expect(mergeDecisions([failed, run('later', 'deny', 'two')]))
      .toEqual({ action: 'deny', reason: 'two' })
  })
})
