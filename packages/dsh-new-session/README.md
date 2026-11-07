# `dsh-new-session`

在输入框里敲 `/clear`（别名 `/new`），**开一段全新的对话，但留在当前工作目录**——和 Claude
Code 的 `/clear` 对齐：旧对话完整留在侧边栏历史里，上下文从零开始。

## 它做什么

- 在 `/` 菜单里注册两个客户端 action：**Clear conversation / 清除对话**（`/clear`）和
  **New session / 新建会话**（`/new`，Claude Code 语义下的别名）。
- 执行时：
  1. 找到当前会话所在的 Workspace，向宿主要一个空白会话（有可复用的空白就复用，和
     New Session 按钮一致，未发送的草稿也还在）；
  2. 通过本插件的宿主路由，把新会话的**工作目录**设成当前会话的工作目录；
  3. 导航到新会话。
- **工作目录（包括 worktree 副本）会继承**：新会话的创建目录仍是 Workspace 路径，但工作
  目录与当前会话一致。因此在 worktree 会话里 `/clear` 会留在**同一个 worktree**，而不是像
  普通新会话那样让 `dsh-worktree-switch` 再建一份副本——`dsh-worktree-switch` 看到新会话已
  在副本里，只显示 ready，不再 prepare。
- 旧会话原样保留（侧边栏历史、`/resume` 语义上的可回）。
- 只在当前 Peer 有 `session/create` 权限时注册；只读的远程访问者看不到这两行。
- 不提交任何提示词：`action` 类型会消费掉 `/clear` / `/new` 这个 token。

## 安装

```sh
# 本地 checkout
dsh plugin --profile web add /home/ubuntu/code/deepseek-plugins/packages/dsh-new-session
dsh --profile web --dump-config    # 应能看到 "# == dsh-new-session"
```

装完需要重启正在运行的 Web profile：宿主半新增了一条 Connection 路由，浏览器半由宿主发布，
页面刷新不够。构建产物由 `prepare` 脚本（tsdown）产出；改完源码后重新
`pnpm --filter dsh-new-session build` 即可（外部安装的插件由 client-hmr 轮询 `lib/client.js`）。

## 在 GUI 里走一遍

1. 重启 Web profile，打开任意会话（在 worktree 里的会话也可以）。
2. 输入 `/clear`（或 `/new`）回车：视图切到一个空白会话，工作目录还是刚才那个目录。
3. 如果原来在 worktree 副本里，新会话仍在同一个副本里——不会多出一份副本；旧会话在侧边栏
   里还在。

## 实现

- **宿主半**（`src/index.ts` + `src/host/adopt.ts`）在 Connection 上注册一条精确路由
  `POST /api/dsh-new-session/adopt`。它只做浏览器做不到的事：把目标会话的工作目录设成源会话
  的当前目录（`ctx.workingDirectory.set`）。守卫：
  - 目标会话必须还没有开始任何 turn；
  - 源会话的工作目录必须位于它自己的创建目录（`header.cwd`）之内——`cd` 到项目外的情况
    报告为 no-op，避免把会话挪进不属于它的项目。
- **浏览器半**（`src/client/index.tsx`）用 `ctx.commandUi.register()` 注册 `/clear` 与 `/new`
  两个 `action`；`run` 里 `uiWorkspace.connectWorkspace()` 拿空白会话 → 调宿主路由 →
  `uiWorkspace.openSession()`。注册包在 `ctx.remoteAccess.whenAccess('session/create', …)` 里。
- 没有 Workspace 的会话回退到普通的新会话导航（`startSession()`）。

## 已知边界

- **只对 Web GUI 生效**。SDK / 桌面纯文本入口的斜杠命令识别只认内置白名单
  （dsh 的 `query-input.ts`），第三方插件命令不会从那条路进入；要覆盖那些入口需要改 dsh 本体。
- **没有 `/clear <name>` 参数**（Claude Code 用它给旧对话命名）。dsh 的客户端 action 只处理
  不带参数的调用；要支持参数得把命令做成宿主 command + 客户端装饰，留作后续。
- `/reset` 别名没有注册：dsh 的客户端命令没有别名机制，每个别名都要占用菜单里的一行，所以
  只保留 `/clear` 和 `/new` 两行。
- 旧会话不会被删除或改名，只是留在历史里。
