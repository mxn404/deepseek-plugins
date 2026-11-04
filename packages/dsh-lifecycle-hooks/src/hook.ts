/**
 * The validated shape of one hook entry.
 *
 * A hook entry is the unit a `.dsh/hooks.json` file lists: an id, the lifecycle
 * point it runs at, the calls it selects, and what it does. Only the pieces
 * this build can execute are represented here; entries naming a lifecycle
 * point, handler kind, or action that a later ticket introduces are skipped at
 * load time with a warning instead of being half-honoured.
 *
 * @module dsh-lifecycle-hooks/hook
 */

import type { HookMatch } from './match.ts'

/**
 * Lifecycle points the `.dsh/hooks.json` vocabulary names. This build
 * dispatches the ones listed in {@link DispatchedHookEvent}.
 */
export type HookEvent =
  | 'session.start'
  | 'step.start'
  | 'tool.pre'
  | 'tool.post'
  | 'tool.result'
  | 'turn.stop'
  | 'session.end'
  | 'notification'

/**
 * Lifecycle points this build dispatches. A later ticket adds its event here
 * and to {@link EVENT_ACTIONS}; the loader derives its supported set from that
 * table, so an entry for any other named event is skipped with one warning.
 */
export type DispatchedHookEvent = 'session.start' | 'step.start' | 'tool.pre' | 'tool.post'

/**
 * Actions each dispatched event applies. This is the single authority the
 * loader validates against and the dispatch plans read from, so an entry can
 * never carry an action its event would silently ignore:
 *
 * - `session.start` only adds context — it fires before a turn exists, so it
 *   has nothing to deny, halt, or ask about.
 * - `step.start` denies the proposed step, adds context to it, or halts the
 *   turn.
 * - `tool.pre` denies the call, adds context for the next request, or halts
 *   the turn.
 * - `tool.post` blocks the result, replaces the model-visible content, adds
 *   context for the next request, or halts the turn.
 */
export const EVENT_ACTIONS: Readonly<Record<DispatchedHookEvent, readonly HookAction[]>> = {
  'session.start': ['context'],
  'step.start': ['deny', 'context', 'halt'],
  'tool.pre': ['deny', 'context', 'halt'],
  'tool.post': ['block', 'replace', 'context', 'halt'],
}

/** Handler kinds the `.dsh/hooks.json` vocabulary names. */
export type HookHandlerKind = 'builtin' | 'command' | 'module'

/**
 * Actions the `.dsh/hooks.json` vocabulary names. This build executes `deny`,
 * `block`, `replace`, `context`, and `halt`; `continue` arrives with a later
 * ticket, and `inject` is the builtin spelling of one context line.
 */
export type HookAction =
  | 'deny'
  | 'ask'
  | 'block'
  | 'continue'
  | 'halt'
  | 'context'
  | 'inject'
  | 'replace'

/** Actions a `builtin` handler can decide without running anything. */
export type BuiltinAction = Extract<
  HookAction,
  'deny' | 'block' | 'replace' | 'inject' | 'context' | 'halt'
>

/**
 * Whether a failing hook lets the event through (`open`, the default) or turns
 * its failure into the event's blocking outcome (`block`).
 */
export type HookFailurePolicy = 'open' | 'block'

/**
 * A one-line builtin decision, applied without running anything.
 *
 * The spec's builtin vocabulary is `{action, reason?, text?}`: a blocking
 * action carries a `reason`, `context` and `inject` carry the reminder `text`,
 * and `replace` carries the model-visible `text` that replaces the tool
 * result. The event's own load gate decides which of them an entry may name.
 */
export type BuiltinRun =
  | {
      readonly type: 'builtin'
      readonly action: Extract<BuiltinAction, 'deny' | 'block' | 'halt'>
      /** Model-facing reason; the loader defaults it, so never empty. */
      readonly reason: string
    }
  | {
      readonly type: 'builtin'
      readonly action: Extract<BuiltinAction, 'replace' | 'inject' | 'context'>
      /** Reminder line (`context`, `inject`) or replacement text (`replace`). */
      readonly text: string
    }

/**
 * A command handler: a process run through `ctx.shell` for every matching
 * event, with the event payload on stdin and `DSH_HOOK_*` facts in its
 * environment.
 */
export interface CommandRun {
  readonly type: 'command'
  /** Shell command line, executed in the Session's current directory. */
  readonly command: string
  /**
   * Detached run: it never contributes to the event's decision, so the event
   * does not wait for it. Its side effect and its audit row still happen; the
   * plugin aborts it on disposal if it is still running.
   */
  readonly async: boolean
}

/** What a matching hook does, discriminated by its handler kind. */
export type HookHandler = BuiltinRun | CommandRun

/** One hook run's contribution to its event's decision. */
export interface HookDecision {
  /**
   * What the hook asks the event to do. Absent when the hook only adds
   * context; an action the event does not support is warned about and ignored.
   */
  readonly action?: HookAction
  /** Model-facing reason for the action, when the action has one. */
  readonly reason?: string
  /** Reminder lines for the model, concatenated across hooks in configuration order. */
  readonly context?: readonly string[]
  /**
   * Replacement for the tool result's model-visible content. Only
   * `tool.post` consumes it, and never for the canonical `value`.
   */
  readonly replace?: { readonly text: string }
}

/** One validated hook entry. */
export interface Hook {
  /** Entry identity, unique within its file by convention and logged with every run. */
  readonly id: string
  /** Lifecycle point; one of the events this build dispatches. */
  readonly on: DispatchedHookEvent
  /** Which calls or steps it selects; `undefined` selects everything at that point. */
  readonly match: HookMatch | undefined
  /** What it does when it matches. */
  readonly run: HookHandler
  /** Per-entry timeout, resolved from the entry or the row's `defaultTimeoutMs`. */
  readonly timeoutMs: number
  /** Failure policy, applied by the handler kinds that can fail. */
  readonly onFailure: HookFailurePolicy
}
