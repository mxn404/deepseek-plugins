/**
 * The Connection fetch bridge: four exact POST routes on the shared `/api`
 * channel, one per verb, speaking the `client-request` / `server-response`
 * envelope the browser's `connection.rpc.call` already implements.
 *
 * Exact routes are the only shape an out-of-tree plugin can claim: `/api` is
 * the one logical channel the API Gateway owns, so `rpc.handle` refuses it and
 * a second `rpc.intercept` throws. Every route below answers owner peers only,
 * which is what the local Web GUI is.
 * @module dsh-worktree-switch/host/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { DiscardValue, ListValue, PrepareValue, StatusValue, WorktreeToggle } from './handlers.ts'
import { WorktreeToggleError } from './handlers.ts'

/** Absolute prefix every route below lives under. */
export const API_PREFIX = '/api/dsh-worktree-switch'

/** Plugin id; the wire method prefix and the package name are the same string. */
export const PLUGIN_ID = 'dsh-worktree-switch'

/** One route per verb. */
export const ENDPOINTS = ['status', 'prepare', 'list', 'discard'] as const

/** A verb this route table serves. */
export type Endpoint = (typeof ENDPOINTS)[number]

/** A decoded client request. */
interface ClientRequest {
  readonly rpcId: string
  readonly method: string
  readonly payload: Record<string, unknown>
}

/** A payload object with the named string field, or the failure to send back. */
function requiredString(
  payload: Record<string, unknown>,
  field: string,
): { readonly value: string } | { readonly failure: WorktreeToggleError } {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      failure: new WorktreeToggleError('bad-request', `payload.${field} must be a non-empty string`),
    }
  }
  return { value }
}

/**
 * Decode the browser's `client-request` envelope.
 * @param body - parsed JSON body.
 * @returns the request, or null when the envelope is malformed.
 */
export function readClientRequest(body: unknown): ClientRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (record.type !== 'client-request') return null
  const { rpcId, method } = record
  if (typeof rpcId !== 'string' || rpcId === '') return null
  if (typeof method !== 'string' || method === '') return null
  const payload = record.payload
  return {
    rpcId,
    method,
    payload: payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {},
  }
}

/** A successful result. */
function ok<T>(value: T): ConnectionRpcResult<T> {
  return { ok: true, value }
}

/** A failed result carrying the stable code. */
function fail(code: string, message: string, details: Record<string, unknown> = {}): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

/**
 * Dispatch one decoded verb.
 * @param toggle - the host face.
 * @param endpoint - the verb.
 * @param payload - its decoded payload.
 * @param signal - request cancellation.
 * @returns the wire result.
 */
export async function dispatch(
  toggle: WorktreeToggle,
  endpoint: Endpoint,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ConnectionRpcResult<StatusValue | PrepareValue | ListValue | DiscardValue>> {
  try {
    if (endpoint === 'status') {
      const sessionId = requiredString(payload, 'sessionId')
      if ('failure' in sessionId) throw sessionId.failure
      return ok(await toggle.status({ sessionId: sessionId.value }, signal))
    }
    if (endpoint === 'prepare') {
      const sessionId = requiredString(payload, 'sessionId')
      if ('failure' in sessionId) throw sessionId.failure
      return ok(await toggle.prepare({ sessionId: sessionId.value }, signal))
    }
    if (endpoint === 'list') {
      const path = requiredString(payload, 'path')
      if ('failure' in path) throw path.failure
      return ok(await toggle.list({ path: path.value }, signal))
    }
    const path = requiredString(payload, 'path')
    if ('failure' in path) throw path.failure
    const name = requiredString(payload, 'name')
    if ('failure' in name) throw name.failure
    return ok(await toggle.discard({ path: path.value, name: name.value }, signal))
  } catch (error) {
    if (error instanceof WorktreeToggleError) return fail(error.code, error.message, { ...error.details })
    return fail('internal', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register one exact route per verb on the shared `/api` channel.
 * @param ctx - Host context carrying `connection`.
 * @param toggle - the host face the routes call.
 */
export function registerWorktreeRoutes(ctx: Context, toggle: WorktreeToggle): void {
  for (const endpoint of ENDPOINTS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const message = readClientRequest(body)
        if (message === null) return new Response('invalid client-request message', { status: 400 })
        if (message.method !== `${PLUGIN_ID}/${endpoint}`) {
          return Response.json({
            type: 'server-response',
            rpcId: message.rpcId,
            result: fail('bad-request', 'RPC method does not match endpoint'),
          })
        }
        const result = await dispatch(toggle, endpoint, message.payload, request.signal)
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }), `${PLUGIN_ID} ${endpoint} route`)
  }
}
