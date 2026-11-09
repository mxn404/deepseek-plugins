/**
 * Rule format and pure matching.
 *
 * A rule is one markdown file under a rule root. Its optional YAML
 * frontmatter carries a `paths` list; the body is what reaches the model.
 * Parsing and matching are pure so the format contract can be tested without
 * an agent loop.
 *
 * @module dsh-path-rules/rule
 */

import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { relativeInside } from './paths.ts'

/** Why a rule cannot participate in injection. */
export type RuleStatus = 'ok' | 'parse-error' | 'too-large' | 'pattern-error'

/** One discovered rule, ready for rendering and matching. */
export interface Rule {
  /** Absolute rule-file path used for display; {@link identityKey} is the dedupe identity. */
  readonly absolutePath: string
  /** Dedupe/seen-map identity: case-folded on win32; display keeps {@link absolutePath}. */
  readonly identityKey: string
  /** Absolute rule root that contained the file. */
  readonly ruleRoot: string
  /** Directory `paths` globs resolve against: the rule root's parent. */
  readonly baseDir: string
  /** Path inside the rule root without the `.md` extension, POSIX separators. */
  readonly name: string
  /** Normalized path globs; empty means an always-on rule. */
  readonly paths: readonly string[]
  /** Body with frontmatter stripped. */
  readonly body: string
  /** First line of the body, used by the rule index when it fits. */
  readonly title: string
  /** Digest of the file content; changes whenever the rule changes. */
  readonly version: string
  readonly status: RuleStatus
  /** Why {@link status} is not `ok`; empty when the rule is usable. */
  readonly reason: string
  /** Compiled matchers for {@link paths}; empty unless `status` is `ok`. */
  readonly matchers: readonly RegExp[]
}

/** Stable identity derived from where a rule file lives. */
export interface RuleIdentity {
  /** Absolute rule-file path used for display. */
  readonly absolutePath: string
  /** Dedupe/seen-map identity: case-folded on win32; display keeps {@link absolutePath}. */
  readonly identityKey: string
  readonly ruleRoot: string
  readonly baseDir: string
  readonly name: string
}

/**
 * Key a rule file is deduplicated by: the absolute path, case-folded and
 * slash-normalized on win32, where the filesystem is case-insensitive. Display
 * paths stay as written; this key only feeds dedupe and the per-agent seen map.
 * @param absolutePath - absolute rule-file path, ideally its realpath.
 * @param platform - platform that decides the folding; defaults to `process.platform`.
 * @returns the dedupe key; identical to `absolutePath` off win32.
 */
export function ruleIdentityKey(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return absolutePath
  return absolutePath.replaceAll('\\', '/').toLowerCase()
}

/** Options for {@link ruleIdentity}. */
export interface RuleIdentityOptions {
  /** Platform that decides identity folding; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /**
   * Canonical file path used only for {@link RuleIdentity.identityKey} (a
   * Windows realpath); the display path stays {@link RuleIdentity.absolutePath}.
   */
  readonly canonicalPath?: string
}

/**
 * Derive a rule's identity from its absolute file path, rule root, and base.
 *
 * `paths` globs resolve against {@link RuleIdentity.baseDir}: the directory
 * that owns the rule root (the project root, or the ancestor whose `.dsh`
 * directory contributed the root). Moving `.dsh/rules` to an ancestor keeps
 * the same globs valid.
 * @param absolutePath - absolute path of the rule file.
 * @param ruleRoot - absolute rule root that contains it.
 * @param baseDir - directory the rule root name was resolved against.
 * @param options - identity-folding options; the display path is unaffected.
 * @returns the identity fields shared by usable and failed rules.
 */
export function ruleIdentity(
  absolutePath: string,
  ruleRoot: string,
  baseDir: string,
  options: RuleIdentityOptions = {},
): RuleIdentity {
  const insideRoot = relative(ruleRoot, absolutePath)
  const withoutExtension = /\.md$/i.test(insideRoot) ? insideRoot.slice(0, -'.md'.length) : insideRoot
  return {
    absolutePath,
    identityKey: ruleIdentityKey(options.canonicalPath ?? absolutePath, options.platform),
    ruleRoot,
    baseDir: resolve(baseDir),
    name: withoutExtension.split(sep).join('/'),
  }
}

/** Successful parse result. */
export interface ParsedRuleMarkdown {
  readonly status: 'ok'
  readonly paths: string[]
  readonly body: string
  readonly title: string
}

/** Failed parse result. */
export interface UnparseableRuleMarkdown {
  readonly status: 'parse-error'
  readonly reason: string
}

/** Outcome of {@link parseRuleMarkdown}. */
export type RuleMarkdown = ParsedRuleMarkdown | UnparseableRuleMarkdown

const FRONTMATTER_OPEN = /^---[ \t]*\r?\n/
const FRONTMATTER_CLOSE = /^---[ \t]*(?:\r?\n|$)/m

function normalizedPaths(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return []
  if (typeof raw === 'string') {
    return raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
  }
  if (!Array.isArray(raw)) {
    return { error: '`paths` must be a comma-separated string or a list of strings' }
  }
  const paths: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { error: '`paths` must be a comma-separated string or a list of strings' }
    }
    const trimmed = entry.trim()
    if (trimmed.length > 0) paths.push(trimmed)
  }
  return paths
}

function firstLineTitle(body: string): string {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.replace(/^#+\s*/, '').trim().slice(0, 120)
}

/**
 * Parse one rule markdown document.
 *
 * Unknown frontmatter fields are ignored. A frontmatter block that exists but
 * cannot be read as a YAML mapping, or whose `paths` is not a string/list of
 * strings, fails closed: the whole rule is unusable.
 * @param content - raw rule-file content.
 * @returns the parsed body and path globs, or the parse error reason.
 */
export function parseRuleMarkdown(content: string): RuleMarkdown {
  const source = content.startsWith('\uFEFF') ? content.slice(1) : content
  const open = FRONTMATTER_OPEN.exec(source)
  if (open === null) {
    const body = source.trim()
    return { status: 'ok', paths: [], body, title: firstLineTitle(body) }
  }
  const rest = source.slice(open[0].length)
  const close = FRONTMATTER_CLOSE.exec(rest)
  if (close === null) {
    return { status: 'parse-error', reason: 'unterminated frontmatter block' }
  }
  const frontmatterText = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length).trim()
  if (frontmatterText.trim().length === 0) {
    return { status: 'ok', paths: [], body, title: firstLineTitle(body) }
  }
  let data: unknown
  try {
    data = parseYaml(frontmatterText)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'parse-error', reason: `invalid YAML frontmatter: ${message.split('\n')[0] ?? message}` }
  }
  if (data === null || data === undefined) {
    return { status: 'ok', paths: [], body, title: firstLineTitle(body) }
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'parse-error', reason: 'frontmatter must be a YAML mapping' }
  }
  const paths = normalizedPaths((data as Record<string, unknown>).paths)
  if (!Array.isArray(paths)) {
    return { status: 'parse-error', reason: paths.error }
  }
  return { status: 'ok', paths, body, title: firstLineTitle(body) }
}

/** Most alternatives one `paths` pattern may expand to before failing closed. */
export const MAX_GLOB_ALTERNATIVES = 256

/**
 * Expand `{a,b}` alternatives in one glob pattern.
 * @param pattern - pattern to expand.
 * @param limit - maximum number of alternatives.
 * @returns the expanded patterns, or `undefined` when the expansion exceeds the limit.
 */
export function expandGlobBraces(pattern: string, limit = MAX_GLOB_ALTERNATIVES): string[] | undefined {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  let close = -1
  const commas: number[] = []
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    } else if (char === ',' && depth === 1) commas.push(index)
  }
  // An unmatched brace is a literal character, matching ordinary glob behavior.
  if (close < 0) return [pattern]
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  const alternatives: string[] = []
  let start = open + 1
  for (const comma of commas) {
    alternatives.push(pattern.slice(start, comma))
    start = comma + 1
  }
  alternatives.push(pattern.slice(start, close))
  const expanded: string[] = []
  for (const alternative of alternatives) {
    const nested = expandGlobBraces(prefix + alternative + suffix, limit)
    if (nested === undefined) return undefined
    expanded.push(...nested)
    if (expanded.length > limit) return undefined
  }
  return expanded
}

const REGEXP_SPECIAL = new Set(['\\', '^', '$', '.', '|', '+', '(', ')', '[', ']', '{', '}', '?', '*'])

function escapeRegexLiteral(char: string): string {
  return REGEXP_SPECIAL.has(char) ? `\\${char}` : char
}

function globToRegexSource(pattern: string): string {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === undefined) break
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          // `**/` matches zero or more complete path segments.
          source += '(?:[^/]+/)*'
          index += 3
        } else {
          source += '.*'
          index += 2
        }
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) {
        source += '\\['
        index += 1
        continue
      }
      let body = pattern.slice(index + 1, end)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      source += `[${body.replaceAll('\\', '\\\\')}]`
      index = end + 1
      continue
    }
    source += escapeRegexLiteral(char)
    index += 1
  }
  return `^${source}$`
}

/** Result of compiling one path pattern. */
export type CompiledGlob =
  | { readonly ok: true; readonly matchers: RegExp[] }
  | { readonly ok: false; readonly reason: string }

/** Options for glob compilation and rule building. */
export interface CompileGlobOptions {
  /** Match paths case-insensitively; the Windows platform passes true. */
  readonly caseInsensitive?: boolean
}

/**
 * Compile one `paths` glob into regular expressions.
 *
 * Globs always use `/` as the separator: backslashes are normalized to `/`
 * before compiling, so a Windows author's `web\\**` means the same thing as
 * `web/**` instead of compiling to a literal backslash that never matches.
 * @param pattern - one path glob, relative to the rule root's parent.
 * @param options - matching policy; POSIX callers omit it and stay case-sensitive.
 * @returns matchers for the expanded pattern, or the reason it fails closed.
 */
export function compileGlob(pattern: string, options: CompileGlobOptions = {}): CompiledGlob {
  const slashPath = pattern.replaceAll('\\', '/')
  const normalized = slashPath.startsWith('./') ? slashPath.slice(2) : slashPath
  const expanded = expandGlobBraces(normalized)
  if (expanded === undefined) {
    return { ok: false, reason: `\`${pattern}\` expands beyond ${MAX_GLOB_ALTERNATIVES} alternatives` }
  }
  const matchers: RegExp[] = []
  for (const alternative of expanded) {
    try {
      matchers.push(new RegExp(
        globToRegexSource(alternative),
        options.caseInsensitive === true ? 'i' : undefined,
      ))
    } catch (error: unknown) {
      return { ok: false, reason: `\`${pattern}\` is not a valid glob: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { ok: true, matchers }
}

function contentVersion(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

/**
 * Build a usable rule from file content.
 * @param identity - location identity of the rule.
 * @param content - raw rule-file content.
 * @param options - matching policy; POSIX callers omit it and stay case-sensitive.
 * @returns the rule, failed closed when parsing or pattern compilation fails.
 */
export function buildRule(identity: RuleIdentity, content: string, options: CompileGlobOptions = {}): Rule {
  const version = contentVersion(content)
  const parsed = parseRuleMarkdown(content)
  if (parsed.status !== 'ok') {
    return { ...identity, paths: [], body: '', title: '', version, status: 'parse-error', reason: parsed.reason, matchers: [] }
  }
  const matchers: RegExp[] = []
  for (const pattern of parsed.paths) {
    const compiled = compileGlob(pattern, options)
    if (!compiled.ok) {
      return {
        ...identity,
        paths: parsed.paths,
        body: parsed.body,
        title: parsed.title,
        version,
        status: 'pattern-error',
        reason: compiled.reason,
        matchers: [],
      }
    }
    matchers.push(...compiled.matchers)
  }
  return {
    ...identity,
    paths: parsed.paths,
    body: parsed.body,
    title: parsed.title,
    version,
    status: 'ok',
    reason: '',
    matchers,
  }
}

/**
 * Build a rule that failed before its content could be used.
 * @param identity - location identity of the rule.
 * @param status - the failure status.
 * @param reason - one-line explanation surfaced in the index and logs.
 * @returns a non-injectable rule.
 */
export function failedRule(identity: RuleIdentity, status: Exclude<RuleStatus, 'ok'>, reason: string): Rule {
  return { ...identity, paths: [], body: '', title: '', version: '', status, reason, matchers: [] }
}

/**
 * Path of an absolute file relative to a rule's base directory, POSIX style.
 * @param baseDir - the rule root's parent directory.
 * @param absolutePath - absolute path to relativize.
 * @returns the POSIX relative path, or `undefined` when the file is outside the base directory.
 */
export function ruleRelativePath(baseDir: string, absolutePath: string): string | undefined {
  return relativeInside(baseDir, absolutePath)
}

/** One rule selected by a trigger, with the touched files that selected it. */
export interface RuleMatch {
  /** The matching path-scoped rule. */
  readonly rule: Rule
  /** Sorted absolute paths from this batch that fall inside the rule's scope. */
  readonly triggeredBy: readonly string[]
}

/**
 * Match touched files against path-scoped rules.
 *
 * Pure: the same rules, touched paths, and working directory always produce
 * the same ordered hit records. Rules without `paths` are always-on and never
 * returned here.
 * @param rules - rules in deterministic order.
 * @param touchedPaths - absolute or cwd-relative paths the agent touched.
 * @param cwd - directory relative touched paths resolve against.
 * @returns one hit per matching rule, in input order, naming every triggering
 * file exactly once.
 */
export function matchRules(rules: readonly Rule[], touchedPaths: readonly string[], cwd: string): RuleMatch[] {
  const resolved = [...new Set(touchedPaths.map(path => isAbsolute(path) ? resolve(path) : resolve(cwd, path)))]
  const matched: RuleMatch[] = []
  for (const rule of rules) {
    if (rule.status !== 'ok' || rule.paths.length === 0) continue
    const triggeredBy: string[] = []
    for (const path of resolved) {
      const rel = ruleRelativePath(rule.baseDir, path)
      if (rel !== undefined && rule.matchers.some(matcher => matcher.test(rel))) triggeredBy.push(path)
    }
    if (triggeredBy.length > 0) matched.push({ rule, triggeredBy: triggeredBy.sort() })
  }
  return matched
}

/**
 * Order rules from the furthest ancestor to the nearest, then by path.
 * @param rules - rules in any order.
 * @param projectRoot - project root that anchors ancestor distance.
 * @returns a new deterministic array.
 */
export function orderRules(rules: readonly Rule[], projectRoot: string): Rule[] {
  const distance = (rule: Rule): number => {
    const rel = relative(projectRoot, rule.ruleRoot)
    if (rel.startsWith('..') || isAbsolute(rel)) return Number.MAX_SAFE_INTEGER
    return rel.length === 0 ? 0 : rel.split(sep).length
  }
  return [...rules].sort((left, right) => {
    const byDistance = distance(left) - distance(right)
    if (byDistance !== 0) return byDistance
    if (left.absolutePath === right.absolutePath) return 0
    return left.absolutePath < right.absolutePath ? -1 : 1
  })
}
