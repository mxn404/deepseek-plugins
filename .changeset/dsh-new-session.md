---
'dsh-new-session': minor
---

Align the plugin with Claude Code's `/clear`: the Web GUI composer now offers `/clear` with `/new` as
its alias. Both start a **new conversation** with empty context, keep the current working directory
(including a session's worktree copy), and leave the previous conversation in the session list.
The browser half creates or reuses the Workspace's blank Session and then asks the new Host route to
adopt the source Session's working directory, so an isolating plugin such as `dsh-worktree-switch`
sees the new Session already inside its copy instead of creating another one.
