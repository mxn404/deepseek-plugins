# dsh-path-rules

## 0.1.2

### Patch Changes

- 428f32f: Windows support: recognise the `pwsh` shell tool as well as `bash`, and trigger path rules from a conservative PowerShell single-file read (`Get-Content` and its `gc` / `cat` / `type` aliases, `-Path` / `-LiteralPath` or one positional file; pipes, wildcards, variables, redirection and multi-file shapes stay untriggered). `paths` globs now normalise backslashes to `/`, `.md` discovery and glob matching are case-insensitive on Windows, and rule dedupe folds the Windows path case while display paths stay as discovered.
  
  POSIX 上既有的 `/` glob 写法与大小写敏感匹配保持不变；反斜杠归一化与扩展名大小写不敏感是这次显式放宽的跨平台行为。

## 0.1.1

### Patch Changes

- 789c790: Build and test against dsh 0.2.2-rc.1 (and cordis 4.1.0 / schemastery 3.19.0):
  `engines.dsh` and the `@deepseek-ai/*` peer ranges move to
  `>=0.2.2-rc.1 <0.2.3-0`, so an installation on the current harness no longer
  refuses the plugin as incompatible. No runtime behavior changed; the
  integration test's content-tool fixture now comes from
  `@deepseek-ai/dsh-tool-testkit`, where 0.2.2 moved it out of `@deepseek-ai/dsh-tools`.
