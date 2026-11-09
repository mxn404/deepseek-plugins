/**
 * Integration spec: PowerShell single-file reads as rule triggers.
 *
 * dsh mounts `pwsh`, not `bash`, on Windows. The trigger decision is pure text,
 * so the harness registers a test-only `pwsh` tool that reports success without
 * running a shell; assertions read only what the model received next. A trigger
 * must be invisible for any command whose touched file cannot be proven.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { countOccurrences, requestText, textResponse, toolCallResponse } from './support/harness.ts'
import { createRulesFixture, type RulesConfigOverrides } from './support/fixture.ts'
import { runTurn, scopedRule, writeFileIn } from './support/project.ts'

const fixture = createRulesFixture()

afterEach(() => fixture.cleanup())

/** A project root seeded with one source file the rules can scope to. */
async function repo(): Promise<string> {
  const root = await fixture.repo()
  await writeFileIn(root, 'src/app.ts', 'export const APP = 1\n')
  return root
}

/** Scripted pwsh call: the harness test double accepts `command` / `workdir`. */
function pwshToolCall(id: string, command: string, workdir?: string) {
  return toolCallResponse(id, 'pwsh', {
    command,
    ...workdir === undefined ? {} : { workdir },
  })
}

/** Mount the test-only pwsh tool next to the rules plugin. */
async function pwshHarness(root: string, config: RulesConfigOverrides = {}) {
  return fixture.harness(root, config, { pwsh: true })
}

describe('pwsh single-file read triggers', () => {
  it.each([
    ['the cmdlet', 'Get-Content src/app.ts'],
    ['a lowercase cmdlet', 'get-content src/app.ts'],
    ['the gc alias with -Path', 'gc -Path src/app.ts'],
    ['the type alias with -LiteralPath', 'type -LiteralPath src/app.ts'],
    ['a read-only flag', 'Get-Content -Raw src/app.ts'],
  ])('injects a path-scoped rule after %s', async (_name, command) => {
    const root = await repo()
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'PWSH-SCOPED-PROBE'))
    const harness = await pwshHarness(root)
    const adapter = harness.registerAdapter('mock', [
      pwshToolCall('pwsh-1', command),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('PWSH-SCOPED-PROBE')
    expect(second).toContain('Repository rule: src')
    expect(second).toContain('Triggered by: src/app.ts')
    expect(countOccurrences(second, 'Triggered by:')).toBe(1)
  })

  it('resolves a relative file against the pwsh call `workdir`', async () => {
    const root = await repo()
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'PWSH-WORKDIR-PROBE'))
    const harness = await pwshHarness(root)
    const adapter = harness.registerAdapter('mock', [
      pwshToolCall('pwsh-1', 'Get-Content app.ts', 'src'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    const second = requestText(adapter.requests[1]!)
    expect(second).toContain('PWSH-WORKDIR-PROBE')
    expect(second).toContain('Triggered by: src/app.ts')
  })

  it.each([
    ['a pipe', 'Get-Content src/app.ts | Select-Object -First 1'],
    ['a wildcard', 'Get-Content src/*.ts'],
    ['two file operands', 'Get-Content src/app.ts src/other.ts'],
    ['-Tail', 'Get-Content -Tail 1 src/app.ts'],
    ['a non-read cmdlet', 'Get-Item src/app.ts'],
  ])('does not inject for %s', async (_name, command) => {
    const root = await repo()
    await writeFileIn(root, 'src/other.ts', 'export const OTHER = 1\n')
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'PWSH-NEGATIVE-PROBE'))
    const harness = await pwshHarness(root)
    const adapter = harness.registerAdapter('mock', [
      pwshToolCall('pwsh-1', command),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).not.toContain('PWSH-NEGATIVE-PROBE')
  })

  it('stops honoring pwsh reads when includeBashReads is false', async () => {
    const root = await repo()
    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'PWSH-TOGGLE-PROBE'))
    const harness = await pwshHarness(root, { includeBashReads: false })
    const adapter = harness.registerAdapter('mock', [
      pwshToolCall('pwsh-1', 'Get-Content src/app.ts'),
      textResponse('done'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent)

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[1]!)).not.toContain('PWSH-TOGGLE-PROBE')
  })
})
