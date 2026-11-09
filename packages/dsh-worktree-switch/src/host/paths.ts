/**
 * Path predicates the host half shares between the verbs, the scope hint, and
 * the working-directory watcher.
 *
 * The platform comes in explicitly for the same reason as in `./platform.ts`:
 * the guard's Windows decision is tested on Linux, and a path predicate that
 * silently uses POSIX semantics would read every Windows path as "outside the
 * project". Callers that have no test-driven platform pass nothing; the
 * default follows the host.
 * @module dsh-worktree-switch/host/paths
 */

import { posix, win32 } from 'node:path'
import { hostPlatform } from './platform.ts'
import type { HostPlatform } from './platform.ts'

/**
 * Whether one absolute directory is the path itself or an ancestor of it.
 * @param directory - candidate ancestor.
 * @param path - absolute path to test.
 * @param platform - path dialect; defaults to the host's.
 * @returns true when `path` is `directory` or lives below it.
 */
export function contains(
  directory: string,
  path: string,
  platform: HostPlatform = hostPlatform(),
): boolean {
  const api = platform === 'win32' ? win32 : posix
  const inside = api.relative(directory, path)
  return inside === '' || (!inside.startsWith('..') && !api.isAbsolute(inside))
}
