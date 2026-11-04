/**
 * The Session audit trail: one plugin record per hook run.
 *
 * The record is `plugin:dsh-lifecycle-hooks/run`, declared in
 * {@link PluginRecordMap} so writes are typed and the Session's plugin-record
 * catalog knows the name. Records are `ignorable`: they never enter the model
 * surface, and fork/resume carry them along with the rest of the log. With no
 * UI, this record plus the plugin's warnings are the only observable trace of
 * what a hook decided, so a run is written even when the hook observed rather
 * than acted, and even when it failed.
 *
 * A run record describes what the hook produced, not what the host did with
 * it. `action: "ask"` at `tool.pre` therefore means "the hook asked for a
 * confirmation", not "the user allowed it": the host runs its approval flow
 * after the pre-execute listener returns, and writes the final outcome as its
 * own durable `approval/asked` + `approval/decided` Session pair. The plugin
 * deliberately does not duplicate that pair in its record.
 *
 * The plugin-record API is experimental, so the write is guarded: when it
 * cannot take the record, the same payload is appended to
 * `<cwd>/.dsh/hooks-audit.jsonl` with one warning per file. A successful
 * record never touches the file, and `audit: false` skips both.
 *
 * @module dsh-lifecycle-hooks/audit
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type { HookRun } from './handler.ts'
import { messageOf } from './message.ts'
import type { HookAction, HookEvent, HookHandlerKind } from './hook.ts'

/**
 * Payload of one `plugin:dsh-lifecycle-hooks/run` record.
 *
 * `duration_ms` is rounded to whole milliseconds; `error` appears only on a
 * failed run, and `action` only on a run that produced an outcome.
 */
export interface HookRunRecord {
  /** Lifecycle point the hook ran at. */
  readonly event: HookEvent
  /** Absolute path of the hooks file the entry came from. */
  readonly source: string
  /** The entry's `id`. */
  readonly hook_id: string
  /** Handler kind that ran. */
  readonly handler: HookHandlerKind
  /**
   * The action the run produced, absent when it observed or failed. Whether
   * the event applied it is a separate question: an event whose plan does not
   * support the action ignores it (with a warning), and a detached run's
   * outcome never reaches the event at all.
   */
  readonly action?: HookAction
  /**
   * `turn.stop` only: consecutive continues already granted in this turn, the
   * same number the payload carried. Present on every run at that event,
   * including one whose continue the loop guard ignored.
   */
  readonly continued_count?: number
  /** Clock milliseconds the run took. */
  readonly duration_ms: number
  /** Exit code of a command run; absent for a builtin or a signal death. */
  readonly exit_code?: number
  /** Failure detail, absent on a successful run. */
  readonly error?: string
  /**
   * Free-form document the handler attached to its outcome, present only when
   * it reported one. Audit-only: no event plan acts on it.
   */
  readonly meta?: Record<string, unknown>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-lifecycle-hooks/run': HookRunRecord
  }
}

/** Name the Session's plugin-record catalog knows this run under. */
const RECORD_TYPE = 'plugin:dsh-lifecycle-hooks/run'

/** Directory, under the Session's cwd, that receives the fallback trail. */
const FALLBACK_DIRECTORY = '.dsh'

/** File that receives one JSON line per run when the record API cannot take it. */
const FALLBACK_FILE = 'hooks-audit.jsonl'

/** Fallback files already warned about, so one broken host warns once, not once per run. */
const warnedFallbacks = new Set<string>()

/** Everything {@link recordHookRun} needs from its owner. */
export interface AuditOptions {
  /** Session working directory the fallback file is written under. */
  readonly cwd: string
  /** Warning sink; the owner adds the plugin-name prefix. */
  readonly warn: (message: string) => void
  /** The event's consecutive-continue count, for `turn.stop`. */
  readonly continuedCount?: number
}

/**
 * Append one run's audit record to the Session log.
 *
 * The experimental plugin-record API is the primary path. If it cannot take
 * the write — the deployment has no record reader, or the host rejects the
 * record — the same payload is appended to `<cwd>/.dsh/hooks-audit.jsonl`
 * instead, with one warning per file, so a run is never silently lost. A
 * successful record never touches the file.
 * @param session - the Session the run happened for.
 * @param run - the measured run.
 * @param options - fallback location, warning sink, and the continue count.
 */
export function recordHookRun(session: Session, run: HookRun, options: AuditOptions): void {
  const record = buildRecord(run, options.continuedCount)
  try {
    appendPluginRecord(session, RECORD_TYPE, record)
    return
  } catch (error) {
    appendFallback(record, options, error)
  }
}

/**
 * Build the record payload, omitting every field a run did not produce.
 *
 * A run can carry context without an action; the record must then omit
 * `action` entirely, because an explicit `undefined` is not lossless JSON and
 * the Session would reject the whole record.
 * @param run - the measured run.
 * @param continuedCount - the event's consecutive-continue count, when it has one.
 * @returns the record payload.
 */
function buildRecord(run: HookRun, continuedCount?: number): HookRunRecord {
  const action = run.outcome?.action
  const meta = run.outcome?.meta
  return {
    event: run.event,
    source: run.source,
    hook_id: run.hook.id,
    handler: run.handler,
    ...action === undefined ? {} : { action },
    ...continuedCount === undefined ? {} : { continued_count: continuedCount },
    duration_ms: run.durationMs,
    ...run.exitCode === undefined ? {} : { exit_code: run.exitCode },
    ...run.error === undefined ? {} : { error: run.error },
    ...meta === undefined ? {} : { meta },
  }
}

/**
 * Append one record to the file trail and warn once per file about the host
 * failure that sent it there.
 * @param record - the same payload the Session record would have carried.
 * @param options - fallback location and warning sink.
 * @param error - why the record API rejected the write.
 */
function appendFallback(record: HookRunRecord, options: AuditOptions, error: unknown): void {
  const path = join(options.cwd, FALLBACK_DIRECTORY, FALLBACK_FILE)
  let detail = `wrote ${path} instead`
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch (writeError) {
    detail = `the fallback ${path} also failed: ${messageOf(writeError)}`
  }
  if (warnedFallbacks.has(path)) return
  warnedFallbacks.add(path)
  options.warn(`hook run for "${record.hook_id}" was not recorded (${messageOf(error)}); ${detail}`)
}
