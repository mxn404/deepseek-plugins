---
paths:
  - "web/**"
  - "docs/web/**"
  - "tests/web/**"
---

# 改 web demo（threat-product 本地驱动页）

`web/` 是仓库根的长期运行服务（`component-layout.md` 第三类）。它自己不分析、只驱动：拉起
常驻 agent 子进程、喂提示词、读事件流、把过程推给页面。契约与字段在 `docs/web/README.md`；
**改完成判据之前必读** `docs/web/adr/0001-完成判据要认全宿主上报的后台任务信号.md`。

## 关子进程 = 连坐处死它里面的一切

后台 Workflow / Task 子代理都活在那个子进程里。`_shutdown()` 关 stdin（不退就按进程树强杀）
**不是「断开连接」，是「把里面的活一起杀掉」**。所以只在确实结束时关，判据宁可保守——
它判错的代价是静默丢产物，不是报错。

- **完成判据要认全宿主上报的后台任务信号**，不许只认一个事件名：那是宿主的实现细节，
  不是协议。换宿主不报错、不告警，只是提前收工并把还在跑的后台任务一起杀了。
  实测差异、为什么两个信号源**不能相加**、为什么 `None ≠ 0`，全在那份 ADR 里。
- 按**进程树**杀（`_kill_tree`）：npm 装的 CLI 是 `.cmd` 壳，只杀壳会留下干活的 node，
  它带着 stdout 管道活着，pump 永远读不到 EOF。**Linux 那侧同样是按树杀**（读
  `/proc/<pid>/task/*/children` 深度优先收后代）——包装脚本（bash / node 壳）下有同一个孤儿
  问题，而它 2026-10-20 之前**一条判据都没有**（那条 `.cmd` 用例在非 Windows 上整条跳过）。
  **不许改用 `killpg`**：子进程没自建会话，与服务端同组，会连服务一起带走；
  要这么改就得动 vendored repl 的 spawn 形态，那条线不许动。见 ADR-0008。

## 三条实测钉死的形态，别「顺手整理」

- **wire 双层信封**：提示词先包成 `{"type":"user","message":{"role":"user","content":"<提示词>"}}`
  一行 JSON，`repl.Session.send` 再包外层 NDJSON。必须 `json.dumps` 构造，**不许手拼**——
  Windows 路径的 `\r` 会被当转义符把 JSON 撕坏，且不报错。
- **`vendor/repl.py` 是本仓自己维护的副本**（原先那份实测版本的拷贝，拷来后按本仓需要改过；
  哈希守卫已按用户要求撤掉）。**它的信封 / 编码 / argv 构造仍照实测那一套，别动**——
  要改的是默认值和注释这类外围，不是收发形态。
- **子进程 cwd = 被测产品根目录**（`_repl_ns(cwd=source_root)`），不是工具目录——
  skill 靠 `pwd` 推 `source_root`，cwd 一错产物就静默落错地方。

## 两个平台：默认 Windows 会把人指错，而且不报错

代码里真正的平台分支只有一处（杀进程树），但**注释与文案里的平台假设是另一回事**：它们在
另一种平台上就是「指向一条不存在的原因」——而那句话往往正是用户撞见的第一句。

- **「找不到 agent CLI」那句按平台给**（`runner.bin_missing_message`；`is_nt` 可注入，
  好让两侧文案都跑得到——不注入的话另一侧只有那种平台的机器才跑得到，等于常年没人看）。
  Windows 说 `.cmd` / `.bat` 壳与正斜杠；Linux 说**可执行位**与**服务进程的 PATH**
  （systemd / 非登录 shell 起的服务，PATH 里常常没有 nvm、npm 全局 bin）。见 ADR-0008。
- **写 `python3`，不是 `python`**：Ubuntu 默认只装前者。`.claude/launch.json` 与 skill 一致。
- **无头机器加 `--no-browser`**；不带也不许**报假成功**——`webbrowser.open` 找不到浏览器是
  **返回 False**（不抛异常，无头 Linux 就是这样），返回值必须看。
- **装依赖那条路**：裸 Ubuntu 上 `python3 -m venv` 以一句 ensurepip 报错收场（缺
  `python3-venv`），先 `apt install python3-venv python3-pip`。README 里写了这一步。
- `PYTHONUTF8=1` / GBK / `.cmd` 壳那几条是 **Windows 专属的病**：在 Linux 上无害，
  别顺手删（删了 Windows 上会犯），也别拿它们解释 Linux 上的现象——两回事。

## web 自己的状态放 `web/`，不写进 `security_audit/`

`{源码根}/security_audit/` 是**跨活动产物契约**。往里加一个 web 的
状态文件等于单方面改契约，而本仓没有任何东西会替你报错。产品登记表落 `web/products.json`，
理由见 `docs/web/adr/0002`。

**测试必须隔离它**（`tests/web/conftest.py` 的 autouse fixture）：`RunManager.create` 与
`Run._finish` 都会写登记表，所以**任何**「建任务 / 跑完」的用例都会中招，哪怕它没提过 products
——真发生过，测试把自己的 tmp 路径写进了工具目录那份。

## 起会话之前：workflow 预注册 + `PYTHONUTF8`

**workflow 命名表是会话启动时的一次性快照**，skill 在会话里注册的 workflow 当会话内调不起来。
所以 `Run._main` 在 `repl.Session` **之前**替用户跑一次该 skill 的 `register_workflows.py`
（`activities.PREREGISTER` / `preregister()`）——**这是唯一一处 web 知道 skill 内部的声明，
破得有账可查**：它是启动前置，不是分析逻辑。跑不成不阻断，只在事件流插一条 `[web]` 说明。

**别删这一条**：删了不会报错，只是**新源码根上的第一趟必停在 `Workflow not found`**，
而第二趟又好了——这种「再跑一次就行」的表象最容易让人当成偶发。
（① 早先没撞上，只因它的 workflow 被更早的会话注册过：**是运气不是设计**。）
两趟对照见 `docs/web/adr/0003` 的「实测发现」。

同一处还顺手压了 **`os.environ.setdefault("PYTHONUTF8", "1")`**：子进程继承本进程环境，
Windows 上默认 GBK，skill 里打 emoji 的脚本会崩（实测 `run_status.py` 就栽在打不出 `⚠️`）。

⚠️ **那句只管得到它之后起的子进程**：进度那条路（`progress._ask`）跑在起会话**之前**、
也可能跑在一个从没起过任务的进程里 —— 于是子进程按 GBK 吐、这边按 UTF-8 解，
**页顶七格阶段名整片变成 `����` 且不报错**（真翻过）。**每个 spawn 点自己带**
`activities.child_env()`，别靠那句的副作用；守卫 `tests/web/test_progress.py` 里那条
**断言子进程真看见了 `PYTHONUTF8=1`**（不这样钉，只在 UTF-8 机器上跑功能测试永远是绿的；
那条现成的「对着真 `run_status.py`」守卫还一度被**跑序**掩盖：别处的用例把这变量设进了
pytest 进程，单跑红、全量绿）。

**反过来也有一条**：从**桌面端托管的 shell**（不是普通 cmd）起 `web/app.py`，它拉起的
`claude` 子进程会继承宿主注入的 `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` /
`CLAUDE_CODE_HOST_AUTH_ENV_VAR`，于是**一句话不说就 `Not logged in · Please run /login`**、
一个 token 都不花。要跑真会话就从普通终端起服务（成员机平时就是这么用的）；
从桌面端起的那个服务只适合看页面、验接口形状，**别拿它跑真趟**。

**改了 `web/*.py` 必须重启服务**：`index.html` 是 `no-cache` 从盘上读的（刷新就是新的），
而 Python 路由活在**进程内存**里——于是会出现「新页面 + 旧后端」，形状是页面上某块功能
**空着**加一句 404（真发生过：⑦ 的清单区显示「读取失败 HTTP 404」，因为那个 `/api/surfaces`
是刚加的、旧进程里没有）。页面那边已经对 404 单说了一句「重启它」，但**别指望文案兜住**：
改完后端先重启再刷新，是改这个 demo 的固定动作。

## 活动：web 只认识「活动名 + 它要的字段」

活动登记在 `web/activities.py` **一处**（id / 中文名 / 阶段目录 / 表单校验 / 拼提示词）。
**skill 内部的脚本名、参数、产物目录布局一概不进那里**——写进去就会在 skill 改动时**静默失效**
（发一条错路径，不报错，只是东西落到别处）。同理前端：活动表走 `/api/activities`，
**不许在 JS 里再抄一份**。见 `docs/web/adr/0003`。

## 读 ① 的攻击面清单：跨 skill 的一场读取，要有守卫

⑦ 从 ① 的清单里挑暴露面（`docs/web/adr/0004`）。web **直接读盘**
（`web/surfaces.py`），因为 ① 没有机读清单出口、⑦ 的 `surface detect` 有意只回摘要。
路径与键名声明在 `surfaces.py` **一处**；守卫 `tests/web/test_surface_contract.py`
**从 ① 的构造点动态提取**键名来钉（`_new_record()` 的返回字典 + `aggregate()` 的 return +
事后补写的 `x["字面量"] =`——`confidence` 就是回填的，只钉 `_new_record` 会误报）。

- **别让 web 抄一遍字面量钉自己**：那样 ① 改字段名 web 照样绿，守卫成摆设。
  同类手法见 `tests/web/test_md.py`（拿真渲染器的输出喂 `web/md.py`）。
- 这条补的是一段旧账：① 改 `attack_surface.json` 的字段名，本仓此前**没有任何东西会报警**
  （`validate_artifacts.py` 校的三份产物里不含它）。
- **认趟认的是那一趟自己的记录**（`01_entries/surface.md` 的 `- 来源:` 行里有没有 AS-…），
  不是「目录名像」——口述趟会恰好占同一个名字（本机 `M-modbus` 就是）。同理那条 `- 来源:`
  行的解析也由真渲染器喂着钉（`render_surface_md`）。
- 三态/四态的判据全是**盘上现成的文件**（目录在 / `04_report/summary.md` 在 / 来源行），
  **不许为它另立状态文件**——那是第三份真相。
- 一趟 = 一个 module_id（skill 的硬约束），所以「勾 N 条」只能是开 N 趟的**串行队列**
  （`runner.Batch` + 一次只看一趟的监督线程）。三个坑写在 ADR-0004 的「要点与陷阱」里：
  排队的趟要有第一条事件、监督线程别扫整批判「被停」、`resume_batch` 的互斥要排除自己那一批。

## 进度：**第一次为展示需求改 skill**（边界与两条实测）

页顶那条进度（`docs/web/adr/0006`）走的是**各活动自己的机读出口**（⑦ `run_status.py --json`、
① `tp_pipeline.py status --json`），web 只渲染。这是 web 侧唯一一处为展示需求改 skill 的地方，
边界写清楚：

- 加的是**只读出口**（一行 JSON），**不动任何分析逻辑**、不动人读那屏（不带 `--json` 时逐字照旧）。
- 阶段表的唯一真相在 skill（`run_status.py` 的 `PHASES`），守卫钉「SKILL.md 的
  `## Phase N — 名字` ↔ 常量表逐字一致」——**阶段号在正文里此前没有守卫兜着**（ADR-0122 自己写着）。
- web 侧读的那份 JSON 由 `tests/web/test_progress.py` **对着真脚本的输出**钉（跨 skill 接缝）。
- **退出码不是机读判据**：① 的 `status --json` 在「还没有配置」时会打一份 `readable:false` 的
  载荷**再退 2**（那是它人读那屏的约定）。`_ask` 先认那行 JSON、rc 只在没东西可解析时才算错——
  只看 rc 就会把有用的载荷丢掉，页面上只剩"问进度失败（exit 2）"（真翻过）。
- **出口脚本名按活动不同**：测试夹具写死一个，另一条路会以"插件版本对不上"收场（也真翻过）。
- **改了 skill 要记着已安装的那份**：`find_skill_dir` 先找到 `~/.claude/skills/…` 等已装副本，
  本机那份没更新时页面会说「unrecognized arguments: --json」——那是对的（它如实说了原因），
  但要真生效得按 `component-layout.md` 的规矩更新成员机那一份。开发预览加
  `--skill-root sectest-threat/skills`（`.claude/launch.json` 已配），否则改了 skill 却在
  预览里测到旧行为——**这个 demo 最阴的一个坑**。
  **2026-10-27 内网又撞了一次**（web 合了、skill 没合，用户自己的 cmd 里当然也验不出来）。
  现在那句报错会**点名用的是哪份 script**、并说明「`--json` 是后来加进 skill 的，把它换掉」——
  别把它改回只说原因：只说原因的样子是「页面上写着问进度失败」，人以为 web 坏了，
  于是这一趟要回到开发这边再问一次（**已经发生过一次**）。

两条实测钉死的（改这块之前先读）：

- **发现段的"当前段"按 mtime 挑，不按「谁还有待派」**：派发表只有当前派的那一段是当轮刷新的，
  其余段是旧快照——按待派挑会报错段（真翻过：顺流段 191 格里跑着，却被报成"当前在初始化段"）。
- **线性流水线要"下游压上游"**：Phase 4/5 的派发表在某些形态下不写 `relay.stop`，而
  `summary.md` 在是铁证；不压就会把跑完整趟的趟报成"卡在第 3 步"。这条读法 `_resume_point` 本来就有。

## 范围口径：web 能给 `⑦` 的唯一一种「纠偏」（`docs/web/adr/0007`）

内网实测：⑦ 跑出**入口函数 0 个**就停了——攻击面的入口全在**平台代码**里，而 ⑦ 不认
「产品代码 / 平台代码」（那是 ① 的概念），它的目录过滤名单又是按**别的产品**调的：平台代码目录
撞上名单里某个名字，子代理把落在那里的锚点读成「非产品代码」丢掉，最后照母版兜底写成 `入口: []`。

修法是 `activities.SCOPE_LINE`——**一句话口径，落点是 intake 的「特别关注点」**（那是 skill 自己
定义好、原文喂进 Phase 2 各子代理上下文的一行；只写在派发那句里到不了做判断的那个子代理）。
**这是「不改 skill」能治的全部**，两条别越过去：

- **口径里不许出现 skill 内部的名字**（名单文件名、判据类名）：写进来就会在 skill 改动时静默失效。
  **别照着 skill 的注释设计**，要去读名单的实际实现——只有 `discover_inputs._SkipPathFilter` 一处。
- **它只治「入口锚点被丢掉」**：豁免的单位是**文件不是目录**（`_keep_paths` 精确相对路径、无前缀
  匹配），所以入口出来了，链上落在平台代码目录里的函数仍会被同一条判据拦。要目录级纳入只有删
  `config/tree-filter.txt` 的 `[skip-path]` 条目一条路（**数据文件**，守卫
  `tests/test_exclude_lists.py` 只断言「基准 ⊆ 本段」，删条目不会红）。

那句口径里必须同时有三件事，缺一件那种失败就原样复现：平台代码**在范围内**、
判红**照留痕要求处理**、落点是**「特别关注点」**。守卫
`tests/web/test_activities.py::test_se_scope_line_says_platform_code_counts` 逐条钉着。

## 提示词：只写人话，不写 skill 的键名（`docs/web/adr/0010`）

两个活动的提示词都是**中文标签：值**、一字段一行、路径值一律加引号；`/` 加 skill 名单独占第一行
（那是 web 唯一的「开哪个 skill」信号）。**`--flag` 与 skill 的键名一律不出现**：

- `--set concurrency=4` 这种写法要求 web 持有一份 skill 的键名表，而那份表会在 skill 改动时
  **静默失效**（发一句错参数，不报错，只是没生效）。模型照 `phase-1-intake/guide.md` 的映射表翻。
- 同理**别在 web 里存运行参数的默认值**：⑦ 从 `<skill>/config/run_config.json` 读、① 从产品的
  `_tp_config.json` 读，读不到就**置灰并说原因**，不编数。① 那个兜底 `TP_DEFAULT_CONCURRENCY`
  有契约守卫从 `tp_pipeline.py` 源码动态抽出来对拍。
- **「不改就不写」按值判**（等于默认值就不进提示词），不记「用户碰没碰过控件」。
- **intake 里「特别关注点」只有一行**：用户填的值与「平台代码也在范围内」那条口径必须
  **合成同一段**。两段各自叫模型去写同一行，多半是一句把另一句挤掉，而丢哪半边都没人报错。
- run 参数只拼进提示词、**web 不替 skill 落盘**：落盘是 `run_setup.py prepare --set` 的活。
  代价（模型漏翻 = 静默按默认跑）与边界（真续跑时 Phase 1 不重跑，那几个值不保证生效）
  写在 ADR-0010，别用"代它落盘"去补——那要推 `module_vh_root`、要调 skill 子命令。

## 选模型：走 argv、清单问 CLI 自己、**取不到不给选**（`docs/web/adr/0009`）

页面上选模型 = 给子进程命令行加 `--model <小写名>`。四条别越过去：

- **模型走 argv，不写进提示词**：提示词里写「请用 opus 审」换不了模型，而且**什么都不报**。
- **清单只问有 `models` 子命令的宿主**（`web/models.py` 的 `MODELS_HOSTS`）。实测：
  `claude models` 不是子命令，`models` 会被当成**提示词**起一次真会话 —— 白烧一次会话，
  而且模型回答里任意一行带 ` - ` 就会被当成模型名**摆进下拉框**，失败出现在几小时后。
  所以没在表里的宿主**不去试**。这条不是"兜底"，是「有没有这个子命令」一个事实。
- **取不到就不给选，不写死兜底清单**（用户 2026-10-26 定的）。**别为开发机开特例**：
  这台机器上 `claude` 没有 `models`，所以那条下拉框本来就该是灰的 —— 这是**真实路径**，
  不是待修的缺陷。要在开发机上验「有选项」那条路，造一个**假 bin**（名字里带 `codeagent`）
  用 `--claude-bin` 起服务，看完就删，**不进仓**。
- **argv 里永远只有一个 `--model`**：页面没选（「宿主默认」）= **不表态**，`extra_args`
  逐字透传（启动参数的 `--model` 照旧生效）；真选了才用 `runner.split_model_args` 把它摘掉
  换成选的。两个都在时取哪一个**没有可靠依据**（`claude --help` 不说），赌错的样子是
  「页面上写着 opus、实际跑的是 haiku」。同理**别在页面里再 lower 一次**：
  小写转换只住 `models.parse` 的 `arg` 一处。
- **留痕只在 web 侧**（任务卡 + `/api/runs`），产物一个字节不动（ADR-0002）。
- **起 agent 子进程之前，bin 名字必须先过 `runner.resolve_exe`**（`shutil.which`）。
  Windows 上 npm / pipx 装的 CLI 是个 `.cmd` / `.bat` 壳，而 `CreateProcess` 对**没有扩展名
  的名字只补 `.exe`、不认 PATHEXT** —— 拿裸名 Popen 报「系统找不到指定的文件」，
  **可同一个名字在用户的 cmd 窗口里、以及 `shutil.which` 那里都好好的**。
  真翻过（2026-10-27 内网）：会话那条路没事（`build_argv` 一直在做这一步），
  只有新加的「问模型清单」那条路栽了 —— 排查时最费劲的正是「我的 cmd 里明明能跑」。
  **每开一个新的 spawn 点都要问一句：这一步过了吗。**（守卫：`test_models.py` 里那条
  **只能用裸名走**的用例 —— 传绝对路径就绕过了这一步，正是它当初没被抓住的原因。）

## 产物渲染：只覆盖本仓渲染器实际吐的构造

`web/md.py` **不是通用 markdown 渲染器**，它只认本仓 `render_*_md.py` 输出的那个闭集
（标题 / 列表 / 表格 / 引用 / 段落 / `**粗体**` / `` `代码` ``）。那几份 md 全部由脚本生成，
构造是可枚举的——真统计过一次：表格 277 行、列表 21、标题 18、引用 4，无 `####`、无有序列表。

- **改 `render_*_md.py` 的输出构造要回头看它**：多吐一类构造（比如 `####`、有序列表），
  页面会把它当普通段落显示——**不报错，只是难看**，所以没人会发现。
  `tests/web/test_md.py` 拿真渲染器的输出喂它是这条的守卫。
- **表格单元格里的 `\|` 必须认**（`_cell()` 转义出来的）。不认，一行就被切成错列。
- **内容一律先转义再做行内格式**：md 里的文本来自模型，是数据不是标记。
- 列清单要**跳过下划线开头的目录**：`_docs_md/` 是输入文档的转换副本（不是产物）、
  `_shards/` `_source_parts/` 是工作工件。列错了用户会对着一堆不是产物的东西发懵。

## 夹具与守卫

- 假宿主 `tests/web/fake_agent.py` 说的是 stream-json，场景照实测事件次序写。**加新场景先问
  它覆盖几种宿主形态**：只跑「恰好有后台任务」那种，测不出判据退化（真翻过）。
  队列那批用例靠它的 `order` 场景（把收到的提示词逐条记进文件）核「勾选顺序 = 执行顺序」——
  后一趟只可能在前一趟终了之后被派出去，所以那份文件的行序就是执行序。它记的是**双层信封
  里层的那个字符串**（`send` 外面还包了一层），空行（提示词还没发就被停）不记。
- `tests/web/test_index_page.py` 是**静态契约**（`$()` 的 id、`els` 的键必须真实存在）：
  mock 冒烟只打 API 不开浏览器，绑定键名写错这一类只有它能先抓住。
- **`products.REGISTRY` 要两道隔离**（`tests/web/conftest.py`）：模块导入时先把**默认值**
  挪进会话级 tmp，autouse 再按用例各给一份。只做后者不够——`Run` 的收尾跑在自己的线程里、
  还带着 15s 的 `exit_timeout`，`_finish` 常常落在用例结束**之后**，那时 monkeypatch 已经把
  默认值还原回工具目录那份了（2026-10-12 真发生：批量用例把一批 pytest 临时路径写进了真的
  `web/products.json`，用户的产品登记被整个盖掉）。
