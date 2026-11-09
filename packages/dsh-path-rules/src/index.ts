/**
 * Host half of `dsh-path-rules`.
 *
 * Rules are markdown files under `.dsh/rules/` (configurable roots). Always-on
 * rules (no `paths` frontmatter) enter the first model request together with an
 * index of path-scoped rules; after that, an always-on rule whose file changed
 * (or a newly created one) is re-injected on the next injection. A successful
 * `read` / `write` / `edit` result, or a conservative single-file shell read on
 * a matching file, queues that rule's body for the next step. Both shell tools
 * count: `bash` on POSIX and `pwsh` on Windows dispatch to their own
 * conservative parser. Nested PTC executions count as touches too: a `read`
 * inside `run_code` is a real successful tool call on the same agent, so it is
 * recorded like a model-direct call. After a session compaction, previously
 * injected rules are replayed once on the next step. Everything reaches the
 * model as one user-role `<system-reminder>` message per step, deduplicated per
 * agent by rule identity and content version.
 *
 * @module dsh-path-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, type Config as RulesConfig, type ResolvedConfig } from './config.ts'
import { RuleWorkspace, type RuleSnapshot, type SnapshotRefresh } from './discover.ts'
import { matchRules, type Rule, type RuleMatch } from './rule.ts'
import { hasIndexEntries, renderReminder, renderRuleIndex } from './render.ts'
import { shellReadPath } from './shell-tools.ts'

/** Plugin id: package name and bundle row id. */
export const name = 'dsh-path-rules'

/** Services this plugin needs before `apply` runs. */
export const inject = ['agents', 'workingDirectory']

export { Config }
export type { Config as RulesConfig }

/** Producer source carried by every injected rules message. */
export interface RulesMessageSource {
  kind: 'dsh-path-rules'
  form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-path-rules': RulesMessageSource
  }
}

const FILE_TOUCH_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit'])

/** Nothing has been delivered yet: the first injection owes every always-on rule. */
const NOTHING_SEEN: ReadonlyMap<string, string> = new Map()

/**
 * Per-agent bookkeeping for injection, dedupe, and replay.
 *
 * Rule content, discovery, and stat caching live in {@link RuleWorkspace}; this
 * state only records what this agent has already received.
 */
interface AgentRulesState {
  /** Stat-validated rule cache and discovery for this agent. */
  workspace: RuleWorkspace
  /** The session-start injection (always-on bodies plus the index) has happened. */
  startupDelivered: boolean
  /** Rule identity key → content version already injected for this agent. */
  seen: Map<string, string>
  /** Paths touched by successful tools since the last injection. */
  touched: Set<string>
  /** A compaction happened; the next step replays everything already injected. */
  replayPending: boolean
}

/** Everything one injection message can carry, after per-agent dedupe. */
interface InjectionPlan {
  /** Always-on rules to render: every one at startup, only changed ones later. */
  readonly alwaysOn: Rule[]
  /** Session-start index text, when startup delivers it. */
  readonly index: string | undefined
  /** Path-scoped rules selected by this step's touches. */
  readonly triggered: RuleMatch[]
  /** Rules restated because the conversation was compacted. */
  readonly replayed: Rule[]
}

function filePathFromExecution(exec: Readonly<ToolExecution>): string | undefined {
  if (!FILE_TOUCH_TOOLS.has(exec.name)) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>).file_path
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Always-on rules that still owe this agent a body: pathless, usable, and never
 * injected at their current content version. Startup passes {@link NOTHING_SEEN}
 * so every always-on rule is delivered once; later injections pass the seen map
 * so only changed or newly created rules come back.
 * @param rules - the current snapshot, in deterministic order.
 * @param seen - rule identity key → version already injected.
 * @returns always-on rules to render in this injection.
 */
function alwaysOnToInject(rules: readonly Rule[], seen: ReadonlyMap<string, string>): Rule[] {
  return rules.filter(rule =>
    rule.status === 'ok'
    && rule.paths.length === 0
    && seen.get(rule.identityKey) !== rule.version)
}

/**
 * Rules restated after a compaction: everything this agent already injected
 * that is still usable, minus anything the always-on section already carries.
 * @param rules - the current snapshot, in deterministic order.
 * @param seen - rule identity key → version already injected.
 * @param delivered - identity keys already rendered in this message's always-on section.
 * @returns rules for the replay section.
 */
function replayToInject(
  rules: readonly Rule[],
  seen: ReadonlyMap<string, string>,
  delivered: ReadonlySet<string>,
): Rule[] {
  return rules.filter(rule =>
    rule.status === 'ok' && seen.has(rule.identityKey) && !delivered.has(rule.identityKey))
}

/**
 * Triggered rules this agent has not received at their current version, minus
 * anything the replay section already restates.
 * @param matches - pure match results for this step's touches.
 * @param seen - rule identity key → version already injected.
 * @param excluded - identity keys rendered by another section of this same message.
 * @returns triggered rules for the triggered section.
 */
function triggersToInject(
  matches: readonly RuleMatch[],
  seen: ReadonlyMap<string, string>,
  excluded: ReadonlySet<string>,
): RuleMatch[] {
  return matches.filter(match =>
    seen.get(match.rule.identityKey) !== match.rule.version
    && !excluded.has(match.rule.identityKey))
}

/**
 * Build one step's injection plan from the current snapshot.
 * @param state - the agent's bookkeeping.
 * @param snapshot - the rules discovered for this step.
 * @param cwd - directory relative touched paths resolve against.
 * @param startupPending - whether this is the first injection of the session.
 * @param indexBudget - `indexMaxBytes` for the session-start index.
 * @returns the deduplicated plan; empty sections are not rendered.
 */
function planInjection(
  state: AgentRulesState,
  snapshot: RuleSnapshot,
  cwd: string,
  startupPending: boolean,
  indexBudget: number,
): InjectionPlan {
  const alwaysOn = alwaysOnToInject(snapshot.rules, startupPending ? NOTHING_SEEN : state.seen)
  const delivered = new Set(alwaysOn.map(rule => rule.identityKey))
  const replayed = state.replayPending ? replayToInject(snapshot.rules, state.seen, delivered) : []
  const replayedPaths = new Set(replayed.map(rule => rule.identityKey))
  const triggered = state.touched.size === 0
    ? []
    : triggersToInject(matchRules(snapshot.rules, [...state.touched], cwd), state.seen, replayedPaths)
  return {
    alwaysOn,
    index: startupPending ? renderRuleIndex(snapshot.rules, indexBudget) : undefined,
    triggered,
    replayed,
  }
}

/**
 * Choose the discovery refresh for this step: a full scan while startup is
 * pending, the already-injected rules while a replay is pending, and otherwise
 * only the touched candidates. Replayed rules are named by identity key, the
 * same value the seen map stores.
 * @param state - the agent's bookkeeping.
 * @param startupPending - whether this is the first injection of the session.
 * @returns the snapshot request.
 */
function snapshotRequest(state: AgentRulesState, startupPending: boolean): SnapshotRefresh {
  if (startupPending) return { refresh: 'full' }
  if (state.replayPending) {
    return { refresh: 'replay', touchedPaths: [...state.touched], replayedPaths: [...state.seen.keys()] }
  }
  return { refresh: 'candidates', touchedPaths: [...state.touched] }
}

/**
 * Report a dropped index once per startup.
 * @param ctx - host context for the log.
 * @param snapshot - rules the index was built from.
 * @param index - rendered index text, when it fit.
 * @param budget - `indexMaxBytes`.
 */
function warnIfIndexOverflow(
  ctx: Context,
  snapshot: RuleSnapshot,
  index: string | undefined,
  budget: number,
): void {
  if (index !== undefined || !hasIndexEntries(snapshot.rules)) return
  ctx.logger.warn(
    `dsh-path-rules: rule index for ${snapshot.projectRoot} exceeds indexMaxBytes ${budget}; `
    + 'the index was not injected',
  )
}

/**
 * Fold the reminder right after the claimed batch, before the driver-appended
 * runtime context: the direct prompt precedes the injected convention.
 * @param decision - the step decision to extend.
 * @param messages - the batch this step claimed.
 * @param text - rendered reminder body.
 * @returns a decision carrying the reminder message.
 */
function foldReminder(
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
  messages: readonly UserMessage[],
  text: string,
): PreStepDecision {
  const desired = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-path-rules', form: 'instructions' },
  })
  const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
  return { ...decision, messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired) }
}

/**
 * Whether this agent has anything to inject on this step: startup still owed,
 * paths touched since the last injection, or a replay pending.
 * @param state - the agent's bookkeeping, when it has one.
 * @returns true when the step needs a snapshot.
 */
function awaitingInjection(state: AgentRulesState | undefined): boolean {
  if (state === undefined) return true
  return !state.startupDelivered || state.touched.size > 0 || state.replayPending
}

/**
 * Mount the host half.
 * @param ctx - host context.
 * @param config - validated row config.
 */
export function apply(ctx: Context, config: RulesConfig): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  // The single host-boundary platform read: discovery and glob matching take it
  // as input, so the win32 semantics stay testable on Linux.
  const platform = process.platform
  const states = new WeakMap<Agent, AgentRulesState>()

  const stateFor = (agent: Agent): AgentRulesState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: AgentRulesState = {
      workspace: new RuleWorkspace({
        roots: resolved.roots,
        maxBytes: resolved.maxBytes,
        // Windows file systems are case-insensitive, so `paths` globs follow
        // the platform here; POSIX matching stays case-sensitive.
        caseInsensitive: platform === 'win32',
        platform,
        onInvalidRule: (rule) => {
          ctx.logger.warn(`dsh-path-rules: rule ${rule.absolutePath} was not loaded: ${rule.reason}`)
        },
      }),
      startupDelivered: false,
      seen: new Map(),
      touched: new Set(),
      replayPending: false,
    }
    states.set(agent, state)
    return state
  }

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (result.isError) return
    if (exec.agent === undefined || exec.signal.aborted) return
    // Nested PTC sub-dispatches are real successful tools too: a `read` or
    // `edit` inside `run_code` touched the same file for the same agent, so it
    // counts like a model-direct call. Both shapes converge on the same
    // per-agent touch set, which deduplicates.
    const agent = exec.agent
    const filePath = filePathFromExecution(exec)
    if (filePath !== undefined) {
      stateFor(agent).touched.add(filePath)
      return
    }
    if (!resolved.includeBashReads) return
    const readPath = shellReadPath(exec.name, exec.arguments, ctx.workingDirectory.get(agent.session))
    if (readPath !== undefined) stateFor(agent).touched.add(readPath)
  })

  // `compaction/end` is a durable SessionEvent, not a Cordis event: observe it
  // through the session's append feed and arm one replay for the owning agent.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end' || event.data.error !== undefined) return
    if (!resolved.replayAfterCompaction) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    stateFor(agent).replayPending = true
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    const state = states.get(agent)
    if (!awaitingInjection(state)) return decision
    // Keep the context pending across a no-step turn instead of turning it into
    // a standalone request of its own.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    signal.throwIfAborted()
    const active = state ?? stateFor(agent)
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    signal.throwIfAborted()
    const startupPending = !active.startupDelivered
    const snapshot = await active.workspace.snapshot(cwd, snapshotRequest(active, startupPending))
    signal.throwIfAborted()
    const plan = planInjection(active, snapshot, cwd, startupPending, resolved.indexMaxBytes)
    if (startupPending) warnIfIndexOverflow(ctx, snapshot, plan.index, resolved.indexMaxBytes)
    const text = renderReminder(plan, snapshot.projectRoot)
    active.touched.clear()
    active.replayPending = false
    if (text === undefined) {
      // Nothing to deliver: a failed index is reported once above, and an
      // otherwise empty startup must not be retried on every later step.
      if (startupPending) active.startupDelivered = true
      return decision
    }
    for (const rule of plan.alwaysOn) active.seen.set(rule.identityKey, rule.version)
    for (const entry of plan.triggered) active.seen.set(entry.rule.identityKey, entry.rule.version)
    // Re-marking the replay as seen keeps the next trigger from repeating it.
    for (const rule of plan.replayed) active.seen.set(rule.identityKey, rule.version)
    if (startupPending) active.startupDelivered = true
    return foldReminder(decision, messages, text)
  })
}
