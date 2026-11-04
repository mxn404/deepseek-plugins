/**
 * Integration spec for `dsh-lifecycle-hooks`.
 *
 * Every case mounts a real Context, the real agent loop, the real tools, and a
 * scripted mock model adapter in a temporary project with a `.dsh/hooks.json`.
 * Assertions only read what the model actually received, whether the tool
 * really ran, what the plugin logged, and which plugin records the Session
 * retained. No internal state is inspected.
 */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  requestText,
  textResponse,
  toolCallBatch,
  toolCallResponse,
} from './support/harness.ts'
import { createHooksFixture } from './support/fixture.ts'
import {
  bashToolCall,
  deny,
  hook,
  hookRunRecords,
  lastSessionEvent,
  runTurn,
  writeFileIn,
  writeHooksFile,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

describe('a project without hooks', () => {
  it('runs tools normally and stays silent', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).toContain('NOTE-CONTENT')
    expect(requestText(adapter.requests[1]!)).not.toContain('<system-reminder>')
    expect(harness.warnings).toEqual([])
    expect(hookRunRecords(agent.session)).toEqual([])
  })
})

describe('match.tool', () => {
  it.each([
    ['an exact name', 'read', true],
    ['an either-or set', 'write|edit', false],
    ['a regular expression', '/^(write|edit)$/', false],
  ])('selects tools by %s', async (_label, pattern, blocksRead) => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'gate', match: { tool: pattern }, run: deny(`blocked by ${pattern}`) })],
    })
    const harness = await fixture.harness(root)
    // One call the pattern must select, one it must not: the denied call leaves
    // an observable absence, the allowed call leaves an observable presence.
    const adapter = harness.registerAdapter('mock', [
      toolCallBatch(blocksRead
        ? [
            { id: 'read-1', name: 'read', arguments: { file_path: 'note.txt' } },
            { id: 'write-1', name: 'write', arguments: { file_path: 'other.txt', content: 'OTHER' } },
          ]
        : [
            { id: 'write-1', name: 'write', arguments: { file_path: 'new.txt', content: 'NEW' } },
            { id: 'read-1', name: 'read', arguments: { file_path: 'note.txt' } },
          ]),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const toolResults = requestText(adapter.requests[1]!)
    expect(toolResults).toContain(`blocked by ${pattern}`)
    if (blocksRead) {
      expect(toolResults).not.toContain('NOTE-CONTENT')
      await expect(access(join(root, 'other.txt'))).resolves.toBeUndefined()
    } else {
      expect(toolResults).toContain('NOTE-CONTENT')
      await expect(access(join(root, 'new.txt'))).rejects.toThrow()
    }
  })
})

describe('builtin deny on tool.pre', () => {
  it('blocks a matching shell command and tells the model why', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'target.txt', 'KEEP-ME\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [
        hook({
          id: 'block-rm',
          match: { tool: 'bash', args: { command: '/(^|\\s)rm\\s+-rf\\b/' } },
          run: deny('rm -rf is blocked'),
        }),
      ],
    })
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'rm -rf target.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The tool never ran: the file the command would have deleted is intact.
    await expect(access(join(root, 'target.txt'))).resolves.toBeUndefined()
    // The model received the hook's reason as the tool result.
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).toContain('rm -rf is blocked')
    expect(harness.warnings).toEqual([])
  })

  it('writes one Session plugin record per hook run', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [
        hook({
          id: 'no-reads',
          match: { tool: 'read', args: { file_path: 'note.txt' } },
          run: deny('reading note.txt is blocked'),
        }),
        hook({
          id: 'never-matches',
          match: { tool: 'write' },
          run: deny('writing is blocked'),
        }),
      ],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('reading note.txt is blocked')
    const records = hookRunRecords(agent.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'tool.pre',
      source: join(root, '.dsh/hooks.json'),
      hook_id: 'no-reads',
      handler: 'builtin',
      action: 'deny',
    })
    expect(typeof records[0]!.duration_ms).toBe('number')
    expect(records[0]!.error).toBeUndefined()
  })
})

describe('builtin halt on tool.pre', () => {
  it('cancels the turn, denies the call, and stops the hooks behind it', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'target.txt', 'KEEP-ME\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [
        hook({
          id: 'stop',
          match: { tool: 'bash' },
          run: { type: 'builtin', action: 'halt', reason: 'stop this call' },
        }),
        hook({
          id: 'late',
          match: { tool: 'bash' },
          run: deny('the late hook must not run'),
        }),
      ],
    })
    const harness = await fixture.harness(root, {}, { bash: true })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'touch target.txt'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The call never ran, the turn ended with the hook cause, and the run
    // behind the halt was never executed.
    await expect(access(join(root, 'target.txt'))).resolves.toBeUndefined()
    expect(lastSessionEvent(agent.session, 'turn/end')?.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'hook', reason: 'stop this call' },
    })
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['stop'])
    expect(hookRunRecords(agent.session)[0]).toMatchObject({ event: 'tool.pre', action: 'halt' })
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('match.args', () => {
  it('requires every leaf of the argument subset to match', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [
        hook({
          id: 'no-secrets',
          match: { tool: 'write', args: { file_path: '/\\.env$/', content: '/SECRET=/' } },
          run: deny('writing secrets to .env is blocked'),
        }),
      ],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallBatch([
        { id: 'w1', name: 'write', arguments: { file_path: 'app.env', content: 'hello' } },
        { id: 'w2', name: 'write', arguments: { file_path: '.env', content: 'hello' } },
        { id: 'w3', name: 'write', arguments: { file_path: '.env', content: 'SECRET=2' } },
      ]),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('writing secrets to .env is blocked')
    // Only the call satisfying both leaves was blocked: the file keeps the
    // harmless content, and the non-.env path with a secret was allowed.
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('hello')
    await expect(access(join(root, 'app.env'))).resolves.toBeUndefined()
  })
})

describe('a broken hooks file', () => {
  it('fails open with one warning when the file is not valid JSON', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFile(root, '{ "version": 1, "hooks": [')
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('NOTE-CONTENT')
    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain('not valid JSON')
    expect(hookRunRecords(agent.session)).toEqual([])
  })

  it('keeps the last valid hooks while the broken edit sits on disk', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'no-reads', match: { tool: 'read' }, run: deny('reading is blocked') })],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('one'),
      toolCallResponse('read-2', 'read', { file_path: 'note.txt' }),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('reading is blocked')

    // A real editor saves a moment later; give the stat stamp room to differ.
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHooksFile(root, '{ "version": 1, "hooks": [')
    await runTurn(agent)

    expect(requestText(adapter.requests[3]!)).toContain('reading is blocked')
    expect(requestText(adapter.requests[3]!)).not.toContain('NOTE-CONTENT')
    expect(harness.warnings.some(warning => warning.includes('not valid JSON'))).toBe(true)
  })

  it('skips one bad entry and keeps its siblings working', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [
        hook({ id: 'bad-regex', match: { tool: '/[/' }, run: deny('never reached') }),
        hook({ id: 'later-ticket', on: 'tool.post', match: { tool: 'read' }, run: deny('never reached') }),
        hook({ id: 'no-reads', match: { tool: 'read' }, run: deny('reading is blocked') }),
      ],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('reading is blocked')
    expect(harness.warnings).toHaveLength(2)
    expect(harness.warnings[0]).toContain('bad-regex')
    expect(harness.warnings[0]).toContain('not a valid regular expression')
    expect(harness.warnings[1]).toContain('not supported by this build')
    expect(hookRunRecords(agent.session)).toHaveLength(1)
  })
})

describe('configuration', () => {
  it('denies but records nothing when audit is turned off', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'no-reads', match: { tool: 'read' }, run: deny('reading is blocked') })],
    })
    const harness = await fixture.harness(root, { audit: false })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('reading is blocked')
    expect(hookRunRecords(agent.session)).toEqual([])
    // Audit off writes neither the Session record nor the file fallback.
    await expect(access(join(root, '.dsh', 'hooks-audit.jsonl'))).rejects.toThrow()
  })
})

describe('hot reload', () => {
  it('re-reads the hooks file after an edit', async () => {
    const root = await fixture.repo()
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'only-bash', match: { tool: 'bash' }, run: deny('shell is blocked') })],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'allowed.txt', content: 'ALLOWED' }),
      textResponse('one'),
      toolCallResponse('write-2', 'write', { file_path: 'blocked.txt', content: 'BLOCKED' }),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    await expect(access(join(root, 'allowed.txt'))).resolves.toBeUndefined()

    // A real editor saves a moment later; give the stat stamp room to differ.
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'no-writes', match: { tool: 'write' }, run: deny('writing is now blocked') })],
    })
    await runTurn(agent)

    expect(requestText(adapter.requests[3]!)).toContain('writing is now blocked')
    await expect(access(join(root, 'blocked.txt'))).rejects.toThrow()
  })
})
