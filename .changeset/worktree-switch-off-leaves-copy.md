---
'dsh-worktree-switch': patch
---

Turning the Worktree switch off before the first prompt now moves the session back
to the project directory instead of leaving the conversation running inside the
copy, and deletes the clean copy the switch just created. A dirty copy, or one the
switch did not create, stays in the pool for the Worktrees panel to discard. The
new `release` host verb carries that undo; the switch shows a "leaving" face and
keeps the composer inert until the host answers.
