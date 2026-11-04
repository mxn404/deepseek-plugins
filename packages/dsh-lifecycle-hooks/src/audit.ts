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
  /** The decision the run produced, absent when it observed or failed. */
  readonly action?: HookAction
  /** Wall-clock milliseconds the run took. */
  readonly duration_ms: number
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
  const record: HookRunRecord = {
    event: run.event,
    source: run.source,
    hook_id: run.hook.id,
    handler: run.handler,
    ...run.decision === undefined ? {} : { action: run.decision.action },
    duration_ms: run.durationMs,
    ...run.error === undefined ? {} : { error: run.error },
  }
  appendPluginRecord(session, 'plugin:dsh-lifecycle-hooks/run', record)
}
