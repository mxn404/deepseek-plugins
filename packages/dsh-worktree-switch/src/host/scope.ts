/**
 * The copy a session is confirmed to run in, plus the one line the model reads
 * about it.
 *
 * The working-directory service already tells the model *where* it is. This
 * module answers the question that line does not: which checkout is the
 * session's workspace and which one is merely the project it was copied from.
 * The registry is fed by three sources — the switch verbs, `agent/created`
 * (resume), and `working-directory/change` (any `cd`) — so the line is never
 * stale, and it drops out entirely once the session leaves the copy.
 * @module dsh-worktree-switch/host/scope
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SessionScope } from '../types.ts'
import { contains } from './paths.ts'

/** Sessions whose confirmed copy the prompt context reads. */
export class SessionScopeRegistry {
  private readonly scopes = new Map<string, SessionScope>()

  /**
   * Read one session's confirmed scope, without any filesystem work.
   * @param sessionId - wire session identity.
   * @returns the known copy, or null.
   */
  get(sessionId: string): SessionScope | null {
    return this.scopes.get(sessionId) ?? null
  }

  /**
   * Record that a session now runs in a copy.
   * @param sessionId - wire session identity.
   * @param scope - the confirmed copy and its project root.
   */
  remember(sessionId: string, scope: SessionScope): void {
    this.scopes.set(sessionId, scope)
  }

  /**
   * Drop a session's scope; a session with no entry gets no hint.
   * @param sessionId - wire session identity.
   */
  forget(sessionId: string): void {
    this.scopes.delete(sessionId)
  }

  /** Drop every entry; the plugin dropping its context drops its hints with it. */
  clear(): void {
    this.scopes.clear()
  }
}

/**
 * The model-facing line describing a worktree session's workspace.
 * @param scope - the session's confirmed copy.
 * @returns one sentence pair, JSON-quoted so paths survive the prompt.
 */
export function scopeHint(scope: SessionScope): string {
  return `This session is a linked Git worktree checkout at ${JSON.stringify(scope.worktree.path)} of the project ${JSON.stringify(scope.repositoryRoot)}. Run Git commands and file edits from the current working directory; the project checkout is the source, not this session's workspace.`
}

/** What the installer needs from the host half that owns Git. */
export interface WorktreeScopeWiring {
  /** Shared registry the prompt context reads. */
  readonly registry: SessionScopeRegistry
  /**
   * Re-derive one session's copy from its committed directory.
   * @param agent - live session owner.
   * @param signal - cancellation.
   * @returns the confirmed copy, or null when the session is not in one.
   */
  detect(agent: Agent, signal?: AbortSignal): Promise<SessionScope | null>
}

/**
 * Register the worktree scope as dynamic prompt context and keep it fresh.
 *
 * The context is `required`, so it survives compositions that suppress
 * optional runtime context, and it renders from the registry synchronously —
 * the expensive Git detection happens on session creation and directory
 * changes, never at request time.
 * @param ctx - host context carrying `systemPrompt`, `agents`, and `workingDirectory`.
 * @param wiring - registry plus the Git-backed detector.
 */
export function installWorktreeScope(ctx: Context, wiring: WorktreeScopeWiring): void {
  const { registry, detect } = wiring

  ctx.inject(['systemPrompt'], (scoped: Context) => {
    scoped.systemPrompt.context({
      name: 'worktree-switch:scope',
      order: scoped.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 5,
      interpolate: false,
      required: true,
      text: (assembly) => {
        const agent = assembly.agent
        if (agent === undefined) return ''
        const sessionId = String(agent.session.id)
        const current = ctx.workingDirectory.get(agent.session)
        const scope = registry.get(sessionId)
        if (scope !== null && contains(scope.worktree.path, current)) return scopeHint(scope)
        // The committed directory is the authority: a session that left the
        // copy must not keep the line.
        if (scope !== null) registry.forget(sessionId)
        const anchor = agent.session.header.cwd ?? current
        // A session still at its creation directory is in no copy; only a
        // directory change inside the project is worth a Git look, and only
        // once per distinct directory value.
        if (current === anchor || !contains(anchor, current)) return ''
        if (lastChecked.get(sessionId) === current) return ''
        void refresh(agent, current)
        return ''
      },
    })
  })

  const inFlight = new Set<string>()
  /** The directory value each session was last inspected at, hit or miss. */
  const lastChecked = new Map<string, string>()

  /** Re-derive one live agent's scope, remembering or forgetting it. */
  const refresh = async (agent: Agent, current: string = ctx.workingDirectory.get(agent.session)): Promise<void> => {
    const sessionId = String(agent.session.id)
    const anchor = agent.session.header.cwd ?? current
    // Cheap reject before any Git work: a copy is always inside the project,
    // and a session still at its creation directory is in no copy.
    if (current === anchor || !contains(anchor, current)) {
      registry.forget(sessionId)
      return
    }
    if (inFlight.has(sessionId)) return
    inFlight.add(sessionId)
    lastChecked.set(sessionId, current)
    try {
      const found = await detect(agent)
      if (found === null) registry.forget(sessionId)
      else registry.remember(sessionId, found)
    } catch {
      registry.forget(sessionId)
    } finally {
      inFlight.delete(sessionId)
    }
  }

  // A resumed session enters no verb, so creation is where it is recognised; an
  // ordinary new session sits at its creation directory and stops at the cheap
  // check. The hook is serial, so the first request already sees the line.
  ctx.on('agent/created', async ({ agent }) => {
    await refresh(agent)
    return undefined
  })
}

