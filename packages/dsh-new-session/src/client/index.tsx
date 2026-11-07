/**
 * Browser half of `dsh-new-session`: `/clear` and its `/new` alias.
 *
 * The behavior follows Claude Code's `/clear`: start a *new conversation* with
 * empty context, keep the working directory, and leave the previous
 * conversation in the session list. dsh has no in-place context reset, so the
 * command creates (or reuses) a blank Session through Workspace navigation and
 * asks the Host to move that Session into the source Session's working
 * directory. Without that last step an isolating plugin such as
 * `dsh-worktree-switch` would treat the blank Session as a new project session
 * and create another worktree.
 *
 * Both commands are client-owned actions: nothing is submitted to the model,
 * and the slash token is consumed locally. They are registered only while the
 * calling Peer may call `session/create`.
 *
 * @module dsh-new-session/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: brings `session/create` into the TypertRemoteMap the access
// helper's action parameter is drawn from.
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { en, zh, type NewSessionKey } from './locales.ts'

/** Browser module id: package name, bundle row id, plugin id. */
export const name = 'dsh-new-session'

/** Locale namespace this plugin owns. */
const NS = 'newSession'

/** Host route namespace; the package name and the wire method prefix are the same. */
const PLUGIN_ID = 'dsh-new-session'

/** Client services the commands cannot work without. */
export const inject = ['commandUi', 'connection', 'locale', 'remoteAccess', 'uiWorkspace', 'workspaces']

/** Dependencies one command set needs; explicit so the spec can double them. */
export interface NewSessionDeps {
  /** Bound translator for this plugin's dictionary. */
  readonly t: Translate<NewSessionKey>
  /** Starts the fresh conversation from one source Session. */
  readonly start: (sessionId: SessionId) => void
}

/**
 * Build the `/clear` contribution and its `/new` alias.
 *
 * The client command registry has no alias mechanism (reserved for first-party
 * host commands), so an alias is a second contribution with the same action;
 * its copy says so.
 *
 * @param deps - translator and conversation starter.
 * @returns both contributions, primary first.
 */
export function createCommands(deps: NewSessionDeps): readonly CommandContribution[] {
  const command = (name: string, prefix: 'clear' | 'new'): CommandContribution => ({
    name,
    label: () => deps.t(`${prefix}.label`),
    description: () => deps.t(`${prefix}.description`),
    // Registration is already behind the `session/create` access gate.
    available: () => true,
    ui: {
      kind: 'action',
      run: session => { deps.start(session.sessionId) },
    },
  })
  return [command('clear', 'clear'), command('new', 'new')]
}

/**
 * Call the Host adoption verb.
 * @param ctx - browser Cordis context providing `connection`.
 * @param sourceSessionId - Session being left.
 * @param targetSessionId - blank Session that should start where the source is.
 * @throws {Error} when the Host refused or the reply is malformed.
 */
async function adopt(
  ctx: Context,
  sourceSessionId: SessionId,
  targetSessionId: SessionId,
): Promise<void> {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('the connection service is not mounted')
  const result = await connection.rpc.call('/api', `${PLUGIN_ID}/adopt`, {
    sourceSessionId,
    targetSessionId,
  })
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    throw new Error('malformed reply from the adopt verb')
  }
  if (!result.ok) throw new Error(result.error.message)
}

/**
 * Start a fresh conversation in the source Session's working directory.
 *
 * Sessions that do not belong to a Workspace fall back to plain navigation:
 * there is no Workspace whose blank Session could reuse the directory, and the
 * previous behavior is still the honest answer for that shape.
 *
 * @param ctx - browser Cordis context.
 * @param sessionId - Session the user is leaving.
 */
async function start(ctx: Context, sessionId: SessionId): Promise<void> {
  const workspace = ctx.workspaces.list.getSnapshot().items
    .find(item => item.sessionIds.includes(sessionId))
  if (workspace === undefined) {
    ctx.uiWorkspace.startSession()
    return
  }
  let target: SessionId
  try {
    target = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)
  } catch (error) {
    // The Workspace notice channel owns create failures; a command action has no
    // composer to report into, so the console is the remaining surface.
    console.warn('dsh-new-session: could not create the next Session:', error)
    return
  }
  try {
    await adopt(ctx, sessionId, target)
  } catch (error) {
    // Navigation still wins: the user asked for a fresh conversation. A failed
    // adoption only means an isolating plugin may create its own copy.
    console.warn('dsh-new-session: could not inherit the working directory:', error)
  }
  ctx.uiWorkspace.openSession(target)
}

/**
 * Mount the browser half.
 * @param ctx - browser-side Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-new-session: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.remoteAccess.whenAccess('session/create', () => {
    const disposers = createCommands({
      t,
      start: sessionId => { void start(ctx, sessionId) },
    }).map(command => ctx.commandUi.register(command))
    return () => { for (const dispose of disposers) dispose() }
  }), 'dsh-new-session: /clear commands')
}
