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
  /**
   * Whether `.dsh/hooks.local.json` layers are discovered. They hold personal
   * overrides that stay out of git; turn this off to run only the committed
   * configuration.
   */
  localHooks: boolean
  /**
   * Maximum number of consecutive `continue` outcomes a single turn may grant
   * at `turn.stop`. The guard exists because a stop hook that always continues
   * would otherwise keep the turn alive forever.
   */
  maxStopContinues: number
  /**
   * Whether `.dsh/hooks.json` layers are discovered. Turning this off leaves
   * the user-level file and the `hooks.local.json` layers in play.
   */
  projectHooks: boolean
  /**
   * Whether `${DSH_HOME:-~/.dsh}/hooks.json` is discovered. Turning this off
   * makes a Session see only the layers under its own project.
   */
  userHooks: boolean
  /**
   * Whether `fs.watch` keeps discovery warm. With it off, an edited file is
   * still picked up by the stat check before every resolve; the watcher only
   * makes the change visible sooner.
   */
  watch: boolean
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
  localHooks: Schema.boolean()
    .default(true)
    .description('Discover .dsh/hooks.local.json layers.'),
  maxStopContinues: Schema.number()
    .step(1)
    .min(1)
    .default(8)
    .description('Maximum consecutive turn.stop continues a single turn may grant.'),
  projectHooks: Schema.boolean()
    .default(true)
    .description('Discover .dsh/hooks.json layers.'),
  userHooks: Schema.boolean()
    .default(true)
    .description('Discover the user-level ${DSH_HOME:-~/.dsh}/hooks.json layer.'),
  watch: Schema.boolean()
    .default(true)
    .description('Watch hooks files so edits apply on the next event without a stat delay.'),
})
