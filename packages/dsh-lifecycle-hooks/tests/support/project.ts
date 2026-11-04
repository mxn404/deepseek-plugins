/**
 * Shared fixtures for the `dsh-lifecycle-hooks` integration specs.
 *
 * Temporary repositories, `.dsh/hooks.json` files, scripted tool calls, and
 * one-turn drivers. Everything here is test scaffolding; the behavior under
 * test lives in `src/`.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type SessionEvent, type SessionEventMap } from '@deepseek-ai/dsh-session'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { toolCallResponse } from './mock-adapter.ts'

/** Record type every hook run writes. */
export const RUN_RECORD_TYPE = 'plugin:dsh-lifecycle-hooks/run'

/**
 * Directory under a temporary project that stands in for the user's `$DSH_HOME`.
 *
 * It lives inside the tracked temp root so cleanup removes it; it is not named
 * `.dsh`, so it never doubles as a project layer.
 */
export const DSH_HOME_DIR = '.dsh-home'

/** Create a temporary project root with a `.git` marker. */
export async function createRepo(prefix = 'dsh-lifecycle-hooks-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(root, '.git'), { recursive: true })
  return root
}

/** Absolute `$DSH_HOME` the harness points the plugin at for one temp project. */
export function dshHomeOf(root: string): string {
  return join(root, DSH_HOME_DIR)
}

/** Absolute path of the user-level hooks file for one temp project. */
export function userHooksSource(root: string): string {
  return join(dshHomeOf(root), 'hooks.json')
}

/** Write `<root>/.dsh-home/hooks.json`, accepting raw text or a JSON value. */
export async function writeUserHooksFile(root: string, hooks: unknown): Promise<void> {
  const text = typeof hooks === 'string' ? hooks : JSON.stringify(hooks, null, 2)
  await writeFileIn(root, join(DSH_HOME_DIR, 'hooks.json'), text)
}

/** Write one file, creating parent directories. */
export async function writeFileIn(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

/**
 * Write an executable script into the project, for a `command` hook to run.
 * @param root - project root the path is relative to.
 * @param relativePath - script path, conventionally under `.dsh/hooks/`.
 * @param source - the script body.
 * @returns the absolute path.
 */
export async function writeHookScript(root: string, relativePath: string, source: string): Promise<string> {
  const absolute = join(root, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, source)
  await chmod(absolute, 0o755)
  return absolute
}

/**
 * A node script that reads the command hook's stdin payload, then runs `body`.
 *
 * `payload` and `emit(outcome)` are in scope for the body; `emit` writes one
 * JSON outcome line to stdout, the only thing the handler reads back.
 * @param body - the script body.
 * @returns the script source.
 */
export function nodeScript(body: string): string {
  return [
    'const chunks = []',
    'for await (const chunk of process.stdin) chunks.push(chunk)',
    "const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))",
    "const emit = (outcome) => { process.stdout.write(JSON.stringify(outcome) + '\\n') }",
    body,
    '',
  ].join('\n')
}

/**
 * A `command` hook entry.
 * @param id - hook id.
 * @param command - shell command line, run in the Session's cwd.
 * @param options - optional lifecycle event, match clause, timeout, failure policy, detachment.
 * @returns the JSON entry to write.
 */
export function commandHook(
  id: string,
  command: string,
  options: {
    on?: string
    match?: Record<string, unknown>
    timeoutMs?: number
    onFailure?: 'open' | 'block'
    async?: boolean
  } = {},
): Record<string, unknown> {
  return hook({
    id,
    ...options.on === undefined ? {} : { on: options.on },
    ...options.match === undefined ? {} : { match: options.match },
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.onFailure === undefined ? {} : { onFailure: options.onFailure },
    run: {
      type: 'command',
      command,
      ...options.async === undefined ? {} : { async: options.async },
    },
  })
}

/** Write `.dsh/hooks.json` with the given command and other entries. */
export async function writeHooks(root: string, hooks: Record<string, unknown>[]): Promise<void> {
  await writeHooksFile(root, { version: 1, hooks })
}

/** Write `.dsh/hooks.json`, accepting either raw text or a JSON value. */
export async function writeHooksFile(root: string, hooks: unknown): Promise<void> {
  await writeHooksFileAt(root, hooks)
}

/** Write one directory's `.dsh/hooks.json`. */
export async function writeHooksFileAt(directory: string, hooks: unknown): Promise<void> {
  const text = typeof hooks === 'string' ? hooks : JSON.stringify(hooks, null, 2)
  await writeFileIn(directory, '.dsh/hooks.json', text)
}

/** Write one directory's `.dsh/hooks.local.json`. */
export async function writeLocalHooksFile(directory: string, hooks: unknown): Promise<void> {
  const text = typeof hooks === 'string' ? hooks : JSON.stringify(hooks, null, 2)
  await writeFileIn(directory, '.dsh/hooks.local.json', text)
}

/**
 * A one-file hooks document with a single `tool.pre` builtin deny.
 * @param id - hook id, for the audit row and the test's readability.
 * @param reason - the model-facing denial text.
 * @param match - optional match clause.
 * @returns the JSON value to write.
 */
export function denyFile(
  id: string,
  reason: string,
  match?: Record<string, unknown>,
): Record<string, unknown> {
  return { version: 1, hooks: [hook({ id, run: deny(reason), ...match === undefined ? {} : { match } })] }
}

/** Create a temporary directory with no `.git` marker of its own. */
export async function createPlainDir(prefix = 'dsh-lifecycle-hooks-plain-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** One hook entry with the walking-skeleton defaults filled in. */
export function hook(overrides: Record<string, unknown> & { id: string }): Record<string, unknown> {
  return { on: 'tool.pre', ...overrides }
}

/** A `builtin` deny run. */
export function deny(reason: string): Record<string, unknown> {
  return { type: 'builtin', action: 'deny', reason }
}

/** A `builtin` continue run for a `turn.stop` hook; the reason is optional. */
export function keepGoing(reason?: string): Record<string, unknown> {
  return { type: 'builtin', action: 'continue', ...reason === undefined ? {} : { reason } }
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

/**
 * The latest durable event of one type, for asserting what the turn did.
 *
 * Test-only: production code reads projections, never session history.
 * @param session - the session whose log is read.
 * @param type - the event type to find.
 * @returns the event's data, or `undefined` when the log has no such event.
 */
export function lastSessionEvent<T extends keyof SessionEventMap>(
  session: { snapshotEvents(): readonly SessionEvent[] },
  type: T,
): SessionEventMap[T] | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === type) return event.data as SessionEventMap[T]
  }
  return undefined
}

/**
 * Poll a condition until it holds.
 * @param condition - the condition, evaluated on an interval.
 * @param timeoutMs - how long to keep trying before failing the test.
 */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const stop = Date.now() + timeoutMs
  while (Date.now() < stop) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition did not hold within ${String(timeoutMs)} ms`)
}

