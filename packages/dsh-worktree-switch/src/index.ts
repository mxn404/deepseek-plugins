/**
 * Host half of the Worktree switch.
 *
 * It mounts no service itself: the bundle patch inserts the harness worktree
 * service (`@deepseek-ai/dsh-experimental-worktree`, which provides
 * `ctx.worktrees`) and this plugin's own row. This plugin exposes five verbs
 * over the Connection fetch bridge and drives that service for creation; it
 * also contributes one model-facing context line while a session runs in a
 * copy, and the browser half renders the switch and the panel.
 * @module dsh-worktree-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createWorktreeToggle, detectSessionScope } from './host/handlers.ts'
import { registerWorktreeRoutes } from './host/routes.ts'
import { installWorktreeScope, SessionScopeRegistry } from './host/scope.ts'

/** Plugin id: package name, bundle row id, browser module id. */
export const name = 'dsh-worktree-switch'

/**
 * Services this plugin cannot work without.
 *
 * `worktrees` is provided by the row this bundle's patch inserts next to its
 * own, so Cordis holds this plugin until that row has mounted.
 */
export const inject = ['agents', 'connection', 'subprocess', 'worktrees', 'workingDirectory']

/** Row config accepted from `cordis.patch.yml`. */
export interface Config {
  /** Default for a project the user has never switched either way. */
  defaultEnabled: boolean
}

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  defaultEnabled: Schema.boolean()
    .default(true)
    .description('Start a new session in a worktree copy until the user turns the switch off for that project.'),
})

/**
 * Mount the host half.
 * @param ctx - Host context.
 * @param config - validated row config.
 */
export function apply(ctx: Context, config: Config): void {
  const scopes = new SessionScopeRegistry()
  const toggle = createWorktreeToggle(ctx, {
    defaultEnabled: config.defaultEnabled,
    onScope: (sessionId, scope) => {
      if (scope === null) scopes.forget(sessionId)
      else scopes.remember(sessionId, scope)
    },
  })
  installWorktreeScope(ctx, {
    registry: scopes,
    detect: (agent, signal) => detectSessionScope(ctx, agent, signal),
  })
  registerWorktreeRoutes(ctx, toggle)
}
