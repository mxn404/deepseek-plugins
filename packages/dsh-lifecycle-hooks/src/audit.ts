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
 * @module dsh-lifecycle-hooks/audit
 */

import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import type { HookRun } from './handler.ts'
import type { HookAction, HookEvent, HookHandlerKind } from './hook.ts'

/**
 * Payload of one `plugin:dsh-lifecycle-hooks/run` record.
 *
 * `duration_ms` is rounded to whole milliseconds; `error` appears only on a
 * failed run, and `action` only on a run that produced a decision.
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
  /** Clock milliseconds the run took. */
  readonly duration_ms: number
  /** Exit code of a command run; absent for a builtin or a signal death. */
  readonly exit_code?: number
  /** Failure detail, absent on a successful run. */
  readonly error?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-lifecycle-hooks/run': HookRunRecord
  }
}

/**
 * Append one run's audit record to the Session log.
 * @param session - the Session the run happened for.
 * @param run - the measured run.
 */
export function recordHookRun(session: Session, run: HookRun): void {
  // A run can carry context without an action; the record must then omit
  // `action` entirely, because an explicit `undefined` is not lossless JSON
  // and the Session would reject the whole record.
  const action = run.decision?.action
  const record: HookRunRecord = {
    event: run.event,
    source: run.source,
    hook_id: run.hook.id,
    handler: run.handler,
    ...action === undefined ? {} : { action },
    duration_ms: run.durationMs,
    ...run.exitCode === undefined ? {} : { exit_code: run.exitCode },
    ...run.error === undefined ? {} : { error: run.error },
  }
  appendPluginRecord(session, 'plugin:dsh-lifecycle-hooks/run', record)
}
