# `dsh-rules`

按路径生效的仓库规则。把约定写成 `.dsh/rules/**/*.md` 文件，**只有当 agent 碰到范围内的
文件时**，规则的正文才进入它的上下文；不带路径范围的规则在每次会话开始时全文载入。

这是 spec [#1](https://github.com/mxn404/deepseek-plugins/issues/1) 的第一刀
（[#3](https://github.com/mxn404/deepseek-plugins/issues/3)）：发现、解析、常驻规则、规则索引、
路径匹配、触发、去重、配置。shell 单文件读取触发与压缩后重放是第二刀
（[#4](https://github.com/mxn404/deepseek-plugins/issues/4)），对应配置项已经存在但不产生行为。

语义基线是 Claude Code 的 `.claude/rules/`，其中七处有意偏离记在
[ADR-0001](../../docs/adr/0001-rule-semantics-deviate-from-claude-code.md)。

## 它做什么

- **发现**：从项目根（最近的含 `.git` 的祖先）到 agent 工作目录之间的每一层，按 `roots`
  列出规则根（默认 `.dsh/rules`），递归收集 `*.md`。规则身份是**绝对路径**，`name` 是它
  相对规则根的路径去掉 `.md`。
- **解析**：可选 YAML frontmatter，`paths` 可以是 YAML 列表或逗号分隔字符串；不认识的字段
  静默忽略；正文剥掉 frontmatter。`paths` 相对「规则根名字所落在的那层目录」解析——把
  `.dsh/rules` 挪到某层祖先，同样的 glob 仍然有效。
- **常驻规则**（无 `paths`）：会话第一个模型请求就以全文注入。
- **路径规则**：会话开始时只进**规则索引**（name + 路径范围 + 放得下时带正文首行标题）；
  当 agent **成功** `read` / `write` / `edit` 了范围内的文件，**下一步**注入正文，并写明
  规则来源文件与触发它的文件。
- **合并且去重**：同一步内命中的所有规则合成**一条** user 角色 `<system-reminder>` 消息；
  每个 agent 对每条规则、每个内容版本只注入一次。规则文件在会话中被改动后，下次触发会
  重新注入新版本。
- **fail closed**：frontmatter 解析失败、文件超过 `maxBytes`、`paths` 展开超预算的规则
  **整条不注入**；它在索引里被标成 `unavailable (...)`，并写一条 `logger.warn`。本插件没有
  UI，日志是唯一的事后可观测面。
- **零打扰**：没有规则根的仓库不产生任何额外消息，也没有日志噪音。

## 配置

行配置在 profile 的 `cordis.patch.yml` 里按行 id `dsh-rules` 覆盖（整块 `config` 替换）。
默认值只写在 `src/config.ts` 的 schema 一处。

| 项 | 默认 | 作用 |
|---|---|---|
| `roots` | `['.dsh/rules']` | 规则根目录名，按「项目根 → 工作目录」的每一层解析。可加 `.claude/rules` 复用现成规则集 |
| `maxBytes` | `65536` | 单条规则文件的 UTF-8 字节上限；超过则整条不注入 |
| `indexMaxBytes` | `4096` | 规则索引的字节预算；超限依次降级：去标题 → 折叠成 name → 整份不注入并记日志 |
| `includeBashReads` | `true` | 是否为保守的 shell 单文件读取触发。第二刀消费，本刀接受但仍不触发 |
| `replayAfterCompaction` | `true` | 压缩后是否重放已注入规则。第二刀消费，本刀接受但不重放 |

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: dsh-rules
  name: 'dsh-rules'
  config:
    roots: ['.dsh/rules', '.claude/rules']
    maxBytes: 32768
    indexMaxBytes: 2048
```

## 规则格式

````md
---
# 可选。列表或逗号分隔字符串都行；相对规则根名字所在的那层目录。
paths:
  - "web/**"
  - "tests/web/**"
description: 给我自己看的说明，插件会忽略
---

# 改 web demo：关子进程 = 连坐处死它里面的一切

正文就是约定本身，会原样进入模型上下文。
````

glob 是标准语义：`**` 跨目录，`*` 不跨 `/`，另有 `?`、`{a,b}`、`[...]`；**不实现**
`!` 否定；多条 `paths` 取并集。规则按「祖先距离由远及近」排序，同层按路径字典序，
输出可复现。

## 安装与验证

```sh
pnpm --dir /home/ubuntu/code/deepseek-harness dsh plugin --profile dev add /home/ubuntu/code/deepseek-plugins/packages/dsh-rules
pnpm --dir /home/ubuntu/code/deepseek-harness dsh --profile dev --dump-config   # 应出现 "# == dsh-rules"
```

构建产物由 `prepare`（tsdown）产出；改完源码重新 `pnpm --filter dsh-rules build`。

## Known blind spots

这些是已接受的行为，不是待修的缺陷：

- **注入只能落在下一步**：触发发生在第 N 步（那次读/写/改已经发生），规则正文出现在第
  N+1 步的请求里。它约束的是之后的工作，不是刚刚那个动作。
- **索引是会话开始时的快照**：会话中途新建的规则文件不会补进索引；但它仍然会在下次触发
  时被发现并注入（发现会在需要触发的步骤重新列目录）。
- **软链会导致重复注入**：身份是绝对路径，同一个文件经软链出现两份路径时会被当成两条规则
  各注入一次；不复刻上游的 inode 去重。
- **只做项目内规则**：没有用户级 `~/.dsh/rules/`，也不会向下发现子目录里的规则根；monorepo
  的多包约定用「祖先目录的规则根 + `paths` 作用域」表达。
- **本刀不认 shell 读取**：`includeBashReads` 已存在但只由第二刀消费；现在 `cat` / `grep`
  这类 shell 读取**不触发**注入。
- **本刀不重放压缩**：`replayAfterCompaction` 已存在但只由第二刀消费；压缩后的会话不会
  自动重新注入已载入的规则。
- **失败可见性只在日志与索引**：没有 UI，坏规则不会弹窗；索引里的 `unavailable` 与一条
  `warn` 是全部线索。
