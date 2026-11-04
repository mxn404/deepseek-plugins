/**
 * The facts one hook run hands to a command: the stdin JSON payload and the
 * `DSH_HOOK_*` environment.
 *
 * Both carry the same information on purpose. A script that parses JSON should
 * read stdin; a shell one-liner should read the environment. The names are part
 * of the format contract: `DSH_HOOK_EVENT`, `DSH_HOOK_SESSION_ID`,
 * `DSH_HOOK_CWD`, `DSH_HOOK_TURN`, `DSH_HOOK_STEP`, and `DSH_HOOK_ID` are
 * always present, and the payload's `event` / `session_id` / `cwd` / `turn` /
 * `step` / `hook_id` always agree with them.
 *
 * @module dsh-lifecycle-hooks/payload
 */

import type { HookEvent } from './hook.ts'

/** The event facts every payload and environment carries. */
export interface PayloadFacts {
  /** Lifecycle point firing. */
  readonly event: HookEvent
  /** Session the event belongs to. */
  readonly sessionId: string
  /** Session's current working directory, and the command's workdir. */
  readonly cwd: string
  /** Agent the event belongs to; equals the Session id for a root agent. */
  readonly agentId: string
  /** Turn number of the latest opened turn; 0 before the first turn. */
  readonly turn: number
  /** Step number of the latest opened step; 0 when no step was observed. */
  readonly step: number
  /** Absolute path of the hooks file the entry came from. */
  readonly source: string
  /** The entry's `id`. */
  readonly hookId: string
}

/**
 * Build the JSON object written to a command hook's stdin.
 * @param facts - the common event facts.
 * @param eventFields - the event's own payload fields: the `tool` block on both
 * tool events, plus `result` (`is_error`, `content`) on `tool.post`.
 * @returns the payload object; `time` is stamped now.
 */
export function commandPayload(
  facts: PayloadFacts,
  eventFields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event: facts.event,
    time: Date.now(),
    session_id: facts.sessionId,
    cwd: facts.cwd,
    agent_id: facts.agentId,
    turn: facts.turn,
    step: facts.step,
    source: facts.source,
    hook_id: facts.hookId,
    ...eventFields,
  }
}

/**
 * Build the `DSH_HOOK_*` environment entries for a command hook.
 * @param facts - the same facts the payload carries.
 * @returns the environment map, with numbers rendered as decimal strings.
 */
export function commandEnv(facts: PayloadFacts): Record<string, string> {
  return {
    DSH_HOOK_EVENT: facts.event,
    DSH_HOOK_SESSION_ID: facts.sessionId,
    DSH_HOOK_CWD: facts.cwd,
    DSH_HOOK_TURN: String(facts.turn),
    DSH_HOOK_STEP: String(facts.step),
    DSH_HOOK_ID: facts.hookId,
  }
}
