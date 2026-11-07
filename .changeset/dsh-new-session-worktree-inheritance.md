---
'dsh-new-session': patch
---

Document the cross-plugin premise of `/clear` (alias `/new`) inside a Worktree
copy. The plugin code is unchanged; its README ships in the npm tarball, so the
behavior text that changed with #32 needs a release:

- `/new` starts the fresh conversation in the current working directory, so a
  session that runs in a worktree copy inherits that same copy.
- The inherited copy still belongs to the original session: leaving from the
  new conversation returns to the source checkout, keeps the copy on disk, and
  raises no leftover notice.
