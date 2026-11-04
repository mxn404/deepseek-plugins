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
 * dispatches `tool.pre` and `tool.post`.
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
 * The lifecycle points this build actually dispatches. A later ticket widens
 * this union; `.dsh/hooks.json` still names the full vocabulary.
 */
export type SupportedHookEvent = Extract<HookEvent, 'tool.pre' | 'tool.post'>

/** Handler kinds the `.dsh/hooks.json` vocabulary names. */
export type HookHandlerKind = 'builtin' | 'command' | 'module'

/**
 * Actions the `.dsh/hooks.json` vocabulary names. This build executes `deny`,
 * `block`, `replace`, and `halt`; `context` is the outcome field every event
 * shares, and a builtin `inject` contributes one context line.
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

/**
 * Whether a failing hook lets the event through (`open`, the default) or turns
 * its failure into the event's blocking outcome (`block`).
 */
export type HookFailurePolicy = 'open' | 'block'

/**
 * A one-line builtin decision, applied without running anything.
 *
 * The spec's builtin vocabulary is `{action, reason?, text?}`: a blocking
 * action carries a `reason`, `inject` carries the reminder `text`, and
 * `replace` carries the model-visible `text` that replaces the tool result.
 * The event's own load gate decides which of them an entry may name.
 */
export type BuiltinRun =
  | {
      readonly type: 'builtin'
      readonly action: 'deny' | 'block'
      /** Model-facing reason; never empty. */
      readonly reason: string
    }
  | {
      readonly type: 'builtin'
      readonly action: 'replace'
      /** Model-visible replacement for the tool result's content. */
      readonly text: string
    }
  | {
      readonly type: 'builtin'
      readonly action: 'inject'
      /** One reminder line, folded into the event's context message. */
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
  readonly on: HookEvent
  /** Which calls it selects; `undefined` selects every call at that point. */
  readonly match: HookMatch | undefined
  /** What it does when it matches. */
  readonly run: HookHandler
  /** Per-entry timeout, resolved from the entry or the row's `defaultTimeoutMs`. */
  readonly timeoutMs: number
  /** Failure policy, applied by the handler kinds that can fail. */
  readonly onFailure: HookFailurePolicy
}
