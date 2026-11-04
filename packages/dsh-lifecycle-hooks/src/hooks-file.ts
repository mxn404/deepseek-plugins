/**
 * Reading and validating `.dsh/hooks.json`.
 *
 * Two layers live here:
 *
 * - {@link parseHooks}, the pure JSON contract: file version, the hooks array,
 *   and each entry's `id` / `on` / `match` / `run` / `timeoutMs` / `onFailure`.
 *   A file-level problem rejects the whole file; an entry-level problem drops
 *   that entry with a warning and keeps the rest.
 * - {@link HookSources}, the per-file cache: re-stat before every use, re-read
 *   only when the stat changed (or the watcher warmed a changed file), and keep
 *   the last valid snapshot when a newer file no longer parses. A malformed
 *   edit must not disable the rules a developer already had working.
 *
 * @module dsh-lifecycle-hooks/hooks-file
 */

import { readFile, stat } from 'node:fs/promises'
import type { Hook, HookEvent } from './hook.ts'
import { compileToolPattern, invalidArgPattern, isRecord, type HookMatch } from './match.ts'

/** Hook events the format names; this build dispatches `tool.pre` only. */
const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEvent>([
  'session.start',
  'step.start',
  'tool.pre',
  'tool.post',
  'tool.result',
  'turn.stop',
  'session.end',
  'notification',
])

/** Handler kinds a later ticket adds; naming one is a "not yet" warning, not a typo. */
const KNOWN_HANDLER_KINDS: ReadonlySet<string> = new Set(['command', 'module'])

/** Actions a later ticket adds; naming one is a "not yet" warning, not a typo. */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(['ask', 'block', 'continue', 'halt', 'inject'])

/** Result of validating one hooks file. */
export type HooksParse =
  | { readonly ok: true; readonly hooks: readonly Hook[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string }

/** One hooks file's usable entries, tagged with the file they came from. */
export interface HookSnapshot {
  /** Absolute path of the file that produced these hooks. */
  readonly source: string
  readonly hooks: readonly Hook[]
}

/** Callbacks the loader needs from its owner. */
export interface HookSourcesOptions {
  /** Per-entry timeout used when an entry declares no own `timeoutMs`. */
  readonly defaultTimeoutMs: number
  /** Sink for load-time warnings; the owner adds the plugin-name prefix. */
  readonly warn: (message: string) => void
}

/** One cached file: the stat stamp it was last attempted at, and its last valid parse. */
interface CacheEntry {
  readonly stamp: string
  readonly snapshot: HookSnapshot | undefined
}

/**
 * Validate one hooks file's text.
 * @param text - the file's raw content.
 * @param defaultTimeoutMs - timeout for entries without an own `timeoutMs`.
 * @returns the usable hooks plus per-entry warnings, or one file-level error.
 */
export function parseHooks(text: string, defaultTimeoutMs: number): HooksParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `hooks file is not valid JSON: ${messageOf(error)}` }
  }
  if (!isRecord(raw)) return { ok: false, error: 'hooks file must be a JSON object' }
  if (raw.version !== 1) {
    return {
      ok: false,
      error: raw.version === undefined
        ? 'hooks file has no version'
        : `unsupported hooks version ${JSON.stringify(raw.version)}; this build understands 1`,
    }
  }
  if (!Array.isArray(raw.hooks)) return { ok: false, error: '"hooks" must be an array' }
  const warnings: string[] = []
  const hooks: Hook[] = []
  raw.hooks.forEach((entry, index) => {
    const parsed: Hook | undefined = parseHook(entry, index, defaultTimeoutMs, warnings)
    if (parsed !== undefined) hooks.push(parsed)
  })
  return { ok: true, hooks, warnings }
}

/**
 * Validate one hook entry. A rejected entry is reported through `warnings` and
 * skipped; no entry-level problem invalidates the file or its siblings.
 * @param raw - the entry as written.
 * @param index - its position in the file, for the warning when it has no usable id.
 * @param defaultTimeoutMs - timeout used when the entry declares none.
 * @param warnings - collector the entry's problem is appended to.
 * @returns the hook, or `undefined` when it was skipped.
 */
function parseHook(
  raw: unknown,
  index: number,
  defaultTimeoutMs: number,
  warnings: string[],
): Hook | undefined {
  if (!isRecord(raw)) {
    warnings.push(`hooks[${index}] skipped: entry is not an object`)
    return undefined
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    warnings.push(`hooks[${index}] skipped: "id" must be a non-empty string`)
    return undefined
  }
  const id = raw.id
  const skip = (reason: string): undefined => {
    warnings.push(`hook "${id}" skipped: ${reason}`)
    return undefined
  }

  if (typeof raw.on !== 'string') return skip('"on" must be a string naming a lifecycle event')
  if (!KNOWN_EVENTS.has(raw.on)) return skip(`unknown event "${raw.on}"`)
  if (raw.on !== 'tool.pre') return skip(`event "${raw.on}" is not supported by this build`)

  const match = parseMatch(raw.match)
  if ('error' in match) return skip(match.error)

  const run = parseRun(raw.run)
  if ('error' in run) return skip(run.error)

  let timeoutMs = defaultTimeoutMs
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
      return skip('"timeoutMs" must be a positive integer')
    }
    timeoutMs = raw.timeoutMs
  }

  let onFailure: Hook['onFailure'] = 'open'
  if (raw.onFailure !== undefined) {
    if (raw.onFailure !== 'open' && raw.onFailure !== 'block') {
      return skip('"onFailure" must be "open" or "block"')
    }
    onFailure = raw.onFailure
  }

  return { id, on: 'tool.pre', match: match.match, run: run.run, timeoutMs, onFailure }
}

/** Match parsing outcome: no clause, a clause, or an entry-level error to report. */
type MatchParse =
  | { readonly match: HookMatch | undefined }
  | { readonly error: string }

/**
 * Parse `match`, if present.
 * @param raw - the entry's `match` value.
 * @returns the compiled clause, or the reason the entry must be dropped.
 */
function parseMatch(raw: unknown): MatchParse {
  if (raw === undefined || raw === null) return { match: undefined }
  if (!isRecord(raw)) return { error: '"match" must be an object' }
  let tool: HookMatch['tool']
  if (raw.tool !== undefined) {
    if (typeof raw.tool !== 'string') return { error: '"match.tool" must be a string' }
    const compiled = compileToolPattern(raw.tool)
    if (compiled === undefined) return { error: `"match.tool" is not a valid regular expression: ${raw.tool}` }
    tool = compiled
  }
  let args: HookMatch['args']
  if (raw.args !== undefined) {
    if (!isRecord(raw.args)) return { error: '"match.args" must be an object' }
    const invalid: string | undefined = invalidArgPattern(raw.args)
    if (invalid !== undefined) return { error: `"match.args" contains an invalid regular expression: ${invalid}` }
    args = raw.args
  }
  return { match: { tool, args } }
}

/** Run parsing outcome: the executable run, or an entry-level error to report. */
type RunParse =
  | { readonly run: Hook['run'] }
  | { readonly error: string }

/**
 * Parse `run`, the handler description.
 * @param raw - the entry's `run` value.
 * @returns the executable run, or the reason the entry must be dropped.
 */
function parseRun(raw: unknown): RunParse {
  if (!isRecord(raw)) return { error: '"run" must be an object' }
  if (typeof raw.type !== 'string') return { error: '"run.type" must be a string' }
  if (raw.type !== 'builtin') {
    return {
      error: KNOWN_HANDLER_KINDS.has(raw.type)
        ? `handler type "${raw.type}" is not supported by this build`
        : `unknown handler type "${raw.type}"`,
    }
  }
  if (typeof raw.action !== 'string') return { error: '"run.action" must be a string' }
  if (raw.action !== 'deny') {
    return {
      error: KNOWN_ACTIONS.has(raw.action)
        ? `action "${raw.action}" is not supported by this build`
        : `unknown action "${raw.action}"`,
    }
  }
  const reason = typeof raw.reason === 'string' && raw.reason.trim().length > 0
    ? raw.reason
    : undefined
  return { run: { type: 'builtin', action: 'deny', reason: reason ?? 'denied by a lifecycle hook' } }
}

/**
 * Per-plugin-instance cache of parsed hooks files.
 *
 * The cache is keyed by absolute path, so a Session that changes directory
 * naturally resolves a different file, and a file that is deleted stops
 * contributing hooks on the next call.
 */
export class HookSources {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<HookSnapshot | undefined>>()

  /** @param options - default timeout and the warning sink. */
  constructor(private readonly options: HookSourcesOptions) {}

  /**
   * Read one hooks file, re-reading it only when its stat changed.
   * @param source - absolute path of the file.
   * @returns the usable hooks, or `undefined` when there is no usable file.
   */
  load(source: string): Promise<HookSnapshot | undefined> {
    // One read per file at a time: parallel tool calls in one step resolve
    // concurrently, and a broken file must warn once, not once per call.
    const running = this.inflight.get(source)
    if (running !== undefined) return running
    const attempt = this.read(source).finally(() => { this.inflight.delete(source) })
    this.inflight.set(source, attempt)
    return attempt
  }

  /**
   * Read and validate one file, consulting the stat stamp first.
   * @param source - absolute path of the file.
   * @returns the usable hooks, or `undefined` when there is no usable file.
   */
  private async read(source: string): Promise<HookSnapshot | undefined> {
    const stamp = await this.stamp(source)
    if (stamp === undefined) {
      this.entries.delete(source)
      return undefined
    }
    const cached = this.entries.get(source)
    if (cached !== undefined && cached.stamp === stamp) return cached.snapshot
    let text: string
    try {
      text = await readFile(source, 'utf8')
    } catch (error) {
      this.warn(source, `hooks file could not be read: ${messageOf(error)}`)
      this.entries.set(source, { stamp, snapshot: cached?.snapshot })
      return cached?.snapshot
    }
    const parsed = parseHooks(text, this.options.defaultTimeoutMs)
    if (!parsed.ok) {
      this.warn(source, parsed.error)
      this.entries.set(source, { stamp, snapshot: cached?.snapshot })
      return cached?.snapshot
    }
    for (const warning of parsed.warnings) this.warn(source, warning)
    const snapshot: HookSnapshot = { source, hooks: parsed.hooks }
    this.entries.set(source, { stamp, snapshot })
    return snapshot
  }

  /**
   * Re-read a file the watcher reported, so the layer is already parsed when
   * the next event resolves it. Only files this loader has parsed before are
   * refreshed: a watcher sees every change in a `.dsh` directory, and parsing
   * an unrelated file there would turn its content into warnings.
   *
   * A refresh never discards the last valid parse: a broken edit keeps the
   * layer's working rules, exactly as an edit noticed by the stat check does.
   * @param source - absolute path the watcher reported, or `undefined` for every
   * cached file when the platform did not name one.
   */
  async refresh(source?: string): Promise<void> {
    const sources = source === undefined ? [...this.entries.keys()] : [source]
    for (const path of sources) {
      if (!this.entries.has(path)) continue
      await this.load(path)
    }
  }

  /** Warn about one file problem, keeping the message one line. */
  private warn(source: string, message: string): void {
    this.options.warn(`${source}: ${message}`)
  }

  /**
   * Stat stamp for one file, used to notice an edit without re-reading.
   * @param source - absolute path of the file.
   * @returns an opaque stamp, or `undefined` when no regular file exists there.
   */
  private async stamp(source: string): Promise<string | undefined> {
    try {
      const info = await stat(source)
      if (!info.isFile()) return undefined
      return `${String(info.mtimeMs)}:${String(info.ctimeMs)}:${String(info.size)}`
    } catch {
      return undefined
    }
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
