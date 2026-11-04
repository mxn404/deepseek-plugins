# deepseek-plugins

存放多个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件的
pnpm workspace。每个插件是一个独立的 npm 包，声明 `dsh.bundle`，既可以单独装进某个
dsh profile，也可以通过本仓库生成的市场索引发布。

## 目录编排

```
deepseek-plugins/
├─ pnpm-workspace.yaml          # 工作区成员；市场生成器也读这里
├─ package.json                 # 根包：只做容器，绝不声明 dsh.bundle
├─ tsconfig.base.json           # 各插件包共享的编译选项
├─ .npmrc                       # autoInstallPeers=false：peer 必须显式声明
├─ .changeset/                  # 版本与变更记录（changesets）
├─ AGENTS.md                    # 仓库不变量与命令，供 agent 读取
├─ tooling/                     # 构建期共享预设，不发布、不被运行时 import
│  ├─ index.mjs
│  ├─ tsdown.host.mjs           # 宿主半 → lib/index.js（ESM）
│  └─ tsdown.client.mjs         # 浏览器半 → lib/client.js（__ModuleLoader__ 产物）
├─ scripts/
│  ├─ workspace.ts              # 工作区发现，规则与市场生成器一致
│  ├─ build.ts                  # 构建全部包 + 校验产物确实存在
│  └─ market.ts                 # 生成 site/index.json
├─ site/                        # 市场索引产物（默认 gitignore，由 CI 部署）
├─ packages/
│  ├─ _template/                # 复制即用的插件骨架，不进入市场
│  └─ dsh-<name>/               # 一个插件 = 一个包
└─ .github/workflows/
   ├─ ci.yml                    # typecheck + build + test
   └─ market.yml                # 打 tag 后重建索引并部署 Pages
```

## 本仓的插件

每个目录都是声明了 `dsh.bundle` 的可安装插件，装进 profile 后按行 id 覆盖配置：

| 包 | 形态 | 一句话 |
|---|---|---|
| `dsh-path-rules` | 仅宿主 | 按路径生效的 `.dsh/rules/` 规则；agent 碰到范围内的文件才注入对应约定 |
| `dsh-worktree-switch` | 宿主 + 浏览器 | 把会话放进 Git worktree 的开关、面板与侧边栏入口 |
| `dsh-lifecycle-hooks` | 仅宿主 | 仓库里的 `.dsh/hooks.json` 生命周期钩子：拦截/审批工具、改写结果、注入上下文、继续停下的 turn |

`dsh-path-rules` 与 `dsh-lifecycle-hooks` 没有浏览器半：没有 `src/client/`、`dsh.client`
与 `exports["./client"]`，`tsdown.config.ts` 也只跑 `hostConfig()`。

## 首次使用

1. 根 `package.json` 的 `repository.url` 已指向本仓库；改名或 fork 时改这一行——市场索引的
   `source.url` 与 `repository` 都由它生成，写错会让安装落到别的仓库。
2. `pnpm install`。
3. `cp -r packages/_template packages/dsh-<name>`，按模板 README 改名，再
   `pnpm install` 让新包进入 lockfile。

## 一个插件包

```
packages/dsh-foo/
├─ package.json                 # npm 身份 + dsh.bundle + dsh.client + engines.dsh
├─ cordis.patch.yml             # 这个包插进 profile 的那一行
├─ icon.svg                     # 插件页与市场的图标
├─ src/index.ts                 # 宿主半：普通 Cordis 插件
├─ src/client/index.tsx         # 浏览器半：由 exports["./client"] 发布
├─ locale/{en,zh}.json          # 展示文案（meta.title / meta.description）
├─ tsconfig.json
├─ tsdown.config.ts             # 两份构建，引用 tooling/ 预设
├─ tests/
└─ README.md
```

没有浏览器半的插件，删掉 `src/client/`、`exports["./client"]`、`dsh.client`，以及
`tsdown.config.ts` 里的 `clientConfig()` 即可。

## 为什么这样摆

编排由 dsh 的三条既有规则决定，不是风格偏好：

| 规则 | 后果 |
|---|---|
| 市场生成器发现顺序：根 `package.json` 的 `dsh.bundle` → workspace globs → 三层回退 | 根包**不能**声明 `dsh.bundle`，否则市场里只剩根包一张卡片 |
| 只有声明 `dsh.bundle` 的包才是可安装插件 | 共享构建配置放在 `tooling/`，天然不进市场；共享运行时包后果自负（见下） |
| 安装 spec 是 `git+<repo>.git#<sha>&path:/packages/<name>` | 插件目录必须稳定在 workspace glob 下，`packages/*` 是最省事的锚点 |

两条容易被忽略的：

- **`workspace:` 运行时依赖在 git 安装下会挂。** git 安装拉的是源码，`prepare` 在临时
  目录里构建，解析不到兄弟包。共享的运行时代码要么发布成独立普通 npm 包，要么让
  tsdown 在构建期内联；`tooling/` 只放构建期配置。
- **与宿主共享实例的 `@deepseek-ai/*` 必须 peer + dev 双写。** 只写 `devDependencies`
  会让运行时拿到第二份模块，`instanceof` 与单例状态全部失效。

## 新建插件

```sh
cp -r packages/_template packages/dsh-my-thing
cd packages/dsh-my-thing
```

按 `packages/_template/README.md` 改包名、插件 id、bundle 行、locale 与 icon，然后回
仓库根执行 `pnpm install` 让新包进入 lockfile。

## 本地开发

```sh
# 构建（会顺带校验 exports / bundle patch 指向的文件真的存在）
pnpm build

# 全量校验
pnpm check

# 装进专用 dev profile（绝对路径会被锚定为 link:）
pnpm --dir /home/ubuntu/code/deepseek-harness dsh plugin --profile dev add /home/ubuntu/code/deepseek-plugins/packages/dsh-my-thing
pnpm --dir /home/ubuntu/code/deepseek-harness dsh --profile dev --dump-config   # 应出现 "# == dsh-my-thing" 这一层
pnpm --dir /home/ubuntu/code/deepseek-harness dsh --profile dev web

# 不想动 profile 时，用临时 overlay（插件行的 name 写绝对路径）
pnpm --dir /home/ubuntu/code/deepseek-harness dsh web --patch ./packages/dsh-my-thing/cordis.patch.yml
```

link 安装会保留插件自己的 `node_modules`，但消费的仍是构建产物，所以改完源码记得
`pnpm --filter <包名> watch` 或重新 `pnpm build`。

## 发布

三条路线，按需要的信任成本取舍：

**1. npm（推荐）**

```sh
pnpm --filter dsh-my-thing publish
```

`prepare` 会在 npm 打包前跑 tsdown，用户 `dsh plugin add dsh-my-thing` 装到的是预构建
产物，不需要任何构建授权。

**2. git 直装**

```sh
dsh plugin --profile dev add 'git+https://github.com/mxn404/deepseek-plugins.git#<sha>&path:/packages/dsh-my-thing'
```

git 安装拉的是源码，pnpm 会先跑一次嵌套 `pnpm install`、再执行插件包的
`"prepare": "tsdown"`。pnpm ≥10 会拦下这次构建，需要用户放行：在 dsh GUI 里安装时，
插件管理器会把被拦的构建写进 profile 的 `allowBuilds` 待办，确认后重试即可；手工安装
则自己往 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { dsh-my-thing: true }`。
锁定 commit，别用分支名。

**3. 市场索引**

```sh
pnpm market --title "My plugins"
# 可选：--offline（完全不查注册表，只发 git 源）
#       --registry <url>（私有注册表）
```

产出 `site/index.json` + `site/icons/`。把它放到任意静态主机（`.github/workflows/market.yml`
已经把它部署到 GitHub Pages），然后在 Web GUI 的**发现**页添加该 `index.json` 的 URL。
打 tag 时 CI 会自动重跑。

每个插件按自己是否已发布**自动选源**：

| 状态 | 索引里的 source | 安装 spec | 用户门槛 |
|---|---|---|---|
| 已发到 npm | `npm`，列出注册表上全部未弃用的 bundle 版本 | `name@version` | 无：装预构建产物，不跑构建脚本 |
| 未发布 | `git`，钉 HEAD commit + 包路径 | `git+…#<sha>&path:/packages/x` | 一次 `allowBuilds` 审批 |

git 源还要求包已提交且工作区干净：索引钉的是 commit，未提交的包会被跳过并列出原因。
注册表不可达时同样回退到 git 源并打印警告。

### 市场里的安装摩擦

- **npm 源**：一键装完，无构建授权；版本列表来自注册表，用户可装旧版本。
- **git 源**：pnpm 会拦下 git 依赖的构建脚本，dsh 把它变成插件页里的待确认项
  （手工安装则在 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds`），且只能装索引钉
  的那个 commit。
- 插件稳定后就 `pnpm release:publish` 发 npm：下次生成索引时该包自动从 git 源切到 npm
  源，用户侧不再需要审批。
- **包名必须归你所有**：注册表按包名查版本，名字被别人占用就会列到对方的包。生成索引时
  会核对最新版本的 `repository`，与本仓库不一致会告警——看到告警就先改名，别让用户装错。

**4. 社区目录（awesome-dsh-plugin / dsh-market）**

Web GUI 里常见的第三方「插件市场」（`dshmarket`）不读本地索引，读的是
`awesome-dsh-plugin/awesome-dsh-plugin` 仓库生成的目录。收录方式就是一个 PR，只加一个
YAML 文件，没有上传接口：

```
data/plugins/<owner>__<repo>.yml
```

```yaml
url: https://github.com/owner/repo        # monorepo 子包用 /tree/main/packages/<name>
name: owner/repo                          # 子包用 owner/repo#<name>
category: git
description:
  en: One accurate sentence about what it does, ending with a period.
  zh: 一句话描述，以句号结尾。             # 可选，维护者会补
# icon: https://raw.githubusercontent.com/owner/repo/main/<路径>/icon-180.png
```

硬门槛（CI 自动检查）：包在**仓库根或 `packages/` · `plugins/` · `apps/` 子包**里声明
`dsh.bundle`；仓库创建满 **1 天**；仓库带 `dsh-plugin` topic；一个 PR 最多 3 条。
人工评审会读源码核对描述，并判断是否与已有条目重复——描述只写真实行为。

**先发 npm 再提交收录**：目录当前全部是 npm 源，装了 npm 包才有预构建安装与下载量；
未发布时条目仍然可用，但用户要过一次 `allowBuilds`。包里的 `repository` 字段要指回被
收录的那个仓库（含 `directory`），npm 包与条目才会自动关联。合并后夜间构建刷新目录，
市场里可见；之后发新版无需再提 PR。

### 版本与标签

多插件版本各自独立，用 changesets 管理：

```sh
pnpm changeset          # 记录变更（选包、选 bump 级别、写说明）
pnpm release:version    # 改版本号、生成 CHANGELOG
pnpm release:publish    # 发布未发布的包
```

标签形如 `dsh-foo@0.1.0`（scoped 包是 `@you/dsh-foo@1.2.0`），这正是市场索引生成器
认的格式。不要用 `vX.Y.Z`：市场生成器把这种标签视为"适用于所有包"，版本分叉后会写出
错乱的历史。

## 目录规约

- 包名：`dsh-<name>`（可用 scope）。插件 id、bundle 行 `name`、`__ModuleLoader__` id
  三者必须等于包名或包名可解析的 specifier。
- 插件行 `id` 与包名同名，用户才能在 profile 里按 id 覆盖配置。
- 每个 bundle 包都要有 `engines.dsh`，市场靠它标注兼容范围。
- 插件目录不要命名成 `test`、`tests`、`fixtures`、`example`、`examples`：市场生成器的
  回退扫描会跳过这些目录。
- `packages/_template` 以 `_` 开头并标记 `private`，本仓库的 `scripts/market.ts` 会跳过
  它。如果改用 harness 自带的参考生成器，它既不认 `private` 也不认 `_`，生成前请把模板
  移出 `packages/` 或临时删掉。

## 已知取舍

- 浏览器半的 sourcemap 关闭：包裹 `factory` 会改变行号，宁可没有地图也不给错的地图。
  需要地图时按 harness 的 `packages/client/tsdown.client.ts` 做 map 组合。
- `scripts/market.ts` 对未发布插件只列当前 commit 一个版本；已发布插件则列出注册表上的
  全部版本。要按 git tag 导出历史版本，用 harness 的参考生成器
  `apps/plugin-market-generator`。
