/**
 * Browser half of `dsh-new-session`: one client-owned `/new` command.
 *
 * A client-owned *action* is the right seam here. The composer resolves the
 * token locally, consumes it, and runs the callback without submitting a line
 * to the Host; the callback calls the Workspace navigation service, which is
 * exactly what the sidebar's New Session button does — reuse the Workspace's
 * blank Session when there is one (so an unsent draft is still there), create
 * one otherwise, then navigate to it.
 *
 * The command is registered only while the calling Peer may call
 * `session/create`: a read-only remote viewer would otherwise see a menu row
 * whose run can only fail.
 *
 * @module dsh-new-session/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
// Type-only: brings `session/create` into the TypertRemoteMap the access
// helper's action parameter is drawn from.
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { en, zh, type NewSessionKey } from './locales.ts'

/** Browser module id: package name, bundle row id, plugin id. */
export const name = 'dsh-new-session'

/** Locale namespace this plugin owns. */
const NS = 'newSession'

/** Client services the command cannot work without. */
export const inject = ['commandUi', 'locale', 'remoteAccess', 'uiWorkspace']

/** Dependencies one contribution needs; kept explicit so the spec can double them. */
export interface NewSessionCommandDeps {
  /** Bound translator for this plugin's dictionary. */
  readonly t: Translate<NewSessionKey>
  /** Starts a Session through the Workspace navigation service. */
  readonly start: () => void
}

/**
 * Build the `/new` contribution.
 *
 * Exported for the contract spec: the contribution is the unit under test, and
 * `apply` only decides when to install it.
 *
 * @param deps - translator and navigation callback.
 * @returns the silent action contribution.
 */
export function createNewSessionCommand(deps: NewSessionCommandDeps): CommandContribution {
  return {
    name: 'new',
    label: () => deps.t('label'),
    description: () => deps.t('description'),
    // Menu availability is the contribution registry's question; the access
    // gate lives on registration (whenAccess below), so every visible row runs.
    available: () => true,
    ui: {
      kind: 'action',
      run: () => { deps.start() },
    },
  }
}

/**
 * Mount the browser half.
 * @param ctx - browser-side Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-new-session: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.remoteAccess.whenAccess('session/create', () => ctx.commandUi.register(
    createNewSessionCommand({
      t,
      start: () => { ctx.uiWorkspace.startSession() },
    }),
  )), 'dsh-new-session: /new command')
}
