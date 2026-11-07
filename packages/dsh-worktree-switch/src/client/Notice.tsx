/**
 * The frame-level one-shot notice a leave raises.
 *
 * Turning the switch off is a promise that the copy is gone; when the host
 * kept it (it holds work, or its ownership is unprovable) or failed to delete
 * it, the switch must not fall silently to "off". This banner says what
 * happened, offers the one place where cleanup lives, and can be dismissed.
 * It sits in `shell.overlay`, so it never blocks the composer.
 * @module dsh-worktree-switch/client/Notice
 */

import type { ReactElement } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { NoticeBinding, NoticeState } from './state.ts'
import type { WorktreeToggleKey } from './locales.ts'

/** Full props of the frame-level notice. */
export type WorktreeNoticeProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<NoticeBinding>
  & PropsLocale<'worktreeToggle'>

/** One translate function bound to this plugin's namespace. */
type Translate = (key: WorktreeToggleKey, params?: Record<string, unknown>) => string

/**
 * The sentence a notice shows.
 * @param notice - what the leave reported.
 * @param t - bound translate.
 * @returns the localized explanation.
 */
export function noticeText(notice: NoticeState, t: Translate): string {
  if (notice.kind === 'failed') return t('notice.failed', { message: notice.message ?? '' })
  // Only content is an event the frame reports; a copy this session did not
  // create is left on disk as the ordinary path, explained in the switch's
  // hover instead of a banner.
  return t('notice.keptDirty', { name: notice.worktree?.name ?? '' })
}

/**
 * Render the one-shot notice.
 * @param props - overlay runtime props, the notice face, and the locale seat.
 * @returns the banner, or null while nothing happened.
 */
export function WorktreeNotice(props: WorktreeNoticeProps): ReactElement | null {
  const { useNotice, dismiss, openPanel, t } = props
  const notice = useNotice(current => current)
  if (notice === null) return null
  return (
    // The sequence key makes React replace the frame per event instead of
    // reusing one that may still be animating out with the previous text.
    <div className="dsh-wt-notice" key={notice.seq} data-kind={notice.kind} data-seq={notice.seq} role="status">
      <span
        className="dsh-wt-notice-text"
        title={notice.kind === 'kept' && notice.message !== null ? notice.message : undefined}
      >
        {noticeText(notice, t)}
      </span>
      <button type="button" className="dsh-wt-notice-open" onClick={() => { openPanel() }}>
        {t('notice.openPanel')}
      </button>
      <button
        type="button"
        className="dsh-wt-notice-dismiss"
        aria-label={t('notice.dismiss')}
        onClick={() => { dismiss() }}
      >
        ×
      </button>
    </div>
  )
}

/** The component under the name the slot registry records. */
export default WorktreeNotice
