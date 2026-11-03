---
paths:
  - "**/*.workflow.js"
  - "**/scripts/*.py"
---

# 写 fan-out 编排（workflow 脚本 + 配套 python）

**唯一真相是 `.claude/skills/workflow-creator/references/create-workflow.md` §11「双宿主：按最严的宿主写」**，
动手前先读它；写或改 `*.workflow.js` 再调 `workflow-creator` skill 跑静态校验器与本地 mock（脚本 API
不在模型训练数据里）。本文只留一行一条的判据索引与本仓特有的约定，正反例、故事、代码片段都在 §11。

**关联是单向的：本仓认得那个 skill，那个 skill 不认得本仓。** 它要整份发给不在本仓开发的部门
（他们没有 `.claude/rules/`、没有本仓目录结构），必须完全自足——**别往它里面加任何指回本仓的引用**。

## 判据索引（每条对应 §11 的一个小节）

- **§11.1 扇出原语**：「N 个 item 各派一个 agent」一律 `parallel()` / `pipeline()`，禁 `Promise.all` 与手起——codeagent3 启动前扫脚本，见不到原语硬拦整趟。worker-pool 的 K 个 worker 同样交 `parallel()` 起。
- **§11.2 返回契约**：扇出子代理一律不带 schema，结论写盘；跨轮的裁决搬到主会话，落成脚本打「可逐字照抄的下一步」；保留的 schema 走 `runAgent` 重试、失败回 `null`，它跑的命令必须幂等且能降级。
- **§11.3 注册名**：只用 `Workflow({ name, args })`，`scriptPath` / `script` 在 codeagent3 直接失败。
- **§11.4 并发闸**：用 worker-pool 别手写信号量；stage1 首参是 item 本身、stage 写成 `(_prev, item) =>`；mock 语义抄 runtime harness，不抄被测代码。
- **§11.5 规模与派发表**：≤1000 agent 是单次 run 上限；派发计划前置算好落盘，进度真相是 done-marker，续跑重新切批。
- **§11.6 resume**：有副作用的命令不 resume-safe——调用方指令层禁 resume，或退出条件挂在盘上 ground truth。
- **§11.7 拆三段**：python 调不了 Workflow——前置合成 → 主会话跑 workflow → 后置打分，靠磁盘产物解耦。

## 本仓特有

- **路径实值由产派发表的脚本经 args 给**（如 `work_root`），workflow 只校验不推导；测试的断言值取自与真相不同源处（mjs 里 `work_root` 故意不放在 `output_root` 下），否则拷贝错误会连测试一起拷过去。
- 「抄 stdout」的字段收 `number|string`，编排层用 `num()` 收口（§11.2 别定死类型的本仓写法）。
- Claude Code 的 workflow 命名表在**进程启动时**一次性扫 `.claude/workflows/` 建成，早于一切 hook：in-session 注册（hook / 脚本 / 自愈提示）对本进程不可见，必须启动前落盘或 `--resume`；验「按名字调得起」要用全新进程。
- 守卫：`tests/ipc-module/test_backtrack_workflow.mjs` 等里「conc ≥ 项数 与 conc < 项数 两条路 label 与提示词逐字节一样」的断言，改 worker-pool 必跑。
