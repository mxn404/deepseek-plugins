# `dsh-worktree-toggle`

在新会话屏幕的输入框工具行里放一个 **Worktree 开关**。默认打开（按项目记忆）：
打开时立刻在 `<项目根>/.agents/worktrees/<名字>` 建一份仓库副本，并把这条会话的工作
目录切进去；关掉时什么都不做，会话就在原目录里跑。副本不会自动消失、也不会自动合并，
用户可以在 **Worktrees 面板**里把它丢弃，或者自己把分支合回源仓库。

## 它做什么

- **开关**（`conversation.input.left` 槽，只在空白新会话的 hero 上出现）：显示本会话
  当前的副本状态——检查中 / 关闭 / 创建中 / 就绪（显示名字）/ 失败（显示原因 + 重试）
  / 不可用（项目不是 Git 仓库）。开关位置本身记的是"这个项目的新会话要不要隔离"。
- **创建**发生在开关打开的那一刻，早于第一条消息。副本名 = 分支名 = 池内目录名，形如
  `quiet-harbor-3fa9`，由插件生成，短且唯一。
- **创建失败不回落**：提示词不发送，错误就地显示。从检查开始、到副本就绪之前（或失败
  之后），开关通过 `ctx.conversation.blocks` 把该会话的输入框置为"暂停发送"；重试成功、
  关掉开关（确认不要隔离）或副本就绪时才解除。关掉开关是明确的退出方式——它表示"这条
  会话就在原目录里跑"，而不是假装隔离成功。
- **面板**（侧边栏条目 + 自己的页面）：按项目列出所有副本，含名字、分支、路径、创建
  时间和未提交改动数；丢弃需要第二次确认，且**有未提交改动时拒绝丢弃**并说明原因。
  丢弃会删掉检出目录和分支。
- **会话身份不变**：会话仍然建在源项目的工作区里，起始目录不变，插件只改会话的工作
  目录（一条持久化事件，重开会话仍然生效）。

## 安装

```sh
# 本地 checkout
dsh plugin --profile web add /home/ubuntu/code/deepseek-plugins/packages/dsh-worktree-toggle
dsh --profile web --dump-config    # 应能看到 "# == dsh-worktree-toggle" 和 "# == worktree" 两层
```

`cordis.patch.yml` 会插入两行：`@deepseek-ai/dsh-experimental-worktree`（提供
`ctx.worktrees`，行 id 特意用 `worktree`，与官方 tool-worktree bundle 的行 id 相同，避免
重复注册服务）和本插件自己。装完需要重启正在运行的 Web profile。

构建产物由 `prepare` 脚本（tsdown）产出；改完源码后重新 `pnpm --filter dsh-worktree-toggle build`
即可。外部安装的插件不在 `pnpm run dev:web` 的监视范围内，client-hmr 每 500ms 轮询
`lib/client.js`，重新构建后页面会自动换上新的浏览器半。

## 在 GUI 里走一遍

1. 重启正在跑的 Web profile。
2. 新建会话（hero 屏幕）：输入框工具行最左侧出现 Worktree 开关；默认打开的项会先显示
   "检查中"，随即"正在创建"，然后显示这条会话的副本名。
3. 按回车发消息：助手的工作目录已经是 `<项目根>/.agents/worktrees/<名字>`，源仓库的
   未提交内容留在原地。
4. 侧边栏出现 **Worktree** 入口：打开后按项目列出磁盘上的副本，含创建时间与未提交改动。
5. 想丢弃一份副本：点两次 Discard（第二次是确认）；有未提交改动时按钮禁用并说明原因。
6. 想换个项目默认：在新会话的开关上拨一下。关掉只影响**下一个**会话，当前会话如果已经
   建好副本，仍继续在副本里跑（提示里会写明这一点）。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultEnabled` | `true` | 用户从未在这个项目上拨过开关时，新会话是否默认隔离。用户拨过一次后，按项目记在浏览器 localStorage 里，优于此项。 |

## 目录与命名

```
<项目根>/.agents/worktrees/
├─ .gitignore          # worktree 服务建池时写入（内容 "*"），池本身不进版本库
└─ quiet-harbor-3fa9/  # 一份副本；同名分支 quiet-harbor-3fa9
```

池固定在项目根内部，**不能挪到项目根之外**：会话的沙箱写入边界来自会话起始目录，
副本落在外面会被直接拒绝。名字不带 `wt/` 前缀——路径里的 `.agents/worktrees/` 已经
把这件事说完了。

## 已知边界（接受，不修）

- 副本里**看不到**未跟踪的项目本地资产：`.dsh/skills`、`.agents/skills`、
  `AGENTS.local.md` / `CLAUDE.local.md`。被 git 跟踪的 `AGENTS.md` 照常可见。
- 会话记录里的起始目录仍指向源项目根；任何信任该字段的功能（"在终端打开"、按目录
  定位文件）显示的是源项目根，而不是副本。这是刻意的：沙箱边界与侧边栏归属都依赖它。
- 沙箱边界仍是源项目根，因此副本不是"写隔离"，它隔离的是**提交与未提交改动**：
  助手在副本里改的文件不会落到源检出的工作树里，但同一会话仍可写源项目根下的文件。
- 不自动合并、不自动回收、不支持多仓库、不识别旧插件的 `.worktree-space/` 目录。

## 实现

宿主半（`src/index.ts`）只做两件事：拿 `cordis.patch.yml` 挂上的 `ctx.worktrees` 和
`ctx.sessionController`，把四个动词注册成 `/api/dsh-worktree-toggle/<verb>` 上的精确
Fetch 路由（`src/host/routes.ts`），说 `client-request` / `server-response` 信封：

| 动词 | 入参 | 行为 |
|---|---|---|
| `status` | `{ sessionId }` | 解析仓库根、池路径、本会话已有副本、源仓库未提交改动数 |
| `prepare` | `{ sessionId }` | 幂等；必要时经 `ctx.worktrees.create` 建副本并切目录，同名冲突自动换名重试 |
| `list` | `{ path }` | 读项目的池，返回每份副本的名字/分支/路径/创建时间/改动数 |
| `discard` | `{ path, name }` | 干净才删：`git worktree remove` + `git branch -D`；改动非空则拒绝 |

创建走 harness 的 worktree 服务（沿用它的沙箱、filter 覆盖和失败语义）；`status`/`list`/
`discard` 是人在界面上的显式动作，用 `ctx.subprocess` 直接跑 Git，与会安装的
`dsh-worktree-space` 一致。浏览器半（`src/client/index.tsx`）只注册三个槽：开关、keyed
`main` 面板页、`sidebar.panellist` 入口；状态机在 `src/client/state.ts`，不依赖 React。

## 校验

```sh
pnpm --filter dsh-worktree-toggle typecheck
pnpm --filter dsh-worktree-toggle test
pnpm build          # 构建全部包并校验 exports / bundle patch 文件存在
```

测试只有两条接缝：宿主半的四个动词（真实临时 Git 仓库 + 真实服务，`tests/host.spec.ts`）
和浏览器半的槽注册与渲染（真实 `SlotRegistry` + 假 `connection`/`conversation`，
`tests/*.client.spec.tsx`）。不断言内部 Git 调用次数，也不测上游 worktree 服务自己的
Git 细节。

浏览器半为什么自带一个 `tests/client-harness.ts` 而不是用官方的
`@deepseek-ai/dsh-client-test-runtime`：该包 0.2.1-rc.5 发布版会 import
`@deepseek-ai/dsh-client-ui-renderer/src/...`，而发布产物里没有 `src/`，装上也跑不起来。
为此测试侧另有两处上游缺口的补丁，都只影响开发依赖：`dsh-client-store` 的运行依赖
`zustand`/`immer` 在发布清单里只写在 devDependencies（所以本包自己也装了这两个）；
`dsh-client-ui-primitives` 同样漏声明了整条工具链，测试里把它 mock 到实际渲染到的
Tooltip。
