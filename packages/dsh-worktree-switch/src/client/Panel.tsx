/**
 * The Worktrees panel and its sidebar entry.
 *
 * The page is a plain read of every workspace's pool plus explicit,
 * twice-confirmed destructive actions. Cleanup is the only write the plugin
 * offers here, and it is always explicit: a copy with uncommitted changes is
 * refused by the host, a leftover branch needs a second click, and a copy
 * whose directory was deleted by hand stays listed so its Git registration can
 * still be pruned. The current copy is marked, so the list answers "where am I"
 * as directly as possible.
 * @module dsh-worktree-switch/client/Panel
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PanelBinding, PanelGroup, PanelState } from './state.ts'
import { branchRowKey, copyRowKey } from './state.ts'
import type { OrphanBranch, WorktreeItem } from '../types.ts'
import type { WorktreeToggleKey } from './locales.ts'

/** One translate function bound to this plugin's namespace. */
type Translate = (key: WorktreeToggleKey, params?: Record<string, unknown>) => string

/** Full props of the panel page. */
export type WorktreePanelProps =
  PropsRuntime<'main'>
  & InjectFace<PanelBinding>
  & PropsLocale<'worktreeToggle'>

/** Face the sidebar icon needs: the panel snapshot and one navigation action. */
export interface PanelIconInjected {
  /** Observable panel state, for the pending-cleanup count. */
  readonly hooks: { readonly worktrees: PanelBinding['hooks']['worktrees'] }
  /** Select this plugin's panel page. */
  open(): void
}

/** Full props of the sidebar icon. */
export type WorktreePanelIconProps =
  PropsRuntime<'sidebar.panellist'>
  & InjectFace<PanelIconInjected>
  & PropsLocale<'worktreeToggle'>

/** How long an armed destructive button stays armed, in milliseconds. */
const ARM_TIMEOUT_MS = 5_000

/** Render one copy's creation time without depending on the test machine's locale. */
function formatTime(milliseconds: number): string {
  if (milliseconds <= 0) return '—'
  return new Date(milliseconds).toISOString().slice(0, 16).replace('T', ' ')
}

/** One project's leftover branches, rendered only when there are any. */
function OrphanSection(props: {
  readonly group: PanelGroup
  readonly state: PanelState
  readonly armed: string | null
  readonly t: Translate
  readonly onArm: (key: string) => void
  readonly onDelete: (group: PanelGroup, orphan: OrphanBranch) => void
}): ReactElement | null {
  const { group, state, armed, t, onArm, onDelete } = props
  if (group.orphans.length === 0) return null
  return (
    <section className="dsh-wt-orphans" data-project={group.path} data-orphans={group.orphans.length}>
      <header className="dsh-wt-orphans-head">
        <h4>{t('panel.orphans')}</h4>
        <span className="dsh-wt-count" data-count={group.orphans.length}>
          {group.orphans.length}
        </span>
      </header>
      <p className="dsh-wt-muted">{t('panel.orphansHint')}</p>
      <ul className="dsh-wt-orphan-rows">
        {group.orphans.map((orphan) => {
          const key = branchRowKey(group.path, orphan.branch)
          const isArmed = armed === key
          const busy = state.busy === key
          return (
            <li
              className="dsh-wt-orphan"
              key={key}
              data-branch={orphan.branch}
              data-commits={orphan.commits}
            >
              <code className="dsh-wt-orphan-branch">{orphan.branch}</code>
              <span className="dsh-wt-orphan-commits">
                {t('panel.orphanCommits', { count: orphan.commits })}
              </span>
              <span className="dsh-wt-orphan-subject" title={orphan.subject}>{orphan.subject}</span>
              <span className="dsh-wt-orphan-time">
                <span className="dsh-wt-muted">{t('panel.orphanLatest')}</span> {formatTime(orphan.committedAt)}
              </span>
              <Tooltip label={t('panel.orphanDeleteHint')} side="top" delayMs={200}>
                <span className="dsh-wt-anchor">
                  <button
                    type="button"
                    className="dsh-wt-orphan-delete"
                    data-armed={isArmed ? 'true' : 'false'}
                    disabled={busy}
                    onClick={() => {
                      if (isArmed) {
                        onDelete(group, orphan)
                        return
                      }
                      onArm(key)
                    }}
                  >
                    {busy ? '…' : isArmed ? t('panel.orphanDeleteAgain') : t('panel.orphanDelete')}
                  </button>
                </span>
              </Tooltip>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** One project's copies. */
function ProjectSection(props: {
  readonly group: PanelGroup
  readonly state: PanelState
  readonly armed: string | null
  readonly t: Translate
  readonly onArm: (key: string) => void
  readonly onDiscard: (group: PanelGroup, item: WorktreeItem) => void
  readonly onDeleteBranch: (group: PanelGroup, orphan: OrphanBranch) => void
}): ReactElement {
  const { group, state, armed, t, onArm, onDiscard, onDeleteBranch } = props
  const current = state.current
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
                  const key = copyRowKey(group.path, item.name)
                  const isArmed = armed === key
                  const busy = state.busy === key
                  const dirty = item.changedFiles > 0
                  const isCurrent = current.includes(item.path)
                  return (
                    <li
                      className="dsh-wt-row"
                      key={key}
                      data-worktree={item.name}
                      data-dirty={dirty ? 'true' : 'false'}
                      data-prunable={item.prunable ? 'true' : 'false'}
                      data-current={isCurrent ? 'true' : 'false'}
                      aria-current={isCurrent ? 'true' : undefined}
                    >
                      <span className="dsh-wt-name">{item.name}</span>
                      <span className="dsh-wt-branch">
                        <span className="dsh-wt-muted">{t('panel.branch')}</span> {item.branch ?? t('panel.detached')}
                      </span>
                      <code className="dsh-wt-row-path">{item.path}</code>
                      <span className="dsh-wt-created">
                        <span className="dsh-wt-muted">{t('panel.created')}</span> {formatTime(item.createdAt)}
                      </span>
                      <span className="dsh-wt-changes" data-changes={item.changedFiles}>
                        {dirty ? t('panel.changesCount', { count: item.changedFiles }) : t('panel.clean')}
                      </span>
                      {item.prunable
                        ? <span className="dsh-wt-prunable" data-prunable="true">{t('panel.prunable')}</span>
                        : null}
                      {isCurrent ? <span className="dsh-wt-current">{t('panel.current')}</span> : null}
                      <Tooltip
                        label={dirty
                          ? t('panel.discardDirty')
                          : item.prunable
                            ? t('panel.prunableHint')
                            : t('panel.discardHint')}
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
      <OrphanSection
        group={group}
        state={state}
        armed={armed}
        t={t}
        onArm={onArm}
        onDelete={onDeleteBranch}
      />
    </section>
  )
}

/**
 * Render the Worktrees panel.
 * @param props - runtime props, the panel face, and the locale seat.
 * @returns the page.
 */
export function WorktreePanel(props: WorktreePanelProps): ReactElement {
  const { useWorktrees, refresh, discard, discardBranch, close, t } = props
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

  const onDeleteBranch = (group: PanelGroup, orphan: OrphanBranch): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setArmed(null)
    discardBranch(group.path, orphan.branch)
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
          <p className="dsh-wt-muted" data-cleanup-hint>{t('panel.cleanupHint')}</p>
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
              onDeleteBranch={onDeleteBranch}
            />
          ))}
    </div>
  )
}

/**
 * Render the sidebar entry that opens the panel.
 *
 * The numeric count is the plugin's only ambient signal outside the header: it
 * appears when a pool still holds a leftover branch or a kept copy, and stays
 * silent otherwise.
 * @param props - sidebar owner props, the panel snapshot, the open action, and the locale seat.
 * @returns the icon button.
 */
export function WorktreePanelIcon(props: WorktreePanelIconProps): ReactElement {
  const { size, active, useWorktrees, open, t } = props
  const cleanup = useWorktrees(state => state.cleanup)
  return (
    <Tooltip label={t('sidebar.label')} side="right" delayMs={300}>
      <span className="dsh-wt-anchor">
        <button
          type="button"
          className="dsh-wt-panel-icon"
          data-active={active ? 'true' : 'false'}
          data-cleanup={cleanup}
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
          {cleanup > 0
            ? <span className="dsh-wt-panel-icon-count" aria-hidden="true">{cleanup > 99 ? '99+' : cleanup}</span>
            : null}
        </button>
      </span>
    </Tooltip>
  )
}
