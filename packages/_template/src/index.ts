import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin id. Keep it equal to the package name: the bundle row in
 * `cordis.patch.yml`, the browser module id and the Host's Loader entry all
 * resolve through the package name.
 */
export const name = 'dsh-plugin-template'

/**
 * Services this plugin needs before `apply` runs. Uncomment and list them when
 * the plugin uses a service such as `tools`, `llm` or `webServer`.
 *
 * @example
 * ```ts
 * export const inject = ['tools']
 * ```
 */

/** Row config accepted from `cordis.patch.yml`. */
export interface Config {
  /** Text the template reserves for its first real use. */
  greeting: string
}

/**
 * Schemastery schema for {@link Config}. Defaults live in the schema, so a row
 * without a `config` block still validates.
 */
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('hello from dsh-plugin-template'),
})

/**
 * Host half: runs inside the DSH Host as a plain Cordis plugin.
 *
 * Everything registered through `ctx` is disposed when the plugin unloads or
 * reloads. Use `ctx.effect()` for resources the framework cannot track.
 *
 * @param ctx - the Cordis context.
 * @param config - the row config, validated and defaulted by {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Register capabilities on `ctx` here. This template registers nothing, so the
  // row is inert until the first real capability lands.
  ctx.effect(() => {
    // The returned function runs on unload or reload.
    return () => {}
  })

  void config
}
