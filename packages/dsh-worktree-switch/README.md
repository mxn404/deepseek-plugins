# `dsh-worktree-switch`

在新会话屏幕的输入框工具行里放一个 **Worktree 开关**。默认打开（按项目记忆）：
打开时立刻在 `<项目根>/.dsh/worktrees/<名字>` 建一份仓库副本，并把这条会话的工作
目录切进去；在发出第一条消息之前再关掉，会话会被切回项目目录，开关自己刚建的干净
副本也一并删掉——关掉就是撤销这次隔离。副本不会自动消失、也不会自动合并，用户可以
在 **Worktrees 面板**里把它丢弃，或者自己把分支合回源仓库。会话在副本里时，宿主半还会
给模型一条工作区说明，并拒绝把 git 指向主检出的 shell 调用（可关）。

新建副本默认以创建前刚拉取到的 `origin/<默认分支>` 为基点，而不是主检出的本地 `HEAD`
（见「创建基点」）。语义基线与有意偏离见
[ADR-0005](../../docs/adr/0005-worktree-base-ref-deviates-from-claude-code.md)。

「关掉」现在只做**撤销**，不叫回收：只有开关为这条会话创建、没有产生提交、也没有未提交
改动的副本，才会在离开时被删掉（检出与分支一起）；有内容的、归属不明的副本一律保留，并
在界面上说明原因。归属记在副本自己的 Git admin dir 里，宿主重启后仍然可证；会话头部常驻
`⎇ 分支名` badge，面板新增「遗留分支」分组。取舍见
[ADR-0006](../../docs/adr/0006-worktree-leave-is-undo-not-reclaim.md)。

## 它做什么

- **开关**（`conversation.input.left` 槽，只在空白新会话的 hero 上出现）：显示本会话
  当前的副本状态——检查中 / 关闭 / 创建中 / 离开中 / 就绪（显示名字）/ 失败（显示原因 +
  重试）/ 不可用（项目不是 Git 仓库）。开关位置本身记的是"这个项目的新会话要不要隔离"。
- **创建**发生在开关打开的那一刻，早于第一条消息；**关闭**发生在第一条消息之前时，
  会话被切回项目目录；只有开关为这条会话创建、仍在创建基点、也没有未提交改动的副本会被
  撤销（检出和分支一起删）。有提交、有改动、或归属不明的副本留在池里，开关的 hover 带上
  保留原因，界面顶部给一次性提示并提供「打开面板」。副本默认从创建前刚拉取到的
  `origin/<默认分支>` 起；
  `baseRef: 'head'` 或远端取不到时回退为本地 `HEAD`（见「创建基点」）。副本名 = 分支名 = 池内
  目录名，形如 `quiet-harbor-3fa9`，由插件生成，短且唯一。
- **归属记在副本里**：创建成功后，插件往该副本自己的 Git admin dir
  （`.git/worktrees/<名字>/dsh-worktree-switch.json`）写一条
  `{ sessionId, createdAt, baseCommit }`。它随副本删除自动消失，不进工作区、不产生未跟踪
  文件，宿主重启后仍然读得到。升级前就存在的副本没有标记，一律按「归属不明」保留：不补写、
  不猜。副本被手工改成 detached 时，撤销只移除检出，永不删任何分支。
- **会话头部 badge**：非空白会话的头部常驻 `⎇ 分支名`
  （`conversation.session.header.utilities`）。hover 给副本绝对路径、仓库根与副本内未提交
  数；它订阅会话当前工作目录的变化，`cd` 出去就消失，副本被建出来也会自己出现。点击打开
  Worktrees 面板并高亮当前副本。空白 hero 与面板页不显示：那两处分别由开关和面板本身表达
  同一件事。
- **创建失败不回落**：提示词不发送，错误就地显示。从检查开始、到副本就绪之前、离开副本
  的过程中（或失败之后），开关通过 `ctx.conversation.blocks` 把该会话的输入框置为"暂停
  发送"；重试成功、关掉开关（确认不要隔离）或副本就绪时才解除。关掉开关是明确的退出
  方式——它表示"这条会话就在原目录里跑"，而不是假装隔离成功。
- **会话范围说明**：会话在副本里时，宿主半跟着每轮请求给模型补一条上下文（紧跟工作目录那
  行）：当前目录是 `<项目>` 的 linked worktree 副本，git 与文件操作在副本里做，主检出是源。
  它会随恢复会话、每次进/出副本重新推导，回到项目目录后自动消失。这是**提示**，不是权限
  边界——真正的写隔离仍取决于沙箱根（见「已知边界」）。
- **主检出守卫**：会话在副本里时，`tools/pre-execute` 会拦下“把 git 指向主检出”的 bash
  调用（命令里出现主检出的绝对路径，或 `workdir` 落在主检出里），拒绝原因直接告诉模型
  在副本里该怎么做（`git fetch origin main` + `merge`/`rebase`）。这是启发式拦截，不是
  沙箱边界：`cd ..` 之类的相对逃逸、shell 变量展开不在它的覆盖范围内；配置
  `guardSourceCheckout: false` 可关掉。拦下的是 git，主检出里的普通写入仍然由沙箱放行。
- **面板**（侧边栏条目 + 自己的页面）：按项目列出该仓库的所有 linked worktree（包括
  手工 `git worktree add` 出来的），含名字、分支、路径、创建时间和未提交改动数；丢弃
  需要第二次确认，且**有未提交改动时拒绝丢弃**并说明原因。目录被手工删掉、Git 注册还在
  的副本标成「目录已丢失」，走同一套丢弃（先删分支、再 `worktree prune`，删不掉就报错而
  不悄悄 prune）。detached 副本只展示，丢弃只移除检出、永不删分支。
- **遗留分支**：每份副本之外，面板单独成组列出「名字符合生成格式（`<词>-<词>-<4位hex>`）、
  但已没有任何 checkout」的分支，含提交数、最近提交 subject 与时间；删除需要第二次确认，
  且只删分支。普通 feature 分支、以及仍被 checkout 的分支永远不会出现在这一组。
- **当前副本**：面板按会话快照里当前主视图的那条会话推导「我在副本里」，给它高亮；不新增
  宿主事件。侧边栏入口在有东西要清理时显示计数。
- **计数口径**：入口计数 = 遗留分支数 + 本次宿主生命周期内被保留的副本数（含删除失败后
  留在磁盘上的那一份）。宿主重启后后者不可知，计数退化为只数遗留分支——这是有意说出来的
  诚实下限，不是 bug。
- **会话身份不变**：会话仍然建在源项目的工作区里，起始目录不变，插件只改会话的工作
  目录（一条持久化事件，重开会话仍然生效）。

## 安装

```sh
# 本地 checkout
dsh plugin --profile web add /home/ubuntu/code/deepseek-plugins/packages/dsh-worktree-switch
dsh --profile web --dump-config    # 应能看到 "# == dsh-worktree-switch" 和 "# == worktree" 两层
```

`cordis.patch.yml` 会插入两行：`@deepseek-ai/dsh-experimental-worktree`（提供
`ctx.worktrees`，行 id 特意用 `worktree`，与官方 tool-worktree bundle 的行 id 相同，避免
重复注册服务）和本插件自己。装完需要重启正在运行的 Web profile。

构建产物由 `prepare` 脚本（tsdown）产出；改完源码后重新 `pnpm --filter dsh-worktree-switch build`
即可。外部安装的插件不在 `pnpm run dev:web` 的监视范围内，client-hmr 每 500ms 轮询
`lib/client.js`，重新构建后页面会自动换上新的浏览器半。

## 在 GUI 里走一遍

1. 重启正在跑的 Web profile。
2. 新建会话（hero 屏幕）：输入框工具行最左侧出现 Worktree 开关；默认打开的项会先显示
   "检查中"，随即"正在创建"，然后显示这条会话的副本名。
3. 按回车发消息：助手的工作目录已经是 `<项目根>/.dsh/worktrees/<名字>`，源仓库的
   未提交内容留在原地；会话头部出现常驻的 `⎇ 分支名`，hover 能核对路径、仓库根和未提交数。
4. 侧边栏出现 **Worktree** 入口：打开后按项目列出磁盘上的副本与遗留分支，含创建时间、
   未提交改动、提交数等；当前会话所在的副本高亮。有东西要清理时入口会带计数。
5. 想丢弃一份副本：点两次 Discard（第二次是确认）；有未提交改动时按钮禁用并说明原因。
   遗留分支同样点两次删除；目录已丢失的副本行标「目录已丢失」，走同一套丢弃。
6. 开关只在空白会话上出现：发第一条消息之前关掉，会把会话切回项目目录，并撤销开关刚建的
   空副本；若副本里有提交或改动（或归属不明），副本保留，开关 hover 说明原因，页面顶部给
   一次性提示与「打开面板」。发过消息之后开关消失，副本留在池里，由面板丢弃。拨开关同时
   记住这个项目下次的默认位置。

## 配置

### 副本目录

副本目录（池）由 **`cordis.patch.yml` 里那一行 `worktree`** 决定，也就是 harness
worktree 服务自己的 `directory` 选项——本插件不另存一份设置，`status` / `list` /
`discard` 都按“仓库里有哪些 linked worktree”去认副本，所以服务把池挪到哪里，插件就
跟到哪里。本包默认是 `.dsh/worktrees`。

要改成别的目录，在 **profile 自己的 patch 层**覆盖同一行即可（后层按行 id 覆盖，整块
`config` 替换）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: worktree
  name: '@deepseek-ai/dsh-experimental-worktree'
  config:
    directory: worktrees          # 相对项目根；这里就会落在 <项目根>/worktrees/<名字>
```

两条硬约束：

- **必须留在项目根内部**。会话的沙箱写入边界是不可变的会话起始目录，池在项目根外时
  创建副本会被直接拒绝。
- 目录对每个项目都生效（是相对路径，不是在某个绝对位置开池）。若想按项目不同，只能
  在项目里放不同的 profile——目前没做这种粒度。

**行 id 撞车**：dsh 0.2.2 的 Forge bundle（`@deepseek-ai/dsh-experimental-forge-bundle`）
也插入一行 `id: worktree`。Loader 按行 id 只留一条、后层覆盖，所以本包的
`directory: '.dsh/worktrees'` 只在**本包的层排在那份 bundle 之后**时才生效——默认情况正是
如此（profile 先列宿主 bundle，再列装进来的插件）。如果你手动调整了 bundle 顺序，请在
profile 的 patch 层里按上面的写法重新声明 `directory`，否则池会静默退回 harness 的默认
目录（`.agents/worktrees`）。这条只影响目录位置，开关、面板与丢弃逻辑都按服务实际用的
池子工作。

改完重启 profile 生效。已经在旧目录里的副本不会消失：面板列的是仓库的所有 linked
worktree，所以新旧目录的副本都会出现，可以照常丢弃。

### 开关默认与基点

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultEnabled` | `true` | 用户从未在这个项目上拨过开关时，新会话是否默认隔离。用户拨过一次后，按项目记在浏览器 localStorage 里，优于此项。 |
| `guardSourceCheckout` | `true` | 会话在副本里时，用 `tools/pre-execute` 拒绝把 git 指向主检出的 bash 调用。关掉就只剩提示。 |
| `baseRef` | `'fresh'` | 创建副本前从 `origin` 拉取默认分支作为基点；`head` 则直接基于本地 HEAD、不联网。 |

### 创建基点

新建的副本默认**不从本地 HEAD 起**。开关真正要建副本之前（拨开开关、且只有那一刻），
宿主半只从 `origin` 拉一个分支——默认分支。解析顺序是 `refs/remotes/origin/HEAD` →
`main` → `master`，拉取带 5 秒超时，副本以拉取到的那个提交为基点。只拉这一个分支，其他
分支和 tag 都不动。

- `baseRef` 默认是 `fresh`：如上所述。主检出落后于远端时，新会话仍从团队已经推上来的
  代码开始。
- `baseRef: 'head'`：完全跳过默认分支解析与 fetch，直接基于主检出的本地 `HEAD`，不联网。
  这是「把 feature 分支里未推送的工作带进副本」的逃生门，也是离线时的确定行为。

**回退一律不阻断创建**：没有 `origin` 远端、远端没有可识别的默认分支、fetch 失败或超时，
都静默回退到本地 HEAD，副本照建。唯一会显式说出来的是「有远端、找到了默认分支、fetch 没
成功」这一种：开关的 hover 提示里会多一句「基点：本地 HEAD（远端未取到）」，开关本身的
文案不变。

只有「即将创建副本」会联网：已经在副本里的会话、`status`、`release`、`discard` 都不 fetch。

在 profile 自己的 patch 层设置（和 `defaultEnabled` 一样，没有 GUI 控件）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-worktree-switch
  name: dsh-worktree-switch
  config:
    baseRef: 'head'
```

`baseRef` 只接受 `fresh` / `head` 两个字面量，写成别的会让插件在挂载时失败、profile 起不
来，而不是静默选另一个基点。

## 目录与命名

```
<项目根>/.dsh/worktrees/
├─ .gitignore          # worktree 服务建池时写入（内容 "*"），池本身不进版本库
└─ quiet-harbor-3fa9/  # 一份副本；同名分支 quiet-harbor-3fa9
```

名字不带 `wt/` 前缀：池路径已经把“这是什么”说清楚了。名字、分支、目录三者是同一个
字符串，`git branch` 里看到的名字就是磁盘上的目录名。

## 已知边界（接受，不修）

- 副本里**看不到**未跟踪的项目本地资产：`.dsh/skills`、`.agents/skills`、
  `AGENTS.local.md` / `CLAUDE.local.md`。被 git 跟踪的 `AGENTS.md` 照常可见。
- 会话记录里的起始目录仍指向源项目根；任何信任该字段的功能（"在终端打开"、按目录
  定位文件）显示的是源项目根，而不是副本。这是刻意的：沙箱边界与侧边栏归属都依赖它。
- 沙箱边界仍是源项目根，因此副本不是"写隔离"，它隔离的是**提交与未提交改动**：
  助手在副本里改的文件不会落到源检出的工作树里，但同一会话仍可写源项目根下的文件。
  主检出守卫只覆盖 bash 里明显指向主检出的 git 调用，是提示之外的兜底，不是权限。
- 不自动合并、不自动回收、不支持多仓库、不识别旧插件的 `.worktree-space/` 目录。
- **不追溯旧副本**：升级前留下的副本没有归属标记，离开时一律保留并提示「归属不明」，需要
  在面板里手动丢弃。插件不会为了「修好这件事」而猜。
- **计数会退化**：「被保留的副本」只是本次宿主生命周期内的知识；宿主重启后入口计数只剩
  遗留分支可数（面板与本节都写明，避免用户以为计数一直准）。
- **detached 副本永远不会被开关自动删掉**：只展示、只允许显式丢弃检出，且不删任何分支。
  这比「猜一个分支名去删」安全，代价是用户要自己回收它。
- **归属标记在 `.git/worktrees/` 里**：不进版本库、不进工作区、不产生未跟踪文件；但用户
  `rm -rf` 掉副本目录后，标记要等 Git 注册被 prune 才消失，那期间面板会把该行标成
  「目录已丢失」，走同一套清理。

## 实现

宿主半（`src/index.ts`）做三件事：拿 `cordis.patch.yml` 挂上的 `ctx.worktrees` 和
`ctx.sessionController`，把下面七个动词注册成 `/api/dsh-worktree-switch/<verb>` 上的精确
Fetch 路由（`src/host/routes.ts`），说 `client-request` / `server-response` 信封；另注册一条
`systemPrompt.context`（`worktree-switch:scope`），内容来自 `SessionScopeRegistry`，由这些
动词、`agent/created` 和每次组装时的目录校验共同维护。「归属」这条记录由
`src/host/ownership.ts` 读写，落在副本自己的 Git admin dir 里。

| 动词 | 入参 | 行为 |
|---|---|---|
| `status` | `{ sessionId }` | 解析仓库根、本会话是否已在某个 linked worktree 里、源仓库未提交改动数 |
| `prepare` | `{ sessionId }` | 幂等；必要时经 `ctx.worktrees.create` 建副本并切目录，同名冲突自动换名重试 |
| `release` | `{ sessionId }` | 把会话切回项目目录；仅在「有归属 + 仍在基点 + 工作区干净」时撤销副本（检出 + 分支），否则保留并返回 `keptReason`（`dirty` / `not-owned`）与原因；删除失败抛错，不吞成「保留」 |
| `scope` | `{ sessionId }` | 轻量回答「这条会话在副本里吗」：先读宿主内存里按会话记录的副本，读不到再对当前目录做一次检测；不读源仓库 status、不切目录 |
| `list` | `{ path }` | 列出该仓库除主检出外的所有 linked worktree（名字/分支/路径/创建时间/改动数/prunable），外加遗留分支（提交数/最近提交/时间）与本次宿主保留的副本数 |
| `discard` | `{ path, name }` | 干净才删：`git worktree remove` + `git branch -D`；prunable 行先删分支再 prune；detached 副本只移除检出；改动非空则拒绝 |
| `discardBranch` | `{ path, branch }` | 只删一个遗留分支：要求名字是生成格式、且不在任何 checkout 的 HEAD 上；已删过再删也算成功 |

创建走 harness 的 worktree 服务（沿用它的沙箱、filter 覆盖和失败语义）；`status`/`list`/
`discard` 是人在界面上的显式动作，用 `ctx.subprocess` 直接跑 Git，与会安装的
`dsh-worktree-space` 一致。浏览器半（`src/client/index.tsx`）注册五个槽：开关、keyed
`main` 面板页、`sidebar.panellist` 入口与计数、`conversation.session.header.utilities` 的
`⎇` badge、`shell.overlay` 的一次性提示；状态机在 `src/client/state.ts`，不依赖 React。

## 校验

```sh
pnpm --filter dsh-worktree-switch typecheck
pnpm --filter dsh-worktree-switch test
pnpm build          # 构建全部包并校验 exports / bundle patch 文件存在
```

测试有三条接缝：宿主半的七个动词（真实临时 Git 仓库 + 真实服务，`tests/host.spec.ts`）、
浏览器半的槽注册与渲染（真实 `SlotRegistry` + 假 `connection`/`conversation`，
`tests/*.client.spec.tsx`），以及插件公开的配置契约（`tests/config.spec.ts`：`baseRef`
只接受 `fresh` / `head`）。不断言内部 Git 调用次数，也不测上游 worktree 服务自己的
Git 细节。

浏览器半为什么自带一个 `tests/client-harness.ts` 而不是用官方的
`@deepseek-ai/dsh-client-test-runtime`：该包 0.2.1-rc.5 发布版会 import
`@deepseek-ai/dsh-client-ui-renderer/src/...`，而发布产物里没有 `src/`，装上也跑不起来。
为此测试侧另有两处上游缺口的补丁，都只影响开发依赖：`dsh-client-store` 的运行依赖
`zustand`/`immer` 在发布清单里只写在 devDependencies（所以本包自己也装了这两个）；
`dsh-client-ui-primitives` 同样漏声明了整条工具链，测试里把它 mock 到实际渲染到的
Tooltip。

## 发布

`prepare` 会在 npm 打包前跑 tsdown，所以发布出去的是预构建产物，用户
`dsh plugin add dsh-worktree-switch` 无需构建授权：

```sh
pnpm --filter dsh-worktree-switch publish --access public
```

包元数据里的 `repository.directory` 指向本仓库的这个子目录，收录到社区目录
（awesome-dsh-plugin / dsh-market）后 npm 包会自动关联回仓库；收录步骤见仓库根
README 的「社区目录」一节。
