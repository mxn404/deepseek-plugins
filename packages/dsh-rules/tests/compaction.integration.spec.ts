/**
 * Integration spec: rule replay after a session compaction.
 *
 * A real compaction engine (with a stubbed summarizer, so no API key) compacts
 * a real session; assertions read only what the model received on the
 * follow-up turn. The regression under test is silent loss: a summary must not
 * erase conventions that were already loaded before it.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countOccurrences,
  createRulesHarness,
  requestText,
  textResponse,
  toolCallResponse,
  type RulesHarness,
} from './support/harness.ts'
import { createRepo, runTurn, scopedRule, writeFileIn } from './support/project.ts'

/** Long enough that the mandatory closed history is compactable. */
const LONG_PROMPT = 'older conversation history '.repeat(60)

/** A summarizer under test control: deterministic, offline, no model call. */
class StubCompactionEngine extends BasicCompactionEngine {
  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return { summary: [{ type: 'text', text: 'COMPACTED-SUMMARY' }], provider: 'mock', model: 'stub' }
  }
}

const roots: string[] = []
const harnesses: RulesHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Fixture {
  readonly root: string
  readonly harness: RulesHarness
  readonly adapter: ReturnType<RulesHarness['registerAdapter']>
  readonly agent: Agent
  readonly compact: StubCompactionEngine
}

/**
 * A repo with one always-on and one path-scoped rule, a mounted TokenMeter, and
 * a manual compaction engine. `scripts` come after the three seeding turns.
 */
async function fixture(
  config: Parameters<typeof createRulesHarness>[1],
  scripts: Parameters<RulesHarness['registerAdapter']>[1],
): Promise<Fixture> {
  const root = await createRepo()
  roots.push(root)
  await writeFileIn(root, '.dsh/rules/base.md', '# Base rules\n\nALWAYS-ON-PROBE\n')
  await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'SCOPED-PROBE'))
  await writeFileIn(root, 'src/app.ts', 'export const app = 1\n')
  const harness = await createRulesHarness(root, config)
  harnesses.push(harness)
  await harness.ctx.plugin(TokenMeter)
  const compact = new StubCompactionEngine(harness.ctx, { auto: false })
  const adapter = harness.registerAdapter('mock', scripts)
  const agent = await harness.createAgent('mock')
  return { root, harness, adapter, agent, compact }
}

/** Turn one: read the scoped file, so both rules are injected into history. */
async function seedRuleInjections(agent: Agent): Promise<void> {
  await runTurn(agent)
}

/** Two long closed turns, so manual compaction has a useful shadowed span. */
async function seedLongHistory(agent: Agent): Promise<void> {
  await runTurn(agent, LONG_PROMPT)
  await runTurn(agent, LONG_PROMPT)
}

function compactionScripts(): Parameters<RulesHarness['registerAdapter']>[1] {
  return [
    toolCallResponse('read-1', 'read', { file_path: 'src/app.ts' }),
    textResponse('first turn done'),
    textResponse('second turn done'),
    textResponse('third turn done'),
    textResponse('after compaction'),
  ]
}

describe('compaction replay', () => {
  it('re-injects every previously injected rule on the step after a compaction', async () => {
    const { adapter, agent, compact } = await fixture({}, compactionScripts())
    await seedRuleInjections(agent)
    await seedLongHistory(agent)

    const before = requestText(adapter.requests[3]!)
    expect(countOccurrences(before, 'ALWAYS-ON-PROBE')).toBe(1)
    expect(countOccurrences(before, 'SCOPED-PROBE')).toBe(1)

    const result = await compact.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    await runTurn(agent, 'after compaction')

    const after = requestText(adapter.requests[4]!)
    expect(after).toContain('COMPACTED-SUMMARY')
    expect(after).toContain('ALWAYS-ON-PROBE')
    expect(after).toContain('SCOPED-PROBE')
    expect(countOccurrences(after, 'ALWAYS-ON-PROBE')).toBe(1)
    expect(countOccurrences(after, 'SCOPED-PROBE')).toBe(1)
    expect(after).toContain('<system-reminder>')
  })

  it('replays from the current snapshot: changed rules enter new, deleted rules are skipped', async () => {
    const { root, adapter, agent, compact } = await fixture({}, compactionScripts())
    await seedRuleInjections(agent)
    await seedLongHistory(agent)
    await compact.compactNow(agent, new AbortController().signal)

    await writeFileIn(root, '.dsh/rules/src.md', scopedRule('src/**', 'SCOPED-PROBE-VERSION-TWO'))
    await rm(join(root, '.dsh/rules/base.md'))
    await runTurn(agent, 'after compaction')

    const after = requestText(adapter.requests[4]!)
    expect(after).toContain('SCOPED-PROBE-VERSION-TWO')
    expect(countOccurrences(after, 'SCOPED-PROBE')).toBe(1)
    expect(after).not.toContain('ALWAYS-ON-PROBE')
  })

  it('does not replay again on later steps after the one replay', async () => {
    const { adapter, agent, compact } = await fixture({}, [
      ...compactionScripts(),
      toolCallResponse('read-2', 'read', { file_path: 'src/app.ts' }),
      textResponse('final turn done'),
    ])
    await seedRuleInjections(agent)
    await seedLongHistory(agent)
    await compact.compactNow(agent, new AbortController().signal)
    await runTurn(agent, 'after compaction')
    await runTurn(agent, 'again')

    const final = requestText(adapter.requests[6]!)
    expect(countOccurrences(final, 'ALWAYS-ON-PROBE')).toBe(1)
    expect(countOccurrences(final, 'SCOPED-PROBE')).toBe(1)
  })

  it('does not duplicate rules when no compaction happened', async () => {
    const { adapter, agent } = await fixture({}, compactionScripts())
    await seedRuleInjections(agent)
    await seedLongHistory(agent)
    await runTurn(agent, 'after compaction')

    const after = requestText(adapter.requests[4]!)
    expect(after).not.toContain('COMPACTED-SUMMARY')
    expect(countOccurrences(after, 'ALWAYS-ON-PROBE')).toBe(1)
    expect(countOccurrences(after, 'SCOPED-PROBE')).toBe(1)
  })

  it('replays nothing when no rule was ever injected', async () => {
    const root = await createRepo()
    roots.push(root)
    await writeFileIn(root, 'src/app.ts', 'export const app = 1\n')
    const harness = await createRulesHarness(root)
    harnesses.push(harness)
    await harness.ctx.plugin(TokenMeter)
    const compact = new StubCompactionEngine(harness.ctx, { auto: false })
    const adapter = harness.registerAdapter('mock', [
      textResponse('first turn done'),
      textResponse('second turn done'),
      textResponse('third turn done'),
      textResponse('after compaction'),
    ])
    const agent = await harness.createAgent('mock')

    await runTurn(agent, LONG_PROMPT)
    await runTurn(agent, LONG_PROMPT)
    await runTurn(agent, LONG_PROMPT)
    const result = await compact.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    await runTurn(agent, 'after compaction')

    expect(requestText(adapter.requests[3]!)).not.toContain('<system-reminder>')
  })

  it('does not replay when replayAfterCompaction is false', async () => {
    const { adapter, agent, compact } = await fixture({ replayAfterCompaction: false }, compactionScripts())
    await seedRuleInjections(agent)
    await seedLongHistory(agent)

    const result = await compact.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    await runTurn(agent, 'after compaction')

    const after = requestText(adapter.requests[4]!)
    expect(after).toContain('COMPACTED-SUMMARY')
    expect(after).not.toContain('ALWAYS-ON-PROBE')
    expect(after).not.toContain('SCOPED-PROBE')
  })
})
