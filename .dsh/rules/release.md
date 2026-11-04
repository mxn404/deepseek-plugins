# 发布插件：合并后立刻发，不等人提醒

`packages/<name>/` 下任何会进入 npm 包的东西（源码、`cordis.patch.yml`、`locale`、`files`、
README 里的安装/行为说明）改动合并进 main 之后，**立刻走完发版**。用户没有说“先别发”就
不要停在“已合并”这一步等提醒；发布是这次改动的最后一步，不是可选后续。

## 1. 合并前

- 必须带 changeset（`.changeset/<slug>.md`）：修 bug / 行为微调用 `patch`，新功能或新配置用
  `minor`。不要手改 `package.json` 版本号绕过 changeset。
- `pnpm check` 全绿。本机沙箱里 pnpm store 在工作区外不可写时，可用主 checkout 的
  `node_modules` 跑单包 `tsc` / `vitest` / `tsdown`，临时的 symlink 与缓存目录不要提交。
- squash 合并会让工作分支与 main 分叉：再开 PR 前先 `git fetch origin && git rebase origin/main`，
  否则 PR 会重新带上已经合并的改动。

## 2. 合并后发版

在**主 checkout**（本机 `/home/ubuntu/code/deepseek-plugins`，不是 `.dsh/worktrees/...`）做：

1. `git pull --ff-only origin main`
2. `pnpm release:version`（= `changeset version`）：改 `package.json`、`CHANGELOG.md`，删除对应
   changeset；提交 `Version <pkg> <ver>`。
3. `pnpm --filter <pkg> build` 确认 `lib/` 是新的（发布时 `prepare` 也会再构建一次）。
4. `pnpm --filter <pkg> publish --access public`。只发有新版本的包；`pnpm release:publish`
   （`changeset publish`）会跳过 npm 上已存在的版本。沙箱里 npm 缓存默认写不进 `~/.npm`，
   加 `--cache /home/ubuntu/code/deepseek-plugins/.npm-cache`，发完删掉该目录。
   先确认 `npm whoami` 正常；认证失败就停下来问用户，不要重试盲发。
5. 打 tag 并推送：tag 必须形如 `<包名>@<版本>`，且指向 main 上的发布提交——
   `git tag dsh-<name>@<ver> <main-commit> && git push origin dsh-<name>@<ver>`。
   不要用 `vX.Y.Z`（市场只认前者）。tag push 会触发 `.github/workflows/market.yml`。

## 3. 验证（少一步都可能白发）

- npm 传播要 1–3 分钟：`curl -s https://registry.npmjs.org/<pkg> | jq -r '."dist-tags".latest'`
  变成新版本才算到了。
- market 工作流可能先于 npm 传播跑完（踩过）：`gh run list --workflow market.yml` 看结果，
  若线上索引还是旧版本就 `gh workflow run market.yml` 重跑，再确认
  `curl -s "https://mxn404.github.io/deepseek-plugins/index.json?ts=$(date +%s)"` 里该包
  出现新版本。
- 告诉用户怎么更新：插件 → 发现 → 右上刷新 → “可更新” → 安装 → **重启 web profile**。
  宿主半（守卫、路由、prompt context）不热更，只刷新页面不算生效。

## 4. 不要做

- 不发布 npm、只在本地 `link` 安装：GUI 的“发现”只读市场索引，索引对已发布包只列 npm
  版本，页面永远看不到更新；link 只够自己用。
- 重发 npm 上已有的版本（会被拒绝）；发布后不要移动或重建 tag。
- 发完不验证索引、不告诉用户重启：用户会在页面上看到一个永远不会更新的“已安装”。
