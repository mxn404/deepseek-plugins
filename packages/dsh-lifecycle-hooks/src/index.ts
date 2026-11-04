/**
 * Host half of `dsh-lifecycle-hooks`.
 *
 * A repository commits `.dsh/hooks.json`; the plugin discovers the layers that
 * apply to the Session's current directory (the user-level file, then every
 * project and local file from the nearest `.git` root down to that directory)
 * and dispatches their hooks at dsh lifecycle extension points. This slice is
 * the walking skeleton: `tool.pre` with the `builtin` `deny` action, so a
 * dangerous command never runs and the model receives the hook's reason as the
 * tool result.
 *
 * The wiring is deliberately thin. Discovery lives in `discovery.ts`, reading
 * and validating one hooks file in `hooks-file.ts`, matching in `match.ts`,
 * execution in `handler.ts`, the decision merge in `outcome.ts`, and the audit
 * row in `audit.ts`; `apply` only connects them to `tools/pre-execute`.
 *
 * @module dsh-lifecycle-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { recordHookRun } from './audit.ts'
import { Config } from './config.ts'
import { HookResolver } from './discovery.ts'
import { executeHook, type HookRun } from './handler.ts'
import { matchesHook } from './match.ts'
import { mergeDecisions } from './outcome.ts'
import { HookWatcher } from './watch.ts'

/** Plugin id: package name and bundle row id. */
export const name = 'dsh-lifecycle-hooks'

/** Quiet period that collapses one editor save into one cache refresh. */
const WATCH_DEBOUNCE_MS = 50

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
  const resolver = new HookResolver({
    defaultTimeoutMs: config.defaultTimeoutMs,
    userHooks: config.userHooks,
    projectHooks: config.projectHooks,
    localHooks: config.localHooks,
    warn: (message) => {
      ctx.logger.warn(`dsh-lifecycle-hooks: ${message}`)
    },
  })

  // One watcher per Session: two Sessions in different directories watch their
  // own trees, and a directory change retargets the same watcher.
  const watchers = new WeakMap<Session, HookWatcher>()
  const liveWatchers = new Set<HookWatcher>()

  const watcherFor = (session: Session): HookWatcher | undefined => {
    if (!config.watch) return undefined
    const existing = watchers.get(session)
    if (existing !== undefined) return existing
    const watcher = new HookWatcher({
      debounceMs: WATCH_DEBOUNCE_MS,
      // Warm the parse so the next event finds the layer already refreshed; the
      // resolve that event triggers re-stats every file and stays the truth.
      onChange: (source) => {
        resolver.refresh(source).catch(() => {
          // A refresh failure is a missed optimisation; resolve still re-stats.
        })
      },
    })
    watchers.set(session, watcher)
    liveWatchers.add(watcher)
    return watcher
  }

  const retarget = async (session: Session, cwd: string): Promise<void> => {
    const watcher = watcherFor(session)
    if (watcher === undefined) return
    watcher.retarget(await resolver.directories(cwd))
  }

  // `working-directory/change` is a durable SessionEvent, not a Cordis event:
  // observe it through the session's append feed and follow the Session into
  // its new tree before the next tool call arrives.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'working-directory/change') return
    retarget(session, event.data.cwd).catch(() => {
      // Discovery never throws for a missing file; a transient filesystem
      // error only means the next tool call's resolve reports it.
    })
  })

  ctx.effect(() => () => {
    for (const watcher of liveWatchers) watcher.close()
    liveWatchers.clear()
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
      const resolved = await resolver.resolve(ctx.workingDirectory.get(agent.session))
      // Keep the watcher aligned with the committed cwd even when no hooks exist
      // yet: a layer created mid-session must become visible on the next event.
      watcherFor(agent.session)?.retarget(resolved.directories)
      if (resolved.layers.length === 0) return next()
      for (const layer of resolved.layers) {
        for (const hook of layer.hooks) {
          if (!matchesHook(hook.match, exec.name, exec.arguments)) continue
          runs.push(await executeHook(hook, layer.source))
        }
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
