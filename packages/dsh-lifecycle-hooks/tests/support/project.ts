/**
 * Shared fixtures for the `dsh-lifecycle-hooks` integration specs.
 *
 * Temporary repositories, `.dsh/hooks.json` files, scripted tool calls, and
 * one-turn drivers. Everything here is test scaffolding; the behavior under
 * test lives in `src/`.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { toolCallResponse } from './mock-adapter.ts'

/** Record type every hook run writes. */
export const RUN_RECORD_TYPE = 'plugin:dsh-lifecycle-hooks/run'

/** Create a temporary project root with a `.git` marker. */
export async function createRepo(prefix = 'dsh-lifecycle-hooks-'): Promise<string> {
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

/** Write `.dsh/hooks.json`, accepting either raw text or a JSON value. */
export async function writeHooksFile(root: string, hooks: unknown): Promise<void> {
  const text = typeof hooks === 'string' ? hooks : JSON.stringify(hooks, null, 2)
  await writeFileIn(root, '.dsh/hooks.json', text)
}

/** One hook entry with the walking-skeleton defaults filled in. */
export function hook(overrides: Record<string, unknown> & { id: string }): Record<string, unknown> {
  return { on: 'tool.pre', ...overrides }
}

/** A `builtin` deny run. */
export function deny(reason: string): Record<string, unknown> {
  return { type: 'builtin', action: 'deny', reason }
}

/** Drive one complete turn and wait for the agent to go idle. */
export async function runTurn(agent: Agent, text = 'go'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Scripted bash tool call, with the required description defaulted. */
export function bashToolCall(
  id: string,
  command: string,
  options: { workdir?: string; description?: string } = {},
) {
  return toolCallResponse(id, 'bash', {
    command,
    description: options.description ?? 'run one command',
    ...options.workdir === undefined ? {} : { workdir: options.workdir },
  })
}

/** Every plugin record of the hook-run type this session retained, in order. */
export function hookRunRecords(session: { snapshotEvents(): readonly SessionEvent[] }): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const event of session.snapshotEvents()) {
    const record = pluginRecordOf(event)
    if (record === undefined || record.type !== RUN_RECORD_TYPE) continue
    records.push(record.data as Record<string, unknown>)
  }
  return records
}
