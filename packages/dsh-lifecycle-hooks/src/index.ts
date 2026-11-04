/**
 * Host half of `dsh-lifecycle-hooks`.
 *
 * A repository commits `.dsh/hooks.json`; the plugin discovers the layers that
 * apply to the Session's current directory (the user-level file, then every
 * project and local file from the nearest `.git` root down to that directory)
 * and dispatches their hooks at dsh lifecycle extension points. This slice
 * dispatches `tool.pre` (deny, context, halt) and `tool.post` (block, replace,
 * context, halt), each through the same merge of `builtin` and `command`
 * outcomes.
 *
 * The wiring here is deliberately thin. Discovery lives in `discovery.ts`,
 * reading and validating one hooks file in `hooks-file.ts`, matching in
 * `match.ts`, execution in `handler.ts` / `command.ts`, the per-event payload in
 * `payload.ts`, the single resolve→run→record→merge→apply pipeline in
 * `dispatch.ts`, the decision ranking in `outcome.ts`, and the audit row in
 * `audit.ts`. `apply` only connects them to the host: the watcher lifecycle,
 * the step tracker, and one listener per dispatched event, each of which hands
 * the shared dispatcher a plan and nothing else.
 *
 * @module dsh-lifecycle-hooks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Config } from './config.ts'
import { createDetachedRuns } from './detached.ts'
import { HookResolver } from './discovery.ts'
import { HookDispatcher } from './dispatch.ts'
import { StepTracker } from './step.ts'
import { toolPostPlan } from './tool-post.ts'
import { toolPrePlan } from './tool-pre.ts'
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
  const warn = (message: string): void => {
    ctx.logger.warn(`dsh-lifecycle-hooks: ${message}`)
  }

  const resolver = new HookResolver({
    defaultTimeoutMs: config.defaultTimeoutMs,
    userHooks: config.userHooks,
    projectHooks: config.projectHooks,
    localHooks: config.localHooks,
    warn,
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

  // Detached command runs (entries with `async: true`) are tracked so disposal
  // aborts a still-running process instead of leaking it past the plugin.
  const detached = createDetachedRuns()
  const steps = new StepTracker()

  // `working-directory/change` is a durable SessionEvent, not a Cordis event:
  // observe it through the session's append feed and follow the Session into
  // its new tree before the next tool call arrives. The same feed keeps the
  // step number each payload reports.
  ctx.on('session/event', (session, event) => {
    steps.observe(session, event)
    if (event.type !== 'working-directory/change') return
    retarget(session, event.data.cwd).catch(() => {
      // Discovery never throws for a missing file; a transient filesystem
      // error only means the next tool call's resolve reports it.
    })
  })

  ctx.effect(() => () => {
    for (const watcher of liveWatchers) watcher.close()
    liveWatchers.clear()
    return detached.drain()
  })

  const dispatcher = new HookDispatcher({
    resolver,
    // `ctx.get` rather than `inject`: a deployment without a shell service
    // makes each command hook fail (and its `onFailure` policy apply), instead
    // of making the whole plugin unavailable.
    shell: () => ctx.get('shell'),
    detached,
    audit: config.audit,
    warn,
    onResolve: (session, directories) => {
      // Keep the watcher aligned with the committed cwd even when no hooks
      // exist yet: a layer created mid-session must become visible on the next
      // event.
      watcherFor(session)?.retarget(directories)
    },
  })

  /**
   * The facts every tool event reports to the dispatcher.
   *
   * Both tool seams share them; only the event's own plan differs. An agent is
   * always set for model-driven calls, and the programmatic ones have no
   * Session, so no audit row and no cwd to resolve hooks against.
   * @param exec - the call the event belongs to.
   * @param agent - the agent that issued it.
   * @returns the dispatch call, or `undefined` when the event must pass through.
   */
  const callFor = (exec: ToolExecution, agent: NonNullable<ToolExecution['agent']>) => {
    // Observe cancellation before doing file work; the registry rechecks it
    // after the gate settles either way.
    if (exec.signal.aborted) return undefined
    return {
      session: agent.session,
      cwd: ctx.workingDirectory.get(agent.session),
      agentId: agent.id,
      turn: ctx.get('sessionProjections')?.stateOf(agent.session, 'turnBoundary')?.lastTurn ?? 0,
      step: steps.of(agent.session),
      signal: exec.signal,
    }
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    // Programmatic callers have no Session: nothing to audit, nothing to resolve.
    if (agent === undefined) return next()
    const call = callFor(exec, agent)
    if (call === undefined) return next()
    return await dispatcher.dispatch(call, toolPrePlan(exec, agent)) ?? next()
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // The tool has already run; a hook here rewrites what the model reads and
    // can never prevent the side effect. Programmatic calls pass straight on.
    const agent = exec.agent
    if (agent === undefined) return next()
    const call = callFor(exec, agent)
    if (call === undefined) return next()
    return await dispatcher.dispatch(call, toolPostPlan(exec, result, agent)) ?? next()
  })
}
