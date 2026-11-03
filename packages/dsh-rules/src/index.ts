/**
 * Host half of `dsh-rules`.
 *
 * Rules are markdown files under `.dsh/rules/` (configurable roots). Always-on
 * rules (no `paths` frontmatter) enter the first model request together with an
 * index of path-scoped rules. A successful `read` / `write` / `edit` result, or
 * a conservative single-file shell read, on a matching file queues that rule's
 * body for the next step. After a session compaction, previously injected rules
 * are replayed once on the next step. Everything reaches the model as one
 * user-role `<system-reminder>` message per step, deduplicated per agent by rule
 * identity and content version.
 *
 * @module dsh-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import { Config, resolveConfig, type Config as RulesConfig, type ResolvedConfig } from './config.ts'
import { RuleWorkspace } from './discover.ts'
import { matchRules, ruleRelativePath, type Rule } from './rule.ts'
import { hasIndexEntries, renderReminder, renderRuleIndex, type TriggeredRule } from './render.ts'
import { parseSingleFileReadCommand } from './shell.ts'

/** Plugin id: package name and bundle row id. */
export const name = 'dsh-rules'

/** Services this plugin needs before `apply` runs. */
export const inject = ['agents', 'workingDirectory']

export { Config }
export type { Config as RulesConfig }

/** Producer source carried by every injected rules message. */
export interface RulesMessageSource {
  kind: 'dsh-rules'
  form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-rules': RulesMessageSource
  }
}

const FILE_TOUCH_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit'])

interface AgentRulesState {
  workspace: RuleWorkspace
  startupDelivered: boolean
  seen: Map<string, string>
  touched: Set<string>
  /** A compaction happened; the next step replays everything already injected. */
  replayPending: boolean
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
 * Absolute path a successful bash call provably read, when it is one
 * conservative single-file read.
 *
 * Relative command paths resolve against the call's `workdir` (itself resolved
 * against the session directory), mirroring the bash tool's own rule.
 * @param exec - the completed tool execution.
 * @param sessionCwd - the agent's current directory.
 * @returns the absolute read path, or `undefined` when the command is not a
 * provable single-file read.
 */
function bashReadPath(exec: Readonly<ToolExecution>, sessionCwd: string): string | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  if (typeof record.command !== 'string') return undefined
  const read = parseSingleFileReadCommand(record.command)
  if (read === undefined) return undefined
  const rawWorkdir = record.workdir
  const workdir = typeof rawWorkdir === 'string' && rawWorkdir.trim().length > 0
    ? rawWorkdir.trim()
    : undefined
  const base = workdir === undefined
    ? sessionCwd
    : isAbsolute(workdir) ? resolve(workdir) : resolve(sessionCwd, workdir)
  return isAbsolute(read.path) ? resolve(read.path) : resolve(base, read.path)
}

/**
 * Absolute paths that selected one rule out of the touched batch.
 * @param rule - matched rule.
 * @param touched - raw touched paths.
 * @param cwd - directory relative paths resolve against.
 * @returns sorted absolute triggering paths.
 */
function triggeringPaths(rule: Rule, touched: readonly string[], cwd: string): string[] {
  const hits = new Set<string>()
  for (const path of touched) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
    const rel = ruleRelativePath(rule.baseDir, absolute)
    if (rel !== undefined && rule.matchers.some(matcher => matcher.test(rel))) hits.add(absolute)
  }
  return [...hits].sort()
}

/**
 * Mount the host half.
 * @param ctx - host context.
 * @param config - validated row config.
 */
export function apply(ctx: Context, config: RulesConfig): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const states = new WeakMap<Agent, AgentRulesState>()

  const stateFor = (agent: Agent): AgentRulesState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: AgentRulesState = {
      workspace: new RuleWorkspace({
        roots: resolved.roots,
        maxBytes: resolved.maxBytes,
        onInvalidRule: (rule) => {
          ctx.logger.warn(`dsh-rules: rule ${rule.absolutePath} was not loaded: ${rule.reason}`)
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
    // Only root executions own the model-visible action; PTC sub-dispatches
    // inherit their transport execution's outcome and add no separate trigger.
    if (exec.parent !== undefined) return
    const agent = exec.agent
    const filePath = filePathFromExecution(exec)
    if (filePath !== undefined) {
      stateFor(agent).touched.add(filePath)
      return
    }
    if (!resolved.includeBashReads || exec.name !== 'bash') return
    const readPath = bashReadPath(exec, ctx.workingDirectory.get(agent.session))
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
    const hasTouches = state !== undefined && state.touched.size > 0
    const replayPending = state?.replayPending === true
    if (state?.startupDelivered === true && !hasTouches && !replayPending) return decision
    // Keep the context pending across a no-step turn instead of turning it into
    // a standalone request of its own.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
    signal.throwIfAborted()
    const active = state ?? stateFor(agent)
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    signal.throwIfAborted()
    const snapshot = await active.workspace.snapshot(cwd)
    signal.throwIfAborted()
    const startupPending = !active.startupDelivered
    let indexText: string | undefined
    const alwaysOn: Rule[] = []
    if (startupPending) {
      alwaysOn.push(...snapshot.rules.filter(rule => rule.status === 'ok' && rule.paths.length === 0))
      indexText = renderRuleIndex(snapshot.rules, resolved.indexMaxBytes)
      if (indexText === undefined && hasIndexEntries(snapshot.rules)) {
        ctx.logger.warn(
          `dsh-rules: rule index for ${snapshot.projectRoot} exceeds indexMaxBytes ${resolved.indexMaxBytes}; `
          + 'the index was not injected',
        )
      }
    }
    // Replay re-reads the current snapshot: a deleted or now-invalid rule is
    // skipped, and a changed rule enters in its new version.
    const replayed: Rule[] = []
    if (active.replayPending) {
      for (const rule of snapshot.rules) {
        if (rule.status === 'ok' && active.seen.has(rule.absolutePath)) replayed.push(rule)
      }
    }
    const replayedPaths = new Set(replayed.map(rule => rule.absolutePath))
    const triggered: TriggeredRule[] = []
    if (hasTouches) {
      const touched = [...active.touched]
      for (const rule of matchRules(snapshot.rules, touched, cwd)) {
        if (replayedPaths.has(rule.absolutePath)) continue
        if (active.seen.get(rule.absolutePath) === rule.version) continue
        triggered.push({ rule, triggeredBy: triggeringPaths(rule, touched, cwd) })
      }
    }
    const text = renderReminder({ alwaysOn, index: indexText, triggered, replayed }, snapshot.projectRoot)
    if (hasTouches) active.touched.clear()
    active.replayPending = false
    if (text === undefined) {
      // Nothing to deliver: a failed index is reported once above, and an
      // otherwise empty startup must not be retried on every later step.
      if (startupPending) active.startupDelivered = true
      return decision
    }
    const desired = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-rules', form: 'instructions' },
    })
    // Fold the message right after the claimed batch, before the driver-appended
    // runtime context: the direct prompt precedes the injected convention.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    if (startupPending) {
      active.startupDelivered = true
      for (const rule of alwaysOn) active.seen.set(rule.absolutePath, rule.version)
    }
    for (const entry of triggered) active.seen.set(entry.rule.absolutePath, entry.rule.version)
    // Re-marking the replay as seen keeps the next trigger from repeating it.
    for (const rule of replayed) active.seen.set(rule.absolutePath, rule.version)
    return { ...decision, messages: entered }
  })
}
