/**
 * Wire vocabulary shared by the host half, the browser half, and the tests.
 *
 * Both halves are built separately; these are the only values that cross
 * between them, so they live in one module and nothing here imports Node or
 * React.
 * @module dsh-worktree-switch/types
 */

/** The two configured base points: fetch the remote default branch, or use local HEAD. */
export type BaseRef = 'fresh' | 'head'

/** One existing copy, as both halves name it. */
export interface WorktreeRef {
  /** Name, branch and directory segment; all three are this one string. */
  readonly name: string
  /** Absolute checkout path. */
  readonly path: string
  /** Branch created for, and checked out by, this copy. */
  readonly branch: string
}

/** What the switch needs before deciding whether to create anything. */
export type StatusValue =
  | {
    readonly supported: true
    /** Root of the Git repository the session's project belongs to. */
    readonly repositoryRoot: string
    /** The copy this session already runs in, or null. */
    readonly sessionWorktree: WorktreeRef | null
    /** Changed and untracked files in the source checkout. */
    readonly sourceDirty: number
    /** Configured default for a project with no remembered choice. */
    readonly defaultEnabled: boolean
  }
  | {
    readonly supported: false
    readonly reason: 'not-a-git-repository'
    readonly defaultEnabled: boolean
  }

/** Where a newly created copy's base commit came from. */
export type PrepareBase =
  /**
   * `origin`'s default branch was fetched and the copy starts at its tip.
   * `branch` is the branch name without the `origin/` prefix.
   */
  | { readonly kind: 'remote'; readonly branch: string }
  /** The local HEAD was used deliberately (`baseRef: 'head'`) or because there was no remote default branch. */
  | { readonly kind: 'head' }
  /** A remote default branch existed, but fetching it failed; the local HEAD was used instead. */
  | { readonly kind: 'fallback' }

/**
 * The result of turning the switch on.
 *
 * `base` exists only on a result that actually created the copy: an existing
 * copy was built by an earlier call (or by hand), so this plugin cannot say
 * where its base came from.
 */
export type PrepareValue =
  | {
    readonly state: 'created'
    readonly worktree: WorktreeRef
    readonly repositoryRoot: string
    readonly sourceDirty: number
    /** Where the copy's base commit came from. */
    readonly base: PrepareBase
  }
  | {
    readonly state: 'existing'
    readonly worktree: WorktreeRef
    readonly repositoryRoot: string
    readonly sourceDirty: number
  }

/** A session's confirmed copy, as the host-side scope hint reads it. */
export interface SessionScope {
  /** The copy the session runs in. */
  readonly worktree: WorktreeRef
  /** Canonical root of the project the copy was made from. */
  readonly repositoryRoot: string
}

/** The result of turning the switch off before the first prompt. */
export type ReleaseValue = {
  /** The checkout the session now runs in. */
  readonly directory: string
  /**
   * The copy this call deleted because the switch created it and it was clean,
   * or null when there was nothing to undo or it was not safe to delete.
   */
  readonly removed: WorktreeRef | null
  /** A copy left on disk: dirty, or not created by the switch. */
  readonly kept: WorktreeRef | null
}

/** One row of the panel's list. */
export interface WorktreeItem extends WorktreeRef {
  /** Milliseconds since the epoch, from the checkout directory's birth time. */
  readonly createdAt: number
  /** Changed and untracked files inside the copy. */
  readonly changedFiles: number
  /** The checkout directory is gone, so only Git metadata remains to prune. */
  readonly prunable: boolean
}

/** The copies under one project's pool. */
export type ListValue =
  | {
    readonly supported: true
    readonly repositoryRoot: string
    readonly items: readonly WorktreeItem[]
  }
  | {
    readonly supported: false
    readonly reason: 'not-a-git-repository'
  }

/** A completed discard. */
export interface DiscardValue {
  readonly removed: true
  readonly name: string
  readonly branch: string
  readonly path: string
}
