/**
 * The New Session switch.
 *
 * The slot it occupies (`conversation.input.left`) renders in the composer of
 * every open session, and gives its occupant no `variant`; the blank-session
 * hero is instead recognised from the session itself, exactly as the shell
 * recognises it: a session whose list summary says blank and whose history is
 * open. Outside that state this component renders nothing at all — the spec's
 * "no greyed remnant" — and it releases the composer block it raised.
 * @module dsh-worktree-switch/client/Chip
 */

import { useEffect, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ChipBinding, ToggleState } from './state.ts'
import type { WorktreeToggleKey } from './locales.ts'

/** Full props of the switch. */
export type WorktreeChipProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<ChipBinding>
  & PropsLocale<'worktreeToggle'>

/** One translate function bound to this plugin's namespace. */
type Translate = (key: WorktreeToggleKey, params?: Record<string, unknown>) => string

/**
 * The line the switch shows.
 * @param state - current state.
 * @param t - bound translate.
 * @returns visible label.
 */
export function chipLabel(state: ToggleState, t: Translate): string {
  switch (state.phase) {
    case 'checking': return t('chip.checking')
    case 'off': return t('chip.off')
    case 'creating': return t('chip.creating')
    case 'reverting': return t('chip.reverting')
    case 'ready': return t('chip.ready', { name: state.worktree?.name ?? '' })
    case 'failed': return t('chip.failed')
    case 'disabled': return t('chip.disabled')
  }
}

/**
 * The hover text: why the switch is where it is, and what the copy is.
 * @param state - current state.
 * @param t - bound translate.
 * @returns tooltip text.
 */
export function chipHint(state: ToggleState, t: Translate): string {
  switch (state.phase) {
    case 'checking': return t('chip.hint.checking')
    case 'off': return t('chip.hint.off')
    case 'creating': return t('chip.hint.creating')
    case 'reverting': return t('chip.hint.reverting')
    case 'ready': {
      const parts = [t('chip.hint.ready', {
        branch: state.worktree?.branch ?? '',
        path: state.worktree?.path ?? '',
      })]
      if (state.base?.kind === 'fallback') parts.push(t('chip.hint.baseFallback'))
      if (!state.intent) parts.push(t('chip.hint.intentOff', { name: state.worktree?.name ?? '' }))
      if (state.sourceDirty > 0) parts.push(t('chip.hint.dirty', { count: state.sourceDirty }))
      if (state.error !== null) parts.push(state.error)
      return parts.join(' ')
    }
    case 'failed': {
      const base = t('chip.hint.failed')
      return state.error === null ? base : `${base} ${state.error}`
    }
    case 'disabled': return t('chip.hint.disabled')
  }
}

/**
 * Render the Worktree switch.
 * @param props - slot runtime props, the binding face, and the locale seat.
 * @returns the switch, or null outside the blank-session hero.
 */
export function WorktreeChip(props: WorktreeChipProps): ReactElement | null {
  const { useSession, useToggle, ensure, setIntent, retry, block, t } = props
  const hero = useSession(session => session.blank && session.openState === 'open')
  const state = useToggle(current => current)

  // The slot renders in every open session's composer; only the blank-session
  // hero may create a copy, so the first round trip waits for that state.
  useEffect(() => {
    if (hero) ensure()
  }, [ensure, hero])

  useEffect(() => {
    if (!hero) {
      block(null)
      return
    }
    // The copy must exist before the first prompt can leave; while the host is
    // still answering, while a copy the switch promised is being created, or
    // while the switch is moving the session back out of one, the composer
    // stays inert. Turning the switch off is the explicit way out, and the
    // disabled face is not a promise of isolation.
    const reason = state.phase === 'checking'
      ? t('chip.blocked.checking')
      : state.phase === 'creating'
        ? t('chip.blocked.creating')
        : state.phase === 'reverting'
          ? t('chip.blocked.reverting')
          : state.phase === 'failed' && state.intent ? t('chip.blocked.failed') : null
    block(reason)
  }, [block, hero, state.intent, state.phase, t])

  // The copy is created before the first prompt, so leaving the hero without
  // clearing the block would leave a stale, unexplained inert composer.
  useEffect(() => () => { block(null) }, [block])

  if (!hero) return null

  const hint = chipHint(state, t)
  const locked = state.phase === 'checking' || state.phase === 'disabled' || state.phase === 'reverting'
  return (
    <div
      className="dsh-wt-chip"
      data-phase={state.phase}
      data-intent={state.intent ? 'on' : 'off'}
      data-hint={hint}
    >
      <Tooltip label={hint} side="top" delayMs={200}>
        <span className="dsh-wt-anchor">
          <button
            type="button"
            role="switch"
            aria-checked={state.intent}
            aria-label={t('chip.label')}
            className="dsh-wt-switch"
            data-phase={state.phase}
            disabled={locked}
            onClick={() => { setIntent(!state.intent) }}
          >
            <span className="dsh-wt-dot" aria-hidden="true" />
            <span className="dsh-wt-label">{chipLabel(state, t)}</span>
          </button>
        </span>
      </Tooltip>
      {state.phase === 'failed'
        ? (
          <button
            type="button"
            className="dsh-wt-retry"
            onClick={() => { retry() }}
          >
            {t('chip.retry')}
          </button>
        )
        : null}
    </div>
  )
}

/** The component under the name the slot registry records. */
export default WorktreeChip
