# AGENTS.md

本仓库是存放多个 dsh 插件的 pnpm workspace。下面的不变量决定插件能否被装进 dsh
profile、能否出现在市场索引里；改目录编排前先读 README.md 的“为什么这样摆”。

## 布局不变量

- 根 `package.json` 只做容器：**不得声明 `dsh.bundle`**。市场生成器发现根包声明
  `dsh.bundle` 时会只列根包，忽略其他所有插件。
- 一个可安装插件 = `packages/<name>/` 下一个声明 `dsh.bundle` 的包，配套
  `cordis.patch.yml`。没有 `dsh.bundle` 的包是普通库，不会进入市场。
- `tooling/` 只放构建期配置（tsdown 预设），**禁止 runtime import**，并且**不是 workspace 包**：插件包用相对路径 `../../tooling/index.mjs` 引用。写成 `workspace:*` 依赖会让 git 安装的嵌套 `pnpm install` 解析失败。
- 插件之间不得互相 `workspace:` 运行时依赖：git 子目录安装时解析不到兄弟包。共享代码
  要么发布成独立普通包，要么在构建期内联。
- 插件目录深度保持在 `packages/<name>`，不要嵌套；不要用 `test`、`tests`、`fixtures`、
  `example`、`examples` 命名插件目录（市场回退扫描会跳过）。
- 需要与宿主共享实例的 `@deepseek-ai/*` 包，`peerDependencies` 与 `devDependencies`
  双写。

## 命名

- 包名 `dsh-<name>`（可用 scope）；插件 id、bundle 行 `name`、客户端模块 id 保持一致。
- bundle 行 `id` 与包名同名，用户才能按 id 覆盖该行配置。
- 每个 bundle 包声明 `engines.dsh`。
- `locale/en.json` 必须有 `meta.title` 与 `meta.description`；市场展示以英文为必填。

## 命令

```sh
pnpm install        # 新增包后必须重跑，让 lockfile 收录
pnpm typecheck      # 各包 tsc --noEmit
pnpm build          # 构建全部包 + 校验 exports / bundle patch 文件存在
pnpm test           # 各包 vitest run
pnpm test:scripts   # scripts/ 里的纯函数单测（node --test）
pnpm check          # typecheck + build + test + test:scripts
pnpm market         # 生成 site/index.json：已发布包走 npm 源，未发布包走 git 源（须已提交）
```

## 发布

- 版本独立，用 changesets；标签格式 `<包名>@<版本>`，不要用 `vX.Y.Z`（市场会当成
  适用于所有包）。
- 每个插件包必须自带 `"prepare": "tsdown"`：npm 打包前与 git/市场安装后都靠它产出
  `lib/`。pnpm ≥10 会拦 git 依赖的构建，安装时由 dsh 的 `allowBuilds` 审批放行。
  `files` 必须包含 `lib`、`cordis.patch.yml`、`locale`、`icon.svg`。
- 市场源按包自动判定：注册表认识该包就用 npm 源（列全部版本），否则用 git 源（钉 HEAD）。
  新增或改名包后要重新生成索引；稳定后优先发 npm，安装无需 `allowBuilds` 审批。
- 浏览器半的 bundle 必须是 `window.__ModuleLoader__.load({ id, factory })` 形状，且
  `react` / `react-dom` / `@deepseek-ai/*` 保持 external，由页面模块表提供。
- 合并插件改动后的完整发版与市场索引验证清单见 [`.dsh/rules/release.md`](.dsh/rules/release.md)；
  dsh 会话会自动加载这条常驻规则，不需要每次提醒。

## 改动完成前

1. `pnpm check` 全绿。
2. 新插件能在 dev profile 里 `--dump-config` 看到自己的层。
3. 若改了 `package.json` 的 `dsh.bundle` / `dsh.client` / `exports`，同步更新
   `scripts/build.ts` 的校验预期与 README 的目录说明。
4. Windows 相关改动不依赖真 Windows 才能测：平台语义（工具名、路径方言、大小写、`NUL`
   选择）做成纯函数入参，Linux CI 覆盖；`windows-latest` lane 覆盖 install / typecheck /
   build / 纯函数与客户端 spec。文件锁、MAX_PATH 这类真实 OS 语义在 Windows 集成 harness
   落地前只是**文档化限制**，不要声称已被 CI 覆盖；缺工具时显式 skip 并写明原因，不要
   静默通过。

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles keep their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
