/**
 * The one dispatcher every lifecycle event goes through.
 *
 * Tickets add events, not pipeline steps. For one event this module owns the
 * whole sequence — resolve the Session's layers, select the entries bound to
 * that event, run them in configuration order, record every run, merge the
 * outcomes, and hand the merged decision to the event's own applier — so a new
 * event only supplies a {@link DispatchPlan}: what it matches, what it puts in
 * the payload, which actions it supports, and how the decision reaches the host
 * seam. This build registers a plan for `session.start`, `step.start`,
 * `tool.pre`, `tool.post`, and `turn.stop`.
 *
 * Two rules are enforced here for every event:
 *
 * - a run that failed (or timed out) is recorded and warned about, contributes
 *   no decision, and becomes the entry's `onFailure: "block"` outcome when it
 *   asked for one;
 * - only `halt` stops later handlers; every other decision runs to the end and
 *   is ranked by {@link mergeDecisions}.
 *
 * @module dsh-lifecycle-hooks/dispatch
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { recordHookRun } from './audit.ts'
import type { DetachedRuns } from './detached.ts'
import type { HookResolver, ResolvedHooks } from './discovery.ts'
import type { HookRun, HandlerShell } from './handler.ts'
import { executeHook } from './handler.ts'
import type { Hook, HookAction, HookEvent } from './hook.ts'
import type { HookMatch } from './match.ts'
import { matchesHook } from './match.ts'
import type { MergedDecision } from './outcome.ts'
import { allowedDecisions, failureDecision, mergeDecisions } from './outcome.ts'
import type { PayloadFacts } from './payload.ts'
import { commandEnv, commandPayload } from './payload.ts'

/** What one event knows about itself when it dispatches. */
export interface DispatchCall {
  /** Session the event belongs to; its log carries the audit rows. */
  readonly session: Session
  /** Session's current working directory: discovery root and command workdir. */
  readonly cwd: string
  /** Agent the event belongs to. */
  readonly agentId: string
  /** Turn number of the latest opened turn. */
  readonly turn: number
  /** Step number of the latest opened step. */
  readonly step: number
  /** Cancels pending runs when the host abandons the event. */
  readonly signal: AbortSignal
  /**
   * Consecutive continues already granted in this turn, for events that carry
   * one (`turn.stop`); every run at that event records it. Absent elsewhere.
   */
  readonly continuedCount?: number
}

/**
 * The match dimensions one event offers its hooks.
 *
 * `session.start` has none, both tool events have a tool and its arguments, and
 * `step.start` has the presence of a user prompt. The loader rejects a `match`
 * dimension the event does not offer, so selection only ever consults the
 * dimension the event hands over.
 */
export type MatchSubject =
  | { readonly kind: 'none' }
  | { readonly kind: 'tool'; readonly tool: string; readonly args: unknown }
  | { readonly kind: 'prompt'; readonly prompt: string | null }

/** The part of a call an event's hooks may select and see. */
export interface DispatchSubject {
  /** What this event's `match` clause can select on. */
  readonly match: MatchSubject
  /** Extra payload fields for this event (the `tool` block, plus `result` on `tool.post`). */
  readonly fields: Record<string, unknown>
}

/** One event's dispatch plan: its selection, its payload, and its application. */
export interface DispatchPlan<TApplied> {
  /** The lifecycle point being dispatched. */
  readonly event: HookEvent
  /** Actions this event supports; any other action is warned about and ignored. */
  readonly actions: readonly HookAction[]
  /** The call this event dispatches. */
  readonly subject: DispatchSubject
  /**
   * Apply the merged decision, or return `undefined` to leave the host's own
   * behaviour untouched. Asynchronous appliers are for events whose fold has
   * to delegate down the host's own waterfall first (`step.start`).
   * @param decision - the ranked outcome of every run.
   * @returns the value the host seam consumes, when the event has one.
   */
  apply(decision: MergedDecision): TApplied | undefined | Promise<TApplied | undefined>
}

/** What the dispatcher needs from the plugin instance that owns it. */
export interface HookDispatcherOptions {
  /** Hook discovery for one directory. */
  readonly resolver: Pick<HookResolver, 'resolve'>
  /**
   * The host shell service, read on every run: a deployment without one turns
   * into a failed run (and its `onFailure` policy), never a plugin failure.
   */
  readonly shell: () => HandlerShell
  /** In-flight registry for detached runs. */
  readonly detached: DetachedRuns
  /** Whether runs append a plugin record to the Session log. */
  readonly audit: boolean
  /** Warning sink; the owner adds the plugin-name prefix. */
  readonly warn: (message: string) => void
  /** Called after each resolve, so the owner can retarget a Session's watcher. */
  readonly onResolve?: (session: Session, directories: readonly string[]) => void
}

/** Resolve, run, record, merge, and apply one event's hooks. */
export class HookDispatcher {
  /** @param options - discovery, shell, audit, and warning seams. */
  constructor(private readonly options: HookDispatcherOptions) {}

  /**
   * Dispatch one event.
   *
   * A discovery failure fails open: the event proceeds exactly as if no hooks
   * were configured, with one warning.
   * @param call - the event's own facts.
   * @param plan - how the event selects hooks and applies its decision.
   * @returns the event's decision, or `undefined` to leave the host's behaviour alone.
   */
  async dispatch<TApplied>(
    call: DispatchCall,
    plan: DispatchPlan<TApplied>,
  ): Promise<TApplied | undefined> {
    let resolved: ResolvedHooks
    try {
      resolved = await this.options.resolver.resolve(call.cwd)
    } catch (error) {
      this.options.warn(`hook dispatch failed: ${messageOf(error)}`)
      return undefined
    }
    this.options.onResolve?.(call.session, resolved.directories)
    if (resolved.layers.length === 0) return undefined

    const runs: HookRun[] = []
    handlers: for (const layer of resolved.layers) {
      for (const hook of layer.hooks) {
        if (hook.on !== plan.event) continue
        if (!selects(hook.match, plan.subject.match)) continue
        if (hook.run.type === 'command' && hook.run.async) {
          // Detached: never awaited, never merged, still audited and cancelled
          // on disposal.
          this.options.detached.track(this.runDetached(hook, layer.source, call, plan))
          continue
        }
        const run = this.settle(await this.run(hook, layer.source, call, plan, call.signal))
        runs.push(run)
        // An illegal action is ignored later, so it must not stop the hooks
        // behind it either: only a halt this event can apply ends the loop.
        if (run.decision?.action === 'halt' && plan.actions.includes('halt')) break handlers
      }
    }

    this.record(call.session, runs, call.continuedCount)
    const merged = mergeDecisions(allowedDecisions(runs, plan.actions, this.options.warn))
    if (merged === undefined) return undefined
    if (call.signal.aborted) return undefined
    return await plan.apply(merged)
  }

  /**
   * Run one hook with its payload and environment.
   * @param hook - the entry to run.
   * @param source - absolute path of its hooks file.
   * @param call - the dispatching event's facts.
   * @param plan - the event's plan, for its payload fields.
   * @param signal - cancels this run.
   * @returns the measured run.
   */
  private run(
    hook: Hook,
    source: string,
    call: DispatchCall,
    plan: DispatchPlan<unknown>,
    signal: AbortSignal,
  ): Promise<HookRun> {
    const facts: PayloadFacts = {
      event: plan.event,
      sessionId: call.session.header.id,
      cwd: call.cwd,
      agentId: call.agentId,
      turn: call.turn,
      step: call.step,
      source,
      hookId: hook.id,
    }
    return executeHook(hook, source, {
      shell: this.options.shell(),
      payload: commandPayload(facts, plan.subject.fields),
      env: commandEnv(facts),
      workdir: call.cwd,
      signal,
    })
  }

  /**
   * Run one detached hook and record it, without touching the event's decision.
   * @param hook - the entry to run.
   * @param source - absolute path of its hooks file.
   * @param call - the dispatching event's facts.
   * @param plan - the event's plan.
   */
  private async runDetached(
    hook: Hook,
    source: string,
    call: DispatchCall,
    plan: DispatchPlan<unknown>,
  ): Promise<void> {
    const run = await this.run(hook, source, call, plan, this.options.detached.signal)
    if (run.error !== undefined) {
      this.options.warn(`hook "${hook.id}" at ${plan.event} failed: ${run.error}`)
    }
    this.reportDetachedDecision(plan, run)
    // The event never sees this decision; the record still says what the run
    // produced, which is the only trace a detached outcome leaves.
    this.record(call.session, [run], call.continuedCount)
  }

  /**
   * Warn when a detached run produced something the event cannot apply.
   *
   * An observe-only event has no decision to merge, so a script that still
   * writes an outcome is reporting a misunderstanding; the same is true of an
   * action the event does not list. The run itself is kept: its side effect and
   * its audit row are the observable trace, and the warning is the only way a
   * hook author learns the outcome went nowhere.
   * @param plan - the event's plan.
   * @param run - the detached run that settled.
   */
  private reportDetachedDecision(plan: DispatchPlan<unknown>, run: HookRun): void {
    const decision = run.decision
    if (decision === undefined) return
    const action = decision.action
    if (plan.actions.length === 0) {
      const reported = action === undefined ? 'an outcome' : `action "${action}"`
      this.options.warn(
        `hook "${run.hook.id}" at ${plan.event} reported ${reported}, but ${plan.event} only observes; ignored`,
      )
      return
    }
    if (action !== undefined && !plan.actions.includes(action)) {
      this.options.warn(
        `hook "${run.hook.id}" at ${plan.event} reported action "${action}", which ${plan.event} does not support; ignored`,
      )
    }
  }

  /**
   * Apply an entry's failure policy to one run.
   * @param run - the run that may have failed.
   * @returns the run, with a synthesized decision when it asked to block.
   */
  private settle(run: HookRun): HookRun {
    if (run.error === undefined) return run
    this.options.warn(`hook "${run.hook.id}" at ${run.event} failed: ${run.error}`)
    if (run.hook.onFailure !== 'block') return run
    const decision = failureDecision(run.event, run.hook.id, run.error)
    return decision === undefined ? run : { ...run, decision }
  }

  /**
   * Append one audit record per run, if auditing is on.
   * @param session - the Session the runs belong to.
   * @param runs - the runs to record, in configuration order.
   * @param continuedCount - the event's consecutive-continue count, when it has one.
   */
  private record(session: Session, runs: readonly HookRun[], continuedCount?: number): void {
    if (!this.options.audit) return
    for (const run of runs) {
      try {
        recordHookRun(session, run, continuedCount)
      } catch (error) {
        this.options.warn(`hook run for "${run.hook.id}" was not recorded: ${messageOf(error)}`)
      }
    }
  }
}

/**
 * Whether one entry selects this event's subject.
 *
 * Selection is per event: a `match.prompt: true` on `step.start` selects only a
 * step that carries a user prompt, while an event with no match dimensions
 * selects only entries with no clause at all. The loader has already rejected
 * a dimension the event does not offer, so each branch only consults its own.
 * @param match - the entry's compiled clause; `undefined` selects everything.
 * @param subject - the event's match facts.
 * @returns true when the entry applies.
 */
function selects(match: HookMatch | undefined, subject: MatchSubject): boolean {
  if (match === undefined) return true
  switch (subject.kind) {
    case 'none':
      return match.tool === undefined && match.args === undefined && match.prompt === undefined
    case 'tool':
      if (match.prompt !== undefined) return false
      return matchesHook(match, subject.tool, subject.args)
    case 'prompt':
      if (match.tool !== undefined || match.args !== undefined) return false
      return match.prompt === undefined || match.prompt === (subject.prompt !== null)
  }
}

/**
 * Render one caught value for a warning line.
 * @param error - anything thrown.
 * @returns a single-line description.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
