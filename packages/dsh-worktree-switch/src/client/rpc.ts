/**
 * Browser-side caller for this plugin's five host verbs.
 *
 * Typed at the wire boundary by hand: the plugin's host half answers exact
 * Connection fetch routes, so there is no generated Remote namespace to import.
 * @module dsh-worktree-switch/client/rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

/** The channel every plugin route lives on. */
const CHANNEL = '/api'

/** This plugin's endpoint prefix. */
const PREFIX = 'dsh-worktree-switch'

/**
 * Call one host verb.
 * @param ctx - browser Cordis context providing `connection`.
 * @param endpoint - verb name without the plugin prefix.
 * @param payload - JSON payload.
 * @param signal - optional caller cancellation.
 * @returns the verb's value.
 * @throws {Error} carrying the host failure's message when the verb refused.
 */
export async function callHost<T>(
  ctx: Context,
  endpoint: 'status' | 'prepare' | 'release' | 'list' | 'discard',
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('worktree switch: the connection service is not mounted')
  const result = await connection.rpc.call(CHANNEL, `${PREFIX}/${endpoint}`, payload, signal)
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    throw new Error(`worktree switch: malformed reply from ${endpoint}`)
  }
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}
