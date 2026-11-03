/**
 * Integration spec for `dsh-rules`.
 *
 * Every case mounts a real Context, the real agent loop, the real filesystem
 * tools, and a scripted mock model adapter in a temporary project. Assertions
 * only read what the model actually received (`adapter.requests`) and what the
 * plugin logged. No internal state is inspected.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countOccurrences,
  createRulesHarness,
  requestText,
  textResponse,
  toolCallBatch,
  toolCallResponse,
  type RulesHarness,
} from './support/harness.ts'

const roots: string[] = []
const harnesses: RulesHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rules-'))
  roots.push(root)
  await mkdir(join(root, '.git'), { recursive: true })
  return root
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

async function harnessFor(root: string, config: Parameters<typeof createRulesHarness>[1] = {}): Promise<RulesHarness> {
  const harness = await createRulesHarness(root, config)
  harnesses.push(harness)
  return harness
}

async function runTurn(agent: Agent, text = 'go'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function scopedRule(paths: string, body: string, title = '# Scoped rule'): string {
  return `---\npaths: [${paths}]\n---\n${title}\n\n${body}\n`
}

describe('session start', () => {
  it('injects nothing and logs nothing when .dsh/rules is empty', async () => {
    const root = await repo()
    await mkdir(join(root, '.dsh/rules'), { recursive: true })
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0]!)).not.toContain('<system-reminder>')
    expect(harness.warnings).toEqual([])
  })

  it('injects an always-on rule in the first request, with its source file', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/base.md', '# Base rules\n\nALWAYS-ON-PROBE\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const first = requestText(adapter.requests[0]!)
    expect(first).toContain('ALWAYS-ON-PROBE')
    expect(first).toContain('Source: .dsh/rules/base.md')
    expect(first).not.toContain('Repository rule index')
  })

  it('lists a path-scoped rule in the index without injecting its body', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE', '# Web rules'))
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const first = requestText(adapter.requests[0]!)
    expect(first).toContain('Repository rule index')
    expect(first).toContain('- web — Web rules — paths: src/**')
    expect(first).not.toContain('PATH-SCOPED-PROBE')
  })

  it('combines always-on bodies and the index in one startup message', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/base.md', '# Base\n\nALWAYS-ON-PROBE\n')
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests[0]!.messages.filter(message => message.role === 'user')
      .filter(message => message.content.some(block => block.type === 'text' && block.text.includes('ALWAYS-ON-PROBE'))))
      .toHaveLength(1)
    const first = requestText(adapter.requests[0]!)
    expect(first).toContain('ALWAYS-ON-PROBE')
    expect(first).toContain('Repository rule index')
    expect(first).not.toContain('PATH-SCOPED-PROBE')
  })
})

describe('tool-result triggers', () => {
  it('injects a path-scoped rule after a successful read, in the next request', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    await write(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[0]!)).not.toContain('PATH-SCOPED-PROBE')
    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('PATH-SCOPED-PROBE')
    expect(second).toContain('Repository rule: web')
    expect(second).toContain('Source: .dsh/rules/web.md')
    expect(second).toContain('Triggered by: src/app.ts')
    expect(countOccurrences(second, 'Triggered by:')).toBe(1)
  })

  it('treats a successful write as a trigger', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/src.md', scopedRule('src/**', 'WRITE-TRIGGER-PROBE'))
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('write-1', 'write', { file_path: 'src/created.ts', content: 'hello\n' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('WRITE-TRIGGER-PROBE')
    expect(requestText(adapter.requests[1]!)).toContain('Triggered by: src/created.ts')
  })

  it('treats a successful edit as a trigger', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/src.md', scopedRule('src/**', 'EDIT-TRIGGER-PROBE'))
    await write(root, 'src/app.ts', 'old value\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('edit-1', 'edit', { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).toContain('EDIT-TRIGGER-PROBE')
    expect(requestText(adapter.requests[1]!)).toContain('Triggered by: src/app.ts')
  })

  it('merges every rule matched in one step into a single message', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/alpha.md', scopedRule('src/a.ts', 'ALPHA-PROBE', '# Alpha'))
    await write(root, '.dsh/rules/beta.md', scopedRule('src/b.ts', 'BETA-PROBE', '# Beta'))
    await write(root, 'src/a.ts', 'a\n')
    await write(root, 'src/b.ts', 'b\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallBatch([
        { id: 'read-a', name: 'read', arguments: { file_path: 'src/a.ts' } },
        { id: 'read-b', name: 'read', arguments: { file_path: 'src/b.ts' } },
      ]),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('ALPHA-PROBE')
    expect(second).toContain('BETA-PROBE')
    // Same ancestor layer: lexicographic path order is the deterministic tiebreak.
    expect(second.indexOf('ALPHA-PROBE')).toBeLessThan(second.indexOf('BETA-PROBE'))
    expect(countOccurrences(second, 'The following repository rules apply to files you just touched.')).toBe(1)
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('ALPHA-PROBE'))))
      .toHaveLength(1)
  })

  it('does not inject for a file outside every rule scope', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    await write(root, 'docs/readme.md', 'outside\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'docs/readme.md' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).not.toContain('PATH-SCOPED-PROBE')
  })

  it('does not inject when the tool call failed', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'src/missing.ts' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).not.toContain('PATH-SCOPED-PROBE')
  })

  it('does not inject when a search tool mentions the path in its result', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    await write(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('search-1', 'search', { query: 'app' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'search',
      description: 'Search files by content.',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'src/app.ts: export const app = 1' }]
      },
    }))

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).not.toContain('PATH-SCOPED-PROBE')
  })
})

describe('per-agent dedupe', () => {
  it('injects the same rule only once across repeated triggers', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    await write(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
      toolCallResponse('read-2', 'read', { file_path: 'src/app.ts' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(countOccurrences(requestText(adapter.requests[1]!), 'PATH-SCOPED-PROBE')).toBe(1)
    expect(countOccurrences(requestText(adapter.requests[2]!), 'PATH-SCOPED-PROBE')).toBe(1)
  })

  it('re-injects a rule after the rule file changes', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'VERSION-ONE-PROBE'))
    await write(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
      textResponse('first turn done'),
      toolCallResponse('read-2', 'read', { file_path: 'src/app.ts' }),
      textResponse('second turn done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    expect(countOccurrences(requestText(adapter.requests[1]!), 'VERSION-ONE-PROBE')).toBe(1)

    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'VERSION-TWO-PROBE-with-extra-length'))
    await runTurn(agent, 'again')

    const finalText = requestText(adapter.requests[3]!)
    expect(finalText).toContain('VERSION-TWO-PROBE-with-extra-length')
    expect(countOccurrences(finalText, 'VERSION-ONE-PROBE')).toBe(1)
  })

  it('lets a rule file created mid-session trigger without entering the startup index', async () => {
    const root = await repo()
    await mkdir(join(root, '.dsh/rules'), { recursive: true })
    await write(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      textResponse('first turn done'),
      toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
      textResponse('second turn done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    expect(requestText(adapter.requests[0]!)).not.toContain('Repository rule index')

    await write(root, '.dsh/rules/late.md', scopedRule('src/**', 'LATE-RULE-PROBE'))
    await runTurn(agent, 'again')

    const finalText = requestText(adapter.requests[2]!)
    expect(finalText).toContain('LATE-RULE-PROBE')
    expect(finalText).toContain('Triggered by: src/app.ts')
    // The index is a session-start snapshot; the late rule is not retro-indexed.
    expect(finalText).not.toContain('Repository rule index')
  })

  it('keeps injections and triggers independent per agent', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/web.md', scopedRule('src/**', 'PATH-SCOPED-PROBE'))
    await write(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapterA = harness.registerAdapter('mock-a', [
      toolCallResponse('read-a', 'read', { file_path: 'src/app.ts' }),
      textResponse('done'),
    ])
    const adapterB = harness.registerAdapter('mock-b', [
      toolCallResponse('read-b', 'read', { file_path: 'src/app.ts' }),
      textResponse('done'),
    ])
    const agentA = await harness.createAgent('mock-a')
    const agentB = await harness.createAgent('mock-b')

    await runTurn(agentA)
    await runTurn(agentB)

    expect(requestText(adapterA.requests[1]!)).toContain('PATH-SCOPED-PROBE')
    expect(requestText(adapterB.requests[1]!)).toContain('PATH-SCOPED-PROBE')
    expect(countOccurrences(requestText(adapterA.requests[1]!), 'PATH-SCOPED-PROBE')).toBe(1)
    expect(countOccurrences(requestText(adapterB.requests[1]!), 'PATH-SCOPED-PROBE')).toBe(1)
  })
})

describe('fail closed and configuration', () => {
  it('withholds broken and oversized rules, names their status in the index, and logs them', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/base.md', '# Base\n\nOK-PROBE\n')
    await write(root, '.dsh/rules/broken.md', '---\npaths: [unterminated\n---\nBROKEN-BODY-PROBE\n')
    await write(root, '.dsh/rules/big.md', scopedRule('src/**', `BIG-BODY-PROBE-${'x'.repeat(300)}`))
    const harness = await harnessFor(root, { maxBytes: 200 })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const first = requestText(adapter.requests[0]!)
    expect(first).toContain('OK-PROBE')
    expect(first).toContain('- broken — unavailable (')
    expect(first).toContain('- big — unavailable (')
    expect(first).not.toContain('BROKEN-BODY-PROBE')
    expect(first).not.toContain('BIG-BODY-PROBE')
    expect(harness.warnings.some(warning => warning.includes('broken.md'))).toBe(true)
    expect(harness.warnings.some(warning => warning.includes('big.md'))).toBe(true)
  })

  it('stacks ancestor rule roots and orders them far to near', async () => {
    const root = await repo()
    await write(root, '.dsh/rules/top.md', '# Top\n\nTOP-ALWAYS-PROBE\n')
    await write(root, '.dsh/rules/top-scoped.md', scopedRule('pkg/src/**', 'TOP-SCOPED-PROBE'))
    await write(root, 'pkg/.dsh/rules/nested.md', '# Nested\n\nNESTED-ALWAYS-PROBE\n')
    await write(root, 'pkg/.dsh/rules/nested-scoped.md', scopedRule('src/**', 'NESTED-SCOPED-PROBE'))
    await write(root, 'pkg/src/app.ts', 'export const app = 1\n')
    const harness = await harnessFor(root)
    const adapter = harness.registerAdapter('mock', [
      toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock', join(root, 'pkg'))

    await runTurn(agent)

    const first = requestText(adapter.requests[0]!)
    expect(first).toContain('TOP-ALWAYS-PROBE')
    expect(first).toContain('NESTED-ALWAYS-PROBE')
    expect(first.indexOf('TOP-ALWAYS-PROBE')).toBeLessThan(first.indexOf('NESTED-ALWAYS-PROBE'))
    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('TOP-SCOPED-PROBE')
    expect(second).toContain('NESTED-SCOPED-PROBE')
    expect(second.indexOf('TOP-SCOPED-PROBE')).toBeLessThan(second.indexOf('NESTED-SCOPED-PROBE'))
  })

  it('honors a custom rule root and ignores it by default', async () => {
    const root = await repo()
    await write(root, '.claude/rules/claude.md', '# Claude rules\n\nCUSTOM-ROOT-PROBE\n')

    const defaultHarness = await harnessFor(root)
    const defaultAdapter = defaultHarness.registerAdapter('mock', [textResponse('done')])
    await runTurn(await defaultHarness.createAgent('mock'))
    expect(requestText(defaultAdapter.requests[0]!)).not.toContain('CUSTOM-ROOT-PROBE')

    const customHarness = await harnessFor(root, { roots: ['.claude/rules'] })
    const customAdapter = customHarness.registerAdapter('mock', [textResponse('done')])
    await runTurn(await customHarness.createAgent('mock'))
    expect(requestText(customAdapter.requests[0]!)).toContain('CUSTOM-ROOT-PROBE')
  })

  it('degrades the index in order: titles, then paths, then nothing', async () => {
    const root = await repo()
    const title = `# ${'T'.repeat(100)}`
    await write(root, '.dsh/rules/alpha.md', scopedRule('src/alpha/**', 'alpha body', title))
    await write(root, '.dsh/rules/beta.md', scopedRule('src/beta/**', 'beta body', title))

    const render = async (indexMaxBytes: number): Promise<string> => {
      const harness = await harnessFor(root, { indexMaxBytes })
      const adapter = harness.registerAdapter('mock', [textResponse('done')])
      await runTurn(await harness.createAgent('mock'))
      return requestText(adapter.requests[0]!)
    }

    const full = await render(4096)
    expect(full).toContain('T'.repeat(100))
    expect(full).toContain('paths:')

    // `indexMaxBytes` budgets the index body, not the surrounding reminder frame.
    const reminderBody = (text: string): string => {
      const reminder = /<system-reminder>[\s\S]*?<\/system-reminder>/.exec(text)?.[0]
      expect(reminder).toBeDefined()
      return reminder!.replace(/^<system-reminder>\n/, '').replace(/\n<\/system-reminder>$/, '')
    }

    const withoutTitles = await render(Buffer.byteLength(reminderBody(full)) - 1)
    expect(withoutTitles).not.toContain('T'.repeat(100))
    expect(withoutTitles).toContain('paths:')

    const namesOnly = await render(Buffer.byteLength(reminderBody(withoutTitles)) - 1)
    expect(namesOnly).not.toContain('paths:')
    expect(namesOnly).toContain('- alpha')
    expect(namesOnly).toContain('- beta')

    const harness = await harnessFor(root, { indexMaxBytes: Buffer.byteLength(reminderBody(namesOnly)) - 1 })
    const adapter = harness.registerAdapter('mock', [textResponse('done')])
    await runTurn(await harness.createAgent('mock'))
    expect(requestText(adapter.requests[0]!)).not.toContain('Repository rule index')
    expect(harness.warnings.some(warning => warning.includes('indexMaxBytes'))).toBe(true)
  })
})
