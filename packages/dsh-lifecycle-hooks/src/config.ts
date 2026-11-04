/**
 * Row configuration for the `dsh-lifecycle-hooks` host plugin.
 *
 * The row defaults live here and nowhere else: `apply` receives the config the
 * Loader already validated and defaulted. Settings a later ticket introduces
 * join this schema rather than a second place to remember.
 *
 * @module dsh-lifecycle-hooks/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Row config accepted from `cordis.patch.yml`. */
export interface Config {
  /**
   * Whether every hook run appends a `plugin:dsh-lifecycle-hooks/run` record to
   * the Session. The records are the plugin's audit trail; turning this off
   * leaves only the log lines a failing hook produces.
   */
  audit: boolean
  /**
   * Per-hook timeout used when a hook entry declares no own `timeoutMs`. A
   * `builtin` action settles synchronously, so only the asynchronous handler
   * kinds a later ticket adds can actually reach it.
   */
  defaultTimeoutMs: number
}

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  audit: Schema.boolean()
    .default(true)
    .description('Append one plugin record per hook run to the Session log.'),
  defaultTimeoutMs: Schema.number()
    .step(1)
    .min(1)
    .default(30000)
    .description('Timeout for a hook entry that declares no timeoutMs.'),
})
