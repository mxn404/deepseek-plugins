/**
 * Host half of `dsh-lifecycle-hooks`.
 *
 * A repository commits `.dsh/hooks.json`; the plugin reads the file from the
 * Session's current directory and dispatches its hooks at dsh lifecycle
 * extension points. This first slice is the walking skeleton: `tool.pre` with
 * the `builtin` `deny` action, so a dangerous command never runs and the model
 * receives the hook's reason as the tool result.
 *
 * The wiring is deliberately thin. Reading and validating a hooks file lives in
 * `hooks-file.ts`, matching in `match.ts`, execution in `handler.ts`, the
 * decision merge in `outcome.ts`, and the audit row in `audit.ts`; `apply` only
 * connects them to `tools/pre-execute`.
 *
 * @module dsh-lifecycle-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { recordHookRun } from './audit.ts'
import { Config } from './config.ts'
import { executeHook, type HookRun } from './handler.ts'
import { HOOKS_FILE_PATH, HookSources } from './hooks-file.ts'
import { matchesHook } from './match.ts'
import { mergeDecisions } from './outcome.ts'

/** Plugin id: package name and bundle row id. */
export const name = 'dsh-lifecycle-hooks'

/** Services this plugin needs before `apply` runs. */
export const inject = ['workingDirectory']

export { Config }
export type { Config as HooksConfig }

/**
 * Mount the host half.
 * @param ctx - host context.
 * @param config - validated row config.
 */
export function apply(ctx: Context, config: Config): void {
  const sources = new HookSources({
    defaultTimeoutMs: config.defaultTimeoutMs,
    warn: (message) => {
      ctx.logger.warn(`dsh-lifecycle-hooks: ${message}`)
    },
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    // Programmatic callers have no Session, so no plugin record and no cwd.
    if (agent === undefined) return next()
    // Observe cancellation before doing file work; the registry rechecks it
    // after the gate settles either way.
    if (exec.signal.aborted) return next()

    const runs: HookRun[] = []
    try {
      const source = join(ctx.workingDirectory.get(agent.session), HOOKS_FILE_PATH)
      const snapshot = await sources.load(source)
      if (snapshot === undefined) return next()
      for (const hook of snapshot.hooks) {
        if (!matchesHook(hook.match, exec.name, exec.arguments)) continue
        runs.push(await executeHook(hook, snapshot.source))
      }
    } catch (error) {
      // A hooks-file problem must never break the tool pipeline: fail open with
      // one warning, exactly as a malformed file does.
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`dsh-lifecycle-hooks: hook dispatch failed: ${detail}`)
      return next()
    }

    if (runs.length === 0) return next()

    if (config.audit) {
      for (const run of runs) {
        try {
          recordHookRun(agent.session, run)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`dsh-lifecycle-hooks: hook run for "${run.hook.id}" was not recorded: ${detail}`)
        }
      }
    }

    const decision = mergeDecisions(runs)
    if (decision === undefined) return next()
    if (exec.signal.aborted) return next()
    return { kind: 'deny', reason: decision.reason }
  })
}
