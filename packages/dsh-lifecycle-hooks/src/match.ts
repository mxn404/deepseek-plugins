/**
 * Match clauses: which tool a hook speaks about, which arguments, and whether
 * a step carries a user prompt.
 *
 * A hook entry's `match` has three independent dimensions, each used by one
 * event family, and any may be omitted:
 *
 * - `match.tool` — the tool name on `tool.pre`: a plain exact name,
 *   `name|other` for an either-or set, or `/regex/` for a pattern.
 * - `match.args` — a deep subset of the tool's parsed arguments on `tool.pre`.
 *   Objects match key by key and array elements match index by index; a string
 *   leaf is an exact value unless it is written as `/regex/`, which tests the
 *   actual string.
 * - `match.prompt` — whether a `step.start` step carries a user prompt:
 *   `true` selects submission steps, `false` continuation steps, and an
 *   omitted clause selects every step.
 *
 * Everything here is pure so the format contract can be table-tested without a
 * host.
 *
 * @module dsh-lifecycle-hooks/match
 */

/** A `match.tool` value compiled once at load time. */
export type ToolPattern =
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'alternatives'; readonly names: readonly string[] }
  | { readonly kind: 'regex'; readonly regex: RegExp }

/** One hook entry's compiled matcher. */
export interface HookMatch {
  readonly tool: ToolPattern | undefined
  readonly args: Record<string, unknown> | undefined
  /** `step.start` only: whether the step must carry a user prompt. */
  readonly prompt?: boolean | undefined
}

/** `/body/` around a whole string, the only regex spelling this format has. */
const REGEX_LITERAL = /^\/(.+)\/$/s

/**
 * Compile one `match.tool` value.
 * @param raw - the config string as written.
 * @returns the compiled pattern, or `undefined` when `/…/` is not a valid regex.
 */
export function compileToolPattern(raw: string): ToolPattern | undefined {
  const literal = REGEX_LITERAL.exec(raw)
  if (literal !== null) {
    try {
      return { kind: 'regex', regex: new RegExp(literal[1]!) }
    } catch {
      return undefined
    }
  }
  if (raw.includes('|')) {
    const names = raw.split('|').map(name => name.trim()).filter(name => name.length > 0)
    if (names.length > 0) return { kind: 'alternatives', names }
  }
  return { kind: 'exact', name: raw }
}

/**
 * Whether one compiled tool pattern selects a tool name.
 * @param pattern - compiled `match.tool`.
 * @param toolName - the called tool's name.
 * @returns true when the name matches.
 */
export function matchesToolName(pattern: ToolPattern, toolName: string): boolean {
  switch (pattern.kind) {
    case 'exact':
      return pattern.name === toolName
    case 'alternatives':
      return pattern.names.includes(toolName)
    case 'regex':
      return pattern.regex.test(toolName)
  }
}

/**
 * Deep-subset match of one argument tree.
 *
 * The expected tree constrains only the keys it names: an object matches when
 * every expected key exists and matches, an array when the actual array is at
 * least as long and matches index by index, and a string when it is equal — or,
 * written as `/regex/`, when the pattern matches the actual string.
 * @param expected - the value as written in `match.args`.
 * @param actual - the tool's parsed argument at the same position.
 * @returns true when the actual value satisfies the expected subset.
 */
export function matchesArgs(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'string') {
    const literal = REGEX_LITERAL.exec(expected)
    if (literal === null) return actual === expected
    if (typeof actual !== 'string') return false
    try {
      return new RegExp(literal[1]!).test(actual)
    } catch {
      return false
    }
  }
  if (expected === null || typeof expected === 'number' || typeof expected === 'boolean') {
    return actual === expected
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false
    return expected.every((entry, index) => matchesArgs(entry, actual[index]))
  }
  if (typeof expected === 'object') {
    if (!isRecord(actual)) return false
    return Object.entries(expected)
      .every(([key, value]) => key in actual && matchesArgs(value, actual[key]))
  }
  return false
}

/**
 * Whether one hook's match clause selects this tool call.
 * @param match - the compiled clause; `undefined` matches every call.
 * @param toolName - the called tool's name.
 * @param args - the call's parsed arguments.
 * @returns true when the hook applies.
 */
export function matchesHook(match: HookMatch | undefined, toolName: string, args: unknown): boolean {
  if (match === undefined) return true
  if (match.tool !== undefined && !matchesToolName(match.tool, toolName)) return false
  if (match.args !== undefined && !matchesArgs(match.args, args)) return false
  return true
}

/**
 * Report the first `/…/` string leaf that is not a valid regex, so a broken
 * pattern can skip its hook at load time instead of silently matching nothing.
 * @param value - the `match.args` tree as written.
 * @returns a description of the offending value, or `undefined` when all are valid.
 */
export function invalidArgPattern(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const literal = REGEX_LITERAL.exec(value)
    if (literal === null) return undefined
    try {
      new RegExp(literal[1]!)
      return undefined
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const invalid: string | undefined = invalidArgPattern(entry)
      if (invalid !== undefined) return invalid
    }
    return undefined
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const invalid: string | undefined = invalidArgPattern(entry)
      if (invalid !== undefined) return invalid
    }
  }
  return undefined
}

/** Whether a value is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
