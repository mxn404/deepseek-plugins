---
"dsh-worktree-switch": patch
---

Windows support: the source-checkout guard now covers the `pwsh` tool and Windows path spellings (drive letters, UNC, backslashes, mixed case) while non-Git commands still pass; Git calls request no optional locks (`GIT_OPTIONAL_LOCKS=0`, so `git status` does not queue behind an IDE-held `.git/index.lock`) and enable `core.longpaths`; a copy removal that hits a transient file lock clears read-only bits and retries a bounded number of times before reporting the real reason, and never force-removes a dirty copy; the panel highlights the current copy across path separators. The README documents the Windows support scope and limits.

POSIX 上的守卫决策、Git 调用与删除失败语义保持不变；`GIT_OPTIONAL_LOCKS=0`、`core.longpaths=true` 与分隔符归一化是对 POSIX 无害的显式放宽。