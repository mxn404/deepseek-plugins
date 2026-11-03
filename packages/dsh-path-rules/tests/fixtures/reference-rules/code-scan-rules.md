---
paths:
  - "sectest-threat/skills/code-scan/scan-rules/**"
  - "sectest-threat/skills/code-scan/guides/**"
  - "docs/code-scan/**"
  - "tests/code-scan/**"
---

# 写 code-scan 扫描规则（semgrep yaml + 规则文档 + 审计指南 + 夹具）

## 编号一致性

一条规则的 id / requirement / 文件名用同一个**无点**编号从头串到尾——带点会被按 `.` 截成末段。

同一规范挂多条规则时，编号加后缀、requirement 保持不变，好按规范去重。

## metavariable-regex 从头锚定

`metavariable-regex` 是从头锚定（≈ `re.match`），**不是 search**。要「包含某子串」的语义，**必须加前导 `.*`**——否则等于要求以该子串开头，名字不以它打头就**静默漏命中、不报错**，最难查。

同一个 metavariable 挂多条 `metavariable-regex` 是**相与**。

跨多行的语句序列 pattern 里，每条表达式语句要像 C 一样**带分号**。

## semgrep taint 的硬天花板

OSS taint 的 propagator 不链、只在函数内——**跨函数的真问题结构上必漏**。别调规则去追，当漏报登记、交人工兜底。

taint 源用**窄词表**（只收确定敏感的词），别沿用结构规则那张宽表，否则污点源 FP 爆炸。

## 模板（用到哪份读哪份，默认不预读）

- `docs/code-scan/rule-docs/_TEMPLATE.md` — 扫描规则文档模板（写 / 改规则文档时读）。
- `docs/code-scan/guide-template.md` — 审计指南模板（写审计指南时读，每条规则一份）。

## Windows 中文环境跑 semgrep / python

Python 按系统 locale（gbk）解码本仓含中文的 yaml / 夹具会炸，semgrep 读配置同样中招。开跑前设 `PYTHONUTF8=1`，不改工具源码；自己的脚本显式指定 utf-8，不赖环境。
