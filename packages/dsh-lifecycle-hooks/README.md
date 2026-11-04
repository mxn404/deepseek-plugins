# `dsh-lifecycle-hooks`

声明式生命周期钩子。把规则写成仓库里的 `.dsh/hooks.json`，随代码提交；插件按 session 的
当前工作目录读它，在工具执行前按名称与参数匹配，命中的 `deny` 让这次工具调用**不执行**，
拒绝理由作为工具结果回到模型。

本插件实现 spec [#7](https://github.com/mxn404/deepseek-plugins/issues/7) 的前两刀：
[#8](https://github.com/mxn404/deepseek-plugins/issues/8) 的最小工具门禁（walking skeleton）与
[#9](https://github.com/mxn404/deepseek-plugins/issues/9) 的分层发现 / 热重载。后续票在同一套
配置 schema、发现与 e2e harness 上补齐其余事件、command / module handler 与 context / replace
等 outcome；目前只把 `tool.pre` + builtin `deny` 这条链路打通。

## 它做什么

- **发现**：按 session 当前工作目录（`ctx.workingDirectory.get(session)`）解析三层配置，**全部
  叠加**：用户级 `${DSH_HOME:-~/.dsh}/hooks.json` → 从最近的 `.git` 根到当前目录的每一层
  `.dsh/hooks.json` → 同目录的 `.dsh/hooks.local.json`。合并顺序就是执行顺序（用户 → 祖先
  远→近 → 同层 project 先于 local），同一事件点多条 hook 里第一条命中的决定生效。没有 `.git`
  祖先时只看当前目录。两个 session 按各自的 cwd 解析；`cd` 之后下一次事件按新目录重新解析。
  任何一层文件都不存在就什么都不做：不注入消息、不打日志、不写记录。
- **匹配**：`match.tool` 认精确名、`a|b` 集合与 `/regex/`；`match.args` 是工具入参的**深子集**
  ——对象按 key 递归、数组按下标前缀、字符串叶子默认精确相等，写成 `/regex/` 则对实际字符串
  做正则测试。`match` 整体省略表示匹配该事件点的全部调用。
- **拒绝**：命中的 builtin `deny` 返回 `{ kind: 'deny', reason }`，宿主的工具管线因此不进入
  工具实现，模型收到的工具结果就是 `Error: <reason>`。被拒绝的调用不会产生副作用。
- **合并**：同一事件点的多条 hook 按合并顺序、文件内数组顺序执行；本刀只有 `deny`，第一条
  拒绝的理由生效。
- **审计**：每次 hook 运行往 session 写一条 `plugin:dsh-lifecycle-hooks/run`，含 `event`、
  `source`（配置文件绝对路径）、`hook_id`、`handler`、`action`、`duration_ms`、`error`。
  记录不进入模型可见面，fork / resume 会带着走。
- **热重载**：`fs.watch` + 50ms debounce 预热改动过的配置文件；每次解析前仍对每个候选文件做
  一次 mtime + ctime + size 快检。所以改 / 新建 / 删除任何一层配置后，**下一次事件**就用新
  配置，不用重启 session；watch 漏掉事件时 stat 兜底。
- **失败不瘫痪**：某一层坏 JSON / 读不了时只 warn 一次（警告里带该文件的绝对路径）并沿用**该层**
  上一份有效配置，其他层照常工作；没有上一份有效配置就等于这一层不存在。单条 hook 配错只跳过
  该条并 warn，兄弟条目照常工作。
- **零打扰**：没有任何一层的配置文件、或文件里没有命中当前调用的 hook 时，不产生额外模型消息
  与日志。

## 配置

行配置在 profile 的 `cordis.patch.yml` 里按行 id `dsh-lifecycle-hooks` 覆盖（整块 `config`
替换）。默认值只写在 `src/config.ts` 的 schema 一处。

| 项 | 默认 | 作用 |
|---|---|---|
| `audit` | `true` | 每次 hook 运行是否写 `plugin:dsh-lifecycle-hooks/run` |
| `defaultTimeoutMs` | `30000` | hook 条目没写 `timeoutMs` 时的超时；builtin 动作同步完成，异步 handler 才用得上 |
| `watch` | `true` | 是否用 `fs.watch` 预热改动过的配置；关掉后仍靠每次解析前的 stat 快检生效 |
| `userHooks` | `true` | 是否发现 `${DSH_HOME:-~/.dsh}/hooks.json` |
| `projectHooks` | `true` | 是否发现祖先链上的 `.dsh/hooks.json` |
| `localHooks` | `true` | 是否发现祖先链上的 `.dsh/hooks.local.json` |

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: dsh-lifecycle-hooks
  name: 'dsh-lifecycle-hooks'
  config:
    audit: false
    defaultTimeoutMs: 60000
    localHooks: false
```

## 配置来源与优先级

假设仓库根 `/repo`（含 `.git`），session 当前目录 `/repo/packages/app`，`DSH_HOME` 未设置：

| 顺序 | 层 | 路径 |
|---|---|---|
| 1 | user | `~/.dsh/hooks.json` |
| 2 | project | `/repo/.dsh/hooks.json` |
| 3 | local | `/repo/.dsh/hooks.local.json` |
| 4 | project | `/repo/packages/.dsh/hooks.json` |
| 5 | local | `/repo/packages/.dsh/hooks.local.json` |
| 6 | project | `/repo/packages/app/.dsh/hooks.json` |
| 7 | local | `/repo/packages/app/.dsh/hooks.local.json` |

同一事件点命中的 hook 按这个顺序执行；全部追加，不做覆盖。`.dsh/hooks.local.json` 是留给个人
覆盖、不进 git 的那一层——本插件**不会**替你写 `.gitignore`，需要自己加。

## hooks 文件格式

```jsonc
{
  "version": 1,
  "hooks": [
    {
      "id": "block-rm",
      "on": "tool.pre",
      "match": {
        "tool": "bash",
        "args": { "command": "/(^|\\s)rm\\s+-rf\\b/" }
      },
      "run": { "type": "builtin", "action": "deny", "reason": "rm -rf blocked" },
      "timeoutMs": 5000,
      "onFailure": "block"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 本插件的格式版本，当前只认 `1` |
| `hooks` | 是 | hook 数组；空数组合法（等于没有配置） |
| `hooks[].id` | 是 | 非空字符串，审计记录用它标识条目 |
| `hooks[].on` | 是 | 事件名；本版只调度 `tool.pre` |
| `hooks[].match` | 否 | 省略 = 全匹配；`tool` 与 `args` 是两条独立的约束 |
| `hooks[].run` | 是 | `{ "type": "builtin", "action": "deny", "reason": "…" }`；`reason` 省略时用默认文案 |
| `hooks[].timeoutMs` | 否 | 正整数，覆盖行配置的 `defaultTimeoutMs` |
| `hooks[].onFailure` | 否 | `open`（默认，失败放行）或 `block`（失败按事件合成阻断） |

不认识的字段静默忽略。`on`、`run.type`、`run.action` 的完整词汇属于 spec，但本版只执行
`tool.pre` + `builtin` + `deny`；写了其他合法值会 warn 一句 “not supported by this build”
并跳过该条，不会让整份文件失效。

匹配边界（都按 JSON 值判，不做字符串化）：`match.tool` 的 `/…/` 是**未锚定**的正则，需要整名
匹配时自己写 `^…$`；`match.args` 的深子集只检查写出来的 key，实际参数里多出来的 key 不影响
命中；数组按**下标前缀**比较，实际数组更短才算不匹配。

## 审计记录

```jsonc
{
  "event": "tool.pre",
  "source": "/repo/.dsh/hooks.json",
  "hook_id": "block-rm",
  "handler": "builtin",
  "action": "deny",
  "duration_ms": 0
}
```

`action` 只在 hook 真的做出决定时出现；`error` 只在 hook 运行失败时出现（失败的运行不贡献
决定）。本插件没有 UI，日志与这条记录是唯一的事后可观测面。

## 安装与验证

```sh
pnpm --dir /home/ubuntu/code/deepseek-harness dsh plugin --profile dev add \
  /home/ubuntu/code/deepseek-plugins/packages/dsh-lifecycle-hooks
pnpm --dir /home/ubuntu/code/deepseek-harness dsh --profile dev --dump-config   # 应出现 "# == dsh-lifecycle-hooks"
```

构建产物由 `prepare`（tsdown）产出；改完源码重新 `pnpm --filter dsh-lifecycle-hooks build`。

## Known blind spots

这些是这一刀接受的边界，不是待修的缺陷：

- **只覆盖 `tool.pre`**：其余事件、command / module handler、`ask` / `block` / `context` /
  `replace` / `continue` / `halt` 都还没实现；配置文件里合法地写了它们也只会被跳过并 warn。
- **`onFailure` 与 `timeoutMs` 目前无处生效**：builtin 动作是同步的，既不失败也不会超时；
  这两个字段为后面的 handler 保留了位置与校验。
- **重载靠文件系统通知与时间戳**：watch 是预热，stat 是兜底；两者都漏掉（例如同一毫秒内
  等长改写、且 watch 没报事件）时，要到下一次真正改动才生效。
- **发现只看 cwd 链**：只有 session 当前目录的祖先链参与解析；monorepo 里同一 session `cd`
  到别的包后按新链解析，但不会去读兄弟目录的配置。
- **坏配置的可见性只有日志**：没有 UI；坏 JSON 保留上一份有效配置并 warn 一次，warn 出现在
  第一次用到该文件的工具调用上。
- **clone 即信任**：hooks 文件是仓库内容，克隆一个仓库就接受了它的规则。本版不执行任何仓库
  提供的代码（只做 deny 判定），但后续 handler 版本之前不会有信任门禁——这一条在
  spec 里是明确取舍。
