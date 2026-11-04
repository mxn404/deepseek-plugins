/**
 * Browser-side state for the switch and the panel.
 *
 * One object per job, each owning a snapshot store the slot component reads
 * through the framework's selector hook. Nothing here renders, so the behavior
 * is testable without React and the components stay dumb.
 * @module dsh-worktree-switch/client/state
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ListValue, PrepareValue, ReleaseValue, StatusValue, WorktreeItem, WorktreeRef } from '../types.ts'
import { readIntent, writeIntent } from './intent.ts'
import { callHost } from './rpc.ts'

/** Which of the switch's six faces is showing. */
export type TogglePhase = 'checking' | 'off' | 'creating' | 'reverting' | 'ready' | 'failed' | 'disabled'

/** One session's switch state. */
export interface ToggleState {
  /** The face to render. */
  readonly phase: TogglePhase
  /** The switch position: whether new sessions in this project isolate. */
  readonly intent: boolean
  /** The copy this session runs in, once there is one. */
  readonly worktree: WorktreeRef | null
  /** Repository root the project belongs to, once known. */
  readonly repositoryRoot: string | null
  /** Changed and untracked files in the source checkout, once known. */
  readonly sourceDirty: number
  /** Readable failure for the failed face. */
  readonly error: string | null
}

/** The initial state: nothing is known until the host answers. */
const INITIAL: ToggleState = {
  phase: 'checking',
  intent: false,
  worktree: null,
  repositoryRoot: null,
  sourceDirty: 0,
  error: null,
}

/** The face a slot component receives for one session. */
export interface ChipBinding {
  /** Observable state, read through the synthesized selector hook. */
  readonly hooks: { readonly toggle: SnapshotStore<ToggleState> }
  /** Ask the host what this session's project can do; idempotent. */
  ensure(): void
  /** Move the switch, creating a copy when it moves on and none exists. */
  setIntent(next: boolean): void
  /** Try again after a failure, with the switch on. */
  retry(): void
  /** Raise or clear this session's composer block. */
  block(reason: string | null): void
}

/** A thrown value's message, without leaking `undefined`. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === '' ? 'unknown error' : text
}

/**
 * One controller per plugin instance: it caches the state of every session the
 * switch has rendered for, and owns their composer blocks.
 */
export class ToggleController {
  private readonly bindings = new Map<string, ChipBinding>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - browser Cordis context.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * The binding for one session, created on first use.
   * @param sessionId - the session whose switch is rendering.
   * @returns the stable binding.
   */
  binding(sessionId: SessionId): ChipBinding {
    const key = String(sessionId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing
    const binding = new InternalBinding(this.ctx, key, this.lifetime.signal)
    this.bindings.set(key, binding.face)
    return binding.face
  }

  /** Clear every composer block this controller raised. */
  dispose(): void {
    this.lifetime.abort(new Error('worktree switch unloaded'))
    for (const binding of this.bindings.values()) binding.block(null)
    this.bindings.clear()
  }
}

/** The concrete per-session state machine behind one {@link ChipBinding}. */
class InternalBinding {
  private readonly store = createSnapshotStore<ToggleState>(INITIAL)
  private started = false
  /** The project whose remembered choice is in play; null until status answers. */
  private project: string | null = null
  /** A create is in flight; a second one would race the same copy. */
  private creating = false
  /** The release in flight, shared by callers that ask to leave at once. */
  private releasing: Promise<void> | null = null

  readonly face: ChipBinding

  /**
   * @param ctx - browser Cordis context.
   * @param sessionId - wire session identity.
   * @param signal - plugin lifetime cancellation.
   */
  constructor(
    private readonly ctx: Context,
    private readonly sessionId: string,
    private readonly signal: AbortSignal,
  ) {
    this.face = {
      hooks: { toggle: this.store },
      ensure: () => { this.ensure() },
      setIntent: next => { this.setIntent(next) },
      retry: () => { this.retry() },
      block: reason => { this.block(reason) },
    }
  }

  /** Run the first status round trip at most once. */
  ensure(): void {
    if (this.started) return
    this.started = true
    void this.check()
  }

  /** Ask the host for the project's facts and act on the remembered choice. */
  private async check(): Promise<void> {
    try {
      const status = await callHost<StatusValue>(this.ctx, 'status', { sessionId: this.sessionId }, this.signal)
      if (!status.supported) {
        this.store.set({
          ...this.store.getSnapshot(),
          phase: 'disabled',
          intent: status.defaultEnabled,
          error: null,
        })
        return
      }
      this.project = status.repositoryRoot
      const intent = readIntent(status.repositoryRoot) ?? status.defaultEnabled
      const base: ToggleState = {
        phase: 'off',
        intent,
        worktree: status.sessionWorktree,
        repositoryRoot: status.repositoryRoot,
        sourceDirty: status.sourceDirty,
        error: null,
      }
      if (status.sessionWorktree !== null) {
        this.store.set({ ...base, phase: 'ready' })
        // The remembered position is "off", so this session should not be in a
        // copy: finish a leave an earlier page (or a failed undo) left behind.
        if (!intent) void this.release()
        return
      }
      if (!intent) {
        this.store.set(base)
        return
      }
      this.store.set(base)
      await this.create()
    } catch (error) {
      if (this.signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), phase: 'failed', error: messageOf(error) })
    }
  }

  /** Create the copy for a session the switch says should have one. */
  private async create(): Promise<void> {
    if (this.creating) return
    const before = this.store.getSnapshot()
    if (before.repositoryRoot === null || !before.intent) return
    this.creating = true
    this.store.set({ ...before, phase: 'creating', error: null })
    try {
      const prepared = await callHost<PrepareValue>(
        this.ctx,
        'prepare',
        { sessionId: this.sessionId },
        this.signal,
      )
      const now = this.store.getSnapshot()
      if (!now.intent) {
        // The user turned isolation off while the copy was being made: that is
        // the position they asked for, so let the leave finish (it is either in
        // flight or already done) rather than pretending they are isolated.
        if (now.phase === 'reverting') void this.release()
        return
      }
      this.store.set({
        ...now,
        phase: 'ready',
        worktree: prepared.worktree,
        repositoryRoot: prepared.repositoryRoot,
        sourceDirty: prepared.sourceDirty,
        error: null,
      })
    } catch (error) {
      if (this.signal.aborted) return
      const now = this.store.getSnapshot()
      if (!now.intent) {
        if (now.phase === 'reverting') void this.release()
        return
      }
      this.store.set({ ...now, phase: 'failed', error: messageOf(error) })
    } finally {
      this.creating = false
    }
  }

  /**
   * Leave the copy this session runs in, so "off" means the project directory.
   * Concurrent callers share one round trip.
   * @returns completion of the leave.
   */
  private release(): Promise<void> {
    const running = this.releasing
    if (running !== null) return running
    const operation = this.leave().finally(() => {
      if (this.releasing === operation) this.releasing = null
    })
    this.releasing = operation
    return operation
  }

  /** Ask the host to undo the copy and settle the switch on what it reported. */
  private async leave(): Promise<void> {
    const before = this.store.getSnapshot()
    this.store.set({ ...before, phase: 'reverting', error: null })
    try {
      await callHost<ReleaseValue>(this.ctx, 'release', { sessionId: this.sessionId }, this.signal)
      if (this.signal.aborted) return
      const now = this.store.getSnapshot()
      this.store.set({ ...now, phase: 'off', intent: false, worktree: null, error: null })
    } catch (error) {
      if (this.signal.aborted) return
      const now = this.store.getSnapshot()
      // A refused release leaves the session where it was. Showing "ready" with
      // the reason is honest; showing "off" over a copy in use would not be.
      this.store.set({
        ...now,
        phase: now.worktree === null ? 'off' : 'ready',
        intent: false,
        error: messageOf(error),
      })
    }
  }

  /** Persist and apply one switch move. */
  setIntent(next: boolean): void {
    const state = this.store.getSnapshot()
    if (state.phase === 'checking' || state.phase === 'disabled' || state.phase === 'reverting') return
    if (this.project !== null) writeIntent(this.project, next)
    if (!next) {
      if (state.intent === next) return
      this.store.set({ ...state, intent: false, error: null })
      void this.release()
      return
    }
    if (state.intent === next) return
    this.store.set({ ...state, intent: true, error: null })
    if (state.phase === 'off' || state.phase === 'failed') void this.create()
  }

  /** Re-run the host round trip with the switch on. */
  retry(): void {
    const state = this.store.getSnapshot()
    if (state.phase !== 'failed') return
    if (this.project !== null) writeIntent(this.project, true)
    this.store.set({ ...state, intent: true, phase: 'off', error: null })
    void this.create()
  }

  /** Block or release this session's composer through the public registry. */
  block(reason: string | null): void {
    const conversation = this.ctx.get('conversation')
    if (conversation === undefined) return
    conversation.blocks.set(this.sessionId as SessionId, reason === null ? undefined : { reason })
  }
}

/** One project group in the panel. */
export interface PanelGroup {
  /** Workspace directory the group came from. */
  readonly path: string
  /** Workspace title, for the heading. */
  readonly title: string
  /** Whether the directory is a Git repository at all. */
  readonly supported: boolean
  /** The copies under it. */
  readonly items: readonly WorktreeItem[]
  /** Per-project failure text, when reading it failed. */
  readonly error: string | null
}

/** The panel's whole state. */
export interface PanelState {
  /** Whether the list is being read. */
  readonly loading: boolean
  /** Groups, one per known workspace. */
  readonly groups: readonly PanelGroup[]
  /** The last refresh or discard failure. */
  readonly error: string | null
  /** Row key currently being discarded, if any. */
  readonly busy: string | null
}

/** The face the panel and its sidebar icon receive. */
export interface PanelBinding {
  /** Observable state. */
  readonly hooks: { readonly worktrees: SnapshotStore<PanelState> }
  /** Re-read every workspace's pool. */
  refresh(): void
  /** Delete one copy and re-read the pool it lived in. */
  discard(project: string, name: string): void
  /** Leave the panel. */
  close(): void
}

/**
 * Read every workspace's pool and discard copies from the panel.
 */
export class PanelController {
  private readonly store = createSnapshotStore<PanelState>({
    loading: true,
    groups: [],
    error: null,
    busy: null,
  })
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - browser Cordis context.
   * @param leave - called by the panel's Back action.
   */
  constructor(private readonly ctx: Context, private readonly leave: () => void) {}

  /** The stable face handed to the panel component. */
  readonly face: PanelBinding = {
    hooks: { worktrees: this.store },
    refresh: () => { this.refresh() },
    discard: (project, name) => { void this.discard(project, name) },
    close: () => { this.leave() },
  }

  /** Read every workspace's pool; projects that fail stay visible with their error. */
  refresh(): void {
    void this.run()
  }

  private async run(): Promise<void> {
    const workspaces = this.ctx.get('workspaces')
    if (workspaces === undefined) {
      this.store.set({ loading: false, groups: [], error: 'the workspace service is not mounted', busy: null })
      return
    }
    const items = workspaces.list.getSnapshot().items
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: null })
    const groups: PanelGroup[] = []
    for (const workspace of items) {
      try {
        const listed = await callHost<ListValue>(this.ctx, 'list', { path: workspace.path }, this.lifetime.signal)
        groups.push(listed.supported
          ? {
            path: workspace.path,
            title: workspace.title,
            supported: true,
            items: listed.items,
            error: null,
          }
          : {
            path: workspace.path,
            title: workspace.title,
            supported: false,
            items: [],
            error: null,
          })
      } catch (error) {
        if (this.lifetime.signal.aborted) return
        groups.push({
          path: workspace.path,
          title: workspace.title,
          supported: true,
          items: [],
          error: messageOf(error),
        })
      }
    }
    if (this.lifetime.signal.aborted) return
    this.store.set({ loading: false, groups, error: null, busy: null })
  }

  private async discard(project: string, name: string): Promise<void> {
    const key = `${project}\u0000${name}`
    this.store.set({ ...this.store.getSnapshot(), busy: key, error: null })
    try {
      await callHost(this.ctx, 'discard', { path: project, name }, this.lifetime.signal)
      this.store.set({ ...this.store.getSnapshot(), busy: null })
      await this.run()
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), busy: null, error: messageOf(error) })
    }
  }

  /** Abort in-flight reads when the plugin unloads. */
  dispose(): void {
    this.lifetime.abort(new Error('worktree switch unloaded'))
  }
}
