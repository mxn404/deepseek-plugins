/**
 * Conservative PowerShell single-file read detection.
 *
 * dsh's pwsh tool reports only the command text, never the files it read, so a
 * trigger has to come from parsing that text. PowerShell's real grammar is far
 * larger than bash's, and a wrong guess would load a rule that has nothing to
 * do with what the model is working on. This parser therefore proves one narrow
 * shape instead: one `Get-Content` call (or one of its aliases) on exactly one
 * file, with no other statement and no option that could change which file is
 * read. Anything else returns `undefined`.
 *
 * Accepted shapes, with read-only options before the operand:
 *
 * - `Get-Content <file>`
 * - `Get-Content -Path <file>` / `Get-Content -LiteralPath <file>`
 * - any of the aliases `gc`, `cat`, `type` in place of the cmdlet name
 * - `-Raw`, `-Force`, and `-Encoding <name>` / `-Encoding:<name>`
 *
 * Cmdlet names, aliases, and parameter names match case-insensitively, as they
 * do in PowerShell. The file token may be single- or double-quoted and may be a
 * Windows path (drive letter, UNC, backslashes, spaces, non-ASCII). Backslashes
 * are ordinary path characters here, not escapes.
 *
 * Everything else fails closed: pipes, `;`, `&`, redirection, `$` variables,
 * backticks, wildcards (`*?[]`), comma-separated arrays, parentheses, script
 * blocks, comments, a home-directory `~`, multiple files, an unknown or
 * abbreviated parameter, an encoding name outside the known set, a quote that
 * directly follows another quote (PowerShell's doubled-quote escape), `.`/`..`,
 * a trailing separator, a drive-relative path, or an operand starting with `-`.
 *
 * The returned path is exactly what the model wrote; callers resolve it
 * against the call's working directory.
 *
 * @module dsh-path-rules/pwsh
 */

/** `Get-Content` and the aliases this parser recognizes, lowercased. */
export type PwshReadCommand = 'get-content' | 'gc' | 'cat' | 'type'

/** One recognized single-file read. */
export interface PwshFileRead {
  readonly command: PwshReadCommand
  /** File operand exactly as the model wrote it: relative or absolute. */
  readonly path: string
}

/** The cmdlet names this parser recognizes, lowercased. */
const READ_COMMANDS: ReadonlySet<PwshReadCommand> = new Set(['get-content', 'gc', 'cat', 'type'])

/**
 * Characters that make the touched path ambiguous or the command more than one
 * statement: pipelines and other statement separators, redirection, command and
 * variable substitution, wildcards, arrays, grouping, comments, home
 * directories, and a second line. The backslash is deliberately absent: it is a
 * Windows path separator, not an escape.
 */
const FORBIDDEN_TEXT = /[|&;<>`$*?\[\]{}()\n\r,#~]/

/** Control characters other than a tab, which separates tokens. */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/** Read-only switches that cannot change which file is read. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['-raw', '-force'])

/** Parameter names that supply the one file operand, lowercased. */
const PATH_FLAGS: ReadonlySet<string> = new Set(['-path', '-literalpath'])

/** `-Encoding` names PowerShell accepts, lowercased. */
const ENCODING_NAMES: ReadonlySet<string> = new Set([
  'ansi',
  'ascii',
  'bigendianunicode',
  'byte',
  'default',
  'oem',
  'unicode',
  'utf7',
  'utf8',
  'utf8bom',
  'utf8nobom',
  'utf16',
  'utf16be',
  'utf16le',
  'utf32',
])

/**
 * Split a command into PowerShell-like tokens.
 *
 * Only single and double quotes are understood. A quote may start or continue a
 * token (as in PowerShell); a quote that directly follows a closing quote is
 * rejected, because it is PowerShell's doubled-quote escape for a literal quote
 * and letting it through would guess the wrong file. Backslashes are ordinary
 * characters. An unterminated quote returns `undefined`.
 * @param command - trimmed command text.
 * @returns the tokens, or `undefined` when the text is ambiguous.
 */
function tokenize(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | undefined
  let justClosedQuote = false
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
        justClosedQuote = true
        continue
      }
      current += char
      justClosedQuote = false
      continue
    }
    if (char === "'" || char === '"') {
      if (justClosedQuote) return undefined
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
      justClosedQuote = false
      continue
    }
    current += char
    started = true
    justClosedQuote = false
  }
  if (quote !== undefined) return undefined
  if (started) tokens.push(current)
  return tokens
}

/**
 * Validate one file operand.
 *
 * Rejecting a leading dash, a directory-looking operand, `.`/`..`, and a
 * colon that is not a drive prefix keeps the trigger tied to a nameable single
 * file.
 * @param value - candidate operand.
 * @returns true when the operand can be a single file path.
 */
function isFileOperand(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false
  if (value.startsWith('-')) return false
  if (value === '.' || value === '..') return false
  if (value.endsWith('/') || value.endsWith('\\')) return false
  // A colon is legal only as an absolute drive prefix (`C:\` or `C:/`); a
  // drive-relative path and an alternate data stream are both ambiguous.
  if (value.includes(':') && !/^[A-Za-z]:[\\/]/.test(value)) return false
  return true
}

/** Whether a token names a known `-Encoding` value. */
function isEncodingName(value: string | undefined): value is string {
  return value !== undefined && ENCODING_NAMES.has(value.toLowerCase())
}

/** Result of consuming one option; the file operand is not yet known. */
type OptionStep =
  | { readonly ok: true; readonly next: number; readonly operand?: string }
  | { readonly ok: false }

/**
 * Consume one read-only option.
 * @param tokens - all tokens.
 * @param index - index of the option token.
 * @returns the next index and, for a path parameter, its operand, or a rejection.
 */
function consumeOption(tokens: readonly string[], index: number): OptionStep {
  const token = tokens[index]
  if (token === undefined) return { ok: false }
  const lower = token.toLowerCase()
  if (BOOLEAN_FLAGS.has(lower)) return { ok: true, next: index + 1 }
  if (PATH_FLAGS.has(lower)) {
    const operand = tokens[index + 1]
    return isFileOperand(operand) ? { ok: true, next: index + 2, operand } : { ok: false }
  }
  if (lower === '-encoding') {
    const value = tokens[index + 1]
    return isEncodingName(value) ? { ok: true, next: index + 2 } : { ok: false }
  }
  if (lower.startsWith('-encoding:')) {
    const value = token.slice('-encoding:'.length)
    return isEncodingName(value) ? { ok: true, next: index + 1 } : { ok: false }
  }
  return { ok: false }
}

/**
 * Recognize a conservative single-file read and return its file operand.
 *
 * The returned path is exactly what the model wrote; callers resolve it against
 * the call's working directory. `undefined` means "do not trigger": unfamiliar
 * cmdlet, unfamiliar flag, ambiguous text, or not exactly one file.
 * @param command - the pwsh tool's `command` argument.
 * @returns the recognized cmdlet and file operand, or `undefined` when unsure.
 */
export function parsePwshSingleFileReadCommand(command: string): PwshFileRead | undefined {
  const trimmed = command.trim()
  if (trimmed.length === 0) return undefined
  if (FORBIDDEN_TEXT.test(trimmed) || FORBIDDEN_CONTROL.test(trimmed)) return undefined
  const tokens = tokenize(trimmed)
  if (tokens === undefined || tokens.length === 0) return undefined
  const name = tokens[0]
  if (name === undefined) return undefined
  const lower = name.toLowerCase()
  if (!READ_COMMANDS.has(lower as PwshReadCommand)) return undefined
  let operand: string | undefined
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    if (token.startsWith('-')) {
      // Options must precede the file operand; anything else is unfamiliar.
      if (operand !== undefined) return undefined
      const step = consumeOption(tokens, index)
      if (!step.ok) return undefined
      if (step.operand !== undefined) operand = step.operand
      index = step.next
      continue
    }
    if (operand !== undefined) return undefined
    operand = token
    index += 1
  }
  if (!isFileOperand(operand)) return undefined
  return { command: lower as PwshReadCommand, path: operand }
}
