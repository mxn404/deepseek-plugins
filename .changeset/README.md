# Changesets

每个插件的版本各自独立，用 changesets 记录变更：

```sh
pnpm changeset          # 选包、选 bump 级别、写变更说明
pnpm release:version    # 消费 changeset，改版本号并生成 CHANGELOG
pnpm release:publish    # 发布未发布的包
```

`changeset version` 会打形如 `dsh-foo@0.1.0` 的标签（scoped 包是
`@you/dsh-foo@1.2.0`），这正是市场索引生成器认的标签格式；不要改用手写的
`vX.Y.Z`，那种标签会被当成"适用于所有包"。

`packages/_template` 是 private 包，changesets 会跳过它（`privatePackages` 两项都为
false）。
