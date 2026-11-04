# `dsh-lifecycle-hooks`

声明式生命周期钩子。把规则写成仓库里的 `.dsh/hooks.json`，随代码提交；插件按 session 的
当前工作目录读它，在工具执行前按名称与参数匹配，命中的 `deny` 让这次工具调用**不执行**，
拒绝理由作为工具结果回到模型。

本插件实现 spec [#7](https://github.com/mxn404/deepseek-plugins/issues/7) 的第一刀：
[#8](https://github.com/mxn404/deepseek-plugins/issues/8) 的最小工具门禁（walking skeleton）。
后续票在同一套配置 schema、发现与 e2e harness 上补齐其余事件、command / module handler 与
context / replace 等 outcome；这一刀只把 `tool.pre` + builtin `deny` 这条链路打通。

## 它做什么

- **发现**：从 session 当前目录读 `.dsh/hooks.json`（即 `ctx.workingDirectory.get(session)`，
  `cd` 之后跟着变）。文件不存在就什么都不做：不注入消息、不打日志、不写记录。
- **匹配**：`match.tool` 认精确名、`a|b` 集合与 `/regex/`；`match.args` 是工具入参的**深子集**
  ——对象按 key 递归、数组按下标前缀、字符串叶子默认精确相等，写成 `/regex/` 则对实际字符串
  做正则测试。`match` 整体省略表示匹配该事件点的全部调用。
- **拒绝**：命中的 builtin `deny` 返回 `{ kind: 'deny', reason }`，宿主的工具管线因此不进入
  工具实现，模型收到的工具结果就是 `Error: <reason>`。被拒绝的调用不会产生副作用。
- **合并**：同一事件点的多条 hook 按文件内数组顺序执行；本刀只有 `deny`，第一条拒绝的理由生效。
- **审计**：每次 hook 运行往 session 写一条 `plugin:dsh-lifecycle-hooks/run`，含 `event`、
  `source`（配置文件绝对路径）、`hook_id`、`handler`、`action`、`duration_ms`、`error`。
  记录不进入模型可见面，fork / resume 会带着走。
- **热重载**：每次工具调用前重新 stat 一次；文件变了才重读，所以改 hooks 后**下一次工具调用**
  就生效，不用重启 session。
- **失败不瘫痪**：坏 JSON / 读不了的整份文件只 warn 一次并沿用上一份有效配置（没有上一份就
  等于没配置）；单条 hook 配错只跳过该条并 warn，兄弟条目照常工作。
- **零打扰**：没有 `.dsh/hooks.json`、或文件里没有命中当前调用的 hook 时，不产生额外模型消息
  与日志。

## 配置

行配置在 profile 的 `cordis.patch.yml` 里按行 id `dsh-lifecycle-hooks` 覆盖（整块 `config`
替换）。默认值只写在 `src/config.ts` 的 schema 一处。

| 项 | 默认 | 作用 |
|---|---|---|
| `audit` | `true` | 每次 hook 运行是否写 `plugin:dsh-lifecycle-hooks/run` |
| `defaultTimeoutMs` | `30000` | hook 条目没写 `timeoutMs` 时的超时；builtin 动作同步完成，异步 handler 才用得上 |

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: dsh-lifecycle-hooks
  name: 'dsh-lifecycle-hooks'
  config:
    audit: false
    defaultTimeoutMs: 60000
```

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
- **一处文件**：这一刀只看 session 当前目录的 `.dsh/hooks.json`，不叠加用户级 / 祖先目录 /
  `hooks.local.json`。
- **重载靠 stat**：mtime + ctime + size 完全相同（例如同一毫秒内等长改写）的编辑不会被察觉，
  要到下一次真正改动才生效。
- **坏配置的可见性只有日志**：没有 UI；坏 JSON 保留上一份有效配置并 warn 一次，warn 出现在
  第一次用到该文件的工具调用上。
- **clone 即信任**：hooks 文件是仓库内容，克隆一个仓库就接受了它的规则。本版不执行任何仓库
  提供的代码（只做 deny 判定），但后续 handler 版本之前不会有信任门禁——这一条在
  spec 里是明确取舍。
