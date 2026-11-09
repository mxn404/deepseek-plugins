# dsh-lifecycle-hooks

## 0.2.2

### Patch Changes

- 428f32f: Windows support: hooks files are decoded by their byte-order mark (UTF-8 BOM, UTF-16 LE and BE), so a `.dsh/hooks.json` written by Notepad or PowerShell 5 no longer drops the whole layer; a broken rewrite still keeps the last valid layer and warns. Module hook extensions (`.mjs` / `.js`) are compared case-insensitively. The README documents that `run.command` runs in the host shell (pwsh on Windows) and that `match.tool` must name the tool the host actually mounts.
  
  POSIX 上原本能加载的 hooks 文件照常工作；新增的是大小写不敏感的 module 扩展名与 BOM 解码，二者不改变既有文件的语义。

## 0.2.1

### Patch Changes

- 789c790: Build and test against dsh 0.2.2-rc.1 (and cordis 4.1.0 / schemastery 3.19.0):
  `engines.dsh` and the `@deepseek-ai/*` peer ranges move to
  `>=0.2.2-rc.1 <0.2.3-0`, so an installation on the current harness no longer
  refuses the plugin as incompatible.
  
  The turn number now comes from the Agent registry's own `turnBoundary`
  projection (`ctx.agents.turnBoundaryOf`); the generic `sessionProjections.stateOf`
  read is deprecated in 0.2.2 and logged a deprecation warning on every profile
  that mounted the plugin.
  
  `session.end` audit rows are documented as the plugin's file fallback:
  dsh 0.2.2 detaches a store-owned Session from its SessionStore as disposal
  completes, and a Session that left the store rejects plugin records, so the
  detached `session.end` run can no longer write a `plugin:dsh-lifecycle-hooks/run`
  record. The same row is appended to `<session cwd>/.dsh/hooks-audit.jsonl`
  instead, with one warning per file naming the path; the run is not lost, only
  its location changes. Nothing changes for `session.end` payloads or hook
  execution.

## 0.2.0

### Minor Changes

- 04f0b12: Add the lifecycle hooks plugin: a host-only runtime that discovers `.dsh/hooks.json` layers from
  the user directory, the project root down to the session's current directory, and the local
  override beside each project file. Hooks run on native dsh lifecycle events as builtin decisions,
  shell commands, or in-process modules, and can deny or gate a tool call, block or rewrite a
  tool result, inject session and step context, and continue a stopping turn. Runs are audited as
  `plugin:dsh-lifecycle-hooks/run` session records, and edits apply on the next event through a
  watcher plus a stat check.
