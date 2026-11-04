/**
 * Path predicates the host half shares between the verbs, the scope hint, and
 * the working-directory watcher.
 * @module dsh-worktree-switch/host/paths
 */

import { isAbsolute, relative } from 'node:path'

/**
 * Whether one absolute directory is the path itself or an ancestor of it.
 * @param directory - candidate ancestor.
 * @param path - absolute path to test.
 * @returns true when `path` is `directory` or lives below it.
 */
export function contains(directory: string, path: string): boolean {
  const inside = relative(directory, path)
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}
