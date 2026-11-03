/**
 * The remembered per-project choice: "this project always isolates" and
 * "this project never isolates" both need to survive a reload, and nothing
 * else about the plugin does.
 *
 * localStorage is the right home for it. The choice is a property of one
 * browser's user, not of the repository or the session log, and the two
 * alternatives (a host endpoint, the settings service) would add a round trip
 * to a decision that must be available before the switch can render.
 * @module dsh-worktree-switch/client/intent
 */

/** One storage key holds the whole map, so a project deletion cannot orphan entries. */
const STORAGE_KEY = 'dsh-worktree-switch:intent'

/** Remembered choices, keyed by repository root path. */
type IntentMap = Record<string, boolean>

/** Read the map, tolerating absent or corrupt storage. */
function readMap(): IntentMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'boolean')
    return Object.fromEntries(entries) as IntentMap
  } catch {
    return {}
  }
}

/**
 * Read the remembered choice for one project.
 * @param project - absolute repository root.
 * @returns the remembered value, or undefined when the project has none.
 */
export function readIntent(project: string): boolean | undefined {
  return readMap()[project]
}

/**
 * Remember one project's choice.
 * @param project - absolute repository root.
 * @param enabled - the value to remember.
 */
export function writeIntent(project: string, enabled: boolean): void {
  try {
    const next: IntentMap = { ...readMap(), [project]: enabled }
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage is optional: a refused write costs one remembered preference, not
    // the switch, so it keeps working for this page's lifetime.
  }
}

/** Storage key, exported for tests that assert the persisted shape. */
export const INTENT_STORAGE_KEY = STORAGE_KEY
