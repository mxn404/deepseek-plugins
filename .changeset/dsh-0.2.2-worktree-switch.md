---
'dsh-worktree-switch': patch
---

Build and test against dsh 0.2.2-rc.1 (and cordis 4.1.0 / schemastery 3.19.0):
`engines.dsh` and the `@deepseek-ai/*` peer ranges move to
`>=0.2.2-rc.1 <0.2.3-0`, so an installation on the current harness no longer
refuses the plugin as incompatible. No behavior changed: the test harness now
builds a real `AgentModel` for its fixture Agent, which 0.2.2 requires, and the
client half (composer chip, Worktrees panel, sidebar entry) was re-checked
against the 0.2.2 slot contract and page module table.
