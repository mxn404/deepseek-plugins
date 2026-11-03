# dsh-worktree-switch

## 0.2.0

### Minor Changes

- 292e803: Add the Worktree switch plugin: a New Session switch that creates a throwaway Git
  worktree inside the project and moves the session into it, plus a Worktrees panel
  that lists the copies and discards them (checkout and branch, after refusing a copy
  with uncommitted changes). The host half mounts
  `@deepseek-ai/dsh-experimental-worktree` and exposes status/prepare/list/discard over
  exact Connection fetch routes; the browser half registers a chip in
  `conversation.input.left` (blank-session hero only), a keyed main panel, and a sidebar
  entry.
  
  The pool directory belongs to the harness worktree service, not to this plugin: the
  bundle's `worktree` row ships `.dsh/worktrees` and a profile overrides `directory` on
  that row to move it. Copies are recognised from the checkout itself (a linked
  worktree's `.git` is a file), so status, list and discard follow whatever pool the
  service is configured with, and the panel also shows worktrees created by hand or by
  the model-facing worktree tool.
