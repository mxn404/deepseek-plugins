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
 * dispatches `tool.pre` only.
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

/** Handler kinds the `.dsh/hooks.json` vocabulary names. */
export type HookHandlerKind = 'builtin' | 'command' | 'module'

/** Actions the `.dsh/hooks.json` vocabulary names. This build executes `deny`. */
export type HookAction = 'deny' | 'ask' | 'block' | 'continue' | 'halt' | 'inject'

/**
 * Whether a failing hook lets the event through (`open`, the default) or turns
 * its failure into the event's blocking outcome (`block`).
 */
export type HookFailurePolicy = 'open' | 'block'

/** The one handler this build executes: a one-line builtin decision. */
export interface BuiltinDenyRun {
  readonly type: 'builtin'
  readonly action: 'deny'
  /** Model-facing reason; never empty. */
  readonly reason: string
}

/** One validated hook entry. */
export interface Hook {
  /** Entry identity, unique within its file by convention and logged with every run. */
  readonly id: string
  /** Lifecycle point; `tool.pre` for every entry this build keeps. */
  readonly on: HookEvent
  /** Which calls it selects; `undefined` selects every call at that point. */
  readonly match: HookMatch | undefined
  /** What it does when it matches. */
  readonly run: BuiltinDenyRun
  /** Per-entry timeout, resolved from the entry or the row's `defaultTimeoutMs`. */
  readonly timeoutMs: number
  /** Failure policy, applied by the handler kinds that can fail. */
  readonly onFailure: HookFailurePolicy
}
