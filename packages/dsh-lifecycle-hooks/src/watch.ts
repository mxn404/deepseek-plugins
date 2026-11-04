/**
 * `fs.watch` based hot reload for hooks discovery.
 *
 * A watcher owns one non-recursive watch per directory that holds a candidate
 * layer file. Events are debounced, so one editor save that produces `rename`
 * and `change` bursts costs one invalidation. The owner re-reads the reported
 * file on the next resolve; the cache keeps that file's last valid parse when
 * the new content is broken.
 *
 * Watching is a latency optimisation, never the source of truth: discovery
 * re-stats every candidate before each resolve, so an event this layer misses
 * (a directory created mid-session, a platform without inotify, a failed
 * `fs.watch`) only costs one extra read, not a stale rule. For that reason a
 * watch failure is silent: it has no user-visible consequence.
 *
 * @module dsh-lifecycle-hooks/watch
 */

import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** What {@link HookWatcher} needs from its owner. */
export interface HookWatcherOptions {
  /** Quiet period after the last event before the burst is reported. */
  readonly debounceMs: number
  /**
   * Called once per debounced burst with the absolute path the event named, or
   * `undefined` when the platform did not name one (invalidate everything).
   */
  readonly onChange: (source: string | undefined) => void
}

/**
 * Watch the directories of one Session's candidate hook files.
 *
 * One instance per Session: two Sessions with different working directories
 * watch different trees, and a directory change retargets the same instance.
 */
export class HookWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private timer: NodeJS.Timeout | undefined
  private pending: string | undefined
  private closed = false

  /** @param options - debounce window and the change sink. */
  constructor(private readonly options: HookWatcherOptions) {}

  /**
   * Watch exactly these directories, closing any that are no longer wanted.
   * Calling it with the same set is cheap and does not reopen watchers.
   * @param directories - existing directories from the last discovery pass.
   */
  retarget(directories: readonly string[]): void {
    if (this.closed) return
    const wanted = new Set(directories)
    for (const [directory, watcher] of this.watchers) {
      if (wanted.has(directory)) continue
      watcher.close()
      this.watchers.delete(directory)
    }
    for (const directory of wanted) {
      if (this.watchers.has(directory)) continue
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          const name = filename === null ? undefined : filename.toString()
          this.schedule(name === undefined ? undefined : join(directory, name))
        })
        // A directory that vanishes ends its watch; the next retarget cleans it
        // up and the stat check keeps discovery correct in the meantime.
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(directory)
        })
        this.watchers.set(directory, watcher)
      } catch {
        // See the module note: a missed watch is not a correctness problem.
      }
    }
  }

  /** Stop watching every directory and cancel a pending debounce. */
  close(): void {
    this.closed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  /**
   * Collapse an event burst into one report.
   * @param source - absolute path the event named, when the platform named one.
   */
  private schedule(source: string | undefined): void {
    if (this.closed) return
    this.pending = source
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      const changed = this.pending
      this.pending = undefined
      this.options.onChange(changed)
    }, this.options.debounceMs)
  }
}
