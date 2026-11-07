# 版本号默认只 bump patch

本仓发布默认只动 **patch 位（C 位）**：`0.5.0` → `0.5.1`。`minor`（B 位）与 `major`（A 位）
只在**维护者在当次请求里明确要求**时才动；「这是新功能」或「这是破坏性变更」都不自动升级
版本位。这是对 semver 的**有意偏离**，取舍见
[ADR-0008](../../docs/adr/0008-version-bumps-only-patch.md)。

- 默认写 `patch`：修 bug、行为微调、新功能、新配置、wire 契约变更都先用 `patch`。
- `minor` / `major` 只在当次明确要求时使用；没有「以后新功能都用 minor」这类常驻许可。
- **新包第一个 changeset 例外**：用 `minor`，`0.0.0` → `0.1.0`（本仓惯例，dsh-new-session、
  dsh-path-rules 都从 0.1.x 起）。
- 版本号只由 `changeset version` 写。不手改 `package.json` 的 `version` 绕过 changeset，
  也不为空补版本位另发一次发布。
- 合并后立刻发版的完整清单在 [release.md](./release.md)；版本位只归本规则。
