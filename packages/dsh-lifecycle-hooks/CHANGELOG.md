# dsh-lifecycle-hooks

## 0.2.0

### Minor Changes

- 04f0b12: Add the lifecycle hooks plugin: a host-only runtime that discovers `.dsh/hooks.json` layers from
  the user directory, the project root down to the session's current directory, and the local
  override beside each project file. Hooks run on native dsh lifecycle events as builtin decisions,
  shell commands, or in-process modules, and can deny or gate a tool call, block or rewrite a
  tool result, inject session and step context, and continue a stopping turn. Runs are audited as
  `plugin:dsh-lifecycle-hooks/run` session records, and edits apply on the next event through a
  watcher plus a stat check.
