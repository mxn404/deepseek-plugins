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
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isKeptLeftover } from '../types.ts'
import type {
  CopyRef, KeptReason, ListValue, OrphanBranch, PrepareBase, PrepareValue, ReleaseValue, ScopeValue,
  StatusValue, WorktreeItem,
} from '../types.ts'
import { readIntent, writeIntent } from './intent.ts'
import { callHost } from './rpc.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Effective session directory recorded by the host's working-directory
     * service. Declared here so the browser half can read the projection key
     * without importing the host package; the key's type is identical to the
     * declaration that host package merges in.
     */
    workingDirectory: string | null
  }
}

/** Which of the switch's six faces is showing. */
export type TogglePhase = 'checking' | 'off' | 'creating' | 'reverting' | 'ready' | 'failed' | 'disabled'

/**
 * A copy a leave left on disk, and why it stayed.
 *
 * This is the wire's kept-copy face, not the domain's 保留副本: only a `dirty`
 * copy is a leftover someone has to clean up. A `not-owned` copy is somebody
 * else's and is only explained in the switch's hover; see {@link isKeptLeftover}.
 */
export interface KeptCopy {
  /** The copy that is still there. */
  readonly worktree: CopyRef
  /** Why the host kept it: it holds content, or its ownership is unprovable. */
  readonly reason: KeptReason
  /** Host-local detail about the kept copy (change count, new commits). */
  readonly error?: string
}

/** One session's switch state. */
export interface ToggleState {
  /** The face to render. */
  readonly phase: TogglePhase
  /**
   * The project's isolation default: whether a new session with no copy of its
   * own gets one. It is not the switch position — see {@link switchPosition}.
   */
  readonly intent: boolean
  /** The copy this session runs in, once there is one. */
  readonly worktree: CopyRef | null
  /** Repository root the project belongs to, once known. */
  readonly repositoryRoot: string | null
  /** Changed and untracked files in the source checkout, once known. */
  readonly sourceDirty: number
  /** Where the copy's base came from, when this page created it; null otherwise. */
  readonly base: PrepareBase | null
  /** Readable failure for the failed face. */
  readonly error: string | null
  /**
   * Whether the failure currently on screen came from an attempted leave.
   *
   * A refused release and a failed check both set {@link error}, but only the
   * former tried to move the session, so only it may make the hover claim the
   * switch failed to leave. Cleared whenever a check, a leave, or a create
   * succeeds.
   */
  readonly leaveFailed: boolean
  /**
   * The copy the last leave kept, with the reason.
   *
   * A leave that deleted its copy clears this; a leave that kept one fills it,
   * so "off" never claims a clean undo it did not get.
   */
  readonly kept: KeptCopy | null
}

/**
 * The switch position the page shows: on exactly while the session runs in a
 * copy.
 *
 * The position is derived, not stored: `ready` means the host confirmed a copy
 * for this session, and every other face falls back to the project's isolation
 * default. Keeping the two apart is what lets `/new` inherit a copy in a
 * project whose default is off without the control claiming the session runs
 * in the source checkout.
 * @param state - the current switch state.
 * @returns whether the switch reads as on.
 */
export function switchPosition(state: ToggleState): boolean {
  return state.phase === 'ready' ? true : state.intent
}

/** The initial state: nothing is known until the host answers. */
const INITIAL: ToggleState = {
  phase: 'checking',
  intent: false,
  worktree: null,
  repositoryRoot: null,
  sourceDirty: 0,
  base: null,
  error: null,
  leaveFailed: false,
  kept: null,
}

/** The face a slot component receives for one session. */
export interface ChipBinding {
  /** Observable state, read through the synthesized selector hook. */
  readonly hooks: { readonly toggle: SnapshotStore<ToggleState> }
  /** Ask the host what this session's project can do; idempotent. */
  ensure(): void
  /** Re-run the whole check after this session's working directory moved. */
  recheck(): void
  /** Whether this session may still get a copy: only the blank hero may. */
  follow(active: boolean): void
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

/** Which event a frame-level notice reports. */
export type NoticeKind = 'kept' | 'failed'

/** One one-shot frame-level notice; null means nothing is showing. */
export interface NoticeState {
  /** Raises on every notice, so React replaces the frame instead of mutating it. */
  readonly seq: number
  /** Whether a leave kept a copy or failed outright. */
  readonly kind: NoticeKind
  /** The copy a leave kept; null for a failed leave. */
  readonly worktree: CopyRef | null
  /** Host-local detail: the change count or the failure message. */
  readonly message: string | null
}

/** The face the frame-level notice receives. */
export interface NoticeBinding {
  /** Observable state; one notice at a time. */
  readonly hooks: { readonly notice: SnapshotStore<NoticeState | null> }
  /** Clear the notice without opening anything. */
  dismiss(): void
  /** Open the panel where the leftover can be cleaned up. */
  openPanel(): void
}

/**
 * Owns the one-shot notice a leave raises.
 *
 * Kept apart from the switch controller because it is frame-scoped and lives
 * outside every session: the notice survives the session header, and unloading
 * the plugin must drop it without touching any session state.
 */
export class NoticeController {
  private readonly store = createSnapshotStore<NoticeState | null>(null)
  private seq = 0

  /**
   * @param openPanel - opens this plugin's panel.
   */
  constructor(private readonly openPanel: () => void) {}

  /** The stable face handed to the overlay component. */
  readonly face: NoticeBinding = {
    hooks: { notice: this.store },
    dismiss: () => { this.store.set(null) },
    openPanel: () => {
      this.store.set(null)
      this.openPanel()
    },
  }

  /**
   * Show one notice, replacing whatever was showing.
   * @param notice - what happened, without its sequence.
   */
  raise(notice: Omit<NoticeState, 'seq'>): void {
    this.seq += 1
    this.store.set({ seq: this.seq, ...notice })
  }
}

/** Whether the header badge has an answer for its session yet. */
export type ScopePhase = 'checking' | 'in' | 'out' | 'failed'

/** One session's answer from the lightweight `scope` verb. */
export interface ScopeState {
  /** `in` is the only phase that renders; the rest keep the header quiet. */
  readonly phase: ScopePhase
  /** The copy the session runs in, while `in`. */
  readonly worktree: CopyRef | null
  /** Repository root of the project the copy came from, while `in`. */
  readonly repositoryRoot: string | null
  /** Changed and untracked files inside the copy. */
  readonly changedFiles: number
}

/** The first answer before the host has said anything. */
const EMPTY_SCOPE: ScopeState = {
  phase: 'checking',
  worktree: null,
  repositoryRoot: null,
  changedFiles: 0,
}

/** The face the header badge receives for one session. */
export interface BadgeBinding {
  /** Observable copy identity, read through the synthesized selector hook. */
  readonly hooks: { readonly scope: SnapshotStore<ScopeState> }
  /** Ask the host again; expected after every working-directory change. */
  query(): void
  /** Open the panel with this session's copy highlighted. */
  open(): void
}

/**
 * Answers "does this session run in a copy?" per session, once per directory.
 *
 * Deliberately not polled: the badge subscribes to the `workingDirectory`
 * projection and asks again only when that value changes, which is also what
 * makes it appear right after the switch creates a copy.
 */
export class BadgeController {
  private readonly bindings = new Map<string, InternalScope>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - browser Cordis context.
   * @param openCopy - opens the panel with one copy path highlighted.
   */
  constructor(
    private readonly ctx: Context,
    private readonly openCopy: (path: string) => void,
  ) {}

  /**
   * The binding for one session, created on first use.
   * @param sessionId - the session whose header badge is rendering.
   * @returns the stable binding.
   */
  binding(sessionId: SessionId): BadgeBinding {
    const key = String(sessionId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing.face
    const binding = new InternalScope(this.ctx, key, this.lifetime.signal, this.openCopy)
    this.bindings.set(key, binding)
    return binding.face
  }

  /** Abort in-flight reads when the plugin unloads. */
  dispose(): void {
    this.lifetime.abort(new Error('worktree switch unloaded'))
    this.bindings.clear()
  }
}

/** The concrete per-session scope reader behind one {@link BadgeBinding}. */
class InternalScope {
  private readonly store = createSnapshotStore<ScopeState>(EMPTY_SCOPE)
  /** Last answer generation; a stale reply to an older directory must not win. */
  private generation = 0

  readonly face: BadgeBinding

  /**
   * @param ctx - browser Cordis context.
   * @param sessionId - wire session identity.
   * @param signal - plugin lifetime cancellation.
   * @param openCopy - opens the panel with one copy path highlighted.
   */
  constructor(
    private readonly ctx: Context,
    private readonly sessionId: string,
    private readonly signal: AbortSignal,
    private readonly openCopy: (path: string) => void,
  ) {
    this.face = {
      hooks: { scope: this.store },
      query: () => { this.query() },
      open: () => {
        const state = this.store.getSnapshot()
        if (state.worktree !== null) this.openCopy(state.worktree.path)
      },
    }
  }

  /** Ask the host where this session is; a superseding call wins. */
  query(): void {
    void this.run()
  }

  private async run(): Promise<void> {
    this.generation += 1
    const generation = this.generation
    try {
      const value = await callHost<ScopeValue>(this.ctx, 'scope', { sessionId: this.sessionId }, this.signal)
      if (this.signal.aborted || generation !== this.generation) return
      this.store.set(value.inWorktree
        ? {
          phase: 'in',
          worktree: value.worktree,
          repositoryRoot: value.repositoryRoot,
          changedFiles: value.changedFiles,
        }
        : { phase: 'out', worktree: null, repositoryRoot: null, changedFiles: 0 })
    } catch {
      if (this.signal.aborted || generation !== this.generation) return
      this.store.set({ phase: 'failed', worktree: null, repositoryRoot: null, changedFiles: 0 })
    }
  }
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
   * @param notices - frame-level notice the switch raises when a leave keeps a copy or fails.
   * @param onLeftover - asks the panel to re-count leftovers after a leave kept one.
   */
  constructor(
    private readonly ctx: Context,
    private readonly notices: NoticeController,
    private readonly onLeftover: () => void,
  ) {}

  /**
   * The binding for one session, created on first use.
   * @param sessionId - the session whose switch is rendering.
   * @returns the stable binding.
   */
  binding(sessionId: SessionId): ChipBinding {
    const key = String(sessionId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing
    const binding = new InternalBinding(
      this.ctx,
      key,
      this.lifetime.signal,
      this.notices,
      this.onLeftover,
    )
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
  /** A check is in flight; a recheck that arrives meanwhile must not double it. */
  private checking = false
  /** A recheck arrived while one was running: run exactly one more afterwards. */
  private checkAgain = false
  /**
   * Whether the chip is still in the blank-session hero. A session that has
   * history must never be moved, even by a check that was in flight when its
   * first prompt landed.
   */
  private following = false

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
    private readonly notices: NoticeController,
    private readonly onLeftover: () => void,
  ) {
    this.face = {
      hooks: { toggle: this.store },
      ensure: () => { this.ensure() },
      recheck: () => { this.recheck() },
      follow: active => { this.following = active },
      setIntent: next => { this.setIntent(next) },
      retry: () => { this.retry() },
      block: reason => { this.block(reason) },
    }
  }

  /** Run the first status round trip at most once. */
  ensure(): void {
    if (this.started) return
    this.started = true
    this.run()
  }

  /**
   * Re-run the whole check after the session's working directory moved.
   *
   * The working-directory projection is the only announcement of a `/new`
   * inheritance, a host self-heal, or a completed leave, so the switch follows
   * it with the same round trip as the first check. That allows one more
   * `prepare` — only for a session the host reports without a copy while the
   * isolation default is on. A create or leave in flight owns the switch: the
   * change it caused is already covered by its own answer, and a second
   * prepare/release must never race it.
   */
  recheck(): void {
    if (this.creating || this.releasing !== null) return
    if (!this.started) {
      this.ensure()
      return
    }
    this.run()
  }

  /** Run one check, coalescing a recheck that arrives while it is in flight. */
  private run(): void {
    if (this.checking) {
      this.checkAgain = true
      return
    }
    this.checking = true
    void this.check().finally(() => {
      this.checking = false
      if (!this.checkAgain) return
      this.checkAgain = false
      this.recheck()
    })
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
          leaveFailed: false,
        })
        return
      }
      this.project = status.repositoryRoot
      const now = this.store.getSnapshot()
      const intent = readIntent(status.repositoryRoot) ?? status.defaultEnabled
      // A recheck that lands on the same copy keeps where that copy's base came
      // from (the projection change was caused by the page's own prepare); one
      // that lands off keeps the copy a leave just kept, so the hover can still
      // explain why it is on disk.
      const sameCopy = now.worktree !== null
        && status.sessionWorktree !== null
        && now.worktree.path === status.sessionWorktree.path
      const kept = !intent
        && now.phase === 'off'
        && now.kept !== null
        && status.sessionWorktree === null
        ? now.kept
        : null
      const base: ToggleState = {
        phase: 'off',
        intent,
        worktree: status.sessionWorktree,
        repositoryRoot: status.repositoryRoot,
        sourceDirty: status.sourceDirty,
        base: sameCopy ? now.base : null,
        error: null,
        leaveFailed: false,
        kept,
      }
      if (status.sessionWorktree !== null) {
        // A session already in a copy stays there: the project default decides
        // only whether a new session gets one, never where an existing session
        // runs. `/new` inherits the copy, so the switch must show it, not undo it.
        this.store.set({ ...base, phase: 'ready' })
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
      const now = this.store.getSnapshot()
      // A session that is already in a copy must not change face because a
      // recheck failed: the copy is still there, and "failed" would derive the
      // isolation default as the position (an inherited copy could then read
      // off) and claim the session is back in the project directory. Only the
      // ready hover's error line may change; a session with no known copy is
      // the one case that really failed to find out where it runs.
      if (now.worktree !== null) {
        this.store.set({ ...now, error: messageOf(error) })
        return
      }
      this.store.set({ ...now, phase: 'failed', error: messageOf(error) })
    }
  }

  /** Create the copy for a session the switch says should have one. */
  private async create(): Promise<void> {
    // Only the blank hero may isolate a session: a check that was in flight
    // when the first prompt landed must not create a copy afterwards.
    if (!this.following || this.creating) return
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
        base: prepared.state === 'created' ? prepared.base : null,
        error: null,
        leaveFailed: false,
        kept: null,
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
    this.store.set({ ...before, phase: 'reverting', error: null, kept: null })
    try {
      const value = await callHost<ReleaseValue>(this.ctx, 'release', { sessionId: this.sessionId }, this.signal)
      if (this.signal.aborted) return
      const now = this.store.getSnapshot()
      const kept = value.kept !== null && value.keptReason !== null
        ? {
          worktree: value.kept,
          reason: value.keptReason,
          ...value.error === undefined ? {} : { error: value.error },
        }
        : null
      this.store.set({
        ...now,
        phase: 'off',
        intent: false,
        worktree: null,
        base: null,
        error: null,
        leaveFailed: false,
        kept,
      })
      // A copy the switch kept because it holds content is a leftover someone
      // has to clean up: tell them once, and let the sidebar count learn about
      // it without waiting for a panel open. A copy this session never owned is
      // not a leftover — the switch never deletes it, so leaving it behind is
      // the ordinary path and only the hover explains it.
      if (kept !== null && isKeptLeftover(kept.reason)) {
        this.notices.raise({
          kind: 'kept',
          worktree: kept.worktree,
          message: kept.error ?? null,
        })
        this.onLeftover()
      }
    } catch (error) {
      if (this.signal.aborted) return
      const now = this.store.getSnapshot()
      // A refused release leaves the session where it was. Showing "ready" with
      // the reason is honest; showing "off" over a copy in use would not be.
      const message = messageOf(error)
      this.store.set({
        ...now,
        phase: now.worktree === null ? 'off' : 'ready',
        intent: false,
        error: message,
        leaveFailed: true,
        kept: null,
      })
      // A delete the host could not finish is exactly the silent "off" the
      // ADR forbids, so the failure gets the same one-shot notice as a kept copy.
      this.notices.raise({ kind: 'failed', worktree: now.worktree, message })
      // Whatever is left is a cleanup item: recount it, and ask the host where
      // the session actually is now (a refused branch delete still removed the
      // checkout and moved the session back).
      this.onLeftover()
      void this.reread()
    }
  }

  /**
   * Re-read the session's projected state after a failure.
   *
   * The failing verb may still have moved the session before the delete it
   * attempted failed, so the cached "ready in <copy>" face can be stale. This
   * asks once which directory the host now records and shows that; it never
   * creates, releases, or retries anything.
   */
  private async reread(): Promise<void> {
    try {
      const status = await callHost<StatusValue>(this.ctx, 'status', { sessionId: this.sessionId }, this.signal)
      if (this.signal.aborted || !status.supported) return
      const now = this.store.getSnapshot()
      this.store.set({
        ...now,
        phase: status.sessionWorktree === null ? 'off' : 'ready',
        worktree: status.sessionWorktree,
        repositoryRoot: status.repositoryRoot,
        sourceDirty: status.sourceDirty,
      })
    } catch {
      // The failure that brought us here is already on screen; a second one
      // from the re-read would only obscure it.
    }
  }

  /** Persist and apply one switch move. */
  setIntent(next: boolean): void {
    const state = this.store.getSnapshot()
    if (state.phase === 'checking' || state.phase === 'disabled' || state.phase === 'reverting') return
    if (this.project !== null) writeIntent(this.project, next)
    if (!next) {
      // A leave is requested whenever the switch is on, even if the project's
      // isolation default is already off (`/new` inherited this copy): the
      // click is about where this session runs, not about the preference.
      const alreadyOff = state.phase === 'off' && state.worktree === null && !state.intent
      if (alreadyOff) return
      this.store.set({ ...state, intent: false, error: null, kept: null })
      void this.release()
      return
    }
    if (state.intent === next) return
    this.store.set({ ...state, intent: true, error: null, kept: null })
    if (state.phase === 'off' || state.phase === 'failed') void this.create()
  }

  /** Re-run the host round trip with the switch on. */
  retry(): void {
    const state = this.store.getSnapshot()
    if (state.phase !== 'failed') return
    if (this.project !== null) writeIntent(this.project, true)
    this.store.set({ ...state, intent: true, phase: 'off', error: null, kept: null })
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
  /** Generated-name branches no copy checks out, newest first. */
  readonly orphans: readonly OrphanBranch[]
  /**
   * Kept copies this host instance left on disk that have content (or whose
   * deletion failed), and that still exist here. A copy left only because
   * another session owns it is not a kept copy and is not counted.
   */
  readonly keptCopies: number
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
  /** Row key currently being discarded or deleted, if any. */
  readonly busy: string | null
  /** Rows that still need cleanup: leftover branches plus kept copies. */
  readonly cleanup: number
  /** Copy paths a session currently runs in; empty when none is known. */
  readonly current: readonly string[]
}

/**
 * The row key that identifies one copy's row in the panel.
 *
 * The panel's armed/busy state and this controller's in-flight key must agree
 * character for character, so both sides build the key here.
 * @param project - workspace directory the row belongs to.
 * @param name - copy name.
 * @returns the stable row key.
 */
export function copyRowKey(project: string, name: string): string {
  return `${project}\u0000${name}`
}

/**
 * The row key that identifies one leftover branch's row in the panel.
 * @param project - workspace directory the row belongs to.
 * @param branch - branch name.
 * @returns the stable row key.
 */
export function branchRowKey(project: string, branch: string): string {
  return `${project}\u0000branch:${branch}`
}

/** The face the panel and its sidebar icon receive. */
export interface PanelBinding {
  /** Observable state. */
  readonly hooks: { readonly worktrees: SnapshotStore<PanelState> }
  /** Re-read every workspace's pool. */
  refresh(): void
  /** Delete one copy and re-read the pool it lived in. */
  discard(project: string, name: string): void
  /** Delete one leftover branch and re-read the pool it lived in. */
  discardBranch(project: string, branch: string): void
  /** Mark one copy as the current one, where a session snapshot cannot say it. */
  highlight(path: string): void
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
    cleanup: 0,
    current: [],
  })
  private readonly lifetime = new AbortController()
  /** The read in flight, so overlapping refreshes coalesce into one more read. */
  private running: Promise<void> | null = null
  /** A refresh arrived while one was in flight. */
  private again = false
  /** A copy path the badge click asked to highlight; wins over the derived ones. */
  private highlighted: string | null = null
  /** The failure a completed read must publish; a fresh read clears it. */
  private failure: string | null = null

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
    discardBranch: (project, branch) => { void this.discardBranch(project, branch) },
    highlight: path => { this.highlight(path) },
    close: () => {
      this.highlighted = null
      this.leave()
    },
  }

  /**
   * Start the count the sidebar entry shows.
   *
   * Runs without the panel being open, so a leftover is visible from the
   * sidebar, and follows the workspace list because a project added later has
   * a pool this page has never read.
   * @returns disposer for the workspace subscription.
   */
  watch(): () => void {
    this.refresh()
    const workspaces = this.ctx.get('workspaces')
    if (workspaces === undefined) return () => {}
    return workspaces.list.subscribe(() => { this.refresh() })
  }

  /** Read every workspace's pool; projects that fail stay visible with their error. */
  refresh(): void {
    this.failure = null
    this.start()
  }

  /** Run one read, or queue exactly one more behind the read in flight. */
  private start(): void {
    if (this.running !== null) {
      this.again = true
      return
    }
    this.running = this.run().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        this.start()
      }
    })
  }

  /** Mark one copy current without asking the host: the badge already knows it. */
  highlight(path: string): void {
    this.highlighted = path
    this.store.set({ ...this.store.getSnapshot(), current: [path] })
  }

  private async run(): Promise<void> {
    const workspaces = this.ctx.get('workspaces')
    if (workspaces === undefined) {
      this.store.set({
        loading: false,
        groups: [],
        error: 'the workspace service is not mounted',
        busy: null,
        cleanup: 0,
        current: [],
      })
      return
    }
    const items = workspaces.list.getSnapshot().items
    this.store.set({ ...this.store.getSnapshot(), loading: true })
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
            orphans: listed.orphans,
            keptCopies: listed.keptCopies,
            error: null,
          }
          : {
            path: workspace.path,
            title: workspace.title,
            supported: false,
            items: [],
            orphans: [],
            keptCopies: 0,
            error: null,
          })
      } catch (error) {
        if (this.lifetime.signal.aborted) return
        groups.push({
          path: workspace.path,
          title: workspace.title,
          supported: true,
          items: [],
          orphans: [],
          keptCopies: 0,
          error: messageOf(error),
        })
      }
    }
    if (this.lifetime.signal.aborted) return
    this.store.set({
      loading: false,
      groups,
      error: this.failure,
      busy: null,
      cleanup: groups.reduce((sum, group) => sum + group.orphans.length + group.keptCopies, 0),
      current: this.highlighted !== null ? [this.highlighted] : this.currentCopies(groups),
    })
  }

  /**
   * The copies a session is currently inside.
   *
   * Read from the Session Controller instead of the host: it is already on the
   * page, and a new host event would have to be threaded through the wire for
   * one highlight. The main-view retention count tells which session is the
   * one on screen, so archived rows never mark a copy.
   * @param groups - the groups just read.
   * @returns copy paths that session's working directory falls inside.
   */
  private currentCopies(groups: readonly PanelGroup[]): readonly string[] {
    // The Context type is shared with the host half, and the host's own
    // `dsh-session` service claims the same `sessions` key, so the client-side
    // Session Controller is read through its own face instead of that key's
    // last declaration in this package's type program.
    const sessions = this.ctx.get('sessions') as unknown as ISessions | undefined
    if (sessions === undefined) return []
    const list = sessions.list.getSnapshot()
    const found = new Set<string>()
    for (const row of Object.values(list.byId)) {
      if ((row.retainedBy.mainView ?? 0) <= 0) continue
      const binding = sessions.binding(row.id)
      if (binding === undefined) continue
      const directory = binding.session.projections.faceOf('workingDirectory').getSnapshot()
      if (typeof directory !== 'string' || directory === '') continue
      for (const group of groups) {
        for (const item of group.items) {
          if (directory === item.path || directory.startsWith(`${item.path}/`)) found.add(item.path)
        }
      }
    }
    return [...found]
  }

  private async discard(project: string, name: string): Promise<void> {
    const key = copyRowKey(project, name)
    this.store.set({ ...this.store.getSnapshot(), busy: key, error: null })
    try {
      await callHost(this.ctx, 'discard', { path: project, name }, this.lifetime.signal)
      this.store.set({ ...this.store.getSnapshot(), busy: null })
      this.refresh()
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      this.store.set({ ...this.store.getSnapshot(), busy: null, error: messageOf(error) })
    }
  }

  /**
   * Delete one leftover branch.
   *
   * A host refusal (the branch is gone already, or a copy has it checked out)
   * still re-reads the pool: the row the user clicked may be stale, and the
   * refreshed list is the honest answer either way.
   * @param project - workspace directory the branch's pool belongs to.
   * @param branch - branch to delete.
   */
  private async discardBranch(project: string, branch: string): Promise<void> {
    const key = branchRowKey(project, branch)
    this.store.set({ ...this.store.getSnapshot(), busy: key, error: null })
    try {
      await callHost(this.ctx, 'discardBranch', { path: project, branch }, this.lifetime.signal)
      this.store.set({ ...this.store.getSnapshot(), busy: null })
      this.refresh()
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      // A refusal may mean the row was stale (the branch is gone already), so
      // the list is re-read; the error line survives that read on purpose.
      const message = messageOf(error)
      this.failure = message
      this.store.set({ ...this.store.getSnapshot(), busy: null, error: message })
      this.start()
    }
  }

  /** Abort in-flight reads when the plugin unloads. */
  dispose(): void {
    this.lifetime.abort(new Error('worktree switch unloaded'))
  }
}
