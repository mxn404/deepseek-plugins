---
paths:
  - "**/codeagent-extension.json"
  - "**/.claude-plugin/**"
  - "**/.cac-plugin/**"
  - "**/hooks/hooks.json"
  - ".claude/settings*.json"
  - "**/hooks/*.py"
  - "**/hooks/*.sh"
---

# 双宿主：插件清单、hooks 与环境变量

插件跑在两种宿主上：Claude Code 与 codeagent3，两者读不同的清单、注入不同前缀的环境变量。
改插件 infra（清单 / hooks / 安装器）时都要顾到两边：

- **清单成套**：`.claude-plugin/plugin.json`（Claude Code 读）、`codeagent-extension.json`
  （codeagent3 读）、`.cac-plugin/plugin.json`（真实目录，不自动同步）在 `name` / `description` / `version` 上必须一致。**改了一份就把在场的其它份都改掉**——
  版本只 bump 一份会让另一个宿主的成员据版本号得出错误结论。`tests/test_plugin_manifests.py` 钉住。
- **hook 的 `command` 必须是单个 `.sh` 路径，绝不能是多语句 shell**（#1094）。两种宿主的
  执行模型不同：Claude Code / Linux 走 `bash -c <命令>`；**Windows + codeagent3 把 `command`
  当成脚本文件路径**交给 bash——多语句 POSIX shell 会被整串当成一个不存在的文件，每次退出码
  127，全部 hook（11 条 command、六个壳）**执行不到**，宿主只报一行非阻塞的 hook error，审计表面照常进行。唯一
  两边都成立的形态是单个可执行文件路径：
  `${CLAUDE_PLUGIN_ROOT}${CODEAGENT3_PLUGIN_ROOT}/hooks/run_<checker>.sh`。
  - 两个占位符**相邻拼接**：两个宿主各注入其中一个、另一个为空。不能写成 `${A:-$B}`——
    替换器只认精确的 `${VAR}`，带 `:-` 的形式会原样落到 shell 拿到空。
  - 不引号、不空白、不含 shell 元字符，必须以 `.sh` 结尾——故障机把这些字面量当路径的一部分。
  - 插件根探路、python3 探路、fail-open（`.py` / python3 缺失 → `exit 0` + 一行说明）全在壳
    脚本里；壳用 `$0` 定位插件根、不解析 stdin、不路由，只 `exec python3 <checker>.py --scripts
    <skill>/scripts`。判据、路由、文案仍然只有 `.py` 里那一份。
  - `Write` 与 `Edit` 共用同一个壳（`run_<checker>.sh`），11 条命令只剩六种。
  - **已知取舍**：两个根变量都取不到时命令退化成 `/hooks/run_x.sh`，宿主报**非阻塞**的 127，
    不再有旧的「静默 exit 0」；插件根路径含空格时未加引号的单路径在 `bash -c` 一侧有风险。
  - `.gitattributes` 钉了 `*.sh text eol=lf`：Windows 上 `core.autocrlf=true` 会把 shebang 检出成
    `#!/bin/sh\r`，脚本要么起不来、要么拿着脏路径走。
  - 守卫：`tests/test_plugin_hook.py`（单 token / 相邻占位符 / shebang / LF / 壳里的 `.py` 与
    `--scripts` 都在）与四个套件的真跑（`bash -c <命令>` 与 `bash <路径>` 两种模式）。
- **宿主专属环境变量按上一条的单路径形态相邻拼接使用**，不再有「谁优先、谁兜底」。两对：
  `CLAUDE_PLUGIN_ROOT` / `CODEAGENT3_PLUGIN_ROOT`（插件 hooks）与 `CLAUDE_PROJECT_DIR` /
  `CODEAGENT3_PROJECT_DIR`（**本仓开发配置** `.claude/settings.json`）——两个宿主各注入其中一个、
  另一个为空。开发配置的 command 同样收成单路径：`${CLAUDE_PROJECT_DIR}${CODEAGENT3_PROJECT_DIR}` +
  `/.claude/hooks/run_<name>.sh`，壳与插件那套同形（`$0` 定位、探 python3、fail-open、exec）。
  守卫：`tests/test_dev_hooks_wiring.py`（单 token / 相邻占位符 / shebang / LF / fail-open 真跑）。
- **hook 的 `if` 里一个路径分隔符都不能有**：写成 `Write(**02_threat_module**)`，别写
  `Write(**/security_audit/02_threat_module/**)`。带 `/` 的 glob 在 **Windows + codeagent3** 上匹配不上
  （那边 `file_path` 是 `C:\…\` 形态），宿主**静默跳过整条 hook**——不报错、不打印、退出码都没有，
  产物的 md 连着几轮不生成而链路上无人吭声。反斜杠版被 glob 引擎当转义符吃掉，两边都不中，
  所以「各写一份」也不成立；只有不含分隔符的形态两边都中。
  粗筛写宽了最多白起一个 python 进程，写窄了就是静默漏校验——**`if` 永远该是 `route_of()` 的超集**。
  守卫见 `tests/test_plugin_hook.py::test_hook_if_conditions_are_separator_free`。
- **两宿主读得到的配置，事件键必须在交集内——插件和本仓开发配置一个口径**。codeagent 的加载器是
  严格模式：顶层 `hooks` 里出现一个它不认识的事件键，就拒绝**整份文件**（连累同文件里别的 hook）。
  这条规则管的是「宿主读不读得到」，不是「随不随插件分发」：仓库根的 `.cac` 是 `.claude` 的快捷
  方式，**codeagent 在本仓启动时读到的就是 `.claude/settings.json`**——`UserPromptExpansion` 曾挂在
  那里，结果一启动 codeagent 就报 `invalid hook event name`，同文件里另两条提醒一起失效
  （2026-10-29，已删，ADR-0022）。手打斜杠命令要用两宿主都认的 **`UserPromptSubmit`**：它收到的
  就是整条 prompt（`/插件:skill 参数`），关键词在脚本里匹配。守卫：插件侧
  `tests/test_plugin_hook.py::test_hook_events_are_cross_host`、开发配置侧
  `tests/test_dev_hooks_wiring.py::test_settings_events_are_cross_host`，共用同一张交集白名单
  `CROSS_HOST_EVENTS`。
  ⚠️ **别把「交集内」读成「两边都发」**：交集规则管的是「**这份文件**在两边都读得了」，不是
  「挂上去就两边都响」。要覆盖某个时机，先看**两宿主各自实际发什么**、以本机会话记录为准，别凭
  印象——2026-10-15 曾据此断言「Claude 手打斜杠命令不发 `UserPromptSubmit`」，2026-10-29 复核
  74 轮斜杠命令发现**每轮都发**（2.1.295～2.1.308 各版本），那条旧结论直接导致了一次错误的修复。
  本仓开发配置的接线由 `tests/test_dev_hooks_wiring.py` 钉住；只有单个宿主有的事件（如
  `UserPromptExpansion`）任何 codeagent 读得到的配置里都不能挂。
