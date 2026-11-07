/**
 * Browser half of the Worktree switch.
 *
 * Five registrations, all on the page's real slot registry:
 * - the switch, into `conversation.input.left` (the compact controls left of
 *   the composer's `+`, a list slot nothing else occupies today);
 * - the panel page, as the keyed `main` occupant named after this plugin;
 * - the sidebar entry that opens it, carrying the pending-cleanup count;
 * - the persistent `⎇ branch` badge in the session header;
 * - the frame-level one-shot notice a leave raises when it keeps a copy or fails.
 *
 * The controllers live for the plugin fiber: unloading the plugin drops every
 * contribution, every composer block, every in-flight read, and the notice.
 * @module dsh-worktree-switch/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorktreeBadge } from './Badge.tsx'
import { WorktreeChip } from './Chip.tsx'
import { WorktreeNotice } from './Notice.tsx'
import { WorktreePanel, WorktreePanelIcon } from './Panel.tsx'
import { en, zh } from './locales.ts'
import { BadgeController, NoticeController, PanelController, ToggleController } from './state.ts'
import { installStyles } from './styles.ts'

/** Browser module id: package name, bundle row id, plugin id. */
export const name = 'dsh-worktree-switch'

/** Locale namespace this plugin owns. */
export const NS = 'worktreeToggle'

/** Keyed `main` panel id; the sidebar entry's list id is the same string. */
export const PANEL_ID = 'dsh-worktree-switch' as MainPanelId

/**
 * Client services this plugin cannot work without.
 *
 * `conversation` is how the switch stops a prompt while a copy it promised is
 * not ready; `workspaces` is how the panel finds the projects to list;
 * `sessions` is how the panel derives which copy the visible session is in.
 */
export const inject = ['conversation', 'connection', 'layout', 'locale', 'sessions', 'slots', 'workspaces']

/**
 * Mount the browser half.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-worktree-switch: dictionaries')
  ctx.effect(installStyles, 'dsh-worktree-switch: styles')

  const t = ctx.locale.bind(NS)
  const notices = new NoticeController(() => { ctx.layout.selectPanel(PANEL_ID) })
  const panels = new PanelController(ctx, () => { ctx.layout.selectPanel(null) })
  const toggles = new ToggleController(ctx, notices, () => { panels.refresh() })
  const badges = new BadgeController(ctx, (path) => {
    panels.highlight(path)
    ctx.layout.selectPanel(PANEL_ID)
  })
  ctx.effect(() => {
    // The sidebar count must exist before the panel is opened: a leftover is
    // surfaced without the user having to know where to look.
    const unwatch = panels.watch()
    return () => {
      unwatch()
      toggles.dispose()
      panels.dispose()
      badges.dispose()
    }
  }, 'dsh-worktree-switch: controllers')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: PANEL_ID,
    order: 40,
    locale: NS,
    inject: (sessionId: SessionId) => toggles.binding(sessionId),
  }, WorktreeChip))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => panels.face,
  }, WorktreePanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t('sidebar.label'),
    inject: () => ({ hooks: panels.face.hooks, open: () => { ctx.layout.selectPanel(PANEL_ID) } }),
  }, WorktreePanelIcon))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-worktree-switch.badge',
    order: 60,
    locale: NS,
    inject: (sessionId: SessionId) => badges.binding(sessionId),
  }, WorktreeBadge))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-worktree-switch.notice',
    order: 20,
    locale: NS,
    inject: () => notices.face,
  }, WorktreeNotice))
}
