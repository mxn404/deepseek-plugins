/**
 * The persistent `⎇ branch` badge in the session header.
 *
 * The switch only exists on the blank-session hero, so once the first prompt is
 * sent nothing on the page said whether this session runs in a copy. The badge
 * fills that seat for non-blank sessions: it is quiet outside a copy, follows
 * the live working directory (changing into or out of a copy), and opens the
 * panel with the current copy highlighted.
 * @module dsh-worktree-switch/client/Badge
 */

import { useEffect, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { BadgeBinding, ScopeState } from './state.ts'
import type { WorktreeToggleKey } from './locales.ts'

/** Full props of the header badge. */
export type WorktreeBadgeProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<BadgeBinding>
  & PropsLocale<'worktreeToggle'>

/** One translate function bound to this plugin's namespace. */
type Translate = (key: WorktreeToggleKey, params?: Record<string, unknown>) => string

/**
 * The hover text: exactly where this session runs, and how much is uncommitted.
 * @param state - the current scope answer.
 * @param t - bound translate.
 * @returns tooltip text, empty when there is no copy.
 */
export function badgeHint(state: ScopeState, t: Translate): string {
  if (state.worktree === null) return ''
  return t('badge.hint', {
    path: state.worktree.path,
    root: state.repositoryRoot ?? '',
    count: state.changedFiles,
  })
}

/**
 * Render the session header badge.
 * @param props - slot runtime props, the badge face, and the locale seat.
 * @returns the badge, or null while the host is checking or outside a copy.
 */
export function WorktreeBadge(props: WorktreeBadgeProps): ReactElement | null {
  const { useSession, useProjection, useScope, query, open, t } = props
  const blank = useSession(session => session.blank)
  // The host records the effective directory as a projection; a change here is
  // the only moment the answer can go stale (cd into or out of a copy).
  const workingDirectory = useProjection('workingDirectory')
  const state = useScope(current => current)

  useEffect(() => {
    // The blank hero already has the switch; asking the host from there would
    // duplicate the same answer for a state that never shows a badge.
    if (blank) return
    query()
  }, [blank, query, workingDirectory])

  if (blank || state.phase !== 'in' || state.worktree === null) return null

  // A detached copy has no branch, and its directory name is not one: say so
  // instead of putting a name under the branch glyph.
  const label = state.worktree.branch === null
    ? t('badge.detached')
    : t('badge.label', { branch: state.worktree.branch })
  const hint = badgeHint(state, t)
  return (
    <span
      className="dsh-wt-badge"
      data-phase={state.phase}
      data-branch={state.worktree.branch ?? ''}
      data-hint={hint}
    >
      <Tooltip label={hint} side="top" delayMs={300}>
        <span className="dsh-wt-anchor">
          <button
            type="button"
            className="dsh-wt-badge-button"
            aria-label={label}
            onClick={() => { open() }}
          >
            {label}
          </button>
        </span>
      </Tooltip>
    </span>
  )
}

/** The component under the name the slot registry records. */
export default WorktreeBadge
