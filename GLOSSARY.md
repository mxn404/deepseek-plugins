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

## Worktree 副本（worktree switch）

**Source checkout**（源检出）:
项目自己的那份 checkout；副本由它 add 出来，两者共享同一个 Git 目录。会话回到源检出
就是回到了项目目录。
_Avoid_: 主仓库、原目录、主工作区

**Worktree copy**（副本）:
池里的一份 linked Git worktree：有自己的工作目录和分支，与源检出共享同一个 Git 目录。
它隔离的是提交与未提交改动，不是写权限。副本可以先于开关存在（手工 add 的、旧会话留下
的），所以「是副本」不蕴含「归开关管」。
_Avoid_: 沙箱、工作树空间、分支目录

**Pool**（池）:
存放副本的目录，默认 `<项目根>/.dsh/worktrees`，位置由 worktree 服务的 `directory` 决定；
池里的每个子目录就是一份副本。
_Avoid_: 工作树根、worktree 目录（作为领域词）

**Switch position**（开关位置）:
会话此刻是否运行在副本里：会话在副本里时恒为开，不在副本时等于项目的隔离默认。它是会话
状态（这条会话在哪跑），不是项目偏好。
_Avoid_: 开关状态、项目开关、当前设置

**Isolation default**（隔离默认）:
项目级的值：这个项目里还没建副本的新会话要不要隔离。它只决定新会话，不裁决已经在副本里
的会话；用户拨动开关会按项目写入它，首次取配置的 `defaultEnabled`。
_Avoid_: 项目默认、开关位置、全局设置

**Inheritance**（继承）:
`/new`（`/clear`）在副本里开新对话时，新会话沿用当前会话的工作目录，于是落进同一份副本。
副本的归属仍记在创建它的会话名下；继承不转移归属、不新建副本。
_Avoid_: 传递副本、复用开关、自动继承

**Ownership**（归属）:
一份副本是否由开关为某个会话创建——它决定离开时这份副本有没有资格被撤销。
_Avoid_: 所有权、所属、我的副本

**Leave**（离开）:
把会话从副本切回源检出的动作，由开关拨回触发。
_Avoid_: 关闭、退出、release

**Undo**（撤销）:
离开时顺带删掉开关刚创建、且没产生提交和未提交改动的那份副本及其分支。有内容、有疑问
或归属不明的一律留下。
_Avoid_: 回收、自动清理、GC

**Reclaim**（回收）:
不区分归属和内容地删掉副本。本插件不做回收，只提供面板上的显式丢弃。
_Avoid_: 自动清理

**Kept copy**（保留副本）:
离开时因为还有内容（提交或未提交改动），或因为删除失败，而被留在磁盘上的副本；它留在池
里，等面板显式丢弃。归属是别的会话的副本不算保留副本——它没被撤销只是因为不属于这条会话，
不是遗留。
_Avoid_: 残留副本、没删掉的副本、泄漏

**Orphan branch**（遗留分支）:
名字符合开关的生成格式、但仓库里已经没有对应副本的分支；面板会把它列出来，删除需要
显式确认。
_Avoid_: 孤儿分支、残留分支、stale branch

**Current copy**（当前副本）:
会话此刻运行在其中的那份副本；会话回到源检出后就不存在。
_Avoid_: 当前 worktree、当前目录

**Base point**（基点）:
新建副本从其开始的提交：`origin` 默认分支在创建前 fetch 到的尖端（`fresh`，默认），
或源检出的本地 `HEAD`（`head`，以及任何 fetch 回退）。配置里这个选项的键叫 `baseRef`、
取值 `fresh` / `head`；`baseRef` 是格式 token，不是领域术语，文档里仍称基点。
_Avoid_: 起点、基线、base ref（作为领域词；配置键 `baseRef` 除外）
