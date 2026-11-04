/**
 * Integration spec for cross-agent coverage.
 *
 * The plugin is mounted once at the root, so its listeners are untagged and the
 * host's scoped dispatch admits them for every Agent, children included. This
 * spec proves the consequence end to end: a delegated child's `bash` call is
 * denied by the rule in the child's own working tree, not by the parent's, and
 * the audit row lands on the child's Session.
 *
 * The child is a real Agent from the loop with a child-shaped Session header
 * (`parentSession` / `origin: 'subagent'` / `delegationDepth`), which is the
 * durable lineage the host persists for a delegated subagent. Mounting the
 * heavyweight subagent tool package is unnecessary for the seam under test:
 * the plugin never reads `subagent/*` events, it reads each Agent's working
 * directory.
 */

import type { GenerateOptions, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createHooksFixture } from './support/fixture.ts'
import { requestText, textResponse } from './support/harness.ts'
import {
  bashToolCall,
  denyFile,
  hookRunRecords,
  runTurn,
  writeHooksFile,
} from './support/project.ts'

const fixture = createHooksFixture()

afterEach(() => fixture.cleanup())

/** The single tool result of a one-call turn. */
function onlyToolResult(request: GenerateOptions): ToolResultMessage {
  const results = request.messages.flatMap(message => message.role === 'tool' ? [message] : [])
  expect(results).toHaveLength(1)
  return results[0]!
}

describe('a child agent under one root-mounted plugin', () => {
  it('denies the child bash call by the child cwd rule and audits it on the child session', async () => {
    const parentRoot = await fixture.repo()
    const childRoot = await fixture.repo()
    await writeHooksFile(parentRoot, denyFile('parent-deny', 'PARENT-RULE: parent bash is blocked'))
    await writeHooksFile(childRoot, denyFile('child-deny', 'CHILD-RULE: child bash is blocked'))

    const harness = await fixture.harness(parentRoot, {}, { bash: true })
    const parentAdapter = harness.registerAdapter('parent', [
      bashToolCall('parent-bash', 'echo PARENT-TOOL-OUTPUT'),
      textResponse('parent done'),
    ])
    const parent = await harness.createAgent('parent', parentRoot)

    const childAdapter = harness.registerAdapter('child', [
      bashToolCall('child-bash', 'echo CHILD-TOOL-OUTPUT > child-ran.txt'),
      textResponse('child done'),
    ])
    // A real child Session header: durable lineage, its own cwd. The loop's
    // `create` types meta as `Pick<SessionHeader, 'cwd'>`; the extra fields are
    // carried by the variable and folded into the header by the store.
    const childMeta = {
      parentSession: parent.id,
      origin: 'subagent' as const,
      delegationDepth: 1,
    }
    const child = await harness.createAgent('child', childRoot, childMeta)

    // The child carries the lineage the host persists for a delegated subagent.
    expect(child.session.header).toMatchObject({
      cwd: childRoot,
      parentSession: parent.id,
      origin: 'subagent',
      delegationDepth: 1,
    })

    await runTurn(parent)
    await runTurn(child)

    // The parent's own call is denied by the parent tree's rule.
    expect(requestText(parentAdapter.requests[1]!)).toContain('PARENT-RULE: parent bash is blocked')
    // The child's call is denied by the child tree's rule, not the parent's:
    // had discovery used the parent cwd, the reason would be PARENT-RULE.
    const childResult = onlyToolResult(childAdapter.requests[1]!)
    const childText = requestText(childAdapter.requests[1]!)
    expect(childResult.isError).toBe(true)
    expect(childText).toContain('CHILD-RULE: child bash is blocked')
    expect(childText).not.toContain('PARENT-RULE')
    // The denial kept the side effect from happening.
    await expect(readFile(join(childRoot, 'child-ran.txt'), 'utf8')).rejects.toThrow()

    // Each Session audits its own run, from its own hooks file.
    expect(hookRunRecords(parent.session)).toMatchObject([
      {
        event: 'tool.pre',
        hook_id: 'parent-deny',
        source: join(parentRoot, '.dsh', 'hooks.json'),
        action: 'deny',
      },
    ])
    expect(hookRunRecords(child.session)).toMatchObject([
      {
        event: 'tool.pre',
        hook_id: 'child-deny',
        source: join(childRoot, '.dsh', 'hooks.json'),
        action: 'deny',
      },
    ])
    // The two Sessions kept their own cwd in the payload they audited.
    expect(hookRunRecords(child.session)[0]!.source).toContain(basename(childRoot))
    expect(harness.pluginWarnings).toEqual([])
  })
})
