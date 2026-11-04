# `dsh-lifecycle-hooks`

声明式生命周期钩子。把规则写成仓库里的 `.dsh/hooks.json`，随代码提交；插件按 session 的
当前工作目录读它，在工具执行前按名称与参数匹配：命中的 `deny` 让这次工具调用**不执行**，
拒绝理由作为工具结果回到模型。工具执行后同一个文件还能改写结果：`replace` 换掉模型读到的
内容（脱敏 / 裁剪），`block` 把结果变成错误反馈，`context` 给模型补一句提醒。会话开始、
每一步开始、以及 turn 自然停下时也能挂规则：注入上下文、按用户 prompt 拒绝一步、或用
`continue` 让停下的 turn 再走一步。需要更复杂的判断时，每个事件点都能跑一条 `command`：
脚本从 stdin 读 JSON、往 stdout 写一个 JSON outcome。

本插件实现 spec [#7](https://github.com/mxn404/deepseek-plugins/issues/7) 的前七刀：
[#8](https://github.com/mxn404/deepseek-plugins/issues/8) 的最小工具门禁（walking skeleton）、
[#9](https://github.com/mxn404/deepseek-plugins/issues/9) 的分层发现 / 热重载、
[#10](https://github.com/mxn404/deepseek-plugins/issues/10) 的 command handler 与 `tool.pre`
决策协议（`deny` / `context` / `halt`）、
[#11](https://github.com/mxn404/deepseek-plugins/issues/11) 的 `tool.post` 结果改写
（`block` / `replace` / `context`）、
[#12](https://github.com/mxn404/deepseek-plugins/issues/12) 的 `session.start` / `step.start`
与 `match.prompt`、
[#13](https://github.com/mxn404/deepseek-plugins/issues/13) 的 `turn.stop` 继续与 loop guard，
以及 [#15](https://github.com/mxn404/deepseek-plugins/issues/15) 的子 agent 覆盖与
`tool.result` / `session.end` / `notification` 三个只观察事件。
后续票在同一套 dispatcher、配置 schema、发现与 e2e harness 上补齐 `module` handler 与
`ask` outcome；目前打通 `session.start`、`step.start`、`tool.pre`、`tool.post`、`turn.stop`
五个可决策事件点，外加 `tool.result`、`session.end`、`notification` 三个只观察事件点。

## 它做什么

- **发现**：按 session 当前工作目录（`ctx.workingDirectory.get(session)`）解析三层配置，**全部
  叠加**：用户级 `${DSH_HOME:-~/.dsh}/hooks.json` → 从最近的 `.git` 根到当前目录的每一层
  `.dsh/hooks.json` → 同目录的 `.dsh/hooks.local.json`。合并顺序就是执行顺序（用户 → 祖先
  远→近 → 同层 project 先于 local），同一事件点多条 hook 里第一条命中的决定生效。没有 `.git`
  祖先时只看当前目录。两个 session 按各自的 cwd 解析；`cd` 之后下一次事件按新目录重新解析。
  任何一层文件都不存在就什么都不做：不注入消息、不打日志、不写记录。
- **匹配**：`match.tool` 认精确名、`a|b` 集合与 `/regex/`；`match.args` 是工具入参的**深子集**
  ——对象按 key 递归、数组按下标前缀、字符串叶子默认精确相等，写成 `/regex/` 则对实际字符串
  做正则测试；`step.start` 上的 `match.prompt` 取 `true`（用户提交的一步）/ `false`
  （工具续跑的一步）。`match` 整体省略表示匹配该事件点的全部调用；`session.start`、
  `turn.stop`、`session.end` 与 `notification` 没有任何选择维度，写了 `match` 的条目在加载时
  被跳过并 warn；`tool.result` 与两个工具决策事件一样可按 `tool` / `args` 选择。
- **拒绝**：命中的 `run` 返回 `deny` 时，宿主拿到 `{ kind: 'deny', reason }`，工具管线因此
  不进入工具实现，模型收到的工具结果就是 `Error: <reason>`。被拒绝的调用不会产生副作用。
- **改写结果**：`tool.post` 的 hook 在工具**已经执行完**之后运行，所以它不能撤销副作用，只能
  决定模型读到什么。`replace` 用一段新文本替换模型可见的 `content`（成功与失败结果都支持），
  结果本身的 `value` 与错误状态不变；`block` 把结果变成 `isError: true`，内容换成合并后的
  反馈，工具确实跑过，模型知道为什么看不到输出。`tool.post` 永远不替换 `value`：那是执行期
  的 schema 内 JSON，宿主只按工具自己的 render 产出模型可见内容；脚本在 stdout 里写
  `{"replace":{"value":…}}` 会被当成协议错误，整次运行失败（默认放行、warn 并记审计）。
- **命令**：`{ "type": "command", "command": "…" }` 通过宿主 `ctx.shell` 执行：cwd 是 session
  当前目录，stdin 是一份 JSON payload（`event` / `time` / `session_id` / `cwd` / `agent_id` /
  `turn` / `step` / `source` / `hook_id` / `tool`），env 至少带 `DSH_HOOK_EVENT`、
  `DSH_HOOK_SESSION_ID`、`DSH_HOOK_CWD`、`DSH_HOOK_TURN`、`DSH_HOOK_STEP`、`DSH_HOOK_ID`。
  stdout 只认**一个** JSON outcome：`{ "action": …, "reason": …, "context": [ … ], "replace": { "text": … } }`；
  空输出等于「没有动作」，只写 `replace` 不写 `action` 也合法（等价于 `replace`）。非零退出、
  坏 JSON、`replace.value`、超时都按运行失败处理（默认放行，见 `onFailure`），超时由 shell
  执行器杀掉整个进程组。`async: true` 的条目脱手执行，只做副作用、不参与决策，插件销毁时会被
  中止。
- **会话与步骤**：`session.start` 在宿主 `agent/created` 里被 await，context 通过
  `agent.inject` 停进 next-step inbox，第一个 `agent/pre-step` 会把它 claim 进首批消息——所以
  注入出现在**首个**模型请求里，不是 best-effort。`step.start` 在 `agent/pre-step` 上按
  `source.kind === 'user'` 的消息提取 prompt（工具续跑的步没有 user 消息，prompt 为 `null`）：
  `deny` 直接 reject 这一步、prompt 不进模型，`context` 折进 `enter.messages`，`halt` 用宿主
  的 `{ kind: 'hook' }` 取消这一轮。
- **停止与继续**：`turn.stop` 在 `agent/turn-stopping` 上运行，`continue` 通过 `agent.steer`
  把一条消息放进 next-step inbox，让本轮再走一步。每个 turn 连续 continue 的次数受
  `maxStopContinues`（默认 8）限制：超过上限后忽略 `continue`、warn，turn 正常关闭；turn 号一变
  计数自动从 0 开始；同一 stop 上多个 hook 的 `continue` 合并成**一次** steer。`turn.stop`
  不接受 `halt`（halt 只属于阻塞事件），非法 action 被忽略并 warn。
- **只观察事件**：`tool.result`（宿主 `tools/result`，在最终结果冻结后触发）、`session.end`
  （`agent/disposed`）与 `notification`（从持久的 `approval/asked` 与 Cordis `agent/error` 派生）
  只报告已经发生的事，没有可决策的 outcome：`command` 在这些事件上**一律脱手执行**（写不写
  `async: true` 都一样），`builtin` 条目在加载时被跳过并 warn。`tool.result` 的 payload 带最终
  `tool` 与 `result`，脚本改写结果不会生效并 warn；`session.end` 的 payload 带最后一个已关闭
  turn 的 `turn` 与 `reason`（`completed` / `aborted` / `error` 等），observer 不阻塞 disposal，
  插件销毁时由 detached tracker 兜底中止；`notification` 的 payload 是
  `type`（`approval` / `error`）、`message` 与 approval 才有的 `tool_name`。运行失败只 warn 并
  写进审计记录，不影响 agent。
- **子 agent**：插件在根 composition 上挂载，listener 不带 agent scope，所以父 agent 与子
  agent 的 `tool.pre` / `tool.post` / `tool.result` 都走同一个实例；每个 session 按**自己的**
  `ctx.workingDirectory.get(session)` 解析配置，子 agent 用自己的 cwd 而不是父的。
- **上下文**：outcome 里的 `context` 是给模型看的提醒。同一事件点所有 hook 的 context 按配置
  顺序拼成**一条** user 消息，包成 `<system-reminder>`，message source 标
  `dsh-lifecycle-hooks`（`src/context.ts` 是唯一的 message 形状与 source 声明）。
  `session.start` / `tool.pre` 通过 `agent.inject` 送达，`step.start` 折进这一步的
  `enter.messages`，`turn.stop` 走 `agent.steer`，`tool.post` 走宿主的 `additionalContexts`，
  都在**下一步**的请求里出现；`tool.post` 的 context 与 `block` 同时出现时也会保留（宿主的
  block 只丢工具自己 defer 的 context，hook 通过 `additionalContexts` 给的那份会留下）。
- **合并**：同一事件点的多条 hook 按合并顺序、文件内数组顺序执行。优先级固定为
  `halt` > `deny` / `block` > `ask` > `continue` > `replace` > `context`：第一条 `deny` 或
  `block` 的理由生效；多个 `continue` 的理由按顺序拼进**一条** steer 消息；
  `replace` **最后一个生效**，后面的 hook 可以精修前面的替换；context 全部保留并按顺序拼接；
  只有 `halt` 会立即停止后续 handler 并以 `agent.cancel({ kind: 'hook', reason })` 中断这一轮
  （`tool.post` 的 halt 同时把该结果变成错误，模型不会读到 hook 愿意中断这一轮的那段输出）。
  事件不支持的 action（例如本版 `tool.pre` 上的 `block`、`tool.post` 上的 `deny`）会 warn 一句
  并忽略该动作，但保留它带的 context。
- **审计**：每次 hook 运行往 session 写一条 `plugin:dsh-lifecycle-hooks/run`，含 `event`、
  `source`（配置文件绝对路径）、`hook_id`、`handler`、`action`、`duration_ms`、`exit_code`
  （command 才有）、`error`。记录不进入模型可见面，fork / resume 会带着走。
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
| `defaultTimeoutMs` | `30000` | hook 条目没写 `timeoutMs` 时的超时；command 走它，builtin 同步完成用不上 |
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
    },
    {
      "id": "guard-deploy",
      "on": "tool.pre",
      "match": { "tool": "bash", "args": { "command": "/^deploy /" } },
      "run": { "type": "command", "command": "node .dsh/hooks/guard-deploy.mjs" },
      "timeoutMs": 2000
    },
    {
      "id": "redact-token",
      "on": "tool.post",
      "match": { "tool": "bash|read" },
      "run": { "type": "command", "command": "node .dsh/hooks/redact-token.mjs" },
      "onFailure": "block"
    },
    {
      "id": "hide-binary",
      "on": "tool.post",
      "match": { "tool": "read", "args": { "file_path": "/\.png$/" } },
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
| `hooks[].on` | 是 | 事件名；本版调度 `session.start` / `step.start` / `tool.pre` / `tool.post` / `tool.result` / `turn.stop` / `session.end` / `notification` |
| `hooks[].match` | 否 | 省略 = 全匹配；`tool` 与 `args` 是工具事件的两条独立约束，`prompt` 属于 `step.start` |
| `hooks[].run` | 是 | handler；`builtin`（`{ "type": "builtin", "action": "…", "reason": "…", "text": "…" }`）或 `command`（`{ "type": "command", "command": "…", "async": false }`） |
| `hooks[].run.command` | command 必填 | shell 命令行，cwd 是 session 当前目录 |
| `hooks[].run.async` | 否 | `true` 时脱手执行：只做副作用、不参与决策，销毁时中止；`tool.result` / `session.end` / `notification` 上的 command 一律强制脱手 |
| `hooks[].timeoutMs` | 否 | 正整数，覆盖行配置的 `defaultTimeoutMs` |
| `hooks[].onFailure` | 否 | `open`（默认，失败放行）或 `block`（失败按事件合成阻断） |

不认识的字段静默忽略。`on`、`run.type`、`run.action` 的完整词汇属于 spec，但本版只调度
上面八个事件、只执行 `builtin` 与 `command`，并且每个事件只接受自己的动作（三个只观察事件
不接受任何 builtin 动作）：

| 事件 | builtin 可用动作 | 写法 |
|---|---|---|
| `session.start` | `context` | `{ "action": "context", "text": "…" }` |
| `step.start` | `deny` / `halt` | `{ "action": "deny", "reason": "…" }` |
| `step.start` | `context` | `{ "action": "context", "text": "…" }` |
| `tool.pre` | `deny` | `{ "action": "deny", "reason": "…" }` |
| `tool.post` | `block` | `{ "action": "block", "reason": "…" }` |
| `tool.post` | `replace` | `{ "action": "replace", "text": "…" }` |
| `tool.post` | `inject` | `{ "action": "inject", "text": "…" }` |
| `turn.stop` | `continue` | `{ "action": "continue", "reason": "…" }`（reason 可省） |
| `tool.result` / `session.end` / `notification` | 无 | 只观察；用 `command` handler，写了 builtin 会在加载时跳过并 warn |

`tool.pre` 的 builtin 自 walking skeleton 起就是 deny-only：command handler 在该事件上仍可报
`context` / `halt`，但 builtin 的 `replace` / `block` / `context` 要等单独的取舍。

`inject` 是 spec 的 builtin 词汇里「补一句 context」的动作，本插件把它折算成 `context` 的一条
文本；`replace` 是 spec 没有单列 builtin 动作、本插件为 `tool.post` 补上的映射，等价于
command 的 `{ "replace": { "text": "…" } }`。每个事件的 command 运行时 outcome 支持
`action` / `reason` / `context` / `replace` 的任意合法组合；事件不支持的 action 只 warn 并忽略。

写了别的合法值会 warn 一句 “not supported by this build” 并跳过该条（command 在运行时输出的
非法 action 则 warn 一句「event 不支持」并忽略该动作，保留 context），不会让整份文件失效。

匹配边界（都按 JSON 值判，不做字符串化）：`match.tool` 的 `/…/` 是**未锚定**的正则，需要整名
匹配时自己写 `^…$`；`match.args` 的深子集只检查写出来的 key，实际参数里多出来的 key 不影响
命中；数组按**下标前缀**比较，实际数组更短才算不匹配。

## 审计记录

```jsonc
{
  "event": "tool.pre",
  "source": "/repo/.dsh/hooks.json",
  "hook_id": "guard-deploy",
  "handler": "command",
  "action": "deny",
  "duration_ms": 42,
  "exit_code": 0
}
```

`action` 是这次运行**自己产出**的动作（`deny` / `block` / `replace` / `halt` / `continue`），不代表事件一定
采纳了它（`async: true` 的运行、只观察事件、事件不支持的 action、以及被更高优先级 outcome
压过的 `replace` 都不会生效；只观察事件上出现 outcome 会 warn 一句「only observes」）；
`block` / `replace` 的运行即使没有压过别的 hook，也照样各写一条记录；
只带 context 的运行没有 `action`。`exit_code` 只在 command 运行拿到退出码时出现（超时被杀、被
信号杀死时没有）；`continued_count` 只在 `turn.stop` 的每条记录上出现（本次 stop 之前该 turn
已授予的连续 continue 次数，含被 loop guard 忽略的那次）；`error` 只在运行失败时出现，失败
默认不贡献决定，`onFailure: "block"` 时同一条记录会同时带 `error` 与合成的 `action`。本插件
没有 UI，日志与这条记录是唯一的事后可观测面。

## 安装与验证

```sh
pnpm --dir /home/ubuntu/code/deepseek-harness dsh plugin --profile dev add \
  /home/ubuntu/code/deepseek-plugins/packages/dsh-lifecycle-hooks
pnpm --dir /home/ubuntu/code/deepseek-harness dsh --profile dev --dump-config   # 应出现 "# == dsh-lifecycle-hooks"
```

构建产物由 `prepare`（tsdown）产出；改完源码重新 `pnpm --filter dsh-lifecycle-hooks build`。

## Known blind spots

这些是这一刀接受的边界，不是待修的缺陷：

- **还差 `module` handler 与 `ask`**：`module` handler 与 `ask` outcome 还没实现；配置文件里
  合法地写了它们也只会被跳过并 warn。`ask` 在 `outcome.ts` 的合并顺序里占了位，但目前没有
  事件允许它，会在合并前被剥掉。
- **只观察事件是 best-effort**：`session.end` 在 `agent/disposed` 上脱手运行，不阻塞 disposal；
  进程整体退出、或插件比 agent 先销毁时，这次运行会被 detached tracker 中止，可能只留下一条
  失败记录。`tool.result` 与 `notification` 同理，都是事件已经提交之后的旁路。
- **`notification` 没有 match 维度**：不能只订阅 approval 或只订阅某类错误；一条条目会在每次
  approval/asked 与 agent/error 上运行，脚本自己按 payload 的 `type` / `tool_name` 分支。
- **`tool.post` 不能阻止副作用**：hook 在工具执行后才运行，`block` / `replace` 只改变模型读到
  的结果；工具写下的文件、发出的请求都已经发生。要在执行前拦截，用 `tool.pre` 的 `deny`。
- **`replace` 只能换模型可见内容**：宿主的 `value` 是执行期 schema 内 JSON、从不落盘，也无法
  由插件重新校验；本插件只做 content 替换，尝试替换 `value` 是运行失败，不是静默忽略。
- **`halt` 不带 context**：halt 意味着这一轮被取消，向已取消的 inbox 注入提醒没有意义，所以
  halt 路径只取消、不注入。
- **`step` 从事件流里记**：`turnBoundary` projection 没有 step 号，历史读取对生产代码已废弃，
  所以插件跟 `session/event` 里的 `step/start` 记账。插件在某个 step 中途才挂载（或 session
  是 resume 而来且还没开新 step）时，这一段时间的 payload 里 step 报 0。
- **重载靠文件系统通知与时间戳**：watch 是预热，stat 是兜底；两者都漏掉（例如同一毫秒内
  等长改写、且 watch 没报事件）时，要到下一次真正改动才生效。
- **发现只看 cwd 链**：只有 session 当前目录的祖先链参与解析；monorepo 里同一 session `cd`
  到别的包后按新链解析，但不会去读兄弟目录的配置。
- **坏配置的可见性只有日志**：没有 UI；坏 JSON 保留上一份有效配置并 warn 一次，warn 出现在
  第一次用到该文件的工具调用上。
- **clone 即信任**：hooks 文件是仓库内容，克隆一个仓库就接受了它的规则。本版已经会**执行仓库
  提供的 command**（cwd 是 session 目录，环境经过凭据擦洗，但没有沙箱、没有信任审批）；
  spec 明确把「项目级信任门禁」列为不做的事。打开陌生仓库前先看它的 `.dsh/hooks.json`。
