# `dsh-lifecycle-hooks`

声明式生命周期钩子。把规则写成仓库里的 `.dsh/hooks.json`，随代码提交；插件按 session 的
当前工作目录发现用户级、项目级与 local 三层配置，把 **dsh 原生**的生命周期事件分发给三种
handler：一行 `builtin`、一个子进程 `command`、或一个进程内 `module`。它能拦住工具调用
（`deny` / `ask`）、改写模型读到的工具结果（`block` / `replace`）、给 session 与 step 注入
上下文、让自然停下的 turn 再走一步；`tool.result`、`session.end`、`notification` 只观察。
每次运行写一条审计记录，供事后还原。

它是原生实现，不是桥：事件名、payload、outcome 都来自 dsh 的扩展点，**不复用** Claude Code
的 `hook/*` 方言，也不读 `.claude/`。要跑现有 Claude Code hooks 请装
`dsh-hooks-claude-code`；要跨 session 的通知/审计面板请看第三方 `dsh-hooks`（见
[与其它 hook 插件的区别](#与其它-hook-插件的区别)）。

本插件实现 spec [#7](https://github.com/mxn404/deepseek-plugins/issues/7)。设计取舍见
[ADR-0002](../../docs/adr/0002-native-lifecycle-hooks-not-a-bridge.md)、
[ADR-0003](../../docs/adr/0003-project-hooks-clone-equals-trust.md) 与
[ADR-0004](../../docs/adr/0004-no-updatedinput-and-no-compaction-interception.md)。

## 安装

### 从 npm（发布后）

```sh
dsh plugin --profile dev add dsh-lifecycle-hooks
```

装的是预构建产物（`prepare` 在发布前已经跑过），用户侧不需要构建授权。包名在写 spec 时
npm 404；**发布前**要再查一次（ticket #17 的收口项），确认没有被别人占用。

### 从市场索引或 git 源

仓库根生成索引后（`pnpm market`），未发布的包以 git 源出现，安装 spec 形如：

```sh
dsh plugin --profile dev add 'git+https://github.com/mxn404/deepseek-plugins.git#<sha>&path:/packages/dsh-lifecycle-hooks'
```

git 安装拉源码，pnpm 会先做嵌套安装、再跑本包的 `"prepare": "tsdown"`。pnpm ≥10 默认拦下
依赖的构建脚本：在 dsh GUI 里安装时，插件管理器会把 `dsh-lifecycle-hooks` 写进 profile 的
`allowBuilds` 待办，确认后重试；手工安装则自己往 profile 的 `pnpm-workspace.yaml` 加
`allowBuilds: { dsh-lifecycle-hooks: true }`。安装 spec 要钉 commit，不要用分支名。

### 本地开发：link 安装

```sh
pnpm --dir /home/ubuntu/code/deepseek-harness dsh plugin --profile dev add \
  /home/ubuntu/code/deepseek-plugins/packages/dsh-lifecycle-hooks
pnpm --dir /home/ubuntu/code/deepseek-harness dsh --profile dev --dump-config \
  | grep '# == dsh-lifecycle-hooks'
```

绝对路径会被锚成 `link:` 依赖，消费的是 `lib/` 构建产物，所以改完源码要重新
`pnpm --filter dsh-lifecycle-hooks build`（或 `watch`）。若 `dsh plugin add` 因 pnpm store
不可写而失败（本沙箱的默认 store 即如此），先在**该 profile** 的 `pnpm-workspace.yaml` 里
写一行 `storeDir: <可写的 store>`，再重试同一条命令。

不想动 profile 时，用临时 overlay：

```sh
pnpm --dir /home/ubuntu/code/deepseek-harness dsh web \
  --patch ./packages/dsh-lifecycle-hooks/cordis.patch.yml
```

overlay 里这一行的 `name` 要写成插件包的绝对路径，否则从仓库根启动的宿主解析不到包名。

## 快速开始

把下面这份放进仓库根的 `.dsh/hooks.json`（随代码提交）：

```jsonc
{
  "version": 1,
  "hooks": [
    {
      "id": "block-rm",
      "on": "tool.pre",
      "match": { "tool": "bash", "args": { "command": "/(^|\\s)rm\\s+-rf\\b/" } },
      "run": { "type": "builtin", "action": "deny", "reason": "rm -rf is blocked by .dsh/hooks.json" }
    },
    {
      "id": "format-after-write",
      "on": "tool.post",
      "match": { "tool": "write|edit" },
      "run": { "type": "module", "path": "hooks/format.mjs" },
      "timeoutMs": 60000
    },
    {
      "id": "notify-approval",
      "on": "notification",
      "run": { "type": "command", "command": "notify-send dsh 'an approval is waiting'", "async": true }
    }
  ]
}
```

- `block-rm` 命中时工具**不执行**，模型收到的工具结果是 `Error: rm -rf is blocked by .dsh/hooks.json`。
- `format-after-write` 指向 `.dsh/hooks/format.mjs`（路径相对**声明它的 hooks 文件所在目录**）。
- `notify-approval` 在每次审批请求或 agent 错误时脱手跑一次，不参与任何决策。

没有 `.dsh/hooks.json` 的仓库零打扰：不注入消息、不打日志、不写记录。

## 配置

### 行配置

在 profile 的 `cordis.patch.yml` 里按行 id `dsh-lifecycle-hooks` 覆盖；一个 patch **整块
替换** `config`，不按键合并。默认值只写在 `src/config.ts` 一处。

| 项 | 默认 | 作用 |
|---|---|---|
| `audit` | `true` | 每次 hook 运行是否写 `plugin:dsh-lifecycle-hooks/run` |
| `defaultTimeoutMs` | `30000` | 条目没写 `timeoutMs` 时的超时；command 与 module 用它，builtin 同步完成用不上 |
| `watch` | `true` | 是否用 `fs.watch` 预热改动过的配置；关掉后仍靠每次解析前的 stat 快检生效 |
| `userHooks` | `true` | 是否发现 `${DSH_HOME:-~/.dsh}/hooks.json` |
| `projectHooks` | `true` | 是否发现祖先链上的 `.dsh/hooks.json` |
| `localHooks` | `true` | 是否发现祖先链上的 `.dsh/hooks.local.json` |
| `maxStopContinues` | `8` | 单个 turn 允许的连续 `turn.stop` continue 次数；超过后忽略并 warn |

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: dsh-lifecycle-hooks
  name: 'dsh-lifecycle-hooks'
  config:
    audit: false
    defaultTimeoutMs: 60000
    localHooks: false
    maxStopContinues: 4
```

### hooks 文件

```jsonc
{
  "version": 1,
  "hooks": [
    {
      "id": "guard-deploy",
      "on": "tool.pre",
      "match": { "tool": "bash", "args": { "command": "/^deploy /" } },
      "run": { "type": "command", "command": "node .dsh/hooks/guard-deploy.mjs" },
      "timeoutMs": 2000,
      "onFailure": "block"
    },
    {
      "id": "redact-token",
      "on": "tool.post",
      "match": { "tool": "bash|read" },
      "run": { "type": "command", "command": "node .dsh/hooks/redact-token.mjs" }
    },
    {
      "id": "hide-binary",
      "on": "tool.post",
      "match": { "tool": "read", "args": { "file_path": "/\\.png$/" } },
      "run": { "type": "builtin", "action": "block", "reason": "read the image with the image tool" }
    },
    {
      "id": "project-notes",
      "on": "session.start",
      "run": { "type": "builtin", "action": "context", "text": "先读 CONTRIBUTING.md" }
    },
    {
      "id": "gate-prompt",
      "on": "step.start",
      "match": { "prompt": true },
      "run": { "type": "command", "command": "node .dsh/hooks/gate-prompt.mjs" }
    },
    {
      "id": "retry-red-tests",
      "on": "turn.stop",
      "run": { "type": "command", "command": "node .dsh/hooks/run-tests.mjs" }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 本插件的格式版本，当前只认 `1` |
| `hooks` | 是 | hook 数组；空数组合法（等于没有配置） |
| `hooks[].id` | 是 | 非空字符串，审计记录用它标识条目 |
| `hooks[].on` | 是 | 钩子点；本版调度 `session.start` / `step.start` / `tool.pre` / `tool.post` / `tool.result` / `turn.stop` / `session.end` / `notification` |
| `hooks[].match` | 否 | 省略 = 全匹配；可用维度取决于事件（见[能力矩阵](#事件与能力矩阵)） |
| `hooks[].run` | 是 | handler；`builtin`、`command` 或 `module` |
| `hooks[].run.command` | command 必填 | shell 命令行，cwd 是 session 当前目录 |
| `hooks[].run.path` | module 必填 | 模块路径，相对声明它的 hooks 文件目录；只认 `.mjs` / `.js` |
| `hooks[].run.async` | 否 | `true` 时脱手执行：只做副作用、不参与决策，销毁时中止；`command` 与 `module` 都支持，只观察事件强制为 `true` |
| `hooks[].timeoutMs` | 否 | 正整数，覆盖行配置的 `defaultTimeoutMs` |
| `hooks[].onFailure` | 否 | `open`（默认，失败放行）或 `block`（失败按事件合成阻断） |

不认识的字段静默忽略。整份文件坏掉（不是 JSON、没有 `version` / 不是 1、`hooks` 不是数组）
只跳过该文件并 warn，保留该层上一份有效配置；单条坏 hook（缺 `id`、未知事件、非法 regex、
事件不支持的 match 维度或 action、`.ts` 模块）只跳过该条并 warn，兄弟条目照常工作。

### 匹配

| 维度 | 用于 | 语义 |
|---|---|---|
| `match.tool` | 三个工具事件 | 精确名、`a\|b` 集合，或 `/regex/`（**未锚定**，整名匹配自己写 `^…$`） |
| `match.args` | 三个工具事件 | 工具入参的**深子集**：对象按 key 递归、数组按下标前缀、字符串叶子默认精确相等，写成 `/regex/` 则对实际字符串做正则测试 |
| `match.prompt` | `step.start` | `true` = 用户提交的一步，`false` = 工具续跑的一步；省略 = 两种都选 |

`match` 整体省略表示匹配该事件点的全部调用。`session.start`、`turn.stop`、`session.end`
与 `notification` 没有选择维度：写了 `match` 的条目在加载时被跳过并 warn。`step.start`
不接受 `tool` / `args`，工具事件不接受 `prompt`，同样在加载时跳过。

## 事件与能力矩阵

五个事件参与决策，三个只观察。`session.start` 只能加 context，`turn.stop` 只能
`continue`；`tool.result` / `session.end` / `notification` 发生在宿主已经提交事实之后，
没有可应用的 decision，它们的 command/module **一律强制脱手**，builtin 条目在加载时跳过。

| 事件 | dsh 扩展点 | match 维度 | 可用 outcome | 阶段与可观测性 |
|---|---|---|---|---|
| `session.start` | `agent/created` | 无 | `context` | 串行 await；context 进 next-step inbox，由首个 `agent/pre-step` claim，保证在**第一个**模型请求前到达；每次运行记审计 |
| `step.start` | `agent/pre-step` | `prompt` | `deny`、`context`、`halt` | 串行 await 在 pre-step waterfall；`deny` 拒绝这一步（prompt 不进模型），`context` 折进这一步的 `enter.messages`，`halt` 以 `{ kind: 'hook' }` 取消本轮 |
| `tool.pre` | `tools/pre-execute` | `tool`、`args` | `deny`、`ask`、`context`、`halt` | 串行 await；`deny` 后工具**不执行**，理由成为该调用的错误结果；`ask` 交宿主审批；`context` 用 `agent.inject`，**下一步**才到；`halt` 取消本轮并 deny 本次调用 |
| `tool.post` | `tools/post-execute` | `tool`、`args` | `block`、`replace`、`context`、`halt` | 串行 await，但工具**已经执行**；`block` 把结果变成 `isError`，`replace` 只换模型可见 `content`，`context` 走 `additionalContexts`（下一步到）；`halt` 取消本轮并阻断该结果 |
| `tool.result` | `tools/result` | `tool`、`args` | 无（只观察） | 宿主 emit，结果已冻结；强制脱手，不阻塞、不改写；outcome 被忽略并 warn |
| `turn.stop` | `agent/turn-stopping` | 无 | `continue` | 串行 await，但宿主的返回值被忽略；plan 用 `agent.steer` 把合并后的消息放进 next-step inbox，让本轮再走一步；受 `maxStopContinues` 限制 |
| `session.end` | `agent/disposed` | 无 | 无（只观察） | teardown 中的 emit；强制脱手、不阻塞 disposal，插件销毁时由 detached tracker 兜底中止；payload 带最后关闭的 `turn` 与可选 `reason` |
| `notification` | 派生：durable `approval/asked` + Cordis `agent/error` | 无 | 无（只观察） | 强制脱手；payload 的 `type` 为 `approval` / `error`，`message` 一行，approval 才有 `tool_name`；approval 需要该 session 的 agent 仍活着，否则跳过 |

**阻塞与只观察的差别**：`session.start` / `step.start` / `tool.pre` / `tool.post` 能改变
宿主接下来的行为；`turn.stop` 只决定本轮是否再走一步；`tool.result` / `session.end` /
`notification` 只能记录和通知——在它们上面返回 outcome 不会生效，插件 warn 一句并保留
它带的 context。

## Handler

### builtin

一行配置完成一个动作，不启动任何进程。加载时就按事件校验 action，不支持的动作让**该条**
被跳过（不会整份文件失效）；`tool.result` / `session.end` / `notification` 不接受任何
builtin 动作。

| 事件 | builtin 可用动作 | 写法 |
|---|---|---|
| `session.start` | `context` / `inject` | `{ "action": "context", "text": "…" }`（`inject` 等价） |
| `step.start` | `deny` / `context` / `inject` / `halt` | `{ "action": "deny", "reason": "…" }`（`halt` 可不写 reason） |
| `tool.pre` | `deny` / `ask` / `context` / `inject` / `halt` | `{ "action": "deny", "reason": "…" }` / `{ "action": "ask", "reason": "…" }` / `{ "action": "halt", "reason": "…" }` |
| `tool.post` | `block` / `replace` / `context` / `inject` / `halt` | `{ "action": "block", "reason": "…" }` / `{ "action": "replace", "text": "…" }` / `{ "action": "halt", "reason": "…" }` |
| `turn.stop` | `continue` | `{ "action": "continue", "reason": "…" }`（reason 可省） |
| 三个只观察事件 | 无 | 用 `command` / `module`；写 builtin 会在加载时跳过并 warn |

`reason` 是模型可见的阻断理由，缺省时按动作补一句默认文案；`text` 是 context / inject
的提醒行，或 replace 的替换文本，必须非空；`continue` 的 `reason` 可省，多个 continue
的理由会按顺序拼进同一条 steer 消息。`inject` 是 builtin 词汇里「补一句 context」的动作，
本插件把它折算成 `context` 的一条文本；两种写法在 `session.start` / `step.start` /
`tool.pre` / `tool.post` 上等价。`halt` 只在有 turn 可取消的可决策事件上合法
（`step.start` / `tool.pre` / `tool.post`）；`session.start` 与 `turn.stop` 上的 halt
在加载时跳过并 warn。

### command

```jsonc
{
  "id": "guard-deploy",
  "on": "tool.pre",
  "match": { "tool": "bash", "args": { "command": "/^deploy /" } },
  "run": { "type": "command", "command": "node .dsh/hooks/guard-deploy.mjs", "async": false },
  "timeoutMs": 2000,
  "onFailure": "block"
}
```

- **stdin** 是一份 JSON：公共字段 `event`、`time`、`session_id`、`cwd`、`agent_id`、`turn`、
  `step`、`source`（配置文件绝对路径）、`hook_id`。事件自己的字段：
  - `session.start`：`source` —— 会话启动来源（`startup` / `resume` / `clear` / `compact`），
    **覆盖**上面那个文件路径键；要拿配置文件路径请读审计记录的 `source`。
  - `step.start`：`prompt`（这一步没有用户输入时为 `null`）、`message_count`。
  - `tool.pre` / `tool.post` / `tool.result`：`tool`（`{ name, call_id, input }`）；
    后两者还有 `result`（`{ is_error, content }`）。
  - `turn.stop`：`turn`、`continued_count`（本次 stop 之前该 turn 已授予的连续 continue 数）。
  - `session.end`：`turn`、可选 `reason`（最后一个关闭 turn 的结束原因）。
  - `notification`：`type`（`approval` / `error`）、`message`、approval 才有的 `tool_name`。
- **env** 至少带 `DSH_HOOK_EVENT`、`DSH_HOOK_SESSION_ID`、`DSH_HOOK_CWD`、
  `DSH_HOOK_TURN`、`DSH_HOOK_STEP`、`DSH_HOOK_ID`，与 stdin 的对应字段一致。
- **stdout** 只认**一个** JSON outcome：
  `{ "action": …, "reason": …, "displayReason": { "en": … }, "context": [ … ], "replace": { "text": … }, "meta": { … } }`。
  空输出等于「没有动作」；只写 `{ "replace": { "text": … } }` 也合法（等价于 `replace`）。
  `meta` 是自由格式的 JSON 对象（数组不算），只随审计记录落盘，不改变事件行为；写了非 JSON
  对象是协议错误，按运行失败处理。
- **失败**：非零退出、stdout 不是 JSON、`replace.value`（协议错误）、超时都按运行失败处理，
  默认放行（见 `onFailure`）。超时由宿主 shell 执行器杀掉**整个进程组**。
- **异步**：`async: true` 的条目脱手执行，只做副作用、不参与决策，插件销毁时会被中止。

### module

```jsonc
{
  "id": "format-after-write",
  "on": "tool.post",
  "match": { "tool": "write|edit" },
  "run": { "type": "module", "path": "hooks/format.mjs" },
  "timeoutMs": 60000,
  "onFailure": "block"
}
```

```js
// .dsh/hooks/format.mjs —— 与 .dsh/hooks.json 同目录下的 hooks/
import { writeFileSync } from 'node:fs'

export default async (ctx) => {
  const path = ctx.tool.input.file_path
  const result = await ctx.exec(`node .dsh/hooks/tidy.mjs ${path}`)
  if (result.exitCode !== 0) {
    return { action: 'block', reason: 'formatter failed: ' + result.stderr }
  }
  ctx.inject('the hook formatted ' + path)
  ctx.log('formatted ' + path)
  return { context: ['the formatter rewrote this file'] }
}
```

默认导出就是 hook：`(ctx) => outcome | void | Promise<…>`。路径相对**声明它的 hooks 文件
所在目录**（`.dsh/hooks.json` 里写 `hooks/format.mjs`），只认 `.mjs` / `.js`；`.ts` 需要
先编译，本版不做。

`ctx` 就是全部可用的东西，没有别的：

| 字段 | 说明 |
|---|---|
| `event` | 事件名，与 payload 里的 `event` 相同 |
| `payload` | 事件 payload，和 command 从 stdin 读到的是同一份 |
| `agent` | 这个事件所属的活 agent（`inject` / `steer` / `cancel` …） |
| `session` | 活 Session，审计记录也写在这里 |
| `tool` | 有工具的事件上为 `{ name, call_id, input }`，否则 `undefined` |
| `result` | 带结果的事件上为 `{ is_error, content }`，否则 `undefined` |
| `signal` | 事件被放弃或本条超时后 abort；不响应它的模块会继续跑完 |
| `log(message)` | 走宿主 logger，前缀 `dsh-lifecycle-hooks: module "<id>" at <event>: `，不进模型 |
| `inject(text)` | 给下一步塞一条 `<system-reminder>`，返回是否送达 |
| `steer(text)` | 用一条 `<system-reminder>` 唤醒下一步，返回是否送达 |
| `exec(command, options?)` | 走宿主 `ctx.shell`：cwd 是 session 当前目录，signal 是事件 signal（加上本条超时）；`options` 可带 `timeoutMs` / `env` / `stdin` |
| `handler` | 这条 hook 自己的 `{ id, event, source }` |

`exec` 把失败当数据返回，不抛异常：
`{ exitCode, stdout, stderr, timedOut, aborted, disabled }`。`exitCode` 为 `null` 表示进程
没给出退出码（起不来、被杀）；`disabled: true` 表示这次运行已经结束（超时 / 取消 / 模块已
返回），命令**根本没有启动**。模板字符串拼命令会经过 shell，需要转义时自己引用参数。

模块的生命周期：

- **改了就重载**：每次运行先 `stat` 文件，把 `mtimeMs` 拼进 import URL（`?v=<mtimeMs>`），
  改完模块后**下一次事件**就是新代码；先失败后补上文件也一样。
- **超时**：条目 `timeoutMs` 优先，否则行 `defaultTimeoutMs`。超时（或事件被取消）后本次
  运行立刻记为失败、按 `onFailure` 处理，并**关闭 `inject` / `steer` / `exec`**，晚到的
  副作用落不到任何地方。模块自己的 `import` 与文件写入不经过 helper，仍会执行。
- **无法强杀**：模块是宿主进程里的普通 JS；不响应 signal、也一直不 resolve 的模块无法从
  插件侧终止。这是拿活 agent / session 的代价，见[已接受的盲区](#已接受的盲区)。
- **脱手**：`async: true` 的模块不被事件等待、不参与决策，副作用与审计照旧；插件销毁时
  它的 signal 会被 abort。
- **失败**：模块缺失 / 读不了 / import 抛错 / 没有 default export / 模块抛错 / 超时，都是
  这一次运行失败。默认 fail open；`onFailure: "block"` 时按事件合成阻断。

## Outcome 与合并

同一个事件点命中的 hook 按配置顺序执行（见[发现、优先级与热重载](#发现优先级与热重载)），
结果按固定优先级合并：

1. `halt` —— 取消当前 turn，压过其它一切；只有能阻断的事件支持。
2. `deny` / `block` —— 第一条的理由生效，后面的不能软化它；`deny` / `block` 永远压过
   `ask`，与书写顺序无关。
3. `ask` —— 只在 `tool.pre` 生效；多个 ask 取第一条，不弹第二次。
4. `continue` —— 只在 `turn.stop` 生效；所有 continue 的理由按顺序拼成**一条** steer 消息。
5. `replace` —— 最后一个生效，后面的 hook 可以精修前面的替换。
6. `context` —— 全部保留，按配置顺序拼接；即使 `block` / `deny` 胜出，context 也保留。
7. `meta` —— 不参与优先级；各 run 的审计文档按配置顺序最后一个生效，只写进合并结果与审计记录。

事件不支持的 action 会 warn 一句并忽略，但保留它带的 context。同一事件点的全部 context
拼成**一条** user 消息，包成 `<system-reminder>`，message source 标
`dsh-lifecycle-hooks`（`src/context.ts` 是唯一的 message 形状与 source 声明）。送达方式：
`session.start` / `tool.pre` 用 `agent.inject`，`step.start` 折进 `enter.messages`，
`turn.stop` 用 `agent.steer`，`tool.post` 走宿主 `additionalContexts`。`session.start` 的
提醒出现在**首个**模型请求，其余事件都在**下一步**的请求里出现。

`halt` 映射到宿主已有的 `agent.cancel({ kind: 'hook', reason })`：`tool.pre` 的 halt 同时
deny 本次调用，`tool.post` 的 halt 同时把该结果变成错误，模型不会读到 hook 愿意中断这一轮
的那段输出。halt 路径不注入 context（这一轮已经取消，inbox 不再有意义）。

### 失败语义

默认 `onFailure: "open"`：一次运行失败（非零退出、坏 JSON、超时、模块抛错……）只 warn、
记审计、不贡献任何决定，事件照常继续。条目写 `onFailure: "block"` 时，失败按事件合成
阻断：

| 事件 | `onFailure: "block"` 合成 |
|---|---|
| `tool.pre` / `step.start` | `deny`，理由含 hook id 与错误 |
| `tool.post` | `block`，理由含 hook id 与错误 |
| `session.start` / `turn.stop` / 三个只观察事件 | 不合成（本来就没有阻断动作），保持放行 |

### turn.stop 的 loop guard

`turn.stop` 的 `continue` 每授予一次都计数，按 **agent + turn** 记；turn 号一变计数从 0
开始。达到 `maxStopContinues`（默认 8）后忽略 `continue`、warn，turn 正常关闭。同一 stop
上多个 hook 的 `continue` 合并成一次 steer，也只计一次。

### 审计与审批

每次 hook 运行往 session 写一条 `plugin:dsh-lifecycle-hooks/run`：

```jsonc
{
  "event": "tool.pre",
  "source": "/repo/.dsh/hooks.json",
  "hook_id": "guard-deploy",
  "handler": "command",
  "action": "deny",
  "duration_ms": 42,
  "exit_code": 0,
  "meta": { "rule": "no-rm", "severity": 2 }
}
```

- `action` 是这次运行**自己产出**的动作（`deny` / `ask` / `block` / `replace` / `halt` /
  `continue`），不代表事件一定采纳了它；只带 context 的运行没有 `action`。
- `meta` 只在 handler 的 outcome 里给了这个字段时出现；它是审计数据，宿主与插件都不据此
  改变行为。
- `exit_code` 只在 command 运行拿到退出码时出现（超时被杀、被信号杀死时没有）。
- `continued_count` 只在 `turn.stop` 的每条记录上出现（本次 stop 之前该 turn 已授予的
  连续 continue 次数）。
- `error` 只在运行失败时出现；`onFailure: "block"` 时同一条记录会同时带 `error` 与合成的
  `action`。
- **写不进 Session 时兜底到文件**：实验性的 plugin-record API 不可用、或宿主拒收这条记录
  时，同一份 payload 会以一行一条 JSON 的形式追加到 `<session cwd>/.dsh/hooks-audit.jsonl`，
  每个文件只 warn 一次；成功的记录路径**不会**产生这个文件。
- `audit: false` 时完全不写——Session 记录与文件兜底都不写。本插件没有 UI，日志与这条记录
  是唯一的事后可观测面。

`ask` 的最终结果**不在**插件记录里：宿主在插件返回 `{ kind: 'ask' }` 之后才问 answerer，
并把结果写成同一条 session 里的 durable 事件对——`approval/asked`（`toolName`、`callId`、
`reason`）与 `approval/decided`（同一 `id`，`outcome` 为 `allowed-once` / `rejected` /
`cancelled` / `unavailable`）。只有 `allowed-once` 会真正执行；拒绝 / 取消 / 没有审批通道
都变成带宿主理由的 deny。部署里没有 `ctx.approval` 时这条链路整段降级为 deny，不会产生
这对事件。插件不直接调用审批服务，所以不会问两次；`ask` 也不会绕过 `ctx.tools.guard`。

## 发现、优先级与热重载

三个来源**全部叠加**，不覆盖：

| 顺序 | 层 | 路径 |
|---|---|---|
| 1 | user | `${DSH_HOME:-~/.dsh}/hooks.json` |
| 2… | project | 从最近的 `.git` 根到 session 当前目录，每层 `.dsh/hooks.json` |
| 3… | local | 同层目录的 `.dsh/hooks.local.json`（不进 git 的个人覆盖） |

以仓库根 `/repo`（含 `.git`）、session 当前目录 `/repo/packages/app` 为例，执行顺序是：

1. `~/.dsh/hooks.json`
2. `/repo/.dsh/hooks.json` → `/repo/.dsh/hooks.local.json`
3. `/repo/packages/.dsh/hooks.json` → `/repo/packages/.dsh/hooks.local.json`
4. `/repo/packages/app/.dsh/hooks.json` → `/repo/packages/app/.dsh/hooks.local.json`

同层 `hooks.json` 先于 `hooks.local.json`；同一文件内按数组顺序；全部追加。没有 `.git`
祖先时只看 session 当前目录。`.dsh/hooks.local.json` 只是文件名约定，本插件**不会**替你
写 `.gitignore`。

- **per-session cwd**：每个 session 按自己的 `ctx.workingDirectory.get(session)` 解析；
  子 agent 用子 agent 的 cwd。`working-directory/change` 之后重新解析并 retarget watcher。
- **热重载**：每个 session 一个 `fs.watch`，50ms debounce 预热改动过的文件；每次解析前仍对
  每个候选文件做 `mtime + ctime + size` 的 stat 快检。改 / 新建 / 删除任何一层配置后，
  **下一次事件**就用新配置，不用重启 session；watch 漏事件时 stat 兜底。
- **坏配置**：某一层 JSON 解析失败或读不了时只 warn 一次（带该文件绝对路径），沿用**该层**
  上一份有效配置；没有上一份就等于该层不存在。其他层照常工作。

## 与其它 hook 插件的区别

| | `dsh-lifecycle-hooks`（本插件） | 第三方 `dsh-hooks`（npm 0.14.x） | `dsh-hooks-claude-code` |
|---|---|---|---|
| 定位 | 仓库级的**阻塞 / 改写**运行时 | 跨 session 的**通知 / 审计**运行时 | Claude Code 方言兼容层 |
| 配置位置 | 仓库 `.dsh/hooks.json` + 用户级三层 | profile 配置 | CC 的 `configPath`（进程级） |
| 发现与热重载 | 按 session cwd 发现，改完即生效 | 无仓库发现 | 启动读一次 |
| 阻塞 agent | `deny` / `ask` / `block` / `halt` | 明确不阻塞 | 取决于 CC 方言能力 |
| 改写结果 | `replace`（只换模型可见 content） | 无 | 不支持 `updatedToolOutput` |
| handler | builtin / command / module | fire-and-forget command | command |
| 可观测性 | 每次运行写 plugin record + 日志 | 历史、UI、webhook / 桌面 / 飞书通知 | 日志 |
| 事件词汇 | dsh 原生（`tool.pre`、`turn.stop`…） | 自己的通知事件 | `hook/*` CC 方言 |

**装哪个：**

- 想让**团队规则随仓库提交**、在工具执行前拦截、在结果回到模型前脱敏、在 stop 前跑测试 →
  本插件。
- 想要**跨项目的通知汇总 / 审计面板**、不想让 hook 影响 agent 循环 → 第三方 `dsh-hooks`。
- 手上已有 `.claude/settings.json` 的 hooks，需要它们继续跑 → `dsh-hooks-claude-code`；
  本插件**故意**不复用 `hook/*` 事件，两者可以同时安装，但不要为同一条规则配两遍。

## 已接受的盲区

这些是**设计边界**，不是待修的缺陷：

- **`tool.pre` 的 context 下一步才到**：宿主的 pre-execute decision 没有携带 context 的
  字段，插件只能 `agent.inject`，模型在**下一次**请求里读到它，而不是被拒绝/放行的这一次。
- **`tool.post` 不能阻止副作用**：hook 在工具执行后才运行，`block` / `replace` 只改变
  模型读到的结果；文件已经写了、请求已经发了。要在执行前拦截用 `tool.pre`。
- **`replace` 只能换模型可见内容**：宿主的结果 `value` 是执行期 schema 内 JSON、从不落盘，
  无法由插件重新校验。尝试替换 `value` 是协议错误，不是静默忽略。
- **`session.end` 是 best-effort**：它在 `agent/disposed` 的 teardown 中脱手运行，不阻塞
  disposal；进程整体退出、或插件比 agent 先销毁时，这次运行可能只留下一条失败记录。
  `tool.result` 与 `notification` 同理，都是事件提交之后的旁路。
- **只观察事件不能决定**：`tool.result` / `session.end` / `notification` 上返回 outcome
  会被忽略并 warn；要干预就绑到对应的可决策事件。
- **module 在宿主进程内**：与插件、宿主共享同一进程与权限，能读环境变量、写任何文件；
  没有 sandbox、没有 worker 隔离。**不响应 signal 的 module 无法强杀**；超时后 helper
  （`inject` / `steer` / `exec`）全部失效，但那段 JS 仍会跑完。改模块后旧版本留在 ESM
  模块表里（拿不到引用，也无法卸载），长 session 里反复改大模块有内存代价。
- **坏配置的可见性只有日志**：没有 UI；坏 JSON 保留上一份有效层并 warn，warn 出现在第一次
  用到该文件的事件上。进程重启后这份「上一份有效」也不存在了。
- **`notification` 没有 match 维度**：一条条目会在每次 approval/asked 与 agent/error 上
  运行，脚本自己按 payload 的 `type` / `tool_name` 分支。approval 通知还要求该 session 的
  agent 仍活着——agent 已经销毁的审批请求会被跳过。
- **`step` 从事件流里记**：`turnBoundary` projection 没有 step 号，插件跟
  `session/event` 里的 `step/start` 记账；插件在某个 step 中途才挂载（或 resume 后还没开
  新 step）时，payload 的 `step` 报 0。
- **重载靠文件系统通知与时间戳**：watch 是预热，stat 是兜底；两者都漏掉（同一毫秒内等长
  改写、且 watch 没报事件）时要到下一次真正改动才生效。
- **发现只看 cwd 链**：只有 session 当前目录的祖先链参与解析，不读兄弟目录；monorepo 里
  `cd` 到别的包后按新链解析。
- **没有 UI / CLI**：日志与 plugin record 是唯一可观测面；`ask` 的最终结果要对着宿主的
  `approval/asked` / `approval/decided` 读。
- **clone 即信任**：hooks 文件是仓库内容。克隆并打开一个仓库，就接受了它在
  `.dsh/hooks.json` 里写的 command / module——它们会在宿主进程或 shell 里运行，**没有**
  项目级信任审批、allowlist 或 sandbox（见 ADR-0003）。打开陌生仓库前先看它的
  `.dsh/hooks.json`。

## 不在范围内

- `updatedInput`：宿主 pre-execute 只能 deny / ask，不能改写工具入参（ADR-0004）。
- compaction 拦截：宿主没有 pre-veto compaction seam；本版不挂钩 compaction（ADR-0004）。
  结果侧改写用 `tool.post` 的 `replace` 代替。
- YAML / TypeScript module：配置只认 JSON，module 只认 `.mjs` / `.js`。
- 项目级信任审批 / allowlist / sandbox：见上。
- module 的 worker 隔离。
- 多文件配置、`extends`、跨文件按 id 禁用。
- 模型侧查询 hooks 的工具。
- Windows 专用 shell 抽象：交给宿主 `ctx.shell`。
- 浏览器半、UI、`/hooks` CLI。
- Claude Code 兼容、`.claude` 配置、`hook/*` 事件、上游 `dsh-hook-protocol`。
- `subagent.*` / `compaction.*` / `cwd.change` / `error` / `turn.*` 等额外事件（留给后续版本）。
- 跨 session 的全局状态。
