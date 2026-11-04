/**
 * Quiescence tracking for detached (`async: true`) command runs.
 *
 * A detached hook is a run nobody awaits: it never contributes to the event's
 * decision, so the event proceeds while the process is still alive. Its work
 * must not outlive the plugin instance, though, so every such run is registered
 * here and the plugin's disposer drains this tracker: the shared signal aborts,
 * `ctx.shell` kills each process group, and disposal resolves only once every
 * run's continuation (its audit row, its warning) has settled.
 *
 * @module dsh-lifecycle-hooks/detached
 */

/** In-flight registry for one plugin instance's detached runs. */
export interface DetachedRuns {
  /**
   * The abort signal every detached run must hand to its execution, so
   * {@link DetachedRuns.drain} kills a still-running process instead of
   * waiting out its timeout.
   */
  readonly signal: AbortSignal
  /**
   * Register one detached run until it settles. Pass the full chain — the
   * process and its continuation — so draining waits for the side effects,
   * not just the exit.
   * @param run - the detached chain; its rejection is absorbed here.
   */
  track(run: Promise<unknown>): void
  /**
   * Abort {@link DetachedRuns.signal}, then resolve once every tracked chain
   * has settled, including chains registered while the drain is in progress.
   * @returns resolves when no detached work remains.
   */
  drain(): Promise<void>
}

/**
 * Create one tracker (one per plugin `apply()`).
 * @returns the tracker; settled runs are pruned as they finish.
 */
export function createDetachedRuns(): DetachedRuns {
  const inflight = new Set<Promise<unknown>>()
  const controller = new AbortController()
  return {
    signal: controller.signal,
    track(run: Promise<unknown>): void {
      inflight.add(run)
      const settled = (): void => { inflight.delete(run) }
      void run.then(settled, settled)
    },
    async drain(): Promise<void> {
      controller.abort(new Error('the lifecycle-hooks plugin was disposed'))
      // Re-check after each wave: a chain can register while an earlier wave
      // settles, and disposal must not resolve with work still running.
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
