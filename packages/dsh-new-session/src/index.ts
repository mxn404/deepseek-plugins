/**
 * Host half of the conversation reset.
 *
 * The browser half owns the `/clear` (alias `/new`) command: it decides when
 * the user wants a fresh conversation and drives Workspace navigation. This
 * half owns the one thing only the Host can do — start the new Session in the
 * source Session's working directory — and exposes it as one exact route on the
 * Connection fetch bridge.
 *
 * @module dsh-new-session
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createAdoption, registerAdoptionRoute } from './host/adopt.ts'

/** Plugin id: package name, bundle row id, and browser module id. */
export const name = 'dsh-new-session'

/** Services this plugin cannot work without. */
export const inject = ['agents', 'connection', 'workingDirectory']

/**
 * Mount the Host half.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  registerAdoptionRoute(ctx, createAdoption(ctx))
}
