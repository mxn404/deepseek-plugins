/**
 * The Worktrees panel and its sidebar entry.
 *
 * The page is a plain read of every workspace's pool plus one explicit,
 * twice-confirmed destructive action. Discarding is the only write the plugin
 * offers here: nothing merges, nothing is reclaimed automatically, and a copy
 * with uncommitted changes is refused by the host, not hidden by a disabled
 * button alone.
 * @module dsh-worktree-toggle/client/Panel
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PanelBinding, PanelGroup, PanelState } from './state.ts'
import type { WorktreeItem } from '../types.ts'
import type { WorktreeToggleKey } from './locales.ts'

/** One translate function bound to this plugin's namespace. */
type Translate = (key: WorktreeToggleKey, params?: Record<string, unknown>) => string

/** Full props of the panel page. */
export type WorktreePanelProps =
  PropsRuntime<'main'>
  & InjectFace<PanelBinding>
  & PropsLocale<'worktreeToggle'>

/** Face the sidebar icon needs: one navigation action. */
export interface PanelIconInjected {
  /** Select this plugin's panel page. */
  open(): void
}

/** Full props of the sidebar icon. */
export type WorktreePanelIconProps =
  PropsRuntime<'sidebar.panellist'>
  & InjectFace<PanelIconInjected>
  & PropsLocale<'worktreeToggle'>

/** How long an armed discard stays armed, in milliseconds. */
const ARM_TIMEOUT_MS = 5_000

/** Render one copy's creation time without depending on the test machine's locale. */
function formatTime(milliseconds: number): string {
  if (milliseconds <= 0) return '—'
  return new Date(milliseconds).toISOString().slice(0, 16).replace('T', ' ')
}

/** The key that identifies one discard row. */
function rowKey(group: PanelGroup, item: WorktreeItem): string {
  return `${group.path}\u0000${item.name}`
}

/** One project's copies. */
function ProjectSection(props: {
  readonly group: PanelGroup
  readonly state: PanelState
  readonly armed: string | null
  readonly t: Translate
  readonly onArm: (key: string) => void
  readonly onDiscard: (group: PanelGroup, item: WorktreeItem) => void
}): ReactElement {
  const { group, state, armed, t, onArm, onDiscard } = props
  return (
    <section className="dsh-wt-project" data-project={group.path}>
      <header className="dsh-wt-project-head">
        <h3>{group.title}</h3>
        <code className="dsh-wt-path">{group.path}</code>
        <span className="dsh-wt-count">{t('panel.count', { count: group.items.length })}</span>
      </header>
      {group.error !== null
        ? <p className="dsh-wt-error" role="alert">{group.error}</p>
        : !group.supported
          ? <p className="dsh-wt-muted">{t('panel.notRepository')}</p>
          : group.items.length === 0
            ? <p className="dsh-wt-muted">{t('panel.empty')}</p>
            : (
              <ul className="dsh-wt-rows">
                {group.items.map((item) => {
                  const key = rowKey(group, item)
                  const isArmed = armed === key
                  const busy = state.busy === key
                  const dirty = item.changedFiles > 0
                  return (
                    <li className="dsh-wt-row" key={key} data-worktree={item.name} data-dirty={dirty ? 'true' : 'false'}>
                      <span className="dsh-wt-name">{item.name}</span>
                      <span className="dsh-wt-branch">
                        <span className="dsh-wt-muted">{t('panel.branch')}</span> {item.branch}
                      </span>
                      <code className="dsh-wt-row-path">{item.path}</code>
                      <span className="dsh-wt-created">
                        <span className="dsh-wt-muted">{t('panel.created')}</span> {formatTime(item.createdAt)}
                      </span>
                      <span className="dsh-wt-changes" data-changes={item.changedFiles}>
                        {dirty ? t('panel.changesCount', { count: item.changedFiles }) : t('panel.clean')}
                      </span>
                      <Tooltip
                        label={dirty ? t('panel.discardDirty') : t('panel.discardHint')}
                        side="top"
                        delayMs={200}
                      >
                        <span className="dsh-wt-anchor">
                          <button
                            type="button"
                            className="dsh-wt-discard"
                            data-armed={isArmed ? 'true' : 'false'}
                            disabled={dirty || busy || !group.supported}
                            onClick={() => {
                              if (isArmed) {
                                onDiscard(group, item)
                                return
                              }
                              onArm(key)
                            }}
                          >
                            {busy ? '…' : isArmed ? t('panel.discardAgain') : t('panel.discard')}
                          </button>
                        </span>
                      </Tooltip>
                    </li>
                  )
                })}
              </ul>
            )}
    </section>
  )
}

/**
 * Render the Worktrees panel.
 * @param props - runtime props, the panel face, and the locale seat.
 * @returns the page.
 */
export function WorktreePanel(props: WorktreePanelProps): ReactElement {
  const { useWorktrees, refresh, discard, close, t } = props
  const state = useWorktrees(current => current)
  const [armed, setArmed] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  const arm = (key: string): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setArmed(key)
    timer.current = window.setTimeout(() => { setArmed(null) }, ARM_TIMEOUT_MS)
  }

  const onDiscard = (group: PanelGroup, item: WorktreeItem): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setArmed(null)
    discard(group.path, item.name)
  }

  const total = state.groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="dsh-wt-panel" data-loading={state.loading ? 'true' : 'false'}>
      <header className="dsh-wt-panel-head">
        <button type="button" className="dsh-wt-back" onClick={() => { close() }}>
          {t('panel.back')}
        </button>
        <div className="dsh-wt-titles">
          <h2>{t('panel.title')}</h2>
          <p>{t('panel.subtitle')}</p>
        </div>
        <span className="dsh-wt-count">{t('panel.count', { count: total })}</span>
        <button type="button" className="dsh-wt-refresh" onClick={() => { refresh() }}>
          {t('panel.refresh')}
        </button>
      </header>
      {state.error !== null
        ? <p className="dsh-wt-error" role="alert">{t('panel.error', { message: state.error })}</p>
        : null}
      {state.loading && state.groups.length === 0
        ? <p className="dsh-wt-muted" role="status">{t('panel.loading')}</p>
        : state.groups.length === 0
          ? <p className="dsh-wt-muted">{t('panel.workspaceEmpty')}</p>
          : state.groups.map(group => (
            <ProjectSection
              key={group.path}
              group={group}
              state={state}
              armed={armed}
              t={t}
              onArm={arm}
              onDiscard={onDiscard}
            />
          ))}
    </div>
  )
}

/**
 * Render the sidebar entry that opens the panel.
 * @param props - sidebar owner props, the open action, and the locale seat.
 * @returns the icon button.
 */
export function WorktreePanelIcon(props: WorktreePanelIconProps): ReactElement {
  const { size, active, open, t } = props
  return (
    <Tooltip label={t('sidebar.label')} side="right" delayMs={300}>
      <span className="dsh-wt-anchor">
        <button
          type="button"
          className="dsh-wt-panel-icon"
          data-active={active ? 'true' : 'false'}
          aria-label={t('sidebar.label')}
          aria-pressed={active}
          onClick={() => { open() }}
        >
          <svg
            width={Math.max(12, Math.round(size * 0.6))}
            height={Math.max(12, Math.round(size * 0.6))}
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <path d="M4 2.5v7A2.5 2.5 0 0 0 6.5 12H11" />
            <circle cx="4" cy="2.5" r="1.5" />
            <circle cx="4" cy="12.5" r="1.5" />
            <circle cx="11" cy="10.5" r="1.5" />
            <path d="M8.5 6.5h2.5v2" strokeDasharray="1.6 2" />
          </svg>
        </button>
      </span>
    </Tooltip>
  )
}
