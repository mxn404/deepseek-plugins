# dsh-worktree-switch

## 0.3.1

### Patch Changes

- 789c790: Build and test against dsh 0.2.2-rc.1 (and cordis 4.1.0 / schemastery 3.19.0):
  `engines.dsh` and the `@deepseek-ai/*` peer ranges move to
  `>=0.2.2-rc.1 <0.2.3-0`, so an installation on the current harness no longer
  refuses the plugin as incompatible. No behavior changed: the test harness now
  builds a real `AgentModel` for its fixture Agent, which 0.2.2 requires, and the
  client half (composer chip, Worktrees panel, sidebar entry) was re-checked
  against the 0.2.2 slot contract and page module table.

## 0.3.0

### Minor Changes

- While a session runs in a worktree copy, the host half now denies shell commands that
  would run Git against the project checkout (`tools/pre-execute`), and the denial reason
  tells the model how to bring main's latest into the copy instead (`git fetch origin main`
  then `merge`/`rebase`). The guard matches a command that names the checkout by absolute
  path, or a `workdir` that resolves into the checkout, so it is a heuristic net rather
  than a sandbox boundary; it predicates on the same registry as the scope hint, and
  `guardSourceCheckout: false` turns it off.

## 0.2.2

### Patch Changes

- 2dffa50: Turning the Worktree switch off before the first prompt now moves the session back
  to the project directory instead of leaving the conversation running inside the
  copy, and deletes the clean copy the switch just created. A dirty copy, or one the
  switch did not create, stays in the pool for the Worktrees panel to discard. The
  new `release` host verb carries that undo; the switch shows a "leaving" face and
  keeps the composer inert until the host answers.
- While a session runs in a worktree copy, the host half now contributes one dynamic
  prompt context (`worktree-switch:scope`) that names the copy as the session's workspace
  and the project checkout as its source. The line follows the session through a resume
  and every entry or exit, and disappears once the committed directory is back in the
  project. It is agent guidance, not a sandbox boundary: writes outside the copy remain
  governed by the harness policy.

## 0.2.1

### Patch Changes

- Prepare the package for npm publication and a community-catalogue listing: declare
  `repository` (with the subdirectory), `homepage`, and `author`, add the `dsh-plugin`
  keyword, ship raster icons under `assets/` for the market card, and document both the
  publish command and the awesome-dsh-plugin submission in the READMEs.
  
  Compatibility is now stated against the line the plugin was built and tested with:
  `engines.dsh` and the `@deepseek-ai/*` peer ranges stop before `0.2.2-0`, so an
  untested harness refuses the install with a compatibility message instead of failing
  inside pnpm peer resolution.

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
