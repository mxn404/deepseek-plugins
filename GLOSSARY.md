# deepseek-plugins

本仓打包多个 DeepSeek Harness（dsh）插件。下列术语只描述本仓自造的概念，宿主既有的概念
（agent、session、profile、tool、skill）按宿主文档原义使用，不在此重定义。

## 规则（rules）

**Rule**（规则）:
一段以 markdown 文件形式存在、由「当前工作在碰哪个文件」决定是否进入 agent 上下文的行为约定。
_Avoid_: 提示词片段、instruction file、AGENTS.md 条目

**Path-scoped rule**（路径规则）:
带路径范围的规则；只有当 agent 碰到范围内的文件时才进入上下文，否则只在规则索引里露面。
_Avoid_: 条件规则、按需规则、惰性规则

**Always-on rule**（常驻规则）:
不带路径范围的规则；会话一开始就进入上下文，与碰了哪个文件无关。
_Avoid_: 全局规则、默认规则、兜底规则

**Rule root**（规则根）:
一个承载规则的 `.dsh/rules/` 目录。它属于某一个目录层级——项目根，或项目根与当前工作目录之间的某个祖先目录。
_Avoid_: 规则目录、rules 文件夹

**Rule index**（规则索引）:
会话开始时进入上下文的紧凑清单（规则名 + 路径范围），作用是让 agent 知道自己身上还可能有哪些路径规则存在。
_Avoid_: 规则目录、清单、catalog

**Injection**（注入）:
把一条规则的正文加入某个 agent 上下文的动作。
_Avoid_: 加载、挂载、读取

**Trigger**（触发）:
agent 的一次工具调用**成功**碰到了某个文件——读、写、编辑它，或在 shell 里对单个文件使用只读命令。
_Avoid_: 命中、访问、触碰事件

## 生命周期钩子（lifecycle hooks）

**Hook point**（钩子点）:
一条 hook 绑定到的 dsh 生命周期事件名，例如 `tool.pre` 或 `turn.stop`；它决定这条 hook 在
宿主的哪个 seam 上运行、能产出哪些 outcome。线上格式里这个字段的键固定叫 `event`（spec
规定的 payload 键，也是 `DSH_HOOK_EVENT` 的值）；`event` 是格式 token，不是领域术语，文档
里仍称 hook point。
_Avoid_: 事件（作为领域词；线上键名 `event` 除外）、阶段、时机

**Handler**（处理器）:
hook 命中后实际执行的东西：一行 `builtin` 动作、一条 `command` 子进程，或一个进程内
`module`。同一钩子点可以挂任意种 handler。
_Avoid_: 动作、脚本、回调

**Outcome**（结果）:
handler 交回给插件的一份结果文档——`action`、`reason`、`context`、`replace`、`meta`——同一
事件点的 outcome 按固定优先级合并后，才交给宿主 seam 应用。
_Avoid_: 返回值、decision、结果对象

**Source**（来源）:
一条 hook 来自哪个 hooks 文件的绝对路径。它决定审计记录里的 `source`，也是 `module` 路径
的解析基准。
_Avoid_: 配置文件、层

**Hook file**（钩子文件）:
承载 hook 声明的 JSON 文件：用户级 `hooks.json`、项目级 `.dsh/hooks.json`，或同目录的
`.dsh/hooks.local.json`。
_Avoid_: 规则文件、配置文件、hooks 配置

**Layer**（层）:
一个 hook 文件所属的来源类别——`user`、`project` 或 `local`。三层全部叠加，不做覆盖。
_Avoid_: 来源、优先级、文件
