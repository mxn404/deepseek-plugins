/**
 * Path relativization shared by rule matching, discovery, and rendering.
 *
 * Rule globs, trigger reporting, and display paths all need the same notion of
 * "inside a base directory, POSIX style"; keeping one implementation stops the
 * three call sites from drifting apart.
 *
 * @module dsh-path-rules/paths
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Path of `absolutePath` under `baseDir`, POSIX-separated.
 * @param baseDir - directory the result is relative to.
 * @param absolutePath - absolute path to relativize.
 * @returns the POSIX relative path, or `undefined` when the path is outside
 * the base directory (or is the base directory itself).
 */
export function relativeInside(baseDir: string, absolutePath: string): string | undefined {
  const rel = relative(resolve(baseDir), resolve(absolutePath))
  if (rel.length === 0 || isAbsolute(rel) || rel.split(sep)[0] === '..') return undefined
  return rel.split(sep).join('/')
}
