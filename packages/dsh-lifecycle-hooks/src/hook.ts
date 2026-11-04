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
 * Lifecycle points the `.dsh/hooks.json` vocabulary names.
 *
 * Every one of them is dispatched by this build; {@link EVENT_ACTIONS} is the
 * table the loader and the dispatch plans read for each point's action set.
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
 * Actions each dispatched event applies: the dispatch authority.
 *
 * The dispatch plans read their action list from this table and the dispatcher
 * filters every handler kind against it, so an entry can never carry an action
 * its event would silently ignore. (The loader also has a builtin-specific
 * gate, `BUILTIN_ACTIONS` in `hooks-file.ts`, a subset of this table: it exists
 * only where a builtin would be a no-op, and README documents both.)
 *
 * - `session.start` only adds context — it fires before a turn exists, so it
 *   has nothing to deny, halt, or ask about.
 * - `step.start` denies the proposed step, adds context to it, or halts the
 *   turn.
 * - `tool.pre` denies the call, asks the user to confirm it, adds context for
 *   the next request, or halts the turn.
 * - `tool.post` blocks the result, replaces the model-visible content, adds
 *   context for the next request, or halts the turn.
 * - `turn.stop` continues the stopping turn for one more step; it has no
 *   blocking action at all, because halt belongs to the events that can stop
 *   work before it happens.
 * - `tool.result`, `session.end`, and `notification` are observe-only: they
 *   fire after the host has already committed the thing they report, so there
 *   is no outcome to apply. Their empty action list is what forces their
 *   command and module handlers detached and rejects their builtin entries at
 *   load time.
 */
export const EVENT_ACTIONS: Readonly<Record<HookEvent, readonly HookAction[]>> = {
  'session.start': ['context'],
  'step.start': ['deny', 'context', 'halt'],
  'tool.pre': ['deny', 'ask', 'context', 'halt'],
  'tool.post': ['block', 'replace', 'context', 'halt'],
  'tool.result': [],
  'turn.stop': ['continue'],
  'session.end': [],
  'notification': [],
}

/**
 * Whether an event only observes.
 *
 * Observe-only events report something the host has already committed and have
 * no outcome to merge, so their command and module handlers never participate
 * in the event: the loader forces them detached, and a builtin entry at one is
 * a configuration mistake it skips with a warning.
 * @param event - the lifecycle point to classify.
 * @returns true for an event whose {@link EVENT_ACTIONS} list is empty.
 */
export function isObserveOnly(event: HookEvent): boolean {
  return EVENT_ACTIONS[event].length === 0
}

/** Handler kinds the `.dsh/hooks.json` vocabulary names. */
export type HookHandlerKind = 'builtin' | 'command' | 'module'

/**
 * Actions the `.dsh/hooks.json` vocabulary names. This build executes `deny`,
 * `ask`, `block`, `replace`, `context`, `halt`, and `continue`; `inject` is the
 * builtin spelling of one context line. `ask` is legal only at `tool.pre`,
 * where the host has an approval flow to run; every other event warns about it
 * and ignores it.
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
 * Every action the outcome vocabulary names, in one place.
 *
 * The loader's unknown-action check and the command/module outcome decoder read
 * this same set, so a new action is added once and both gates learn it
 * together. Event legality stays in {@link EVENT_ACTIONS}; this is the wire
 * vocabulary, not a promise that every event supports every action.
 */
export const KNOWN_ACTIONS: ReadonlySet<string> = new Set<HookAction>([
  'deny',
  'ask',
  'block',
  'continue',
  'halt',
  'context',
  'inject',
  'replace',
])

/**
 * Whether a failing hook lets the event through (`open`, the default) or turns
 * its failure into the event's blocking outcome (`block`).
 */
export type HookFailurePolicy = 'open' | 'block'

/**
 * A one-line builtin outcome, applied without running anything.
 *
 * The spec's builtin vocabulary is `{action, reason?, text?}`: a blocking or
 * asking action carries a `reason`, `context` and `inject` carry the reminder
 * `text`, and `replace` carries the model-visible `text` that replaces the tool
 * result. The event's own load gate decides which of them an entry may name; an
 * `ask` there is a request for the host's approval flow, never an outcome.
 */
export type BuiltinRun =
  | {
      readonly type: 'builtin'
      readonly action: Extract<HookAction, 'deny' | 'ask' | 'block' | 'halt'>
      /** Model-facing reason; the loader defaults it, so never empty. */
      readonly reason: string
    }
  | {
      readonly type: 'builtin'
      readonly action: Extract<HookAction, 'replace' | 'inject' | 'context'>
      /** Reminder line (`context`, `inject`) or replacement text (`replace`). */
      readonly text: string
    }
  | {
      readonly type: 'builtin'
      readonly action: 'continue'
      /**
       * Model-facing reason, folded into the one steer message the model reads;
       * absent when the plan should supply its own fallback line.
       */
      readonly reason?: string
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
   * Detached run: it never contributes to the event's outcome, so the event
   * does not wait for it. Its side effect and its audit row still happen; the
   * plugin aborts it on disposal if it is still running.
   */
  readonly async: boolean
}

/**
 * A module handler: an in-process ESM module loaded for every matching event.
 *
 * Only JavaScript modules are supported in this build — a TypeScript file has
 * to be built before a hook can point at it — and the path is kept exactly as
 * written, because it is relative to the hooks file that names it, not to the
 * process. `module.ts` resolves it and reloads the module when its mtime moves.
 */
export interface ModuleRun {
  readonly type: 'module'
  /** Module path as written; resolved against the hooks file's directory. */
  readonly path: string
  /**
   * Detached run: it never contributes to the event's outcome, so the event
   * does not wait for it. Its side effects and its audit row still happen, and
   * its helpers stop working once the plugin is disposed.
   */
  readonly async: boolean
}

/** What a matching hook does, discriminated by its handler kind. */
export type HookHandler = BuiltinRun | CommandRun | ModuleRun

/**
 * Whether a handler kind runs detached from its event's outcome.
 * @param run - the entry's handler.
 * @returns true when the event must not wait for it.
 */
export function isDetached(run: HookHandler): boolean {
  return run.type !== 'builtin' && run.async
}

/**
 * Localized presentation of an approval question, as the host's `ask` decision
 * accepts it: English is the required fallback, every other locale is optional.
 */
export interface ApprovalDisplayReason {
  readonly en: string
  readonly [locale: string]: string
}

/** One hook run's contribution to its event's outcome. */
export interface HookOutcome {
  /**
   * What the hook asks the event to do. Absent when the hook only adds
   * context; an action the event does not support is warned about and ignored.
   */
  readonly action?: HookAction
  /** Model-facing reason for the action, when the action has one. */
  readonly reason?: string
  /**
   * Localized approval prompt copy for an `ask`; only `tool.pre` consumes it,
   * and only the command handler can currently supply it.
   */
  readonly displayReason?: ApprovalDisplayReason
  /** Reminder lines for the model, concatenated across hooks in configuration order. */
  readonly context?: readonly string[]
  /**
   * Replacement for the tool result's model-visible content. Only
   * `tool.post` consumes it, and never for the canonical `value`.
   */
  readonly replace?: { readonly text: string }
  /**
   * Free-form audit metadata the handler attached to its outcome. It is
   * carried through the merge and written to the audit record; no event plan
   * acts on it.
   */
  readonly meta?: Record<string, unknown>
}

/** One validated hook entry. */
export interface Hook {
  /** Entry identity, unique within its file by convention and logged with every run. */
  readonly id: string
  /** Lifecycle point; one of the events this build dispatches. */
  readonly on: HookEvent
  /** Which calls or steps it selects; `undefined` selects everything at that point. */
  readonly match: HookMatch | undefined
  /** What it does when it matches. */
  readonly run: HookHandler
  /** Per-entry timeout, resolved from the entry or the row's `defaultTimeoutMs`. */
  readonly timeoutMs: number
  /** Failure policy, applied by the handler kinds that can fail. */
  readonly onFailure: HookFailurePolicy
}
