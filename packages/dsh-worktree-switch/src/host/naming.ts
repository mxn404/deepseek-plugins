/**
 * Names for the copy a session gets: lowercase words and a short suffix, so a
 * branch, a directory, a `git branch` row and this plugin's UI all read the
 * same. No prefix: the pool path already says where it lives.
 * @module dsh-worktree-switch/host/naming
 */

/** First word of a generated name. */
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'crisp', 'eager', 'faint', 'fresh',
  'gentle', 'happy', 'hollow', 'kind', 'lively', 'mellow', 'nimble', 'polite',
  'quiet', 'rapid', 'ready', 'silent', 'soft', 'solid', 'steady', 'sunny',
  'swift', 'tidy', 'vivid', 'warm', 'wise', 'young',
] as const

/** Second word of a generated name. */
const NOUNS = [
  'anchor', 'atlas', 'badger', 'birch', 'brook', 'cedar', 'comet', 'coral',
  'delta', 'ember', 'fern', 'field', 'finch', 'glade', 'harbor', 'heron',
  'island', 'lark', 'ledge', 'maple', 'meadow', 'otter', 'pebble', 'pine',
  'quartz', 'river', 'shore', 'stone', 'trail', 'willow',
] as const

/**
 * Generate one candidate worktree name.
 * @param random - uniform source in `[0, 1)`; injectable for deterministic tests.
 * @returns a lowercase, hyphen-joined branch-safe name such as `quiet-harbor-3fa9`.
 */
export function worktreeName(random: () => number = Math.random): string {
  const pick = (values: readonly string[]): string => {
    const index = Math.min(values.length - 1, Math.floor(random() * values.length))
    return values[index] ?? values[0] ?? 'copy'
  }
  const suffix = Math.min(0xffff, Math.floor(random() * 0x10000)).toString(16).padStart(4, '0')
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`
}

/** A pool entry name is exactly one path segment, as `git worktree` names it. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The shape this plugin generates: two lowercase words and four hex digits. */
const GENERATED_PATTERN = /^[a-z]+-[a-z]+-[0-9a-f]{4}$/

/**
 * Whether a branch name looks like one this plugin generated.
 *
 * Leftover-branch cleanup only offers names of this shape: an ordinary feature
 * branch is never a candidate, even when no checkout holds it.
 * @param value - candidate branch name.
 * @returns true for the generated-name format.
 */
export function isGeneratedName(value: string): boolean {
  return GENERATED_PATTERN.test(value)
}

/**
 * Validate a worktree name received from the browser before it reaches Git.
 * @param value - candidate name.
 * @returns true for one plain path segment that Git also accepts as a branch.
 */
export function isWorktreeName(value: string): boolean {
  return NAME_PATTERN.test(value) && !value.endsWith('.lock')
}
