/**
 * Integration spec for layered hook discovery and hot reload.
 *
 * Each case mounts the real host, the real tools, and a scripted model, then
 * asserts only what a user can observe: the messages the model received,
 * whether a tool really ran, the plugin's warnings, and the Session's plugin
 * records. The user-level layer is isolated by pointing `$DSH_HOME` at a temp
 * directory under the project root, so no test reads the developer's `~/.dsh`.
 */

import { access, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createHooksFixture } from './support/fixture.ts'
import { requestText, textResponse, toolCallBatch, toolCallResponse } from './support/harness.ts'
import {
  deny,
  denyFile,
  dshHomeOf,
  hook,
  hookRunRecords,
  runTurn,
  userHooksSource,
  writeFileIn,
  writeHooksFileAt,
  writeLocalHooksFile,
  writeUserHooksFile,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

describe('user-level hooks', () => {
  it('applies $DSH_HOME/hooks.json to a project with no hooks of its own', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    await writeUserHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'user-no-reads', match: { tool: 'read' }, run: deny('user-level read block') })],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    // The read never ran: the model got the user-level reason instead of content.
    const toolResults = requestText(adapter.requests[1]!)
    expect(toolResults).toContain('user-level read block')
    expect(toolResults).not.toContain('NOTE-CONTENT')
    expect(harness.warnings).toEqual([])
    expect(hookRunRecords(agent.session)).toEqual([
      expect.objectContaining({
        event: 'tool.pre',
        source: userHooksSource(root),
        hook_id: 'user-no-reads',
        action: 'deny',
      }),
    ])
  })
})

describe('project layers', () => {
  it('merges user, ancestor, and local layers in order', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeFileIn(pkg, 'note.txt', 'NOTE-CONTENT\n')
    await writeUserHooksFile(root, denyFile('user-rule', 'user layer', { tool: 'read' }))
    await writeHooksFileAt(root, denyFile('root-rule', 'far layer', { tool: 'read' }))
    await writeHooksFileAt(pkg, denyFile('pkg-rule', 'near layer', { tool: 'read' }))
    await writeLocalHooksFile(pkg, denyFile('local-rule', 'local layer', { tool: 'read' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)

    const toolResults = requestText(adapter.requests[1]!)
    // The first hook in merge order decides; the ones after it still run.
    expect(toolResults).toContain('user layer')
    expect(toolResults).not.toContain('far layer')
    expect(toolResults).not.toContain('near layer')
    expect(toolResults).not.toContain('local layer')
    expect(toolResults).not.toContain('NOTE-CONTENT')
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual([
      'user-rule',
      'root-rule',
      'pkg-rule',
      'local-rule',
    ])
    expect(hookRunRecords(agent.session).map(record => record.source)).toEqual([
      userHooksSource(root),
      join(root, '.dsh/hooks.json'),
      join(pkg, '.dsh/hooks.json'),
      join(pkg, '.dsh/hooks.local.json'),
    ])
    expect(harness.warnings).toEqual([])
  })

  it('lets every layer contribute a hook to the same event', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeFileIn(root, 'root.txt', 'ROOT-CONTENT\n')
    await writeFileIn(pkg, 'pkg.txt', 'PKG-CONTENT\n')
    await writeHooksFileAt(root, {
      version: 1,
      hooks: [hook({ id: 'far-read', match: { tool: 'read', args: { file_path: '../root.txt' } }, run: deny('far layer') })],
    })
    await writeHooksFileAt(pkg, {
      version: 1,
      hooks: [hook({ id: 'near-write', match: { tool: 'write', args: { file_path: 'pkg-new.txt' } }, run: deny('near layer') })],
    })
    await writeLocalHooksFile(pkg, {
      version: 1,
      hooks: [hook({ id: 'local-read', match: { tool: 'read', args: { file_path: 'pkg.txt' } }, run: deny('local layer') })],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallBatch([
        { id: 'read-1', name: 'read', arguments: { file_path: '../root.txt' } },
        { id: 'write-1', name: 'write', arguments: { file_path: 'pkg-new.txt', content: 'NEW' } },
        { id: 'read-2', name: 'read', arguments: { file_path: 'pkg.txt' } },
      ]),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)

    const toolResults = requestText(adapter.requests[1]!)
    expect(toolResults).toContain('far layer')
    expect(toolResults).toContain('near layer')
    expect(toolResults).toContain('local layer')
    expect(toolResults).not.toContain('ROOT-CONTENT')
    expect(toolResults).not.toContain('PKG-CONTENT')
    await expect(access(join(pkg, 'pkg-new.txt'))).rejects.toThrow()
    const recordIds = hookRunRecords(agent.session).map(record => record.hook_id)
    expect(recordIds).toHaveLength(3)
    expect(recordIds.sort()).toEqual(['far-read', 'local-read', 'near-write'])
  })

  it('reads only the session directory when no .git ancestor exists', async () => {
    const plain = await fixture.plainDir()
    const child = join(plain, 'child')
    await writeFileIn(child, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFileAt(plain, denyFile('parent-rule', 'parent layer', { tool: 'read' }))
    await writeHooksFileAt(child, denyFile('child-rule', 'child layer', { tool: 'read' }))
    const harness = await fixture.harness(child)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock', child)

    await runTurn(agent)

    const toolResults = requestText(adapter.requests[1]!)
    expect(toolResults).toContain('child layer')
    expect(toolResults).not.toContain('parent layer')
    expect(hookRunRecords(agent.session).map(record => record.source)).toEqual([
      join(child, '.dsh/hooks.json'),
    ])
  })
})

describe('per-session resolution', () => {
  it('gives two sessions in different directories different hooks', async () => {
    const root = await fixture.repo()
    const left = join(root, 'left')
    const right = join(root, 'right')
    await writeFileIn(left, 'note.txt', 'LEFT-CONTENT\n')
    await writeFileIn(right, 'note.txt', 'RIGHT-CONTENT\n')
    await writeHooksFileAt(left, denyFile('left-rule', 'left layer', { tool: 'read' }))
    await writeHooksFileAt(right, denyFile('right-rule', 'right layer', { tool: 'read' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('left done'),
      toolCallResponse('read-2', 'read', { file_path: 'note.txt' }),
      textResponse('right done'),
    ])
    const leftAgent = await harness.createAgent('mock', left)
    const rightAgent = await harness.createAgent('mock', right)

    await runTurn(leftAgent)
    await runTurn(rightAgent)

    expect(requestText(adapter.requests[1]!)).toContain('left layer')
    expect(requestText(adapter.requests[1]!)).not.toContain('LEFT-CONTENT')
    expect(requestText(adapter.requests[3]!)).toContain('right layer')
    expect(requestText(adapter.requests[3]!)).not.toContain('RIGHT-CONTENT')
    expect(hookRunRecords(leftAgent.session).map(record => record.source)).toEqual([
      join(left, '.dsh/hooks.json'),
    ])
    expect(hookRunRecords(rightAgent.session).map(record => record.source)).toEqual([
      join(right, '.dsh/hooks.json'),
    ])
  })

  it('re-resolves after the session changes directory', async () => {
    const root = await fixture.repo()
    const left = join(root, 'left')
    const right = join(root, 'right')
    await writeFileIn(left, 'note.txt', 'LEFT-CONTENT\n')
    await writeFileIn(right, 'note.txt', 'RIGHT-CONTENT\n')
    await writeHooksFileAt(right, denyFile('right-rule', 'right layer', { tool: 'read' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('left done'),
      toolCallResponse('read-2', 'read', { file_path: 'note.txt' }),
      textResponse('right done'),
    ])
    const agent = await harness.createAgent('mock', left)

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('LEFT-CONTENT')

    await harness.ctx.workingDirectory.set(agent, right)
    await runTurn(agent)

    const toolResults = requestText(adapter.requests[3]!)
    expect(toolResults).toContain('right layer')
    expect(toolResults).not.toContain('RIGHT-CONTENT')
    expect(hookRunRecords(agent.session).map(record => record.source)).toEqual([
      join(right, '.dsh/hooks.json'),
    ])
  })
})


describe('hot reload', () => {
  it('uses an edited layer on the next event', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeFileIn(pkg, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFileAt(root, denyFile('far-rule', 'far layer', { tool: 'bash' }))
    await writeHooksFileAt(pkg, denyFile('near-rule', 'first edit', { tool: 'read' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('one'),
      toolCallResponse('write-1', 'write', { file_path: 'blocked.txt', content: 'BLOCKED' }),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('first edit')
    expect(requestText(adapter.requests[1]!)).not.toContain('NOTE-CONTENT')

    // A real editor saves a moment later; give the stat stamp room to differ.
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHooksFileAt(pkg, denyFile('near-rule', 'second edit', { tool: 'write' }))
    await runTurn(agent)

    // The edited layer now gates writes; had the edit been missed, this write
    // would have created the file and produced no reason.
    expect(requestText(adapter.requests[3]!)).toContain('second edit')
    await expect(access(join(pkg, 'blocked.txt'))).rejects.toThrow()
    expect(hookRunRecords(agent.session).map(record => record.source)).toEqual([
      join(pkg, '.dsh/hooks.json'),
      join(pkg, '.dsh/hooks.json'),
    ])
  })

  it('starts using a layer created after the session started', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeFileIn(pkg, 'placeholder.txt', 'PLACEHOLDER\n')
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'before.txt', content: 'BEFORE' }),
      textResponse('one'),
      toolCallResponse('write-2', 'write', { file_path: 'after.txt', content: 'AFTER' }),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)
    await expect(access(join(pkg, 'before.txt'))).resolves.toBeUndefined()
    expect(harness.warnings).toEqual([])

    await writeHooksFileAt(pkg, denyFile('new-rule', 'created mid-session', { tool: 'write' }))
    await runTurn(agent)

    expect(requestText(adapter.requests[3]!)).toContain('created mid-session')
    await expect(access(join(pkg, 'after.txt'))).rejects.toThrow()
    expect(hookRunRecords(agent.session).map(record => record.source)).toEqual([
      join(pkg, '.dsh/hooks.json'),
    ])
  })

  it('stops using a layer deleted after it was loaded', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeHooksFileAt(pkg, denyFile('gone-rule', 'deleted layer', { tool: 'write' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'blocked.txt', content: 'BLOCKED' }),
      textResponse('one'),
      toolCallResponse('write-2', 'write', { file_path: 'allowed.txt', content: 'ALLOWED' }),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('deleted layer')
    await expect(access(join(pkg, 'blocked.txt'))).rejects.toThrow()

    await rm(join(pkg, '.dsh', 'hooks.json'))
    await runTurn(agent)

    await expect(access(join(pkg, 'allowed.txt'))).resolves.toBeUndefined()
    // The second write was not gated: only the first run left a record.
    expect(hookRunRecords(agent.session)).toHaveLength(1)
  })

  it('still re-reads edits through the stat check when watching is off', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeHooksFileAt(pkg, denyFile('near-rule', 'first edit', { tool: 'write' }))
    const harness = await fixture.harness(root, { watch: false })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'first.txt', content: 'FIRST' }),
      textResponse('one'),
      toolCallResponse('write-2', 'write', { file_path: 'second.txt', content: 'SECOND' }),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('first edit')

    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHooksFileAt(pkg, denyFile('near-rule', 'second edit', { tool: 'write' }))
    await runTurn(agent)

    expect(requestText(adapter.requests[3]!)).toContain('second edit')
    await expect(access(join(pkg, 'second.txt'))).rejects.toThrow()
  })

  it('follows a directory change into the new tree and sees its edits', async () => {
    const root = await fixture.repo()
    const left = join(root, 'left')
    const right = join(root, 'right')
    await writeFileIn(left, 'note.txt', 'LEFT-CONTENT\n')
    await writeFileIn(right, 'note.txt', 'RIGHT-CONTENT\n')
    await writeHooksFileAt(right, denyFile('right-rule', 'right first edit', { tool: 'read' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('left done'),
      toolCallResponse('read-2', 'read', { file_path: 'note.txt' }),
      textResponse('right done'),
      toolCallResponse('read-3', 'read', { file_path: 'note.txt' }),
      textResponse('right again'),
    ])
    const agent = await harness.createAgent('mock', left)

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('LEFT-CONTENT')

    await harness.ctx.workingDirectory.set(agent, right)
    await runTurn(agent)
    expect(requestText(adapter.requests[3]!)).toContain('right first edit')

    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHooksFileAt(right, denyFile('right-rule', 'right second edit', { tool: 'read' }))
    await runTurn(agent)

    expect(requestText(adapter.requests[5]!)).toContain('right second edit')
    expect(requestText(adapter.requests[5]!)).not.toContain('RIGHT-CONTENT')
  })
})

describe('a broken layer', () => {
  it('keeps that layer last valid hooks while the other layers keep working', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeFileIn(pkg, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFileAt(root, denyFile('far-read', 'far layer', { tool: 'read' }))
    await writeHooksFileAt(pkg, denyFile('near-write', 'near layer', { tool: 'write' }))
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallBatch([
        { id: 'read-1', name: 'read', arguments: { file_path: 'note.txt' } },
        { id: 'write-1', name: 'write', arguments: { file_path: 'first.txt', content: 'FIRST' } },
      ]),
      textResponse('one'),
      toolCallBatch([
        { id: 'read-2', name: 'read', arguments: { file_path: 'note.txt' } },
        { id: 'write-2', name: 'write', arguments: { file_path: 'second.txt', content: 'SECOND' } },
      ]),
      textResponse('two'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)
    expect(requestText(adapter.requests[1]!)).toContain('near layer')

    await new Promise(resolve => setTimeout(resolve, 10))
    await writeHooksFileAt(pkg, '{ "version": 1, "hooks": [')
    await runTurn(agent)

    // The unreadable layer keeps its last valid hook; the sibling layer is
    // unaffected, and the warning names the file that is broken.
    const toolResults = requestText(adapter.requests[3]!)
    expect(toolResults).toContain('far layer')
    expect(toolResults).toContain('near layer')
    await expect(access(join(pkg, 'second.txt'))).rejects.toThrow()
    const warnings = harness.warnings.filter(warning => warning.includes(join(pkg, '.dsh/hooks.json')))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not valid JSON')
  })

  it('skips one bad entry, names its source, and keeps its siblings working', async () => {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    await writeFileIn(pkg, 'note.txt', 'NOTE-CONTENT\n')
    await writeHooksFileAt(root, denyFile('far-rule', 'far layer', { tool: 'bash' }))
    await writeHooksFileAt(pkg, {
      version: 1,
      hooks: [
        hook({ id: 'bad-regex', match: { tool: '/[/' }, run: deny('never reached') }),
        hook({ id: 'near-read', match: { tool: 'read' }, run: deny('near layer') }),
      ],
    })
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('near layer')
    const warnings = harness.warnings.filter(warning => warning.includes('bad-regex'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(join(pkg, '.dsh/hooks.json'))
    expect(hookRunRecords(agent.session).map(record => record.hook_id)).toEqual(['near-read'])
  })
})

describe('layer switches', () => {
  const files = ['user.txt', 'root.txt', 'pkg.txt', 'local.txt'] as const

  async function treeWithEveryLayer() {
    const root = await fixture.repo()
    const pkg = join(root, 'pkg')
    for (const file of files) await writeFileIn(pkg, file, `${file.toUpperCase()}-CONTENT\n`)
    await writeUserHooksFile(root, {
      version: 1,
      hooks: [hook({ id: 'user-read', match: { tool: 'read', args: { file_path: 'user.txt' } }, run: deny('user layer') })],
    })
    await writeHooksFileAt(root, {
      version: 1,
      hooks: [hook({ id: 'root-read', match: { tool: 'read', args: { file_path: 'root.txt' } }, run: deny('far layer') })],
    })
    await writeHooksFileAt(pkg, {
      version: 1,
      hooks: [hook({ id: 'pkg-read', match: { tool: 'read', args: { file_path: 'pkg.txt' } }, run: deny('near layer') })],
    })
    await writeLocalHooksFile(pkg, {
      version: 1,
      hooks: [hook({ id: 'local-read', match: { tool: 'read', args: { file_path: 'local.txt' } }, run: deny('local layer') })],
    })
    return { root, pkg }
  }

  function readEveryFile() {
    return toolCallBatch(files.map((file, index) => ({
      id: `read-${String(index)}`,
      name: 'read',
      arguments: { file_path: file },
    })))
  }

  it('runs every layer by default', async () => {
    const { root, pkg } = await treeWithEveryLayer()
    const harness = await fixture.harness(root)
    const adapter = harness.registerAdapter('mock', [readEveryFile(), textResponse('done')])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)

    const toolResults = requestText(adapter.requests[1]!)
    for (const reason of ['user layer', 'far layer', 'near layer', 'local layer']) {
      expect(toolResults).toContain(reason)
    }
    for (const file of files) expect(toolResults).not.toContain(`${file.toUpperCase()}-CONTENT`)
    expect(hookRunRecords(agent.session)).toHaveLength(4)
  })

  it.each([
    ['userHooks', { userHooks: false }, 'user.txt', ['far layer', 'near layer', 'local layer']],
    ['projectHooks', { projectHooks: false }, 'root.txt', ['user layer', 'local layer']],
    ['localHooks', { localHooks: false }, 'local.txt', ['user layer', 'far layer', 'near layer']],
  ])('turns off one layer with %s: false', async (_label, config, allowedFile, blockedReasons) => {
    const { root, pkg } = await treeWithEveryLayer()
    const harness = await fixture.harness(root, config)
    const adapter = harness.registerAdapter('mock', [readEveryFile(), textResponse('done')])
    const agent = await harness.createAgent('mock', pkg)

    await runTurn(agent)

    const toolResults = requestText(adapter.requests[1]!)
    expect(toolResults).toContain(`${allowedFile.toUpperCase()}-CONTENT`)
    for (const reason of blockedReasons) expect(toolResults).toContain(reason)
    expect(hookRunRecords(agent.session)).toHaveLength(blockedReasons.length)
  })
})

describe('zero noise', () => {
  it('stays silent when the user home exists but holds no hooks file', async () => {
    const root = await fixture.repo()
    await writeFileIn(root, 'note.txt', 'NOTE-CONTENT\n')
    const harness = await fixture.harness(root)
    // The stub home exists as a directory, just without `hooks.json`.
    await mkdir(dshHomeOf(root), { recursive: true })
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'note.txt' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('NOTE-CONTENT')
    expect(harness.warnings).toEqual([])
    expect(hookRunRecords(agent.session)).toEqual([])
  })
})
