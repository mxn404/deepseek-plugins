/**
 * Browser half of the Worktree switch.
 *
 * Three registrations, all on the page's real slot registry:
 * - the switch, into `conversation.input.left` (the compact controls left of
 *   the composer's `+`, a list slot nothing else occupies today);
 * - the panel page, as the keyed `main` occupant named after this plugin;
 * - the sidebar entry that opens it.
 *
 * The two controllers live for the plugin fiber: unloading the plugin drops
 * every contribution, every composer block, and every in-flight read.
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
import { WorktreeChip } from './Chip.tsx'
import { WorktreePanel, WorktreePanelIcon } from './Panel.tsx'
import { en, zh } from './locales.ts'
import { PanelController, ToggleController } from './state.ts'
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
 * not ready; `workspaces` is how the panel finds the projects to list.
 */
export const inject = ['conversation', 'connection', 'layout', 'locale', 'slots', 'workspaces']

/**
 * Mount the browser half.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-worktree-switch: dictionaries')
  ctx.effect(installStyles, 'dsh-worktree-switch: styles')

  const t = ctx.locale.bind(NS)
  const toggles = new ToggleController(ctx)
  const panels = new PanelController(ctx, () => { ctx.layout.selectPanel(null) })
  ctx.effect(() => () => {
    toggles.dispose()
    panels.dispose()
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
    inject: () => ({ open: () => { ctx.layout.selectPanel(PANEL_ID) } }),
  }, WorktreePanelIcon))
}
