/**
 * Workspace discovery shared by `scripts/build.ts` and `scripts/market.ts`.
 *
 * This mirrors the rules the dsh plugin market generator uses, so a package that
 * is visible to these scripts is visible to the market as well:
 *
 * 1. A root manifest that declares `dsh.bundle` would make the generator list
 *    only the root package, so the root must never declare one.
 * 2. Packages matching `pnpm-workspace.yaml` globs are scanned; only those that
 *    declare `dsh.bundle` become installable plugins.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to the repository root. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** One manifest-bearing directory of this workspace. */
export interface WorkspacePackage {
  /** Repo-relative POSIX directory, for example `packages/dsh-foo`. */
  readonly dir: string
  /** Absolute directory. */
  readonly path: string
  /** Parsed `package.json`. */
  readonly manifest: Record<string, unknown>
}

/** Read and parse a JSON file, returning `unknown` so callers must narrow. */
export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Whether a manifest declares the bundle role that makes a package installable. */
export function isBundlePackage(manifest) {
  const dsh = manifest?.dsh
  const bundle = dsh && typeof dsh === 'object' ? dsh.bundle : undefined
  if (bundle === null || typeof bundle !== 'object') return false
  const patch = bundle.patch
  return typeof patch === 'string'
    || (Array.isArray(patch) && patch.length > 0 && patch.every(entry => typeof entry === 'string'))
}

/** The patch files a bundle package declares, relative to its own directory. */
export function bundlePatchFiles(manifest) {
  const patch = manifest.dsh.bundle.patch
  return typeof patch === 'string' ? [patch] : [...patch]
}

/** Whether a manifest declares a browser half. */
export function hasClientHalf(manifest) {
  const dsh = manifest.dsh
  const client = dsh && typeof dsh === 'object' ? dsh.client : undefined
  return client !== null && typeof client === 'object'
}

/**
 * Read the package globs from `pnpm-workspace.yaml`.
 *
 * Only the `packages:` list is read, which is all this repository uses. Negated
 * globs are dropped rather than applied: the market generator ignores them too,
 * so package visibility must not depend on them.
 *
 * @returns the glob patterns, without leading `./` or trailing `/`.
 */
export async function workspaceGlobs() {
  const text = await readFile(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const globs = []
  let inPackages = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^[A-Za-z]/.test(line)) {
      inPackages = /^packages\s*:/.test(line.trim())
      continue
    }
    if (!inPackages) continue
    const match = /^-\s*(.+)$/.exec(line.trim())
    if (match === null) continue
    const glob = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/\/+$/, '')
    if (glob !== '' && !glob.startsWith('!')) globs.push(glob)
  }
  return globs
}

/**
 * Expand one glob segment by segment. A segment is either a literal directory
 * name or a `*` wildcard; `**` is not used by this workspace and is rejected
 * loudly rather than silently matching nothing.
 *
 * @param glob - one pattern from `pnpm-workspace.yaml`.
 * @returns repo-relative POSIX directories that exist.
 */
async function expandGlob(glob) {
  let current = ['']
  for (const segment of glob.split('/').filter(part => part !== '' && part !== '.')) {
    if (segment === '**') throw new Error(`scripts: '**' is not supported in workspace glob "${glob}"`)
    const next = []
    for (const prefix of current) {
      if (segment === '*') {
        const base = join(REPO_ROOT, prefix)
        if (!existsSync(base)) continue
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === 'node_modules') continue
          next.push(prefix === '' ? entry.name : `${prefix}/${entry.name}`)
        }
      } else {
        const candidate = prefix === '' ? segment : `${prefix}/${segment}`
        if (existsSync(join(REPO_ROOT, candidate))) next.push(candidate)
      }
    }
    current = next
  }
  return current
}

/**
 * List every workspace package that has a readable `package.json`, sorted by
 * directory.
 *
 * @returns the packages.
 */
export async function listPackages() {
  const dirs = new Set()
  for (const glob of await workspaceGlobs()) {
    for (const dir of await expandGlob(glob)) dirs.add(dir)
  }
  const packages = []
  for (const dir of [...dirs].sort()) {
    const path = join(REPO_ROOT, dir)
    const manifestPath = join(path, 'package.json')
    if (!existsSync(manifestPath)) continue
    packages.push({ dir, path, manifest: await readJson(manifestPath) })
  }
  return packages
}
