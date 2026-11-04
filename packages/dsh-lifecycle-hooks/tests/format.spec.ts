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
import { Config } from '../src/config.ts'
import type { HookDecision } from '../src/hook.ts'
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
import { allowedDecisions, mergeDecisions } from '../src/outcome.ts'

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
    expect(parsed.hooks[0]?.run).toMatchObject({ reason: 'nope' })
  })

  it('accepts the tool.post builtin outcomes and keeps their text', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [
        { id: 'redact', on: 'tool.post', run: { type: 'builtin', action: 'replace', text: 'REDACTED' } },
        { id: 'block', on: 'tool.post', run: { type: 'builtin', action: 'block', reason: 'do not read that' } },
        { id: 'note', on: 'tool.post', run: { type: 'builtin', action: 'inject', text: 'the file is generated' } },
        { id: 'quiet', on: 'tool.post', run: { type: 'builtin', action: 'block' } },
      ],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks.map(hook => hook.run)).toEqual([
      { type: 'builtin', action: 'replace', text: 'REDACTED' },
      { type: 'builtin', action: 'block', reason: 'do not read that' },
      { type: 'builtin', action: 'inject', text: 'the file is generated' },
      { type: 'builtin', action: 'block', reason: 'blocked by a lifecycle hook' },
    ])
    expect(parsed.hooks.map(hook => hook.on)).toEqual(['tool.post', 'tool.post', 'tool.post', 'tool.post'])
  })

  it.each([
    [
      'a tool.post denial',
      { id: 'a', on: 'tool.post', run: { type: 'builtin', action: 'deny', reason: 'no' } },
      'not supported by this build',
    ],
    [
      'a tool.post replace with no text',
      { id: 'a', on: 'tool.post', run: { type: 'builtin', action: 'replace' } },
      '"run.text"',
    ],
    [
      'a tool.post inject with no text',
      { id: 'a', on: 'tool.post', run: { type: 'builtin', action: 'inject' } },
      '"run.text"',
    ],
    [
      'a tool.post replace with an empty text',
      { id: 'a', on: 'tool.post', run: { type: 'builtin', action: 'replace', text: '  ' } },
      '"run.text"',
    ],
    [
      'a tool.pre replace',
      { id: 'a', on: 'tool.pre', run: { type: 'builtin', action: 'replace', text: 'x' } },
      'not supported by this build',
    ],
  ])('skips %s', (_label, entry, expected) => {
    const parsed = hooksOf(JSON.stringify({ version: 1, hooks: [entry] }))
    expect(parsed.hooks).toEqual([])
    expect(parsed.warnings[0]).toContain(expected)
  })

  it('accepts the tool.pre builtin ask and defaults its reason', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [
        { id: 'confirm', on: 'tool.pre', run: { type: 'builtin', action: 'ask', reason: 'this write is dangerous' } },
        { id: 'quiet', on: 'tool.pre', run: { type: 'builtin', action: 'ask' } },
        { id: 'elsewhere', on: 'step.start', run: { type: 'builtin', action: 'ask', reason: 'not here' } },
      ],
    }))
    expect(parsed.hooks.map(hook => hook.run)).toEqual([
      { type: 'builtin', action: 'ask', reason: 'this write is dangerous' },
      { type: 'builtin', action: 'ask', reason: 'a lifecycle hook asked for confirmation' },
    ])
    expect(parsed.hooks.map(hook => hook.on)).toEqual(['tool.pre', 'tool.pre'])
    // `ask` is legal only where a confirmation stop exists: every other event
    // drops the entry at load time instead of letting it look configured.
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain('ask')
    expect(parsed.warnings[0]).toContain('step.start')
  })

  it('accepts builtin context, inject, and halt where the event applies them', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [
        { id: 'pre-note', on: 'tool.pre', run: { type: 'builtin', action: 'inject', text: 'pre note' } },
        { id: 'pre-context', on: 'tool.pre', run: { type: 'builtin', action: 'context', text: 'pre context' } },
        { id: 'pre-halt', on: 'tool.pre', run: { type: 'builtin', action: 'halt' } },
        { id: 'post-context', on: 'tool.post', run: { type: 'builtin', action: 'context', text: 'post context' } },
        {
          id: 'post-halt',
          on: 'tool.post',
          run: { type: 'builtin', action: 'halt', reason: 'stop after this result' },
        },
        { id: 'start-inject', on: 'session.start', run: { type: 'builtin', action: 'inject', text: 'start note' } },
        { id: 'step-inject', on: 'step.start', run: { type: 'builtin', action: 'inject', text: 'step note' } },
      ],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks.map(hook => [hook.on, hook.run])).toEqual([
      ['tool.pre', { type: 'builtin', action: 'inject', text: 'pre note' }],
      ['tool.pre', { type: 'builtin', action: 'context', text: 'pre context' }],
      ['tool.pre', { type: 'builtin', action: 'halt', reason: 'halted by a lifecycle hook' }],
      ['tool.post', { type: 'builtin', action: 'context', text: 'post context' }],
      ['tool.post', { type: 'builtin', action: 'halt', reason: 'stop after this result' }],
      ['session.start', { type: 'builtin', action: 'inject', text: 'start note' }],
      ['step.start', { type: 'builtin', action: 'inject', text: 'step note' }],
    ])
  })

  it.each([
    [
      'context at turn.stop',
      { id: 'a', on: 'turn.stop', run: { type: 'builtin', action: 'context', text: 'no' } },
      'not supported by this build on turn.stop',
    ],
    [
      'inject at turn.stop',
      { id: 'a', on: 'turn.stop', run: { type: 'builtin', action: 'inject', text: 'no' } },
      'not supported by this build on turn.stop',
    ],
    [
      'halt at session.start',
      { id: 'a', on: 'session.start', run: { type: 'builtin', action: 'halt' } },
      'not supported by this build on session.start',
    ],
    [
      'ask at tool.post',
      { id: 'a', on: 'tool.post', run: { type: 'builtin', action: 'ask' } },
      'not supported by this build on tool.post',
    ],
    [
      'context at notification',
      { id: 'a', on: 'notification', run: { type: 'builtin', action: 'context', text: 'no' } },
      'only observes',
    ],
    [
      'inject at tool.result',
      { id: 'a', on: 'tool.result', run: { type: 'builtin', action: 'inject', text: 'no' } },
      'only observes',
    ],
  ])('skips builtin %s', (_label, entry, expected) => {
    const parsed = hooksOf(JSON.stringify({ version: 1, hooks: [entry] }))
    expect(parsed.hooks).toEqual([])
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain(expected)
  })

  it('accepts a command handler on tool.post', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'redact',
        on: 'tool.post',
        match: { tool: 'bash' },
        run: { type: 'command', command: 'node .dsh/hooks/redact.mjs' },
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]).toMatchObject({ id: 'redact', on: 'tool.post', run: { type: 'command' } })
  })

  it('accepts a command handler on tool.pre', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'gate',
        on: 'tool.pre',
        match: { tool: 'bash' },
        run: { type: 'command', command: 'node .dsh/hooks/gate.mjs' },
        timeoutMs: 250,
        onFailure: 'block',
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]).toEqual({
      id: 'gate',
      on: 'tool.pre',
      match: { tool: { kind: 'exact', name: 'bash' }, args: undefined },
      run: { type: 'command', command: 'node .dsh/hooks/gate.mjs', async: false },
      timeoutMs: 250,
      onFailure: 'block',
    })
  })

  it('accepts a detached command handler', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'notify',
        on: 'tool.pre',
        run: { type: 'command', command: 'echo noted', async: true },
      }],
    }))
    expect(parsed.hooks[0]?.run).toEqual({ type: 'command', command: 'echo noted', async: true })
  })

  it('accepts a module handler and keeps its path relative to the hooks file', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'format',
        on: 'tool.post',
        match: { tool: 'write|edit' },
        run: { type: 'module', path: '.dsh/hooks/format.mjs' },
        timeoutMs: 60_000,
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]).toEqual({
      id: 'format',
      on: 'tool.post',
      match: { tool: { kind: 'alternatives', names: ['write', 'edit'] }, args: undefined },
      run: { type: 'module', path: '.dsh/hooks/format.mjs', async: false },
      timeoutMs: 60_000,
      onFailure: 'open',
    })
  })

  it('accepts a detached module handler', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'notify',
        on: 'tool.post',
        run: { type: 'module', path: '.dsh/hooks/notify.js', async: true },
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]?.run).toEqual({ type: 'module', path: '.dsh/hooks/notify.js', async: true })
  })

  it('forces a module handler on an observe-only event detached', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'audit',
        on: 'tool.result',
        run: { type: 'module', path: '.dsh/hooks/audit.mjs' },
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]?.run).toEqual({ type: 'module', path: '.dsh/hooks/audit.mjs', async: true })
  })

  it('accepts a builtin continue on turn.stop', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'keep-going',
        on: 'turn.stop',
        run: { type: 'builtin', action: 'continue', reason: 'the tests are still red' },
      }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks).toEqual([{
      id: 'keep-going',
      on: 'turn.stop',
      match: undefined,
      run: { type: 'builtin', action: 'continue', reason: 'the tests are still red' },
      timeoutMs: DEFAULTS,
      onFailure: 'open',
    }])
  })

  it('accepts a turn.stop continue that carries no reason', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{ id: 'quiet', on: 'turn.stop', run: { type: 'builtin', action: 'continue' } }],
    }))
    expect(parsed.warnings).toEqual([])
    expect(parsed.hooks[0]?.run).toEqual({ type: 'builtin', action: 'continue' })
  })

  it('skips a turn.stop entry that carries a match clause', () => {
    const parsed = hooksOf(JSON.stringify({
      version: 1,
      hooks: [{
        id: 'matched',
        on: 'turn.stop',
        match: { tool: 'bash' },
        run: { type: 'builtin', action: 'continue' },
      }],
    }))
    expect(parsed.hooks).toEqual([])
    expect(parsed.warnings).toHaveLength(1)
    expect(parsed.warnings[0]).toContain('matched')
    expect(parsed.warnings[0]).toContain('turn.stop')
    expect(parsed.warnings[0]).toContain('match')
  })

  it.each([
    ['a non-object entry', 7, 'not an object'],
    ['an empty id', { id: '', on: 'tool.pre', run: { type: 'builtin', action: 'deny' } }, '"id"'],
    ['a non-string event', { id: 'a', on: 1, run: { type: 'builtin', action: 'deny' } }, '"on"'],
    ['an unknown event', { id: 'a', on: 'nope', run: { type: 'builtin', action: 'deny' } }, 'unknown event'],
    [
      'an event a later ticket owns',
      { id: 'a', on: 'session.start', run: { type: 'builtin', action: 'deny' } },
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
      'a module with no path',
      { id: 'a', on: 'tool.pre', run: { type: 'module' } },
      '"run.path"',
    ],
    [
      'a module with an empty path',
      { id: 'a', on: 'tool.pre', run: { type: 'module', path: '  ' } },
      '"run.path"',
    ],
    [
      'a TypeScript module',
      { id: 'a', on: 'tool.pre', run: { type: 'module', path: '.dsh/hooks/gate.ts' } },
      '.mjs or .js',
    ],
    [
      'a module with an unknown extension',
      { id: 'a', on: 'tool.pre', run: { type: 'module', path: '.dsh/hooks/gate.wasm' } },
      '.mjs or .js',
    ],
    [
      'a non-boolean module async flag',
      { id: 'a', on: 'tool.pre', run: { type: 'module', path: '.dsh/hooks/gate.mjs', async: 'yes' } },
      '"run.async"',
    ],
    [
      'a command with no command string',
      { id: 'a', on: 'tool.pre', run: { type: 'command' } },
      '"run.command"',
    ],
    [
      'a command with an empty command string',
      { id: 'a', on: 'tool.pre', run: { type: 'command', command: '   ' } },
      '"run.command"',
    ],
    [
      'a non-boolean async flag',
      { id: 'a', on: 'tool.pre', run: { type: 'command', command: 'true', async: 'yes' } },
      '"run.async"',
    ],
    [
      'an unknown handler type',
      { id: 'a', on: 'tool.pre', run: { type: 'wat' } },
      'unknown handler type',
    ],
    [
      'an ask outside tool.pre',
      { id: 'a', on: 'step.start', run: { type: 'builtin', action: 'ask' } },
      'not supported by this build on step.start',
    ],
    [
      'a builtin continue on tool.pre',
      { id: 'a', on: 'tool.pre', run: { type: 'builtin', action: 'continue' } },
      'not supported by this build on tool.pre',
    ],
    [
      'a builtin deny on turn.stop',
      { id: 'a', on: 'turn.stop', run: { type: 'builtin', action: 'deny' } },
      'not supported by this build on turn.stop',
    ],
    [
      'a builtin halt on turn.stop',
      { id: 'a', on: 'turn.stop', run: { type: 'builtin', action: 'halt' } },
      'not supported by this build on turn.stop',
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

describe('the row configuration', () => {
  it('caps consecutive stop continues at 8 by default', () => {
    // Schemastery normalizes a partial row to the Config the plugin receives.
    expect(Config({} as Config).maxStopContinues).toBe(8)
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
  const run = (id: string, decision?: HookDecision, error?: string): HookRun => ({
    hook: {
      id,
      on: 'tool.pre',
      match: undefined,
      run: { type: 'builtin', action: 'deny', reason: 'because' },
      timeoutMs: DEFAULTS,
      onFailure: 'open',
    },
    source: '/repo/.dsh/hooks.json',
    event: 'tool.pre',
    handler: 'builtin',
    decision,
    error,
    durationMs: 1,
    exitCode: undefined,
  })

  it('is undefined when no run decided anything', () => {
    expect(mergeDecisions([])).toBeUndefined()
    expect(mergeDecisions([run('observer')])).toBeUndefined()
    expect(mergeDecisions([run('empty-context', { context: [] })])).toBeUndefined()
  })

  it('takes the first denial in configuration order', () => {
    expect(mergeDecisions([
      run('first', { action: 'deny', reason: 'one' }),
      run('second', { action: 'deny', reason: 'two' }),
    ])).toEqual({ action: 'deny', reason: 'one', context: [] })
  })

  it('fills a missing denial reason', () => {
    expect(mergeDecisions([run('quiet', { action: 'deny' })]))
      .toEqual({ action: 'deny', reason: 'denied by a lifecycle hook', context: [] })
  })

  it('lets a later halt outrank an earlier denial', () => {
    expect(mergeDecisions([
      run('deny', { action: 'deny', reason: 'nope' }),
      run('halt', { action: 'halt', reason: 'stop the turn' }),
    ])).toEqual({ action: 'halt', reason: 'stop the turn', context: [] })
  })

  it('keeps a halt ahead of a later denial', () => {
    // Only a halt stops later handlers, but the merge ranking must not depend
    // on that: halt wins wherever it appears.
    expect(mergeDecisions([
      run('halt', { action: 'halt', reason: 'stop' }),
      run('deny', { action: 'deny', reason: 'nope' }),
    ])).toEqual({ action: 'halt', reason: 'stop', context: [] })
  })

  it('concatenates every context in configuration order', () => {
    expect(mergeDecisions([
      run('one', { action: 'deny', reason: 'no', context: ['first', 'second'] }),
      run('two', { context: ['third'] }),
      run('three', { action: 'deny', reason: 'later', context: ['fourth'] }),
    ])).toEqual({ action: 'deny', reason: 'no', context: ['first', 'second', 'third', 'fourth'] })
  })

  it('keeps the last meta in configuration order', () => {
    expect(mergeDecisions([
      run('one', { action: 'deny', reason: 'no', meta: { rule: 'no-rm' } }),
      run('two', { context: ['a note'], meta: { rule: 'no-rm', severity: 2 } }),
    ])).toEqual({
      action: 'deny',
      reason: 'no',
      context: ['a note'],
      meta: { rule: 'no-rm', severity: 2 },
    })
  })

  it('returns a meta-only outcome when nothing else decided', () => {
    expect(mergeDecisions([run('meta', { meta: { took: 3 } })]))
      .toEqual({ context: [], meta: { took: 3 } })
  })

  it('returns context alone when no hook blocked the event', () => {
    expect(mergeDecisions([run('note', { context: ['just so you know'] })]))
      .toEqual({ context: ['just so you know'] })
  })

  it('ignores a failed run that contributed no decision', () => {
    const failed = run('broken', undefined, 'boom')
    expect(mergeDecisions([failed, run('later', { action: 'deny', reason: 'two' })]))
      .toEqual({ action: 'deny', reason: 'two', context: [] })
  })

  /** The same run helper, for a `tool.post` entry. */
  const post = (id: string, decision?: HookDecision): HookRun => ({
    ...run(id, decision),
    event: 'tool.post',
  })

  it('lets a block outrank a replace and keeps every context', () => {
    expect(mergeDecisions([
      post('redact', { action: 'replace', replace: { text: 'clean' }, context: ['first'] }),
      post('block', { action: 'block', reason: 'do not read this', context: ['second'] }),
    ])).toEqual({
      action: 'block',
      reason: 'do not read this',
      context: ['first', 'second'],
    })
  })

  it('takes the last replace in configuration order', () => {
    expect(mergeDecisions([
      post('first', { action: 'replace', replace: { text: 'first text' } }),
      post('second', { action: 'replace', replace: { text: 'second text' } }),
    ])).toEqual({
      action: 'replace',
      replace: { text: 'second text' },
      context: [],
    })
  })

  it('returns a replace alone when nothing blocked the event', () => {
    expect(mergeDecisions([post('redact', { action: 'replace', replace: { text: 'clean' } })]))
      .toEqual({ action: 'replace', replace: { text: 'clean' }, context: [] })
  })

  it('fills a missing block reason', () => {
    expect(mergeDecisions([post('quiet', { action: 'block' })]))
      .toEqual({ action: 'block', reason: 'blocked by a lifecycle hook', context: [] })
  })

  it('keeps a synthesized blocking decision that accompanies a failure', () => {
    // `onFailure: "block"` records the failure and a denial in the same run;
    // the merge must honour the denial instead of discarding the whole run.
    const blocked = run('broken', { action: 'deny', reason: 'hook "broken" failed: boom' }, 'boom')
    expect(mergeDecisions([blocked]))
      .toEqual({ action: 'deny', reason: 'hook "broken" failed: boom', context: [] })
  })

  it('returns continue alone when no hook blocked the event', () => {
    expect(mergeDecisions([run('keep', { action: 'continue', reason: 'fix the tests' })]))
      .toEqual({ action: 'continue', reason: 'fix the tests', context: [] })
  })

  it('still continues when the continue hook gave no reason', () => {
    expect(mergeDecisions([run('quiet', { action: 'continue' })]))
      .toEqual({ action: 'continue', context: [] })
  })

  it('joins every continue reason in configuration order', () => {
    expect(mergeDecisions([
      run('one', { action: 'continue', reason: 'first reason' }),
      run('two', { action: 'continue', reason: '  ', context: ['second context'] }),
      run('three', { action: 'continue', reason: 'third reason' }),
    ])).toEqual({
      action: 'continue',
      reason: 'first reason\nthird reason',
      context: ['second context'],
    })
  })

  it('asks when no blocking action outranks the ask', () => {
    expect(mergeDecisions([run('confirm', { action: 'ask', reason: 'write to .env?', context: ['one'] })]))
      .toEqual({ action: 'ask', reason: 'write to .env?', context: ['one'] })
  })

  it('fills a missing ask reason', () => {
    expect(mergeDecisions([run('quiet', { action: 'ask' })]))
      .toEqual({ action: 'ask', reason: 'a lifecycle hook asked for confirmation', context: [] })
  })

  it('carries the winning ask’s display copy', () => {
    expect(mergeDecisions([run('confirm', {
      action: 'ask',
      reason: 'write to .env?',
      displayReason: { en: 'Allow writing to .env?', zh: '允许写入 .env 吗？' },
    })])).toEqual({
      action: 'ask',
      reason: 'write to .env?',
      displayReason: { en: 'Allow writing to .env?', zh: '允许写入 .env 吗？' },
      context: [],
    })
  })

  it.each([
    ['an ask before a deny', ['ask', 'deny']],
    ['a deny before an ask', ['deny', 'ask']],
  ])('lets a deny outrank %s', (_label, order) => {
    const decisions: Record<string, HookDecision> = {
      ask: { action: 'ask', reason: 'may I?' },
      deny: { action: 'deny', reason: 'not allowed' },
    }
    expect(mergeDecisions(order.map((action, index) => run(String(index), decisions[action]))))
      .toEqual({ action: 'deny', reason: 'not allowed', context: [] })
  })

  it('lets an ask outrank a continue', () => {
    expect(mergeDecisions([
      run('keep', { action: 'continue', reason: 'go on' }),
      run('confirm', { action: 'ask', reason: 'may I?' }),
    ])).toEqual({ action: 'ask', reason: 'may I?', context: [] })
  })

  it('lets a blocking action outrank a continue', () => {
    expect(mergeDecisions([
      run('keep', { action: 'continue', reason: 'go on' }),
      run('deny', { action: 'deny', reason: 'no' }),
    ])).toEqual({ action: 'deny', reason: 'no', context: [] })
  })
})

describe('filtering actions an event does not support', () => {
  const run = (id: string, decision: HookDecision): HookRun => ({
    hook: {
      id,
      on: 'tool.pre',
      match: undefined,
      run: { type: 'command', command: 'true', async: false },
      timeoutMs: DEFAULTS,
      onFailure: 'open',
    },
    source: '/repo/.dsh/hooks.json',
    event: 'tool.pre',
    handler: 'command',
    decision,
    error: undefined,
    durationMs: 1,
    exitCode: 0,
  })

  it('drops an unsupported action, warns about it, and keeps the hook’s context', () => {
    const warnings: string[] = []
    const filtered = allowedDecisions(
      [run('asker', { action: 'ask', reason: 'may I?', context: ['one'] })],
      ['deny', 'context', 'halt'],
      message => warnings.push(message),
    )
    expect(filtered[0]?.decision).toEqual({ context: ['one'] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('asker')
    expect(warnings[0]).toContain('"ask"')
    expect(warnings[0]).toContain('tool.pre')
  })

  it('passes a supported action through untouched', () => {
    const warnings: string[] = []
    const decision = { action: 'deny', reason: 'no' } as const
    expect(allowedDecisions([run('gate', decision)], ['deny'], message => warnings.push(message))[0]?.decision)
      .toEqual(decision)
    expect(warnings).toEqual([])
  })

  it('drops the replacement with an unsupported replace action', () => {
    const warnings: string[] = []
    const filtered = allowedDecisions(
      [run('redactor', { action: 'replace', replace: { text: 'clean' }, context: ['kept'] })],
      ['deny', 'context', 'halt'],
      message => warnings.push(message),
    )
    expect(filtered[0]?.decision).toEqual({ context: ['kept'] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"replace"')
  })
})
