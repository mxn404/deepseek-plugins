# `dsh-new-session`

在输入框里敲 `/new`，直接在当前工作区开一个新会话——等价于点侧边栏的 **New Session**
按钮，但不用把手从键盘上拿开。

## 它做什么

- 在 `/` 菜单里注册一个 **New session / 新建会话** 命令（`/new`，客户端 action）。
- 执行时调用 Web GUI 的工作区导航服务，行为和 New Session 按钮完全一致：
  - 当前工作区里已有空白会话时**复用**它——所以回到那个空白会话未发送的草稿；
  - 没有空白会话时新建一个；
  - 旧会话原样留在历史列表里，不会被删除或修改。
- 命令只在当前 Peer 有 `session/create` 权限时出现；只读的远程访问者看不到这一行。
- 不提交任何提示词：`action` 类型会消费掉 `/new` 这个 token，不会把它当消息发给模型。

## 安装

```sh
# 本地 checkout
dsh plugin --profile web add /home/ubuntu/code/deepseek-plugins/packages/dsh-new-session
dsh --profile web --dump-config    # 应能看到 "# == dsh-new-session"
```

装完需要重启正在运行的 Web profile：浏览器半由宿主发布，页面刷新不够，Host 的
client-module 扫描要重新 boot。

构建产物由 `prepare` 脚本（tsdown）产出；改完源码后重新
`pnpm --filter dsh-new-session build` 即可。外部安装的插件不在 `pnpm run dev:web` 的监视
范围内，client-hmr 每 500ms 轮询 `lib/client.js`，重新构建后页面会自动换上新的浏览器半。

## 在 GUI 里走一遍

1. 重启 Web profile，打开任意一个会话。
2. 在输入框里输入 `/new`：`/` 菜单里出现 **新建会话** 一行（也可以直接按回车执行）。
3. 执行后当前视图切到一个空白会话；输入框里是空的（如果那个空白会话本来就有草稿，草稿还在）。
4. 侧边栏里原来的会话还在，点回去内容完全没变。

## 实现

两半都只做一件事：

- **宿主半**（`src/index.ts`）是空插件。它存在的意义是让 Loader 挂载这个包——只有挂载了，
  client-module 扫描才会把 `lib/client.js` 发布给页面。
- **浏览器半**（`src/client/index.tsx`）用 `ctx.commandUi.register()` 注册一个
  `kind: 'action'` 的贡献；`run` 调用 `ctx.uiWorkspace.startSession()`。注册包在
  `ctx.remoteAccess.whenAccess('session/create', …)` 里，权限变化时自动装上/卸下。

`/new` 这个名字没有对应宿主命令，所以不会和现有 command 撞名；
`cordis.patch.yml` 只插一行，没有配置项。

## 已知边界

- **只对 Web GUI 生效**。SDK / 桌面纯文本入口的斜杠命令识别只认内置白名单
  （dsh 的 `query-input.ts`），第三方插件命令不会从那条路进入；要覆盖那些入口需要改 dsh 本体。
- 它是「新会话」而不是「原地清空上下文」：旧对话仍然在历史里，会话 id 也不变的是**新会话**
  的 id。想在同一个会话里清空上下文是另一件事（surface replace），这个插件不做。
- 复用空白会话意味着连续两次 `/new` 可能停在同一个空白会话上——和按钮行为一致。
- 菜单行的文案来自浏览器半的字典（en / zh）；`locale/*.json` 只给市场页的
  `meta.title` / `meta.description` 用。
