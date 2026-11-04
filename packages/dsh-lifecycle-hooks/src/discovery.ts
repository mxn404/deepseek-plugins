/**
 * Where a Session's hooks come from: the user-level file plus the project
 * layers that apply to the Session's current directory.
 *
 * Three layers exist, and they all append:
 *
 * - **user** — `${DSH_HOME:-~/.dsh}/hooks.json`, the machine-wide defaults;
 * - **project** — every `.dsh/hooks.json` on the way from the nearest `.git`
 *   root down to the Session's current directory;
 * - **local** — the `.dsh/hooks.local.json` beside each project file, for
 *   personal overrides that stay out of git.
 *
 * Merge order is user first, then the project chain from the furthest ancestor
 * to the nearest directory, `hooks.json` before `hooks.local.json` within one
 * directory. `DSH_HOME` is read on every resolve, so a test (or a profile
 * switch) can retarget the user layer without remounting the plugin.
 *
 * Discovery is pure filesystem inspection: it lists candidate paths and reports
 * which directories exist, so the owner can watch them. Reading and validating
 * a layer stays in {@link HookSources}; a missing file is not an error and
 * produces no warning.
 *
 * @module dsh-lifecycle-hooks/discovery
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HookSources, type HookSnapshot, type HookSourcesOptions } from './hooks-file.ts'

/** Which of the three layers a candidate file belongs to. */
export type HookLayer = 'user' | 'project' | 'local'

/** One candidate hooks file, tagged with the layer that produced it. */
export interface HookSource {
  /** Absolute path of the file; it may not exist. */
  readonly source: string
  readonly layer: HookLayer
}

/** Layer switches from the row config. */
export interface HookLayers {
  /** Include `${DSH_HOME:-~/.dsh}/hooks.json`. */
  readonly userHooks: boolean
  /** Include every `.dsh/hooks.json` on the ancestor chain. */
  readonly projectHooks: boolean
  /** Include every `.dsh/hooks.local.json` on the ancestor chain. */
  readonly localHooks: boolean
}

/** Path of a project layer, relative to its directory. */
export const PROJECT_HOOKS_PATH = join('.dsh', 'hooks.json')

/** Path of a local layer, relative to its directory. */
export const LOCAL_HOOKS_PATH = join('.dsh', 'hooks.local.json')

/** Project-root marker: the nearest ancestor containing it bounds discovery. */
const PROJECT_MARKER = '.git'

/** Environment variable that relocates the user-level dsh home. */
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * The user-level hooks file for the current environment.
 * @param env - environment to read; defaults to `process.env` at call time.
 * @returns absolute `${DSH_HOME:-~/.dsh}/hooks.json`.
 */
export function userHooksSource(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DSH_HOME_ENV]?.trim()
  const home = configured !== undefined && configured.length > 0
    ? resolve(configured)
    : join(homedir(), '.dsh')
  return join(home, 'hooks.json')
}

/** True when anything exists at `path` (a `.git` file counts, as in worktrees). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Nearest ancestor of `cwd` that holds a project marker.
 * @param cwd - directory to start from.
 * @returns the nearest ancestor containing `.git`, or `undefined` when none does.
 */
export async function findProjectRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd)
  for (;;) {
    if (await exists(join(current, PROJECT_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * The inclusive directory chain from a project root down to `cwd`.
 * @param root - directory that bounds discovery; expected to contain `cwd`.
 * @param cwd - the Session's current directory.
 * @returns directories ordered broadest to most specific. When `cwd` is not
 * under `root`, only `cwd` is returned, so discovery never reads outside the
 * Session's own tree.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const resolvedRoot = resolve(root)
  const chain: string[] = []
  let current = resolve(cwd)
  for (;;) {
    chain.push(current)
    if (current === resolvedRoot) return chain.reverse()
    const parent = dirname(current)
    if (parent === current) return [resolve(cwd)]
    current = parent
  }
}

/**
 * Candidate hook files for one directory, in merge order.
 * @param cwd - the Session's current directory.
 * @param layers - which layers the row config enabled.
 * @returns the candidate paths, user first, without duplicates.
 */
export async function discoverHookSources(cwd: string, layers: HookLayers): Promise<HookSource[]> {
  const candidates: HookSource[] = []
  const seen = new Set<string>()
  const add = (source: string, layer: HookLayer): void => {
    const absolute = resolve(source)
    if (seen.has(absolute)) return
    seen.add(absolute)
    candidates.push({ source: absolute, layer })
  }
  if (layers.userHooks) add(userHooksSource(), 'user')
  if (!layers.projectHooks && !layers.localHooks) return candidates
  // Without a project marker there is no ancestor chain to walk: the Session's
  // own directory is the only project layer.
  const projectRoot = await findProjectRoot(cwd)
  const directories = projectRoot === undefined ? [resolve(cwd)] : ancestorChain(projectRoot, cwd)
  for (const directory of directories) {
    if (layers.projectHooks) add(join(directory, PROJECT_HOOKS_PATH), 'project')
    if (layers.localHooks) add(join(directory, LOCAL_HOOKS_PATH), 'local')
  }
  return candidates
}

/** One Session's resolved hook layers plus the directories worth watching. */
export interface ResolvedHooks {
  /** Usable layers, in merge order; a layer with no file is absent. */
  readonly layers: readonly HookSnapshot[]
  /** Existing directories that hold a candidate file, for the watcher. */
  readonly directories: readonly string[]
}

/** Everything {@link HookResolver} needs from its owner. */
export interface HookResolverOptions extends HookSourcesOptions, HookLayers {}

/**
 * Resolves the layered hook set for a directory.
 *
 * Caching belongs to {@link HookSources}: each file is re-stat-ed before it is
 * used, so an edited, created, or deleted file is seen on the next resolve
 * whether or not the watcher reported it.
 */
export class HookResolver {
  private readonly files: HookSources

  /** @param options - timeout, warning sink, and layer switches. */
  constructor(private readonly options: HookResolverOptions) {
    this.files = new HookSources(options)
  }

  /**
   * Resolve every enabled layer for one directory.
   * @param cwd - the Session's current directory.
   * @returns the usable layers in merge order and the directories to watch.
   */
  async resolve(cwd: string): Promise<ResolvedHooks> {
    const candidates = await discoverHookSources(cwd, this.options)
    const layers: HookSnapshot[] = []
    for (const candidate of candidates) {
      const snapshot = await this.files.load(candidate.source)
      if (snapshot !== undefined) layers.push(snapshot)
    }
    return { layers, directories: await watchDirectories(candidates) }
  }

  /**
   * Directories worth watching for one directory, without parsing any file.
   * Used when a Session changes directory, so the watcher follows the new tree
   * before the next event arrives.
   * @param cwd - the Session's current directory.
   * @returns existing directories that hold a candidate layer file.
   */
  async directories(cwd: string): Promise<string[]> {
    return watchDirectories(await discoverHookSources(cwd, this.options))
  }

  /**
   * Re-read a file the watcher reported, keeping the layer's last valid parse
   * when the new content is broken. Correctness never depends on this call:
   * {@link resolve} re-stats every candidate anyway.
   * @param source - absolute path the watcher reported, or `undefined` for all.
   */
  async refresh(source?: string): Promise<void> {
    await this.files.refresh(source)
  }
}

/**
 * Existing directories that hold candidate files.
 * @param candidates - discovery result, in merge order.
 * @returns unique directories, in discovery order.
 */
async function watchDirectories(candidates: readonly HookSource[]): Promise<string[]> {
  const directories: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const directory = dirname(candidate.source)
    if (seen.has(directory)) continue
    seen.add(directory)
    if (await exists(directory)) directories.push(directory)
  }
  return directories
}
