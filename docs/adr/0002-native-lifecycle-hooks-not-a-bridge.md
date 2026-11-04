# 生命周期钩子做成 dsh 原生运行时，而不是 Claude Code / Codex 兼容桥

dsh 的扩展点已经足够密：`agent/created`、`agent/pre-step`、`tools/pre-execute`、
`tools/post-execute`、`tools/result`、`agent/turn-stopping`、`agent/disposed`，加上持久
的 `approval/asked` 与 Cordis 的 `agent/error`。缺的不是扩展点，而是「把这些点上的用户
逻辑写进仓库、按项目生效、改完即生效」的载体。仓库里已有 `dsh-hooks-claude-code`：它把
Claude Code 的 `hook/*` 方言翻译到 dsh，只跑 command，`configPath` 是进程级的、启动时读
一次；第三方 `dsh-hooks` 则是通知/审计用的 fire-and-forget 运行时，明确不阻塞 agent 循环。
两者都不是「仓库级、可决策、原生」的那一格。

本仓选择**从零做一个 dsh 原生运行时**（`dsh-lifecycle-hooks`），而不是扩展任一兼容桥。

## 两条路的差别

| 维度 | 扩展现有 CC 桥 | 本仓的原生运行时 |
|---|---|---|
| 配置格式 | Claude Code 的 `hook/*` 方言 | `.dsh/hooks.json`，dsh 自己的事件名与 payload |
| 配置生命周期 | `configPath` 进程级，启动读一次 | 按 session cwd 分层发现，文件改动下一次事件生效 |
| handler | 只有 command | builtin / command / module |
| 事件词汇 | `hook/*`（PreToolUse、Stop…） | `tool.pre`、`turn.stop`…，与宿主 seam 一一对应 |
| 结果改写 | 不支持 `updatedToolOutput` | `tool.post` 的 `replace` |
| 维护面 | 上游方言 + 本仓的适配层 | 只跟着 dsh 的扩展点走 |

## 决定

- 事件名、payload、outcome 全部用 dsh 原生词汇，**不复用 `hook/*`**。`hook/*` 是 Claude
  Code 的兼容契约：名字和语义由上游定义，本仓只是翻译者。把它当作本插件的事件模型，等于把
  一个我们控制不了、也不覆盖 dsh 全部 seam 的方言冻结成产品接口。
- 配置用 JSON、放仓库的 `.dsh/` 下，按 session 当前目录发现；这是本插件存在的理由，不能
  退回进程级配置。
- 三种 handler 一次定死：`builtin` 覆盖一行规则，`command` 覆盖任意语言的脚本，`module`
  覆盖需要活 agent/session/result 的复杂逻辑。桥的 command-only 是它的定位，不是本插件的
  起点。
- 兼容性由 `engines.dsh` 的版本区间兜底：dsh 的 seam 变了就发新版本，而不是在运行时猜两套
  行为。

## 后果

- **从 Claude Code 迁过来的用户不能直接复用配置**：事件名、payload 字段、outcome 结构都
  不同。README 明确写了这一点，并指向 `dsh-hooks-claude-code` 作为兼容选择。
- 两个插件可以共存：一个消费 `hook/*`，一个消费 dsh 原生事件。它们互不 import，也不共享
  配置；同一行为不要配两遍，否则会执行两次。
- 本插件的语义跟着 dsh 走。dsh 的 seam 一旦变化，影响面是明确的（`EVENT_ACTIONS` 与各
  event plan），不需要同时维护一套上游兼容层。
- module handler 把宿主暴露给仓库代码，这是原生的代价，也是它相对于桥的卖点；风险在
  README 与 ADR-0003 里写明。
- 文档里必须同时解释「为什么不是 CC 兼容」，否则用户会按 CC 的预期使用（尤其是
  `updatedInput`，见 ADR-0004）。

## 考虑过但不选的

- **扩展 `dsh-hooks-claude-code`**：它的单一职责是方言桥，配置生命周期和 handler 形态都
  与仓库级决策运行时冲突。要满足本 spec，得重写它的大半，还会破坏现有 CC 用户的预期。
- **给每个仓库生成一个 Cordis 插件**：要建包、构建、装 profile、重启，正是本插件要消掉的
  摩擦，而且无法随仓库共享。
- **定义一个跨宿主 hook 协议（如 `dsh-hook-protocol`）**：没有稳定的上游契约，先造协议等于
  把兼容负担提前；dsh 的 `tools/pre-execute` 等 seam 已经能表达本插件的全部决策。
