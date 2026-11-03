/**
 * Rule discovery: project-root detection, recursive rule-root traversal, and a
 * stat-validated cache so a session only re-reads content that changed.
 *
 * @module dsh-rules/discover
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildRule, failedRule, orderRules, ruleIdentity, type Rule } from './rule.ts'

/** Project-root marker: the nearest ancestor containing it is the project root. */
const PROJECT_ROOT_MARKER = '.git'

interface CachedRule {
  mtimeMs: number
  size: number
  rule: Rule
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
    /* v8 ignore next -- findProjectRoot always returns cwd or one of its ancestors. */
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
 * Callers take one {@link snapshot} at session start (for always-on rules and
 * the index) and one {@link snapshot} per trigger batch. Unchanged files are
 * reused; only new or changed candidate files are read again.
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
   * Discover the rules that apply to one working directory.
   * @param cwd - the agent's working directory.
   * @returns the ordered snapshot.
   */
  async snapshot(cwd: string): Promise<RuleSnapshot> {
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
    const files: { file: string; ruleRoot: string; baseDir: string }[] = []
    const seenFiles = new Set<string>()
    for (const { ruleRoot, baseDir } of ruleRoots) {
      const found = await listMarkdownFiles(ruleRoot, new Set())
      for (const file of found) {
        if (seenFiles.has(file)) continue
        seenFiles.add(file)
        files.push({ file, ruleRoot, baseDir })
      }
    }
    const rules: Rule[] = []
    for (const entry of files) {
      const rule = await this.load(entry.file, entry.ruleRoot, entry.baseDir)
      if (rule !== undefined) rules.push(rule)
    }
    for (const file of this.cache.keys()) {
      if (!seenFiles.has(file)) this.cache.delete(file)
    }
    return { cwd: resolve(cwd), projectRoot, rules: orderRules(rules, projectRoot) }
  }
}
