# `@dsh-plugins/template`

一个可直接复制的插件包骨架。它不是要安装的插件，模板本身也不会进入市场索引
（`scripts/market.ts` 跳过以 `_` 开头的目录）。

## 复制成新插件

```sh
cp -r packages/_template packages/dsh-my-thing
```

然后按顺序改这几处，名字必须三处一致（包名 / 插件 id / bundle 行）：

1. `package.json`：`name`、`description`、`keywords`、`version`（改成 `0.1.0`）、
   删掉 `"private": true`，补 `author` / `homepage` / `repository`。
2. `cordis.patch.yml`：`id` 与 `name`。
3. `src/index.ts` 与 `src/client/index.tsx` 的 `export const name`。
4. `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description`。
5. `icon.svg`。
6. 回到仓库根执行 `pnpm install`，让新包进入 lockfile。

## 一个插件包里有什么

| 路径 | 作用 |
|---|---|
| `package.json` | npm 身份 + `dsh.bundle`（配置层）+ `dsh.client`（浏览器半）+ `engines.dsh`（兼容范围） |
| `cordis.patch.yml` | 这个包插进 profile 的那一行 |
| `src/index.ts` | 宿主半：普通 Cordis 插件，导出 `name` / `Config` / `apply` |
| `src/client/index.tsx` | 浏览器半：由 `exports["./client"]` 发布 |
| `locale/{en,zh}.json` | 插件页与市场的展示文案 |
| `tsdown.config.ts` | 两份构建：宿主 ESM + 浏览器 `__ModuleLoader__` 产物 |

不需要浏览器半时：删 `src/client/`、`exports["./client"]`、`dsh.client`，以及
`tsdown.config.ts` 里的 `clientConfig()`。

## 依赖规则

- 需要与宿主共享实例的 `@deepseek-ai/dsh-*`、`@deepseek-ai/cordis` 包：
  `peerDependencies` + `devDependencies` 双写，否则运行时会拿到第二份模块。
- 只有本插件自己用的第三方库放 `dependencies`。
- 不要在这里 import 兄弟包（`workspace:*` 的运行时依赖在 git 子目录安装下解析
  不到）。共享代码要么发布成独立普通包，要么让 tsdown 在构建期内联。

## 校验

```sh
pnpm --filter <包名> typecheck
pnpm --filter <包名> test
pnpm build      # 构建全部包并校验 exports / bundle patch 文件确实存在
```

## 发布

- **npm**：`prepare` 会在打包前跑 tsdown，`pnpm --filter <包名> publish` 自带构建产物。
- **git 直装 / 市场安装**：同一条 `prepare` 也会在 git 安装后执行，缺了它装到的是没有
  `lib/` 的源码。pnpm ≥10 会拦下这次构建，安装时按 dsh 的提示在 `allowBuilds` 放行即可。
- 构建预设用相对路径 `../../tooling/index.mjs` 引用：git 安装时整个仓库树都在，但这个
  包不能依赖 `workspace:*` 的兄弟包，pnpm 的嵌套安装解析不了它。
