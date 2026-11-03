/**
 * Integration spec: shell single-file reads as rule triggers.
 *
 * The real bash tool stack (jobs, subprocess, shell environment, executor) runs
 * the model's command; assertions read only what the model received next. A
 * trigger must be invisible for any command whose touched file cannot be proven.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  countOccurrences,
  requestText,
  textResponse,
  toolCallResponse,
} from './support/harness.ts'
import { createRulesFixture, type RulesConfigOverrides } from './support/fixture.ts'
import { bashToolCall, runTurn, scopedRule, writeFileIn } from './support/project.ts'

const fixture = createRulesFixture()

afterEach(() => fixture.cleanup())

/** A project root seeded with one source file the rules can scope to. */
async function repo(): Promise<string> {
  const root = await fixture.repo()
  await writeFileIn(root, 'src/app.ts', 'export const APP = 1\n')
  return root
}

/** Mount the real bash stack next to the rules plugin. */
async function bashHarness(root: string, config: RulesConfigOverrides = {}) {
  return fixture.harness(root, config, { bash: true })
}

describe('shell single-file read triggers', () => {
  it.each([
    ['cat', 'cat src/app.ts'],
    ['head', 'head -n 2 src/app.ts'],
    ['tail', 'tail -n 2 src/app.ts'],
    ['sed', "sed -n '1,2p' src/app.ts"],
    ['grep', 'grep -n APP src/app.ts'],
  ])('injects a path-scoped rule after `%s`', async (_name, command) => {
    const root = await repo()
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'SHELL-SCOPED-PROBE'))
    const harness = await bashHarness(root)
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', command),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('SHELL-SCOPED-PROBE')
    expect(second).toContain('Repository rule: src')
    expect(second).toContain('Triggered by: src/app.ts')
    expect(countOccurrences(second, 'Triggered by:')).toBe(1)
  })

  it('resolves a relative file against the bash call `workdir`', async () => {
    const root = await repo()
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'WORKDIR-PROBE'))
    const harness = await bashHarness(root)
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'cat app.ts', { workdir: 'src' }),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('WORKDIR-PROBE')
    expect(second).toContain('Triggered by: src/app.ts')
  })

  it.each([
    ['a pipe', 'cat src/app.ts | head -n 1'],
    ['a wildcard', 'cat src/*.ts'],
    ['a variable', 'cat $FILE'],
    ['two file operands', 'cat src/app.ts src/other.ts'],
    ['recursive grep', 'grep -r APP src'],
    ['a non-read command', 'ls src'],
    ['command substitution', 'cat $(ls src)'],
    ['a redirection', 'cat src/app.ts > /dev/null'],
  ])('does not inject for %s', async (_name, command) => {
    const root = await repo()
    await writeFileIn(root, 'src/other.ts', 'export const OTHER = 1\n')
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'NEGATIVE-PROBE'))
    const harness = await bashHarness(root)
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', command),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).not.toContain('NEGATIVE-PROBE')
  })

  it('does not inject for a shell read outside every rule scope', async () => {
    const root = await repo()
    await writeFileIn(root, 'docs/readme.md', 'outside\n')
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'OUTSIDE-PROBE'))
    const harness = await bashHarness(root)
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'cat docs/readme.md'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(requestText(adapter.requests[1]!)).not.toContain('OUTSIDE-PROBE')
  })

  it('stops honoring shell reads when includeBashReads is false, while read still triggers', async () => {
    const root = await repo()
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'BASH-TOGGLE-PROBE'))
    const harness = await bashHarness(root, { includeBashReads: false })
    const adapter = harness.registerAdapter('mock', [
      bashToolCall('bash-1', 'cat src/app.ts'),
      textResponse('first turn done'),
      toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
      textResponse('second turn done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).not.toContain('BASH-TOGGLE-PROBE')

    await runTurn(agent, 'again')
    expect(requestText(adapter.requests[3]!)).toContain('BASH-TOGGLE-PROBE')
  })
})
