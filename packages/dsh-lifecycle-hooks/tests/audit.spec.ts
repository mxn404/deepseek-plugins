/**
 * Contract spec for the audit trail: one Session plugin record per run, and
 * the file fallback for a deployment where the experimental record API cannot
 * take the write.
 *
 * The fallback is exercised by handing the writer a Session-shaped object the
 * record API rejects, which is the same failure a reader-less host would
 * produce; no module is mocked and no API is removed.
 */

import { pluginRecordOf, Session, SessionId } from '@deepseek-ai/dsh-session'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordHookRun } from '../src/audit.ts'
import type { HookRun } from '../src/handler.ts'

/** Record type every hook run writes. */
const RUN_RECORD = 'plugin:dsh-lifecycle-hooks/run'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-hooks-audit-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One measured run with an audit meta document. */
function run(overrides: Partial<HookRun> = {}): HookRun {
  return {
    hook: {
      id: 'gate',
      on: 'tool.pre',
      match: undefined,
      run: { type: 'builtin', action: 'deny', reason: 'because' },
      timeoutMs: 1_000,
      onFailure: 'open',
    },
    source: '/repo/.dsh/hooks.json',
    event: 'tool.pre',
    handler: 'builtin',
    decision: { action: 'deny', reason: 'because', meta: { rule: 'no-rm', severity: 2 } },
    error: undefined,
    durationMs: 3,
    exitCode: undefined,
    ...overrides,
  }
}

/** The fallback file's lines, parsed. */
async function fallbackLines(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, '.dsh', 'hooks-audit.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('writing a hook run to the Session log', () => {
  it('appends the record and never touches the fallback file', async () => {
    const session = Session.create(SessionId('audit-unit-ok'))
    const warnings: string[] = []

    recordHookRun(session, run(), { cwd: root, warn: message => warnings.push(message) })

    const events = session.snapshotEvents()
    expect(events).toHaveLength(1)
    const record = pluginRecordOf(events[0]!)
    expect(record?.type).toBe(RUN_RECORD)
    expect(record?.data).toMatchObject({
      event: 'tool.pre',
      source: '/repo/.dsh/hooks.json',
      hook_id: 'gate',
      handler: 'builtin',
      action: 'deny',
      duration_ms: 3,
      meta: { rule: 'no-rm', severity: 2 },
    })
    expect(warnings).toEqual([])
    await expect(access(join(root, '.dsh', 'hooks-audit.jsonl'))).rejects.toThrow()
  })
})

describe('falling back when the record API cannot take the write', () => {
  it('appends one JSON line with the same payload and warns once', async () => {
    // A bare object is not a Session: the record API's private append path
    // rejects it, exactly like an unavailable experimental API.
    const session = {} as unknown as Session
    const warnings: string[] = []

    recordHookRun(session, run(), { cwd: root, warn: message => warnings.push(message) })
    recordHookRun(session, run({ hook: { ...run().hook, id: 'later' } }), {
      cwd: root,
      warn: message => warnings.push(message),
    })

    const lines = await fallbackLines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      event: 'tool.pre',
      source: '/repo/.dsh/hooks.json',
      hook_id: 'gate',
      handler: 'builtin',
      action: 'deny',
      duration_ms: 3,
      meta: { rule: 'no-rm', severity: 2 },
    })
    expect(lines[1]!.hook_id).toBe('later')
    // One warning for the whole fallback, not one per run.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('hooks-audit.jsonl')
  })

  it('keeps the optional continued count and exit code in the fallback payload', async () => {
    const session = {} as unknown as Session
    const warnings: string[] = []

    recordHookRun(session, run({ handler: 'command', exitCode: 0, event: 'turn.stop' }), {
      cwd: root,
      continuedCount: 4,
      warn: message => warnings.push(message),
    })

    const [line] = await fallbackLines()
    expect(line).toMatchObject({ event: 'turn.stop', handler: 'command', exit_code: 0, continued_count: 4 })
  })
})
