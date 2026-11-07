---
'dsh-worktree-switch': minor
---

离开即撤销：归属持久化、失败可见、遗留分支清理与当前副本 badge

- 关掉开关只撤销「开关为本会话创建、没有产生提交、也没有未提交改动」的副本（检出与分支一起删）；有内容或归属不明的副本保留，并在开关 hover 与帧级一次性提示里说明原因，提示带「打开面板」动作。
- 归属记在副本自己的 Git admin dir（`{ sessionId, createdAt, baseCommit }`），宿主重启后仍可证；升级前就存在的副本不补写标记，按「归属不明」保留，不猜。
- 删除失败不再被吞成「保留」：`release` 抛错，由界面显式提示，不再静默把开关置 off。
- 面板新增「遗留分支」分组（提交数 / 最近提交 / 时间，删除需二次确认）、`prunable` 行标「目录已丢失」、当前副本高亮；侧边栏入口在有待清理项时显示计数。
- 新增 wire 动词 `scope`（会话头部 `⎇ 分支名` badge 的数据来源，不读源仓库 status、不切目录）与 `discardBranch`；`release` 增加 `keptReason` / 可选 `error`，`list` 增加 `orphans` / `keptCopies`，`WorktreeItem` / `ReleaseValue` 的副本引用改用 `CopyRef`（`branch` 可为 null，detached 副本不猜分支名）。
