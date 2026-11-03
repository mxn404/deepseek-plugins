/**
 * Rule discovery: project-root detection, recursive rule-root traversal, and a
 * stat-validated cache so a session only re-reads content that changed.
 *
 * Discovery always re-lists the rule roots, so a rule file created mid-session
 * is found on the next batch. What it does NOT do is stat every known file on
 * every batch: {@link RuleWorkspace.snapshot} distinguishes a `full` refresh
 * (session start, where everything is validated) from a `candidates` refresh
 * (a trigger batch, where only rules that could matter are re-validated).
 *
 * @module dsh-rules/discover
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildRule, failedRule, orderRules, ruleIdentity, ruleRelativePath, type Rule } from './rule.ts'

/** Project-root marker: the nearest ancestor containing it is the project root. */
const PROJECT_ROOT_MARKER = '.git'

interface CachedRule {
  mtimeMs: number
  size: number
  rule: Rule
}

/** One discoverable rule file and the roots that own it. */
interface RuleFile {
  readonly file: string
  readonly ruleRoot: string
  readonly baseDir: string
}

/** One discovery result for a working directory. */
export interface RuleSnapshot {
  /** Resolved working directory the snapshot was taken for. */
  readonly cwd: string
  /** Project root used by discovery and display paths. */
  readonly projectRoot: string
  /** Rules ordered from the furthest ancestor to the nearest, then by path. */
  readonly rules: Rule[]
}

/**
 * How much of the cached rule set one snapshot re-validates.
 *
 * `full` reads and stats every rule file (session start). `candidates` reads
 * new files, then stats only rules whose cached content could matter for this
 * batch: pathless rules (they may become injectable always-on rules) and
 * path-scoped rules whose cached matchers hit a touched file. Everything else
 * is reused from cache without touching the filesystem. `replay` additionally
 * re-validates the rules this session already injected, so a changed or
 * deleted rule resolves from its current content.
 */
export type SnapshotRefresh =
  | { readonly refresh: 'full' }
  | { readonly refresh: 'candidates'; readonly touchedPaths: readonly string[] }
  | {
    readonly refresh: 'replay'
    readonly touchedPaths: readonly string[]
    readonly replayedPaths: readonly string[]
  }

/** Options for {@link RuleWorkspace}. */
export interface RuleWorkspaceOptions {
  /** Rule-root directory names, resolved under every ancestor directory. */
  readonly roots: readonly string[]
  /** Maximum UTF-8 bytes of one rule file. */
  readonly maxBytes: number
  /** Called once per unusable rule file. */
  readonly onInvalidRule: (rule: Rule) => void
}

/** True when `path` exists, regardless of whether it is a file or a directory. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Find the nearest ancestor of `cwd` that contains a project-root marker.
 * @param cwd - directory to start from.
 * @returns the nearest ancestor with `.git`, or `cwd` itself when there is none.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    if (await exists(join(current, PROJECT_ROOT_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive root-to-cwd directory chain.
 * @param root - root directory expected to contain or equal `cwd`.
 * @param cwd - most-specific directory in the chain.
 * @returns directories ordered from broadest to most specific.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * List every markdown file under a directory, recursively.
 *
 * Symlinks are followed; a visited-realpath set stops directory cycles. Files
 * reached through a symlink keep their link path, so a symlinked duplicate of
 * the same rule is a distinct identity, exactly as documented.
 * @param dir - directory to walk.
 * @param visited - realpaths already walked in this traversal.
 * @returns absolute markdown file paths.
 */
async function listMarkdownFiles(dir: string, visited: Set<string>): Promise<string[]> {
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return []
  }
  if (visited.has(real)) return []
  visited.add(real)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(full, visited))
      continue
    }
    if (entry.isFile()) {
      if (entry.name.endsWith('.md')) files.push(full)
      continue
    }
    if (entry.isSymbolicLink()) {
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) files.push(...await listMarkdownFiles(full, visited))
      else if (info.isFile() && entry.name.endsWith('.md')) files.push(full)
    }
  }
  return files
}

/**
 * Per-agent rule workspace: discovery plus a stat-validated content cache.
 *
 * Callers take one `full` {@link snapshot} at session start (for always-on
 * rules and the index), then one `candidates` snapshot per trigger batch and
 * one `replay` snapshot per post-compaction step.
 */
export class RuleWorkspace {
  private readonly cache = new Map<string, CachedRule>()
  private readonly reported = new Set<string>()

  constructor(private readonly options: RuleWorkspaceOptions) {}

  private report(rule: Rule): Rule {
    if (rule.status !== 'ok' && !this.reported.has(rule.absolutePath)) {
      this.reported.add(rule.absolutePath)
      this.options.onInvalidRule(rule)
    }
    return rule
  }

  private async load(file: string, ruleRoot: string, baseDir: string): Promise<Rule | undefined> {
    let info
    try {
      info = await stat(file)
    } catch {
      return undefined
    }
    if (!info.isFile()) return undefined
    const cached = this.cache.get(file)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return this.report(cached.rule)
    }
    const identity = ruleIdentity(file, ruleRoot, baseDir)
    if (info.size > this.options.maxBytes) {
      const rule = failedRule(
        identity,
        'too-large',
        `file is ${info.size} bytes, over maxBytes ${this.options.maxBytes}`,
      )
      this.cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, rule })
      return this.report(rule)
    }
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      return undefined
    }
    const rule = buildRule(identity, content)
    this.cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, rule })
    return this.report(rule)
  }

  /**
   * Whether a cached rule must be re-validated for this trigger batch.
   *
   * A pathless rule is always a candidate: its content decides whether it is an
   * injectable always-on rule. A path-scoped rule is a candidate only when its
   * cached matchers hit a touched file; a rule whose scope was broadened
   * mid-session is therefore not noticed until a `full` or `replay` refresh.
   * @param rule - cached rule.
   * @param touched - resolved absolute touched paths.
   * @returns true when the rule must be stat-validated.
   */
  private isCandidate(rule: Rule, touched: readonly string[]): boolean {
    if (rule.paths.length === 0) return true
    return touched.some((path) => {
      const rel = ruleRelativePath(rule.baseDir, path)
      return rel !== undefined && rule.matchers.some(matcher => matcher.test(rel))
    })
  }

  /**
   * List the rule files in scope for one working directory.
   * @param cwd - the agent's working directory.
   * @returns the project root and the de-duplicated rule files with their roots.
   */
  private async discover(cwd: string): Promise<{ projectRoot: string; files: RuleFile[] }> {
    const projectRoot = await findProjectRoot(cwd)
    const directories = ancestorChain(projectRoot, cwd)
    const ruleRoots: { ruleRoot: string; baseDir: string }[] = []
    const seenRoots = new Set<string>()
    for (const directory of directories) {
      for (const root of this.options.roots) {
        const ruleRoot = resolve(directory, root)
        if (seenRoots.has(ruleRoot)) continue
        seenRoots.add(ruleRoot)
        ruleRoots.push({ ruleRoot, baseDir: directory })
      }
    }
    const files: RuleFile[] = []
    const seenFiles = new Set<string>()
    for (const { ruleRoot, baseDir } of ruleRoots) {
      const found = await listMarkdownFiles(ruleRoot, new Set())
      for (const file of found) {
        if (seenFiles.has(file)) continue
        seenFiles.add(file)
        files.push({ file, ruleRoot, baseDir })
      }
    }
    return { projectRoot, files }
  }

  /**
   * Re-validate or reuse one discovered rule file.
   * @param entry - the file and its roots.
   * @param request - how much this snapshot re-validates.
   * @param touched - resolved absolute touched paths.
   * @param replayed - absolute rule paths that a replay must re-validate.
   * @returns the current rule, or `undefined` when the file vanished.
   */
  private async refreshRule(
    entry: RuleFile,
    request: SnapshotRefresh,
    touched: readonly string[],
    replayed: ReadonlySet<string>,
  ): Promise<Rule | undefined> {
    const cached = this.cache.get(entry.file)
    const validate = request.refresh === 'full'
      || cached === undefined
      || replayed.has(entry.file)
      || this.isCandidate(cached.rule, touched)
    if (validate) return this.load(entry.file, entry.ruleRoot, entry.baseDir)
    // A candidate-less cached rule is reused untouched: no stat, no read.
    return cached.rule
  }

  /**
   * Discover the rules that apply to one working directory.
   * @param cwd - the agent's working directory.
   * @param request - refresh mode for this snapshot; defaults to a full scan.
   * @returns the ordered snapshot.
   */
  async snapshot(cwd: string, request: SnapshotRefresh = { refresh: 'full' }): Promise<RuleSnapshot> {
    const { projectRoot, files } = await this.discover(cwd)
    const touched = request.refresh === 'full'
      ? []
      : request.touchedPaths.map(path => resolve(cwd, path))
    const replayed = new Set(request.refresh === 'replay' ? request.replayedPaths : [])
    const rules: Rule[] = []
    for (const entry of files) {
      const rule = await this.refreshRule(entry, request, touched, replayed)
      if (rule !== undefined) rules.push(rule)
    }
    // A rule file that disappeared (or moved out of scope) leaves the cache too.
    const listed = new Set(files.map(entry => entry.file))
    for (const file of this.cache.keys()) {
      if (!listed.has(file)) this.cache.delete(file)
    }
    return { cwd: resolve(cwd), projectRoot, rules: orderRules(rules, projectRoot) }
  }
}
