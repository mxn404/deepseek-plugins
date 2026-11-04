/**
 * The `command` handler: one process per matching event, run through
 * `ctx.shell`.
 *
 * The process contract is deliberately small, so a hook can be written in any
 * language:
 *
 * - stdin carries one JSON payload (the event's facts);
 * - the environment carries the same facts a script needs to locate itself
 *   (`DSH_HOOK_*`, see `payload.ts`);
 * - stdout carries at most one JSON outcome object, the spec's document:
 *   `{action?, reason?, context?, replace?}`;
 * - a clean exit (0) with empty stdout means "no action"; a non-zero exit, a
 *   malformed outcome, or a timeout is a failure, which the dispatcher turns
 *   into the entry's `onFailure` policy.
 *
 * `replace` is `{text}` only. The canonical `value` of a tool result is never
 * replaceable from here: it is execution-local, schema-checked JSON, and the
 * model only ever reads the rendered content, so naming it is a protocol
 * error rather than a silent no-op.
 *
 * `ctx.shell` owns the timeout, the process-group kill, the credential scrub,
 * and the output caps; this module never spawns directly.
 *
 * The outcome vocabulary is validated by {@link decodeDecision}, which the
 * `module` handler shares: a module's return value is the same document a
 * script writes to stdout, validated once.
 *
 * @module dsh-lifecycle-hooks/command
 */

import type { ShellExecution, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { HookAction, HookDecision } from './hook.ts'
import { isRecord } from './match.ts'

/** Actions the `.dsh/hooks.json` outcome vocabulary knows. */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set<HookAction>([
  'deny',
  'ask',
  'block',
  'continue',
  'halt',
  'context',
  'inject',
  'replace',
])

/** How much of a failure's stderr the log line keeps. */
const STDERR_EXCERPT_CHARS = 300

/** The decoded stdout of one command run. */
export interface CommandDecode {
  /** The outcome the script reported, or `undefined` for empty output. */
  readonly decision: HookDecision | undefined
  /** Why the stdout did not honour the protocol, or `undefined` when it did. */
  readonly error: string | undefined
}

/** Everything one command run needs. */
export interface CommandOptions {
  /** The host shell service, or `undefined` when this deployment has none. */
  readonly shell: Pick<ShellExecutor, 'resolve' | 'execute'> | undefined
  /** Shell command line, as written in the hooks file. */
  readonly command: string
  /** Payload serialized onto the process's stdin. */
  readonly payload: unknown
  /** `DSH_HOOK_*` facts handed to the process. */
  readonly env: Record<string, string>
  /** Session working directory the command runs in. */
  readonly workdir: string
  /** Per-entry timeout; the shell executor kills the process group at expiry. */
  readonly timeoutMs: number
  /** Cancels the run when the event itself is abandoned. */
  readonly signal: AbortSignal
}

/** What one command run produced. */
export interface CommandResult {
  /** The outcome the script reported, if any. */
  readonly decision: HookDecision | undefined
  /** Process exit code; absent when the process never produced one. */
  readonly exitCode: number | undefined
  /** Why the run failed, if it did; a failed run contributes no decision. */
  readonly error: string | undefined
}

/**
 * Decode one command's stdout into an outcome.
 *
 * Total: a malformed document becomes a failure description, never a throw.
 * @param stdout - the process's captured standard output.
 * @returns the decoded decision plus any protocol error.
 */
export function decodeOutcome(stdout: string): CommandDecode {
  const text = stdout.trim()
  if (text.length === 0) return { decision: undefined, error: undefined }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { decision: undefined, error: `stdout is not a single JSON outcome: ${messageOf(error)}` }
  }
  return decodeDecision(raw)
}

/**
 * Validate one outcome value.
 *
 * Both handler kinds speak the same document — a command through its stdout and
 * a module through its return value — so the validation lives here once.
 * @param raw - the parsed value.
 * @param subject - what produced it, for the failure message (`stdout`, `module result`).
 * @returns the decoded decision plus any protocol error.
 */
export function decodeDecision(raw: unknown, subject = 'stdout'): CommandDecode {
  if (!isRecord(raw)) return { decision: undefined, error: `${subject} must be a JSON object` }

  let action: HookAction | undefined
  if (raw.action !== undefined) {
    if (typeof raw.action !== 'string') return protocolError('"action" must be a string')
    if (!KNOWN_ACTIONS.has(raw.action)) return protocolError(`unknown action ${JSON.stringify(raw.action)}`)
    action = raw.action as HookAction
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') {
    return protocolError('"reason" must be a string')
  }
  let context: readonly string[] | undefined
  if (raw.context !== undefined) {
    if (!Array.isArray(raw.context)) return protocolError('"context" must be an array')
    if (!raw.context.every((entry): entry is string => typeof entry === 'string')) {
      return protocolError('"context" entries must be strings')
    }
    context = raw.context
  }
  const replace = decodeReplace(raw.replace)
  if ('error' in replace) return protocolError(replace.error)
  if (action === 'replace' && replace.replace === undefined) {
    return protocolError('"action":"replace" needs a "replace" object with the replacement text')
  }

  const decision: HookDecision = {
    // A bare `{replace:{text}}` is the spec's replace outcome; the action is
    // derived so the audit row and the merge rank it like any other action.
    ...action === undefined && replace.replace === undefined
      ? {}
      : { action: action ?? 'replace' },
    ...raw.reason === undefined ? {} : { reason: raw.reason as string },
    ...context === undefined ? {} : { context },
    ...replace.replace === undefined ? {} : { replace: replace.replace },
  }
  const decided = decision.action !== undefined || decision.context !== undefined
  return { decision: decided ? decision : undefined, error: undefined }
}

/**
 * Run one command hook and decode its outcome.
 *
 * Never throws: an unavailable shell service, an infrastructure rejection, a
 * timeout, and a non-zero exit all come back as a failed {@link CommandResult},
 * which the dispatcher records and applies the entry's failure policy to.
 * @param options - the command, its input, and its execution facts.
 * @returns the run's decision, exit code, and failure detail.
 */
export async function runCommand(options: CommandOptions): Promise<CommandResult> {
  const shell = options.shell
  if (shell === undefined) return failed(undefined, 'the shell service is not available')

  let handle: ShellExecution
  try {
    handle = await shell.execute(shell.resolve({
      command: options.command,
      workdir: options.workdir,
      timeoutMs: options.timeoutMs,
      // One JSON document, newline-terminated: a script reading stdin to its
      // end (the common shape) sees the newline, a JSON parser ignores it.
      stdin: `${JSON.stringify(options.payload)}\n`,
      env: options.env,
      signal: options.signal,
    }))
  } catch (error) {
    return failed(undefined, `the command could not be started: ${messageOf(error)}`)
  }

  let result: ShellRunResult
  try {
    result = await handle.result()
  } catch (error) {
    return failed(undefined, `the command failed to run: ${messageOf(error)}`)
  }

  const exitCode = result.exitCode ?? undefined
  if (result.timedOut) {
    return failed(exitCode, `timed out after ${String(options.timeoutMs)} ms`)
  }
  if (result.aborted) return failed(exitCode, 'was cancelled before it finished')
  if (exitCode !== 0) {
    const status = exitCode === undefined ? 'was killed by a signal' : `exited with code ${String(exitCode)}`
    return failed(exitCode, `${status}${excerpt(result.stderr.text)}`)
  }

  const decoded = decodeOutcome(result.stdout.text)
  return { decision: decoded.decision, exitCode, error: decoded.error }
}

/** Decoded `replace` field: the replacement, no replacement written, or a protocol error. */
type ReplaceDecode =
  | { readonly replace: { readonly text: string } | undefined }
  | { readonly error: string }

/**
 * Decode the optional `replace` field.
 *
 * Only the model-visible text is replaceable, so a `value` key is rejected
 * outright instead of being ignored: a hook that tries to rewrite canonical
 * tool output must learn that the host cannot re-validate it here.
 * @param raw - the outcome's `replace` value.
 * @returns the replacement text, absence, or the reason to fail the run.
 */
function decodeReplace(raw: unknown): ReplaceDecode {
  if (raw === undefined) return { replace: undefined }
  if (!isRecord(raw)) return { error: '"replace" must be an object' }
  if (Object.hasOwn(raw, 'value')) {
    return {
      error: '"replace" cannot replace "value": only the model-visible "text" is replaceable',
    }
  }
  if (typeof raw.text !== 'string') return { error: '"replace.text" must be a string' }
  return { replace: { text: raw.text } }
}

/**
 * Describe one protocol violation.
 * @param message - what the stdout got wrong.
 * @returns the failure shape {@link decodeOutcome} answers with.
 */
function protocolError(message: string): CommandDecode {
  return { decision: undefined, error: message }
}

/**
 * Build a failed run result.
 * @param exitCode - the exit code that was observed, when there was one.
 * @param error - the failure detail recorded on the audit row and logged.
 * @returns the failed result.
 */
function failed(exitCode: number | undefined, error: string): CommandResult {
  return { decision: undefined, exitCode, error }
}

/**
 * Keep a failure's stderr short enough for one log line and one audit record.
 * @param stderr - the captured standard error.
 * @returns `: <excerpt>`, or the empty string when stderr is blank.
 */
function excerpt(stderr: string): string {
  const text = stderr.trim()
  if (text.length === 0) return ''
  const clipped = text.length > STDERR_EXCERPT_CHARS ? `${text.slice(0, STDERR_EXCERPT_CHARS)}…` : text
  return `: ${clipped}`
}

/**
 * Render one caught value for a failure message.
 * @param error - anything thrown.
 * @returns a single-line description.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
