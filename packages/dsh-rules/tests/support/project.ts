/**
 * Shared fixtures for the `dsh-rules` integration specs.
 *
 * Temporary repositories, rule markdown, scripted bash calls, and one-turn
 * drivers. Everything here is test scaffolding; the behavior under test lives
 * in `src/`.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { toolCallResponse } from './mock-adapter.ts'

/** Create a temporary project root with a `.git` marker, stopping discovery there. */
export async function createRepo(prefix = 'dsh-rules-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(root, '.git'), { recursive: true })
  return root
}

/** Write one file, creating parent directories. */
export async function writeFileIn(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

/** Drive one complete turn and wait for the agent to go idle. */
export async function runTurn(agent: Agent, text = 'go'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Markdown for one path-scoped rule. */
export function scopedRule(paths: string, body: string, title = '# Scoped rule'): string {
  return `---\npaths: [${paths}]\n---\n${title}\n\n${body}\n`
}

/** Scripted bash tool call, with the required description defaulted. */
export function bashToolCall(
  id: string,
  command: string,
  options: { workdir?: string; description?: string } = {},
) {
  return toolCallResponse(id, 'bash', {
    command,
    description: options.description ?? 'read one file',
    ...options.workdir === undefined ? {} : { workdir: options.workdir },
  })
}
