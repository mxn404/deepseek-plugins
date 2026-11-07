# dsh-new-session

## 0.2.1

### Patch Changes

- a9eef28: Document the cross-plugin premise of `/clear` (alias `/new`) inside a Worktree
  copy. The plugin code is unchanged; its README ships in the npm tarball, so the
  behavior text that changed with #32 needs a release:
  
  - `/new` starts the fresh conversation in the current working directory, so a
    session that runs in a worktree copy inherits that same copy.
  - The inherited copy still belongs to the original session: leaving from the
    new conversation returns to the source checkout, keeps the copy on disk, and
    raises no leftover notice.

## 0.2.0

### Minor Changes

- 1973239: Align the plugin with Claude Code's `/clear`: the Web GUI composer now offers `/clear` with `/new` as
  its alias. Both start a **new conversation** with empty context, keep the current working directory
  (including a session's worktree copy), and leave the previous conversation in the session list.
  The browser half creates or reuses the Workspace's blank Session and then asks the new Host route to
  adopt the source Session's working directory, so an isolating plugin such as `dsh-worktree-switch`
  sees the new Session already inside its copy instead of creating another one.

## 0.1.0

### Minor Changes

- f936be3: Add `dsh-new-session`: a client-owned `/new` slash command in the Web GUI composer. Running it
  calls the Workspace navigation service exactly like the New Session button — reusing the
  Workspace's blank Session (and its unsent draft) when one exists, creating one otherwise — and it
  is only registered while the Peer may call `session/create`.
