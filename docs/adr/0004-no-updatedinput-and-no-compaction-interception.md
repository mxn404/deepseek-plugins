# 不实现 `updatedInput`，也不拦截 compaction

Claude Code 的 hooks 有两项在 dsh 里没有对应 seam 的能力：pre-tool 的 `updatedInput`
（在执行前改写工具入参）和 `PreCompact`（在压缩发生前拦截或改写）。本插件明确不做这两件
事，而不是用近似行为假装支持。

- **工具入参不可改写**：`tools/pre-execute` 的返回类型只有 `allow` / `deny` / `cancel` /
  `ask`，没有「换一份 arguments」的字段。更外层的 `tools/execute` waterfall 在文档里直接
  写明：wrapper 只能改 `exec.signal`，调用身份保持不变。参数在进入 seam 前已经解析并按工具
  schema 校验过。
- **compaction 没有 pre-veto seam**：压缩引擎自己选范围、写 `compaction/start`、生成摘要、
  写 `compaction/end`；Cordis 上唯一的压缩扩展点是失败后的
  `compaction/summary-error` 恢复 waterfall，只能在摘要失败后修输入并重试，不能在压缩
  开始前说「这次不要压」。
- **结果侧改写有官方替代**：`tools/post-execute` 的 `PostToolDecision` 支持
  `accept.content` / `accept.value` / `block`，本插件用其中的 `content` 替换实现
  `tool.post` 的 `replace`。模型读到的内容可以换，工具真实返回的 `value` 不动。

## 决定

- v1 不做 `updatedInput` 的模拟：`tool.pre` 只提供 `deny` / `ask` / `context` / `halt`。
  要在执行前改变行为，就 deny 并给出可操作的 reason，让模型换一种调用重试。
- v1 不挂 compaction：没有拦截，也不在摘要之后偷偷改写历史。压缩仍完全由宿主负责。
- 需要「改结果」的场景一律走 `tool.post` 的 `replace`；需要「别执行」的场景走
  `tool.pre` 的 `deny`。README 的能力矩阵把这两个替代路径写清楚。

## 后果

- **不能替工具补参数**：例如不能把 `git push` 自动改成 `git push --dry-run`，只能拦住并
  告诉模型为什么。依赖 `updatedInput` 的 Claude Code 配置迁不过来。
- **敏感参数只能在执行前拦截，不能脱敏**：argument 里的 token 一旦进入工具就没有 hook 能
  改写；要么 deny 这次调用，要么接受它出现在工具入参与（可能的）日志里。结果侧的
  `replace` 只能清理模型读到的输出。
- **`replace` 只换模型可见内容**：`value` 是执行期、schema 内的 JSON，不能由插件重新校验，
  所以本插件不提供 `value` 替换；写了 `replace.value` 是协议错误，不是静默忽略。
- **压缩不可干预**：本插件无法阻止一次自动压缩，也无法替换摘要。能做的只有观察压缩前后的
  会话事件（本版未挂钩）或在压缩后由宿主重建上下文。
- **配置写错会显式失败**：`updatedInput` 或 compaction 拦截这类本版不支持的字段不会被当作
  可用能力；模块 / command 返回非法 action 会 warn 并忽略，而不是半生效。

## 考虑过但不选的

- **在 pre-execute 里直接改 `exec.arguments`**：类型上不提供，宿主也声明调用身份不可变。
  绕过契约改已解析的参数会跳过工具 schema 校验，把「门禁」变成「隐式改写调用」，行为不可
  预测，也不随宿主版本稳定。
- **包一层 / 替换工具注册**：会改变工具身份与 schema，破坏 registry 的配对、展示与权限
  语义；这不是 hooks 该做的事。
- **用 deny + 让模型重试模拟 `updatedInput`**：没有宿主改动就能工作，正是本版的做法，但
  它是「拒绝并给建议」，不是「静默替换参数」，两者对模型与用户的可观测性不同。
- **监听 `compaction/start` 再撤销**：摘要范围已经选定并写入，事后撤销只能伪造历史；要真正
  veto 需要在宿主里新增 pre-compaction 事件，这超出插件边界，也超出 spec 的 Out of Scope。
