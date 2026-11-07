---
'dsh-worktree-switch': minor
---

Copies are now created from `origin`'s default branch instead of the local `HEAD`. Before
a copy is created the host half fetches only that branch (resolution order:
`refs/remotes/origin/HEAD`, then `main`, then `master`) under a 5 second bound and bases
the copy on the fetched commit, so a checkout that is behind origin no longer makes a new
session start from stale code. The fetch is best-effort: no `origin`, no resolvable
default branch, a failure or a timeout all fall back silently to the local `HEAD` and
never block creation; only a remote with a resolved default branch whose fetch failed
adds the hover-hint note 「基点：本地 HEAD（远端未取到）」. New `baseRef` config opts out:
`baseRef: 'head'` skips resolution and network entirely and uses the local `HEAD`, the
escape hatch for unpushed work in a feature branch. The value is validated strictly, so a
typo fails plugin mount rather than silently picking the other base, and there is no GUI
control — set it in the profile's patch layer like `defaultEnabled`. Existing copies,
`status`, `release` and `discard` never fetch.
