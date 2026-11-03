/**
 * Conservative shell single-file read detection.
 *
 * dsh's bash tool reports only the command text, never the files it read. A
 * trigger therefore has to come from parsing that text, and a wrong guess would
 * load a rule that has nothing to do with what the model is working on. This
 * parser proves the narrow case instead: one simple command, one unambiguous
 * file operand. Anything else — pipes, wildcards, expansions, redirections,
 * multiple files, unknown flags — returns `undefined`.
 *
 * Accepted shapes, with options before the operands:
 *
 * - `cat <flags...> <file>`
 * - `head <flags...> <file>`, `tail <flags...> <file>` (with `-n` / `-c` counts)
 * - `sed -n '<range>p' <file>`
 * - `grep <flags...> <pattern> <file>`, including `-e <pattern>`
 *
 * @module dsh-rules/shell
 */

/** The five read commands this plugin recognizes. */
export type ShellReadCommand = 'cat' | 'head' | 'tail' | 'sed' | 'grep'

/** One recognized single-file read. */
export interface ShellFileRead {
  readonly command: ShellReadCommand
  /** File operand exactly as the model wrote it: relative or absolute. */
  readonly path: string
}

/**
 * Characters that make the touched path ambiguous (`|`, `&`, `;`, redirection,
 * command and variable substitution, wildcards, brace expansion, a home
 * directory, subshells, line continuation, or a second line).
 */
const FORBIDDEN_TEXT = /[|&;<>`$*?[\]{}~()\\\n\r]/

/** Control characters other than a tab, which separates tokens. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

const CAT_SHORT_FLAGS = new Set([...'AbEeEnstTuv'])
const CAT_LONG_FLAGS = new Set([
  '--show-all',
  '--number-nonblank',
  '--show-ends',
  '--number',
  '--squeeze-blank',
  '--show-tabs',
  '--show-nonprinting',
])

const COUNT_LONG_FLAGS = new Set(['--lines', '--bytes'])
const COUNT_BOOLEAN_LONG_FLAGS = new Set(['--quiet', '--silent', '--verbose'])
const COUNT_SHORT_FLAGS = new Set(['q', 'v'])

const SED_FLAGS = new Set(['-n', '--quiet', '--silent'])

const GREP_SHORT_FLAGS = new Set([...'abcEFhHilLnoqsvwxz'])
const GREP_LONG_FLAGS = new Set([
  '--byte-offset',
  '--count',
  '--extended-regexp',
  '--fixed-strings',
  '--basic-regexp',
  '--ignore-case',
  '--line-number',
  '--line-regexp',
  '--no-filename',
  '--with-filename',
  '--no-messages',
  '--only-matching',
  '--quiet',
  '--silent',
  '--text',
  '--invert-match',
  '--word-regexp',
  '--files-with-matches',
  '--files-without-match',
])
const GREP_FORBIDDEN_SHORT_FLAGS = new Set(['r', 'R', 'f'])

/** A numeric count for `head -n` / `tail -n`. */
const COUNT_VALUE = /^-?\d+$/
/** The conservative `sed` script shape: a line or range that prints. */
const SED_SCRIPT = /^\d+(?:,\d+)?p$/

/**
 * Split a command into shell-like tokens.
 *
 * Only single and double quotes are understood; there are no escapes, because
 * a backslash is rejected before tokenization. An unterminated quote returns
 * `undefined`.
 * @param command - trimmed command text.
 * @returns the tokens, or `undefined` when a quote never closes.
 */
function tokenize(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | undefined
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote !== undefined) return undefined
  if (started) tokens.push(current)
  return tokens
}

/** A token that may be interpreted as an option rather than an operand. */
function isOptionToken(token: string): boolean {
  return token.length > 1 && token.startsWith('-')
}

/**
 * Validate one file operand.
 *
 * Rejecting `-`, leading dashes, a directory-looking operand, and `.`/`..`
 * keeps the trigger tied to a nameable single file.
 * @param value - candidate operand.
 * @returns true when the operand can be a single file path.
 */
function isFileOperand(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false
  if (value.startsWith('-')) return false
  if (value === '.' || value === '..') return false
  if (value.endsWith('/')) return false
  return true
}

/** Result of consuming one option; the file operand is not yet known. */
type OptionStep =
  | { readonly ok: true; readonly next: number; readonly pattern?: string }
  | { readonly ok: false }

/**
 * Consume one `cat` option.
 * @param token - option token.
 * @returns whether the option is a known boolean cat flag.
 */
function isCatOption(token: string): boolean {
  if (token.startsWith('--')) return CAT_LONG_FLAGS.has(token)
  if (!/^-[A-Za-z]+$/.test(token)) return false
  return [...token.slice(1)].every(char => CAT_SHORT_FLAGS.has(char))
}

/**
 * Consume one `head` / `tail` option, including a count that may follow as a
 * separate token.
 * @param tokens - all tokens.
 * @param index - index of the option token.
 * @returns the next index, or a rejection.
 */
function consumeCountOption(tokens: readonly string[], index: number): OptionStep {
  const token = tokens[index]
  if (token === undefined) return { ok: false }
  if (token.startsWith('--')) {
    const equals = token.indexOf('=')
    if (equals >= 0) {
      const name = token.slice(0, equals)
      const value = token.slice(equals + 1)
      if (!COUNT_LONG_FLAGS.has(name) || !COUNT_VALUE.test(value)) return { ok: false }
      return { ok: true, next: index + 1 }
    }
    if (COUNT_BOOLEAN_LONG_FLAGS.has(token)) return { ok: true, next: index + 1 }
    if (!COUNT_LONG_FLAGS.has(token)) return { ok: false }
    const value = tokens[index + 1]
    if (value === undefined || !COUNT_VALUE.test(value)) return { ok: false }
    return { ok: true, next: index + 2 }
  }
  // `-5` is the short numeric form of `-n 5`.
  if (/^-\d+$/.test(token)) return { ok: true, next: index + 1 }
  if (!/^-[A-Za-z]\d*$/.test(token)) return { ok: false }
  const flag = token[1]
  const attached = token.slice(2)
  if (flag === 'n' || flag === 'c') {
    if (attached.length > 0) {
      return COUNT_VALUE.test(attached) ? { ok: true, next: index + 1 } : { ok: false }
    }
    const value = tokens[index + 1]
    if (value === undefined || !COUNT_VALUE.test(value)) return { ok: false }
    return { ok: true, next: index + 2 }
  }
  if (attached.length === 0 && flag !== undefined && COUNT_SHORT_FLAGS.has(flag)) {
    return { ok: true, next: index + 1 }
  }
  return { ok: false }
}

/**
 * Parse a `cat` / `head` / `tail` shape: options first, then one file operand.
 * @param command - the recognized command name.
 * @param tokens - full token list.
 * @returns the file operand, or `undefined`.
 */
function parseSingleOperand(
  command: 'cat' | 'head' | 'tail',
  tokens: readonly string[],
): string | undefined {
  let operand: string | undefined
  let endOfOptions = false
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    if (!endOfOptions && token === '--') {
      endOfOptions = true
      index += 1
      continue
    }
    if (!endOfOptions && isOptionToken(token)) {
      // Options must precede the file operand; anything else is unfamiliar.
      if (operand !== undefined) return undefined
      if (command === 'cat') {
        if (!isCatOption(token)) return undefined
        index += 1
        continue
      }
      const step = consumeCountOption(tokens, index)
      if (!step.ok) return undefined
      index = step.next
      continue
    }
    if (operand !== undefined) return undefined
    operand = token
    index += 1
  }
  return isFileOperand(operand) ? operand : undefined
}

/**
 * Parse a `sed -n '<range>p' <file>` shape.
 * @param tokens - full token list.
 * @returns the file operand, or `undefined`.
 */
function parseSed(tokens: readonly string[]): string | undefined {
  let quiet = false
  let endOfOptions = false
  const operands: string[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) break
    if (!endOfOptions && token === '--') {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && isOptionToken(token)) {
      if (operands.length > 0) return undefined
      if (!SED_FLAGS.has(token)) return undefined
      quiet = true
      continue
    }
    operands.push(token)
    if (operands.length > 2) return undefined
  }
  if (!quiet) return undefined
  const script = operands[0]
  const file = operands[1]
  if (operands.length !== 2 || script === undefined) return undefined
  if (!SED_SCRIPT.test(script)) return undefined
  return isFileOperand(file) ? file : undefined
}

/**
 * Consume one `grep` option.
 * @param tokens - all tokens.
 * @param index - index of the option token.
 * @param hasPattern - whether a pattern was already supplied through `-e`.
 * @returns the next index and any pattern, or a rejection.
 */
function consumeGrepOption(
  tokens: readonly string[],
  index: number,
  hasPattern: boolean,
): OptionStep {
  const token = tokens[index]
  if (token === undefined) return { ok: false }
  if (token.startsWith('--')) {
    const equals = token.indexOf('=')
    if (equals >= 0) {
      const name = token.slice(0, equals)
      const value = token.slice(equals + 1)
      if (name !== '--regexp' || value.length === 0 || hasPattern) return { ok: false }
      return { ok: true, next: index + 1, pattern: value }
    }
    if (token === '--regexp') {
      const value = tokens[index + 1]
      if (value === undefined || value.length === 0 || hasPattern) return { ok: false }
      return { ok: true, next: index + 2, pattern: value }
    }
    // Recursive and pattern-file flags imply many files: never a trigger.
    if (token === '--recursive' || token === '--dereference-recursive' || token === '--file') {
      return { ok: false }
    }
    return GREP_LONG_FLAGS.has(token) ? { ok: true, next: index + 1 } : { ok: false }
  }
  if (token === '-e') {
    const value = tokens[index + 1]
    if (value === undefined || value.length === 0 || hasPattern) return { ok: false }
    return { ok: true, next: index + 2, pattern: value }
  }
  if (token.startsWith('-e')) {
    const value = token.slice(2)
    if (value.length === 0 || hasPattern) return { ok: false }
    return { ok: true, next: index + 1, pattern: value }
  }
  if (!/^-[A-Za-z]+$/.test(token)) return { ok: false }
  for (const char of token.slice(1)) {
    if (GREP_FORBIDDEN_SHORT_FLAGS.has(char)) return { ok: false }
    if (!GREP_SHORT_FLAGS.has(char)) return { ok: false }
  }
  return { ok: true, next: index + 1 }
}

/**
 * Parse a `grep <flags...> <pattern> <file>` shape.
 * @param tokens - full token list.
 * @returns the file operand, or `undefined`.
 */
function parseGrep(tokens: readonly string[]): string | undefined {
  const operands: string[] = []
  let pattern: string | undefined
  let endOfOptions = false
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    if (!endOfOptions && token === '--') {
      endOfOptions = true
      index += 1
      continue
    }
    if (!endOfOptions && isOptionToken(token)) {
      if (operands.length > 0) return undefined
      const step = consumeGrepOption(tokens, index, pattern !== undefined)
      if (!step.ok) return undefined
      if (step.pattern !== undefined) pattern = step.pattern
      index = step.next
      continue
    }
    operands.push(token)
    if (operands.length > 2) return undefined
    index += 1
  }
  if (pattern === undefined) {
    if (operands.length !== 2) return undefined
    const [first, second] = operands
    if (first === undefined || first.length === 0) return undefined
    return isFileOperand(second) ? second : undefined
  }
  if (operands.length !== 1) return undefined
  const file = operands[0]
  return isFileOperand(file) ? file : undefined
}

/**
 * Recognize a conservative single-file read and return its file operand.
 *
 * The returned path is exactly what the model wrote; callers resolve it
 * against the command's working directory. `undefined` means "do not trigger":
 * unfamiliar command, unfamiliar flag, ambiguous text, or not exactly one file.
 * @param command - the bash tool's `command` argument.
 * @returns the recognized command and file operand, or `undefined` when unsure.
 */
export function parseSingleFileReadCommand(command: string): ShellFileRead | undefined {
  const trimmed = command.trim()
  if (trimmed.length === 0) return undefined
  if (FORBIDDEN_TEXT.test(trimmed) || FORBIDDEN_CONTROL.test(trimmed)) return undefined
  const tokens = tokenize(trimmed)
  if (tokens === undefined || tokens.length === 0) return undefined
  const name = tokens[0]
  if (name === undefined) return undefined
  if (name !== 'cat' && name !== 'head' && name !== 'tail' && name !== 'sed' && name !== 'grep') {
    return undefined
  }
  const path = name === 'sed'
    ? parseSed(tokens)
    : name === 'grep'
      ? parseGrep(tokens)
      : parseSingleOperand(name, tokens)
  return path === undefined ? undefined : { command: name, path }
}
