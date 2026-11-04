# Sandbox 多根：让 worktree 会话的空间就是副本目录

- 状态：**提案（未开工）**，面向上游 `deepseek-harness`，目标版本 `0.2.x`
- 提出背景：`dsh-worktree-switch` 的会话空间问题（见「问题」）
- 结论先行：**需要上游把 `workspace-write` 的可写边界从「一个根」改成「一组根」**，并由会话投影承载这组根；否则任何「会话空间 = worktree」的做法都会撞上 linked worktree 的 git 管理目录在副本之外这一事实。

## English summary

`workspace-write` resolves its write boundary from the immutable session header cwd
(`packages/sandbox/sandbox-policy/src/index.ts:168`) and every enforcement dialect
consumes exactly one root. A linked worktree's Git administration directory lives
*outside* the checkout (`<project>/.git/worktrees/<name>`), so a session rooted in a
worktree cannot commit, and a session rooted in the project cannot be isolated from
the source checkout. This proposal turns the policy into a root *set* carried by a
new session projection (`sandbox/roots`), unions it in `writableRoots()`, teaches the
bwrap/Landlock/Seatbelt/Windows-ACL rungs to grant each root, and has the worktree
service publish `[checkout, git-dir, git-common-dir]` when it enters a copy. Defaults
are unchanged: sessions without the projection behave exactly as today.

## 问题

在 worktree 会话里能观察到三个现象，根因是同一个：

1. **会话空间不是副本**：模型文件视图、沙箱写入边界、侧栏归属都指向源项目根；副本只是一个「当前目录」。
2. **越界写入主检出是允许的**：用户说「拉取 main 最新代码」，agent 直接在主检出执行 git——因为策略文字告诉它「会话工作区 = 源项目根」，而写入权限确实覆盖那里。
3. **反过来，让会话以副本为根也走不通**：linked worktree 的 git 管理目录在 `<项目>/.git/worktrees/<name>`，单根策略下 `git add/commit/checkout` 全部被沙箱拒绝。上游已有测试钉死了这个拒绝（`packages/experimental/worktree/tests/sandbox.spec.ts:82-89`）。

因此「worktree 会话」目前只能是「cwd 在副本、权限在源项目」的半套隔离。

## 现状（代码事实）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 沙箱写边界 = `session.header.cwd`，header 是创建时深冻结的不可变元数据，没有改根 API | `packages/sandbox/sandbox-policy/src/index.ts:168`；`packages/core/session/src/types.ts:96-107`；`packages/core/session/src/index.ts:533-540` |
| 2 | 策略类型只带一个根 | `packages/sandbox/sandbox/src/index.ts:41-56`（`workspaceRoot: string`） |
| 3 | 所有 dialect 从这一个根派生 | `packages/sandbox/sandbox/src/roots.ts:52-55`；bwrap/Landlock/Seatbelt：`packages/sandbox/sandbox-local/src/profiles.ts:15-23, 30-36, 49-58`；Windows ACL：`packages/sandbox/sandbox-local/src/index.ts:374-386, 403-423`；进程内 fs fence：`packages/fs/fs-sandbox/src/index.ts:134` |
| 4 | 目录可变、权限独立，是**刻意**的设计 | `packages/session/working-directory/src/index.ts:33-41, 163-170`；`.agents/notes/implemented/architecture/2026-09-13-session-working-directory.md:13, 17, 33`（明确否决「改写 header」：「used by storage, grouping, and **permission roots**」） |
| 5 | worktree 服务只切 cwd，不扩权；「原沙箱根保持归原服务所有」是已记录的取舍 | `packages/experimental/worktree/src/index.ts:170`；`.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md:17`；`packages/experimental/worktree/README.md:12, 47, 88` |
| 6 | 会话在 hero 渲染之前就已创建（按 workspace），所以「切换开关时改根」没有插入点 | `packages/client/ui-workspace/src/client/navigation.ts:194-249`；`packages/api/session-controller/src/commands.ts:111-150` |
| 7 | GUI 文件视图也按 header 取根 | `packages/api/workspace-files/src/index.ts:218` |

## 设计

### 1. 策略类型：单根 → 根集合（增量、向后兼容）

```ts
export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode
  /** 主根：保留字段，单根消费者与所有展示继续读它。 */
  readonly workspaceRoot: string
  /** 额外可写根（规范化、去重）；由 session 投影设置，默认空。 */
  readonly additionalRoots?: readonly string[]
  readonly sessionId?: SessionId
}
```

- `writableRoots()` 改为并集：`workspaceRoot + additionalRoots + /tmp + tmpdir()`，逐个 `canonicalPath` 后去重（`packages/sandbox/sandbox/src/roots.ts:25-31` 已有 canonical 语义，直接复用）。
- 不改字段名、不移除 `workspaceRoot`：所有现有消费者编译不破，未设置投影的会话行为完全不变。

### 2. 根的来源：新的会话投影 `sandbox/roots`

照抄 `sandboxMode` 的形态（`packages/sandbox/sandbox-policy/src/index.ts:133-139`；写入路径 `packages/sandbox/sandbox-policy/src/session-mode.ts:53`）：

```ts
// packages/sandbox/sandbox-policy/src/session-roots.ts
export interface SandboxRootsState {
  /** 新的主根；null 表示沿用 header.cwd。 */
  readonly primary: string | null
  /** 额外可写根（git 管理目录等）。 */
  readonly extra: readonly string[]
} // 投影状态整体为 null = 从未设置

// session 事件（log-only，last-wins fold，不进模型 transcript）
'sandbox/roots': { primary: string | null; extra: readonly string[] }
```

- `setSandboxRoots(session, roots)` / `clearSandboxRoots(session)`：唯一写路径，追加一条事件；投影 `stateVersion: 1`，重放即可恢复。
- `resolve()`：

```ts
const roots = this.ctx.sessionProjections.stateOf(session, 'sandboxRoots')
const primary = roots?.primary ?? session?.header.cwd ?? this.workspaceRoot
const extra = roots?.extra ?? []
return { mode, workspaceRoot: resolveWorkspaceRoot(primary), additionalRoots: extra.map(canonical), sessionId }
```

- 参数校验：`primary` 必须是绝对路径；`extra` 里相对路径直接抛错（fail closed），不存在的路径保留原样（与 `roots.ts` 的「缺失根匹配不到任何东西」一致，不发明 fallback）。
- `primary` 的语义是**替换**：一旦设置，header.cwd 不再是可写根。这是「严格隔离」选项，也是用户诉求；默认 null 保持现状。

### 3. 谁写这组根：worktree 服务

`packages/experimental/worktree/src/index.ts` 的 `createCheckout()` 在 checkout 成功后：

1. 已经解析出 `repositoryRoot`（`:136`）。再取两个路径（复用现有的 `run(...)`）：
   - `git rev-parse --git-dir` → `<common>/worktrees/<name>`
   - `git rev-parse --git-common-dir` → `<project>/.git`
2. `setSandboxRoots(session, { primary: checkout, extra: [gitDir, commonDir] })`
3. 再 `workingDirectory.set(agent, checkout)`（`:170`），保证第一条受限调用之前根已经生效。

**离开副本**：必须清根，否则会话离开后仍持有旧副本与主仓 `.git` 的写权限。

- 新增 `ctx.worktrees.leave(agent)`：`setSandboxRoots` 清空 + `workingDirectory.set(header.cwd)`。
- 同时让服务监听 `working-directory/change`：新 cwd 不在已发布的 `primary` 之下时自动清根（兜底任何 `cd` 路径，包括 `working_directory` 工具、GUI 的目录切换、子 agent 继承）。
- 语义：同一会话只保留最近一次进入的副本（last-wins）；从副本 A 进副本 B 后离开 B，根回到 header.cwd，不回到 A。文档写明。

**恢复**：会话重启/恢复后，投影从日志重放；若 `primary` 目录已不存在（副本被手工删掉），按 `workingDirectory.ensure()` 的同一个恢复思路处理（`packages/session/working-directory/src/index.ts:134-152`）：清根并回退到 `header.cwd`，写一条 notice；不要留下「根全都不存在、会话完全不可写」的死状态。

### 4. 各 provider 的改造

| 位置 | 改动 |
|---|---|
| `packages/sandbox/sandbox/src/roots.ts:52-55` | 并集所有根 |
| `packages/sandbox/sandbox-local/src/profiles.ts:15-23`（bwrap） | 每个额外根一条 `--bind` |
| 同上 `:30-36`（Landlock） | `readWrite.push(...additionalRoots)` |
| 同上 `:49-58`（Seatbelt） | 免费：已经走 `writableRoots()` |
| `packages/sandbox/sandbox-local/src/index.ts:374-386`（Windows ACL 参数） | `--workspace` 改为可重复的 `--write-root`；主根仍驱动 temp grant |
| `packages/sandbox/sandbox-local/src/index.ts:403-423` + `packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts:35` | 每个根一个 `workspaceWriteSid(root)` + 一条 standing ACE；`assertTempRootOutsideWorkspace` 对每个根都跑 |
| `packages/fs/fs-sandbox/src/index.ts:134` | 免费：已经在循环 |
| `packages/sandbox/sandbox/src/escalation.ts:28-31` | 不动：根不是提权通道，mode 阶梯不变 |

### 5. 模型可见文本

`renderPolicyContext()`（`packages/sandbox/sandbox-policy/src/index.ts:47`）现在只打印一个根。改为：

```
Current DSH file policy: workspace-write. ... may modify files under the session workspace:
"<primary>" and "<extra 1>", ... . The extra paths are tool-owned metadata (Git
administration directories); the model should keep file and Git operations in the
session workspace unless a task explicitly requires otherwise.
Some platform temporary areas may also be writable.
```

固定顺序（primary 在前，extra 排序）避免无关抖动；根本身变化时文本变化，与 mode 变化同样处理。

### 6. 消费方迁移表

| 消费方 | 位置 | 是否需要改 |
|---|---|---|
| `writableRoots` | `sandbox/src/roots.ts` | 是（并集） |
| bwrap / Landlock / Seatbelt | `sandbox-local/src/profiles.ts` | 是 / 免费 |
| Windows ACL runner | `sandbox-local/src/index.ts`、`sandbox-windows-acl` | 是 |
| 进程内 fs fence | `fs/fs-sandbox` | 否 |
| bash / fs 工具的拒绝提示 | `shell/tool-bash`、`fs/tool-fs/src/sandbox.ts:76-80` | 文案里「工作区」改为「工作区（含工具自有根）」 |
| 文件视图 | `api/workspace-files/src/index.ts:218` | 是（用主根，或展示全部根） |
| 系统提示 | `sandbox/sandbox-policy/src/index.ts:47` | 是 |
| 审批 / 审计 | `sandbox/src/escalation.ts`、approval | 否 |
| 会话列表 / 侧栏归属 | `workspace` 包 | 否（header 不变；workspace 归属仍靠 header） |

## 安全分析

- **共享 `.git` 可写**是最重的一条：`git commit` 需要写共享对象库与 refs，所以 `commonDir` 必须在根集合里。代价是会话（及其工具）可以改写源仓的分支/refs（但**写不到主检出的工作树**）。三个选项：
  1. 接受并写入文档（推荐：与「用户把会话交给 agent」的现有信任级别一致）；
  2. 只授权 `<common>/worktrees/<name>`，不接受共享写 → `git commit` 不可用，本提案失去意义；
  3. 上游做更细的 per-path 规则（把 refs/objects 拆成独立根或只读绑），成本高，可作为后续方向。
- **根的信任级别**：根从会话日志来，与 `sandbox/mode` 同级（后者已经能到 `danger-full-access`）；写入口应该是 feature/UI 所有，不暴露成模型可调用的工具。
- **规范化**：每个根 `realpath`；拒相对路径；嵌套根按 canonical 去重（外层已覆盖内层，保留外层不会扩大权限）。
- **临时目录**：`/tmp`、`tmpdir()` 照旧授予；`assertTempRootOutsideWorkspace` 对每个根检查（worktree 池在项目根内部，天然安全；项目本身在 temp 下时保持现有行为）。
- **Windows ACL**：每个根一条 standing ACE + 一个 SID；离开副本/会话结束时要撤销，否则 ACE 累积（现状是 per-provider lifetime 的 standing grant，`sandbox-local/src/index.ts:269-304`，需要扩展撤销路径）。
- **不做**：`read-only` 模式不因根集合而放行；根集合不是提权（escalation 仍是 mode 阶梯）。

## 兼容与迁移

- 没有 `sandbox/roots` 事件的会话：行为与今天逐字节一致（投影 init 为 null，`additionalRoots` 为空）。
- 旧日志重放安全：新投影 `init: () => null`，`stateVersion: 1`。
- 无配置项变化、无 config-catalog 变更；只需补文档与 i18n（`docs/subsystems/worktrees.md`、各包 README、`docs/config-catalog.md` 不含新配置）。
- 系统提示文本只在根集合被设置时变化，不会打穿既有会话的前缀缓存。

## 测试计划

单元：

- `sandbox-policy`：默认单根；投影设置/清空；相对路径拒绝；canonical 去重；last-wins fold；重放；`primary` 缺失时的恢复。
- `sandbox/src/roots.ts`：N 根 + 临时区的并集与去重。
- `sandbox-local`：bwrap `--bind` 数量、Landlock readWrite 列表、Seatbelt subpath 列表。
- `sandbox-windows-acl`：每根 SID、standing ACE、temp root 检查、撤销。

集成（验收）：

- **worktree 会话里能 commit**：以副本为主根、roots = `[checkout, git-dir, common-dir]`，走真实受限执行路径（`ctx.subprocess` + 沙箱 provider，而不是测试里裸跑 `execFile`）执行 `git add/commit/checkout -b` → 成功；对源仓执行 `git -C <project> checkout main` → 拒绝。
- **离开即收起**：`ctx.worktrees.leave(agent)`（或 `cd` 到项目根）后，副本与主仓 `.git` 都不再可写。
- **恢复**：重启后重放投影；副本被删时回退 header.cwd 并留 notice。
- **回归**：未设置投影的现有 worktree 测试保持 `workspaceRoot === root`（`packages/experimental/worktree/tests/sandbox.spec.ts:62-63, 82-89` 需要按新语义调整，而不是删掉）。

## 备选方案（否决）

| 方案 | 为什么不行 |
|---|---|
| 给现有会话一个 `setWorkspaceRoot()` / 插件猴补 `ctx.sandboxPolicy.resolve` | 只是换单根：git 管理目录仍然在外面；猴补不是受支持接口，没有 provider/撤销/审计，还会影响所有工具族 |
| worktree 当独立 workspace、会话 cwd = 副本（**今天就能做**） | 沙箱根、文件视图、侧栏归属确实都对了，但会话里 `git commit/checkout` 被拒；agent 改完不能提交，体验是半套 |
| 改写 `session.header.cwd` | 上游已明确否决（header 是身份/存储/分组/权限根） |
| 把 worktree 池做成子模块/嵌套仓库 | 不解决 git 管理目录在根外的问题，还引入子模块生命周期 |
| 让插件 host 代跑所有 git | 只覆盖插件自己的动词，agent 仍然不能提交，不是「会话空间」 |

## 分期与工作量

1. 策略类型 + 根并集 + `sandbox/roots` 投影 + fs fence + 提示文本（约 0.5–1 天）
2. bwrap / Landlock / Seatbelt（约 1 天）
3. Windows ACL 多根与撤销（约 1 天）
4. worktree 服务发布根、`leave()`、离开/恢复语义（约 0.5–1 天）
5. 测试与文档（约 1 天）

合计 3–5 天；全部向后兼容，无破坏性变更。

## 待上游拍板

1. 根的语义是**替换** header.cwd（严格隔离，推荐）还是**追加**（更保守，但解决不了「不许写主检出」）？
2. 共享 `.git` 是否必须可写（决定 commit 能不能用）？接受「可改分支、不可改工作树」的风险，还是先只做「只读 + 不可 commit」的版本？
3. 副本目录消失后的恢复：回退 header.cwd（推荐）还是拒绝 turn？
4. `sandbox/roots` 由谁写：工作区/feature 级（推荐，与 `permission-presets` 写 `sandbox/mode` 一致）还是任意工具？
5. Windows ACL 的 standing ACE 生命周期与撤销时机。
6. permission presets 切换时是否清根（建议：不清，根只由 worktree 服务负责）。

## 落地上游后，插件侧怎么接

- `dsh-worktree-switch` 可以改成「先建 worktree，再建会话」：`session.create({ cwd: <checkout> })` 或把副本注册成 workspace 后 `session.create({ workspaceId })`；会话的 header.cwd 就是副本，配合本提案的根集合，空间、沙箱、git 全部落在副本里。
- 在那之前，插件保持现状（开关只切 cwd + 关闭即撤回），并明确告知用户「副本不是写隔离」。当前已在 `dsh-worktree-switch` 修复「关掉开关后会话仍留在副本里」的问题（`release` 动词）。

## 参考

- 策略与根：`packages/sandbox/sandbox-policy/src/index.ts`、`packages/sandbox/sandbox/src/index.ts`、`packages/sandbox/sandbox/src/roots.ts`
- 执行方言：`packages/sandbox/sandbox-local/src/profiles.ts`、`packages/sandbox/sandbox-local/src/index.ts`、`packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts`
- 进程内 fence：`packages/fs/fs-sandbox/src/index.ts`
- 目录所有权：`packages/session/working-directory/src/index.ts`、`.agents/notes/implemented/architecture/2026-09-13-session-working-directory.md`
- worktree 运行时：`packages/experimental/worktree/src/index.ts`、`packages/experimental/worktree/README.md`、`.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md`
- 会话创建：`packages/api/session-controller/src/commands.ts`、`packages/client/ui-workspace/src/client/navigation.ts`
- 文件视图：`packages/api/workspace-files/src/index.ts`
