/**
 * The `module` handler: one in-process ESM module per matching event.
 *
 * A hook points at a JavaScript file beside its own configuration:
 *
 * ```jsonc
 * { "run": { "type": "module", "path": ".dsh/hooks/format.mjs" } }
 * ```
 *
 * The path is resolved against the hooks file's directory, never against the
 * process's working directory, so a repository's rules travel with the file
 * that declares them. The default export is the hook:
 *
 * ```js
 * export default async ({ event, payload, agent, session, tool, result, signal, log, inject, steer, exec, handler }) => {
 *   const run = await exec('node .dsh/hooks/tidy.mjs')
 *   inject(`formatting finished with exit code ${run.exitCode}`)
 *   return { context: ['the formatter rewrote the file'] }
 * }
 * ```
 *
 * The first argument is a curated surface, not the Cordis `Context`: a hook
 * module can poke the live agent and session, run one command through the host
 * shell, and hand back an outcome, and nothing else. The plugin's services,
 * config, and event pipeline stay out of reach.
 *
 * Two containment rules keep a module from hurting the host:
 *
 * - **it is reloaded when its file changes.** The import URL carries the file's
 *   mtime (`?v=…`), because the ESM loader caches by URL forever otherwise. An
 *   edited module is picked up on the next matching event, and a module created
 *   after its first failure starts working as soon as it exists.
 * - **it cannot outlive its run.** The run is raced against `timeoutMs` and the
 *   event's own signal. Once either fires — and also once the module returns —
 *   `inject`, `steer`, and `exec` are disabled, so a late continuation cannot
 *   land a message in a turn that already moved on. A module that never settles
 *   and ignores its signal cannot be killed from here: it is ordinary
 *   JavaScript in the host's process. That is the price of the live API, and
 *   the README says so.
 *
 * `log` routes to the host logger under the prefix
 * `dsh-lifecycle-hooks: module "<id>" at <event>: `, so a hook author's `log`
 * line is attributable and greppable, and never reaches the model.
 *
 * @module dsh-lifecycle-hooks/module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecution, ShellExecutor } from '@deepseek-ai/dsh-shell'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CommandDecode } from './command.ts'
import { messageOf } from './message.ts'
import { decodeOutcomeValue } from './command.ts'
import { contextMessage } from './context.ts'
import type { HookEvent, HookOutcome } from './hook.ts'

/** The shell surface a module's `exec` helper needs; absent when the deployment has none. */
export type ModuleShell = Pick<ShellExecutor, 'resolve' | 'execute'> | undefined

/** Options one `exec(command, options?)` call may pass. */
export interface ModuleExecOptions {
  /** Override the run's timeout for this process; defaults to the entry's. */
  readonly timeoutMs?: number
  /** Extra environment entries, merged after the host's credential scrub. */
  readonly env?: Record<string, string>
  /** Text written to the process's stdin, then closed. */
  readonly stdin?: string
}

/**
 * What one module `exec` produced.
 *
 * Failure is data, not an exception: a missing shell service, a spawn fault, a
 * timeout, and a non-zero exit all come back here, and a hook decides whether
 * any of them matters.
 */
export interface ModuleExecResult {
  /** Process exit code; `null` when the process never produced one. */
  readonly exitCode: number | null
  /** Captured standard output. */
  readonly stdout: string
  /** Captured standard error; also carries the failure detail when there is one. */
  readonly stderr: string
  /** Whether the process was killed at expiry. */
  readonly timedOut: boolean
  /** Whether the run was cancelled through the event signal before finishing. */
  readonly aborted: boolean
  /**
   * Whether the helper refused to run at all because the hook run had already
   * ended (timeout, cancellation, or a returned module).
   */
  readonly disabled: boolean
}

/** The entry facts a module may read about itself. */
export interface ModuleHandlerInfo {
  /** The entry's `id`. */
  readonly id: string
  /** The lifecycle point the entry is bound to. */
  readonly event: HookEvent
  /** Absolute path of the hooks file that declared it. */
  readonly source: string
}

/**
 * The curated context one module receives.
 *
 * This is the whole contract: anything not on this list (the Cordis `Context`,
 * the plugin's config, its dispatcher) is deliberately out of reach.
 */
export interface ModuleContext {
  /** Lifecycle point firing, the same string the payload carries. */
  readonly event: HookEvent
  /** Event payload, identical to what a `command` hook reads on stdin. */
  readonly payload: unknown
  /** The live agent the event belongs to. */
  readonly agent: Agent
  /** The live Session the event belongs to. */
  readonly session: Session
  /** The called tool's facts (`{name, call_id, input}`), where the event has a tool. */
  readonly tool: unknown
  /** The tool result's facts (`{is_error, content}`), on events that carry one. */
  readonly result: unknown
  /**
   * Aborts when the event is abandoned or this run times out. A module that
   * ignores it keeps running; nothing can force it to stop.
   */
  readonly signal: AbortSignal
  /** Log one line through the host logger; never model-visible. */
  readonly log: (message: string) => void
  /**
   * Add one `<system-reminder>` line to the agent's next step.
   * @returns false when the run already ended and the message went nowhere.
   */
  readonly inject: (text: string) => boolean
  /**
   * Wake the agent with one `<system-reminder>` line as its next step.
   * @returns false when the run already ended and the message went nowhere.
   */
  readonly steer: (text: string) => boolean
  /**
   * Run one command through the host shell, in the Session's directory.
   * @returns the exit code and captured output; never throws for a failed command.
   */
  readonly exec: (command: string, options?: ModuleExecOptions) => Promise<ModuleExecResult>
  /** The entry this module was loaded for. */
  readonly handler: ModuleHandlerInfo
}

/** Everything one module run needs from the plugin instance. */
export interface ModuleRunOptions {
  /** Absolute path of the module file. */
  readonly file: string
  /** The entry's timeout, also the default for its `exec` calls. */
  readonly timeoutMs: number
  /** Cancels the run when the event (or a detached run) is abandoned. */
  readonly signal: AbortSignal
  /** Event payload; also where `tool` and `result` are read from. */
  readonly payload: Record<string, unknown>
  /** The entry's own facts. */
  readonly handler: ModuleHandlerInfo
  /** The live agent and its session. */
  readonly agent: Agent
  /** Session working directory `exec` runs in. */
  readonly workdir: string
  /** Host shell service, or `undefined` when the deployment has none. */
  readonly shell: ModuleShell
  /** Logger sink; the plugin adds its own name prefix. */
  readonly log: (message: string) => void
}

/** What one module run produced. */
export interface ModuleResult {
  /** The outcome the module returned, validated like a command's stdout. */
  readonly outcome: HookOutcome | undefined
  /** Why the run failed, or `undefined` when it settled cleanly. */
  readonly error: string | undefined
}

/**
 * Resolve an entry's module path against the hooks file that declared it.
 * @param source - absolute path of the hooks file.
 * @param path - the entry's `run.path`, as written.
 * @returns the absolute module path.
 */
export function resolveModulePath(source: string, path: string): string {
  return resolve(dirname(source), path)
}

/**
 * Run one module hook and decode its outcome.
 *
 * Never throws: a missing file, an import failure, a module with no default
 * function, a thrown error, a timeout, and an abandoned event all come back as
 * a failed {@link ModuleResult}, which the dispatcher records and applies the
 * entry's `onFailure` policy to.
 * @param options - the module, its input, and its execution facts.
 * @returns the run's outcome and failure detail.
 */
export async function runModule(options: ModuleRunOptions): Promise<ModuleResult> {
  let version: number
  try {
    version = (await stat(options.file)).mtimeMs
  } catch (error) {
    return { outcome: undefined, error: `the module could not be read: ${messageOf(error)}` }
  }

  let namespace: { default?: unknown }
  try {
    // The version query is the whole cache-busting story: the ESM loader keys
    // modules by URL, so an edited file would otherwise keep its first parse
    // for the life of the process.
    namespace = await import(`${pathToFileURL(options.file).href}?v=${String(version)}`) as { default?: unknown }
  } catch (error) {
    return { outcome: undefined, error: `the module could not be imported: ${messageOf(error)}` }
  }
  const factory = namespace.default
  if (typeof factory !== 'function') {
    return { outcome: undefined, error: 'the module must export a default function' }
  }

  let timeoutTimer: NodeJS.Timeout | undefined
  const runSignal = new AbortController()
  const contextSignal = AbortSignal.any([options.signal, runSignal.signal])
  let ended = false
  const end = (): void => {
    ended = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
  }
  const stop = (): boolean => ended || contextSignal.aborted
  let wake: (kind: 'timeout' | 'aborted') => void = () => {}
  const stopped = new Promise<'timeout' | 'aborted'>((settle) => { wake = settle })
  const onAbort = (): void => {
    if (ended) return
    end()
    wake('aborted')
  }
  if (options.signal.aborted) onAbort()
  else options.signal.addEventListener('abort', onAbort, { once: true })
  timeoutTimer = setTimeout(() => {
    if (ended) return
    end()
    runSignal.abort(options.timeoutMs)
    wake('timeout')
  }, options.timeoutMs)
  // A pending timer must not hold the process open on its own.
  timeoutTimer.unref()

  const context = createContext(options, contextSignal, stop)
  // A module's own late rejection must not become an unhandled rejection: the
  // race may already have settled on the timeout, and nobody is waiting then.
  const returned = (async (): Promise<{ readonly value: unknown } | { readonly thrown: unknown }> => {
    try {
      return { value: await (factory as (context: ModuleContext) => unknown)(context) }
    } catch (error) {
      return { thrown: error }
    }
  })()

  const settled = await Promise.race([returned, stopped])
  const kind = typeof settled === 'string' ? settled : undefined
  end()
  options.signal.removeEventListener('abort', onAbort)
  timeoutTimer = undefined

  if (kind === 'timeout') {
    return { outcome: undefined, error: `timed out after ${String(options.timeoutMs)} ms` }
  }
  if (kind === 'aborted') return { outcome: undefined, error: 'was cancelled before it finished' }
  // The module returned before the timeout; helpers are closed from here on so
  // a detached continuation cannot act after its run was recorded.
  const outcome = settled as { readonly value?: unknown; readonly thrown?: unknown }
  if ('thrown' in outcome) return { outcome: undefined, error: messageOf(outcome.thrown) }
  if (outcome.value === undefined || outcome.value === null) {
    return { outcome: undefined, error: undefined }
  }
  const decoded: CommandDecode = decodeOutcomeValue(outcome.value, 'module result')
  return { outcome: decoded.outcome, error: decoded.error }
}

/**
 * Build the one curated context object, closing every helper over one `ended`
 * flag so they all stop together.
 * @param options - the run's facts.
 * @param contextSignal - the event signal, aborted again when this run times out.
 * @param stop - whether the run has already ended (for the helpers).
 * @returns the frozen context handed to the module.
 */
function createContext(
  options: ModuleRunOptions,
  contextSignal: AbortSignal,
  stop: () => boolean,
): ModuleContext {
  const handler = options.handler
  const log = (message: string): void => {
    options.log(`module "${handler.id}" at ${handler.event}: ${message}`)
  }
  const send = (text: string, deliver: (message: ReturnType<typeof contextMessage>) => void): boolean => {
    if (stop() || typeof text !== 'string' || text.trim().length === 0) return false
    deliver(contextMessage([text]))
    return true
  }
  const exec = async (command: string, execOptions: ModuleExecOptions = {}): Promise<ModuleExecResult> => {
    if (stop()) return disabled('the hook run already ended; exec is disabled')
    const shell = options.shell
    if (shell === undefined) return failedExec('the shell service is not available')
    let handle: ShellExecution
    try {
      handle = await shell.execute(shell.resolve({
        command,
        workdir: options.workdir,
        timeoutMs: execOptions.timeoutMs ?? options.timeoutMs,
        ...execOptions.stdin === undefined ? {} : { stdin: execOptions.stdin },
        ...execOptions.env === undefined ? {} : { env: execOptions.env },
        signal: contextSignal,
      }))
    } catch (error) {
      return failedExec(`the command could not be started: ${messageOf(error)}`)
    }
    try {
      const result = await handle.result()
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
        timedOut: result.timedOut,
        aborted: result.aborted,
        disabled: false,
      }
    } catch (error) {
      return failedExec(`the command failed to run: ${messageOf(error)}`)
    }
  }
  const context: ModuleContext = {
    event: handler.event,
    payload: options.payload,
    agent: options.agent,
    session: options.agent.session,
    tool: options.payload.tool,
    result: options.payload.result,
    signal: contextSignal,
    log,
    inject: (text: string) => send(text, message => { options.agent.inject(message) }),
    steer: (text: string) => send(text, message => { options.agent.steer(message) }),
    exec,
    handler,
  }
  return Object.freeze(context)
}

/**
 * A helper call that never reached the shell because the run was already over.
 * @param stderr - why it was refused.
 * @returns the result the module sees.
 */
function disabled(stderr: string): ModuleExecResult {
  return { exitCode: null, stdout: '', stderr, timedOut: false, aborted: true, disabled: true }
}

/**
 * A helper call the shell could not run, as data rather than an exception.
 * @param stderr - why it failed.
 * @returns the result the module sees.
 */
function failedExec(stderr: string): ModuleExecResult {
  return { exitCode: null, stdout: '', stderr, timedOut: false, aborted: false, disabled: false }
}
