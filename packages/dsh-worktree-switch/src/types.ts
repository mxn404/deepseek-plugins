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

/** One copy the switch created or found already run by the session. */
export interface WorktreeRef {
  /** Name, branch and directory segment; all three are this one string. */
  readonly name: string
  /** Absolute checkout path. */
  readonly path: string
  /** Branch created for, and checked out by, this copy. */
  readonly branch: string
}

/**
 * One copy on disk, as the list, the scope answer and the leave result name it.
 *
 * The directory name is always {@link name}. A copy created by the switch
 * checks out the same string as a branch, but a detached copy has no branch at
 * all, and no reader may invent one from the directory name.
 */
export interface CopyRef {
  /** Name and directory segment; both are this one string. */
  readonly name: string
  /** Absolute checkout path. */
  readonly path: string
  /** Branch checked out here, or null for a detached copy. */
  readonly branch: string | null
}

/** What the switch needs before deciding whether to create anything. */
export type StatusValue =
  | {
    readonly supported: true
    /** Root of the Git repository the session's project belongs to. */
    readonly repositoryRoot: string
    /** The copy this session already runs in, or null. */
    readonly sessionWorktree: CopyRef | null
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
    /** A copy the session already ran in; it may be detached, so no branch is claimed. */
    readonly worktree: CopyRef
    readonly repositoryRoot: string
    readonly sourceDirty: number
  }

/** A session's confirmed copy, as the host-side scope hint reads it. */
export interface SessionScope {
  /** The copy the session runs in. */
  readonly worktree: CopyRef
  /** Canonical root of the project the copy was made from. */
  readonly repositoryRoot: string
}

/**
 * Why leaving the copy did not delete it.
 *
 * `dirty` means the copy has content to lose — uncommitted changes, new commits,
 * or both. `not-owned` means the switch cannot prove it created this copy for
 * this session (a copy made by hand, or one created before ownership markers
 * existed); neither state is ever overruled by a guess.
 */
export type KeptReason = 'dirty' | 'not-owned'

/** The result of turning the switch off before the first prompt. */
export type ReleaseValue = {
  /** The checkout the session now runs in. */
  readonly directory: string
  /**
   * The copy this call deleted because the switch created it, it never left its
   * base commit, and it has no uncommitted changes; null otherwise.
   */
  readonly removed: CopyRef | null
  /** A copy left on disk, or null when this leave left nothing behind. */
  readonly kept: CopyRef | null
  /** Why {@link kept} was kept; null exactly when nothing was kept. */
  readonly keptReason: KeptReason | null
  /** Host-local English detail about a kept copy (change count, new commits). */
  readonly error?: string
}

/**
 * Whether the session runs in a copy, for the header badge.
 *
 * This is the lightweight question: it never reads the source checkout's
 * status and never moves a directory. `changedFiles` counts the copy's own
 * uncommitted files, which is what the badge tooltip shows.
 */
export type ScopeValue =
  | {
    readonly inWorktree: true
    readonly worktree: CopyRef
    readonly repositoryRoot: string
    /** Changed and untracked files inside the copy. */
    readonly changedFiles: number
  }
  | {
    readonly inWorktree: false
  }

/** One row of the panel's list. */
export interface WorktreeItem extends CopyRef {
  /** Milliseconds since the epoch, from the checkout directory's birth time. */
  readonly createdAt: number
  /** Changed and untracked files inside the copy. */
  readonly changedFiles: number
  /** The checkout directory is gone, so only Git metadata remains to prune. */
  readonly prunable: boolean
}

/**
 * One generated-name branch with no checkout anywhere.
 *
 * A leftover from an isolation that ended without deleting its branch. It is
 * listed so a person can delete it deliberately; nothing reclaims it.
 */
export interface OrphanBranch {
  /** Branch name; matches the switch's generated-name format. */
  readonly branch: string
  /** Commits on this branch that the source checkout's HEAD does not contain. */
  readonly commits: number
  /** Subject line of the branch tip's commit. */
  readonly subject: string
  /** Milliseconds since the epoch of the tip commit's committer date. */
  readonly committedAt: number
}

/** The copies under one project's pool, plus what still needs cleaning up. */
export type ListValue =
  | {
    readonly supported: true
    readonly repositoryRoot: string
    readonly items: readonly WorktreeItem[]
    /** Generated-name branches with no checkout, oldest last. */
    readonly orphans: readonly OrphanBranch[]
    /**
     * Kept copies this host instance left on disk and that still exist here.
     * A host restart forgets them; the panel then counts leftovers only, which
     * is the honest floor.
     */
    readonly keptCopies: number
  }
  | {
    readonly supported: false
    readonly reason: 'not-a-git-repository'
  }

/** A completed discard of one copy. */
export interface DiscardValue {
  readonly removed: true
  readonly name: string
  /** Branch deleted with the checkout, or null for a detached copy. */
  readonly branch: string | null
  readonly path: string
}

/** A completed deletion of one leftover branch. */
export interface DiscardBranchValue {
  readonly removed: true
  readonly branch: string
}
