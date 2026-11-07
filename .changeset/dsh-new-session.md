---
'dsh-new-session': minor
---

Add `dsh-new-session`: a client-owned `/new` slash command in the Web GUI composer. Running it
calls the Workspace navigation service exactly like the New Session button — reusing the
Workspace's blank Session (and its unsent draft) when one exists, creating one otherwise — and it
is only registered while the Peer may call `session/create`.
