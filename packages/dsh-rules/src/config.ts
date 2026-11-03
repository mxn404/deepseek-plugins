/**
 * Row configuration for the `dsh-rules` host plugin.
 *
 * The row defaults live here and nowhere else: `apply` receives the config the
 * Loader already validated and defaulted.
 *
 * @module dsh-rules/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Row config accepted from `cordis.patch.yml`. */
export interface Config {
  /**
   * Rule-root directory names, resolved against the project root and every
   * directory between it and the agent's working directory.
   */
  roots: string[]
  /** Maximum UTF-8 bytes of one rule file; a larger rule is not injected. */
  maxBytes: number
  /** Byte budget of the session-start rule index; overflow degrades the index. */
  indexMaxBytes: number
  /**
   * Whether conservative single-file shell reads count as triggers. Consumed by
   * the shell-trigger slice; accepted here so profiles can pin it already.
   */
  includeBashReads: boolean
  /**
   * Whether injected rules are replayed after a session compaction. Consumed by
   * the compaction slice; accepted here so profiles can pin it already.
   */
  replayAfterCompaction: boolean
}

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  roots: Schema.array(Schema.string())
    .default(['.dsh/rules'])
    .description('Rule-root directories, resolved under the project root and every ancestor down to the working directory.'),
  maxBytes: Schema.number()
    .step(1)
    .min(1)
    .default(65536)
    .description('Maximum UTF-8 bytes of one rule file. Larger rules fail closed and are reported in the index.'),
  indexMaxBytes: Schema.number()
    .step(1)
    .min(1)
    .default(4096)
    .description('Byte budget of the session-start rule index. Overflow drops titles, then paths, then the index itself.'),
  includeBashReads: Schema.boolean()
    .default(true)
    .description('Treat conservative single-file shell reads as triggers. Takes effect with the shell-trigger slice.'),
  replayAfterCompaction: Schema.boolean()
    .default(true)
    .description('Re-inject rules after a session compaction. Takes effect with the compaction slice.'),
})

/** Configuration normalized for discovery. */
export interface ResolvedConfig {
  roots: string[]
  maxBytes: number
  indexMaxBytes: number
}

const RESERVED_ROOT_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..'])

/**
 * Normalize the row config for use by discovery and rendering.
 *
 * Defaults are not re-applied here: the Loader has already filled them from
 * {@link Config}. Only unusable root names are filtered out.
 * @param config - validated row config.
 * @returns the resolved config.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    roots: [...new Set(config.roots.filter(root => !RESERVED_ROOT_SEGMENTS.has(root)))],
    maxBytes: config.maxBytes,
    indexMaxBytes: config.indexMaxBytes,
  }
}
