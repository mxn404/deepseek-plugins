# dsh-path-rules

## 0.1.1

### Patch Changes

- 789c790: Build and test against dsh 0.2.2-rc.1 (and cordis 4.1.0 / schemastery 3.19.0):
  `engines.dsh` and the `@deepseek-ai/*` peer ranges move to
  `>=0.2.2-rc.1 <0.2.3-0`, so an installation on the current harness no longer
  refuses the plugin as incompatible. No runtime behavior changed; the
  integration test's content-tool fixture now comes from
  `@deepseek-ai/dsh-tool-testkit`, where 0.2.2 moved it out of `@deepseek-ai/dsh-tools`.
