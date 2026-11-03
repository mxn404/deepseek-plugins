---
'dsh-worktree-toggle': minor
---

Add the Worktree toggle plugin: a New Session switch that creates a throwaway Git
worktree under `<project>/.agents/worktrees/<name>` and moves the session into it,
plus a Worktrees panel that lists the copies and discards them (checkout and branch,
after refusing a copy with uncommitted changes). The host half mounts
`@deepseek-ai/dsh-experimental-worktree` and exposes status/prepare/list/discard over
exact Connection fetch routes; the browser half registers a chip in
`conversation.input.left` (blank-session hero only), a keyed main panel, and a sidebar
entry.
