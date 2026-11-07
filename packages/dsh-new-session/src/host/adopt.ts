/**
 * Host half of the conversation reset: adopt a freshly created Session into the
 * source Session's working directory.
 *
 * This is the dsh equivalent of Claude Code recording a new conversation under
 * the same working directory as the previous one. A dsh Session owns two
 * directories: the immutable creation directory (`header.cwd`, which is what
 * keeps it inside its Workspace) and the committed working directory (the
 * `working-directory` projection). `/clear` must move the *working* directory
 * only, so the new Session stays a member of the same Workspace while any
 * worktree/isolation state the source had is carried over.
 *
 * @module dsh-new-session/host/adopt
 */

import { isAbsolute, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

/** Absolute prefix every route below lives under. */
export const API_PREFIX = '/api/dsh-new-session'

/** Plugin id; the wire method prefix and the package name are the same string. */
export const PLUGIN_ID = 'dsh-new-session'

/** This plugin serves exactly one verb. */
export const ENDPOINT = 'adopt' as const

/** One decoded adoption request. */
export interface AdoptionInput {
  /** Session the user is leaving; its working directory is the target. */
  readonly sourceSessionId: string
  /** Freshly created Session that should start where the source is. */
  readonly targetSessionId: string
}

/** What the Host did with one adoption request. */
export interface AdoptionValue {
  /** Whether the target's working directory was moved. */
  readonly adopted: boolean
  /** The source's current working directory. */
  readonly workingDirectory: string | null
}

/** The verb implementation the route dispatches to. */
export type Adopt = (input: AdoptionInput, signal: AbortSignal) => Promise<AdoptionValue>

/**
 * Whether `directory` is `root` or one of its descendants.
 * @param directory - candidate absolute directory.
 * @param root - absolute ancestor directory.
 * @returns whether `directory` is contained in `root`.
 */
export function isInside(directory: string, root: string): boolean {
  const path = relative(root, directory)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Resolve one live Agent, resuming it through the Session Controller when
 * available and falling back to the registry otherwise.
 * @param ctx - Host context.
 * @param sessionId - wire session identity.
 * @param signal - caller cancellation.
 * @returns the live Agent.
 * @throws when the Session cannot be resolved.
 */
async function agentOf(ctx: Context, sessionId: string, signal: AbortSignal): Promise<Agent> {
  signal.throwIfAborted()
  if (sessionId === '') throw new Error('a session id is required')
  // The common case (the Session the user is in, and the blank Session just
  // created for them) is already live; the controller handles a cold Session.
  const live = ctx.agents.get(sessionId as SessionId)
  if (live !== undefined) return live
  const controller = ctx.get('sessionController')
  if (controller !== undefined) {
    const resolved = await controller.resolveAgent(sessionId as SessionId)
    if (!('error' in resolved)) return resolved.agent
    throw new Error(resolved.error.message)
  }
  throw new Error(`no live agent for session ${sessionId}`)
}

/**
 * Build the adoption verb.
 *
 * Discovery is deliberately conservative: the target must be a Session that
 * has not started a turn yet, and the source's working directory must live
 * inside the source's own creation directory. Copying a directory from outside
 * that tree (a Session that `cd`-ed into another repository) would contradict
 * the target's project membership and make an isolating plugin misread it, so
 * that case is a reported no-op instead.
 *
 * @param ctx - Host context carrying `agents` and `workingDirectory`.
 * @returns the verb.
 */
export function createAdoption(ctx: Context): Adopt {
  return async (input, signal) => {
    const source = await agentOf(ctx, input.sourceSessionId, signal)
    const target = await agentOf(ctx, input.targetSessionId, signal)
    signal.throwIfAborted()
    if (source.session.id === target.session.id) {
      throw new Error('the source and target sessions must differ')
    }
    const boundary = ctx.agents.turnBoundaryOf(target.session)
    if (boundary.lastTurn !== 0 || boundary.openTurnStartSeq !== null) {
      throw new Error(`target session "${target.session.id}" has already started`)
    }
    const workingDirectory = ctx.workingDirectory.get(source.session)
    const home = source.session.header.cwd
    if (home === undefined || !isInside(workingDirectory, home)) {
      return { adopted: false, workingDirectory }
    }
    await ctx.workingDirectory.set(target, workingDirectory, signal)
    return { adopted: true, workingDirectory }
  }
}

/** One decoded client request. */
interface ClientRequest {
  readonly rpcId: string
  readonly method: string
  readonly payload: Record<string, unknown>
}

/**
 * Decode the browser's `client-request` envelope.
 * @param body - parsed JSON body.
 * @returns the request, or null when the envelope is malformed.
 */
function readClientRequest(body: unknown): ClientRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (record['type'] !== 'client-request') return null
  const { rpcId, method } = record
  if (typeof rpcId !== 'string' || rpcId === '') return null
  if (typeof method !== 'string' || method === '') return null
  const payload = record['payload']
  return {
    rpcId,
    method,
    payload: payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {},
  }
}

/**
 * Read one required non-empty string field.
 * @param payload - decoded payload.
 * @param field - field name.
 * @returns the value.
 * @throws when the field is missing or empty.
 */
function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`payload.${field} must be a non-empty string`)
  }
  return value
}

/** A successful wire result. */
function ok<T>(value: T): ConnectionRpcResult<T> {
  return { ok: true, value }
}

/** A failed wire result carrying the stable code. */
function fail(code: string, message: string): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Register the adoption route on the shared `/api` channel.
 *
 * Exact routes are the only shape an out-of-tree plugin can claim: `/api` is
 * the one logical channel the API Gateway owns, so `rpc.handle` refuses it and
 * a second `rpc.intercept` throws. The route answers owner peers only, which is
 * what the local Web GUI is.
 *
 * @param ctx - Host context carrying `connection`.
 * @param adopt - the verb this route serves.
 */
export function registerAdoptionRoute(ctx: Context, adopt: Adopt): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/${ENDPOINT}`,
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
      if (message.method !== `${PLUGIN_ID}/${ENDPOINT}`) {
        return Response.json({
          type: 'server-response',
          rpcId: message.rpcId,
          result: fail('bad-request', 'RPC method does not match endpoint'),
        })
      }
      let result: ConnectionRpcResult<AdoptionValue>
      try {
        result = ok(await adopt({
          sourceSessionId: requiredString(message.payload, 'sourceSessionId'),
          targetSessionId: requiredString(message.payload, 'targetSessionId'),
        }, request.signal))
      } catch (error) {
        result = fail('adopt-failed', error instanceof Error ? error.message : String(error))
      }
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
    },
  }), `${PLUGIN_ID} ${ENDPOINT} route`)
}
