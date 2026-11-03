// @vitest-environment jsdom
/**
 * The Worktrees panel and its sidebar entry, rendered through the real slot
 * ledger. The discard confirmation, the dirty-row refusal, per-project errors,
 * and the open/back navigation are all driven by real clicks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// The published ui-primitives bundle declares none of its runtime
// dependencies, so importing it pulls in an uninstallable markdown toolkit.
// The Worktree UI only needs the tooltip wrapper; stub it at the import site.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
}))

import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ROOT_PANEL_ID } from './client-harness.ts'
import {
  discardValue, fail, listValue, ok, REPOSITORY, setup, worktreeItem,
} from './client-harness.ts'
import type { ClientHarness, ClientSlotView } from './client-harness.ts'
import type { ListValue, WorktreeItem } from '../src/types.ts'

afterEach(cleanup)

const CLEAN = worktreeItem({ name: 'quiet-harbor-3fa9', changedFiles: 0 })
const DIRTY = worktreeItem({ name: 'brisk-anchor-1a2b', changedFiles: 2 })
const PLAIN = '/fixtures/plain'

/** Render the panel page (the keyed `main` occupant). */
function renderPanel(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('main', {}, { entryKey: ROOT_PANEL_ID })
}

/** The panel root element. */
function panelOf(view: ClientSlotView): HTMLElement {
  const element = view.container.querySelector('.dsh-wt-panel')
  if (!(element instanceof HTMLElement)) throw new Error('the panel is not rendered')
  return element
}

/** One pool row by copy name. */
function rowOf(view: ClientSlotView, name: string): HTMLElement {
  const element = view.container.querySelector(`li[data-worktree="${name}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no row for ${name}`)
  return element
}

/** One row's discard button. */
function discardButtonOf(row: HTMLElement): HTMLButtonElement {
  const element = row.querySelector('.dsh-wt-discard')
  if (!(element instanceof HTMLButtonElement)) throw new Error('no discard button')
  return element
}

/** Script a two-workspace list answer; `removed` filters discarded copies out. */
function scriptList(harness: ClientHarness, removed: Set<string> = new Set()): void {
  harness.connection.setAnswer('list', (call) => {
    if (String(call.payload.path) === REPOSITORY) {
      const items: WorktreeItem[] = [CLEAN, DIRTY].filter(item => !removed.has(item.name))
      return ok(listValue(items))
    }
    const unsupported: ListValue = { supported: false, reason: 'not-a-git-repository' }
    return ok(unsupported)
  })
}

/** Wait until the first refresh has published both groups. */
async function settlePanel(view: ClientSlotView): Promise<void> {
  await waitFor(() => { expect(panelOf(view).getAttribute('data-loading')).toBe('false') })
  await waitFor(() => { expect(view.container.querySelector(`li[data-worktree="${CLEAN.name}"]`)).not.toBeNull() })
}

describe('panel groups', () => {
  it('renders one group per workspace, including a non-repository notice', async () => {
    const harness = await setup({
      workspaces: [{ path: REPOSITORY, title: 'repo' }, { path: PLAIN, title: 'plain' }],
    })
    scriptList(harness)

    const view = renderPanel(harness)
    await settlePanel(view)

    expect(view.view.getByText('repo')).toBeTruthy()
    expect(view.view.getByText('plain')).toBeTruthy()
    expect(view.view.getByText('Not a Git repository.')).toBeTruthy()
    expect(harness.connection.callsFor('list')).toHaveLength(2)
  })

  it('shows clean and dirty change text and disables discard on the dirty row', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const view = renderPanel(harness)
    await settlePanel(view)

    const clean = rowOf(view, CLEAN.name)
    const dirty = rowOf(view, DIRTY.name)
    expect(clean.getAttribute('data-dirty')).toBe('false')
    expect(dirty.getAttribute('data-dirty')).toBe('true')
    expect(clean.textContent).toContain('Clean')
    expect(dirty.textContent).toContain('2 uncommitted')
    expect(discardButtonOf(clean).disabled).toBe(false)
    expect(discardButtonOf(dirty).disabled).toBe(true)
  })

  it('keeps a project visible with its error when its pool cannot be read', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    harness.connection.setAnswer('list', () => fail('permission denied reading the pool'))

    const view = renderPanel(harness)
    await waitFor(() => {
      expect(view.view.getByRole('alert').textContent).toContain('permission denied reading the pool')
    })
    expect(view.view.getByText('repo')).toBeTruthy()
    expect(view.container.querySelector('li[data-worktree]')).toBeNull()
  })
})

describe('discard', () => {
  it('arms on the first click and issues exactly one discard on the second', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    const removed = new Set<string>()
    scriptList(harness, removed)
    harness.connection.setAnswer('discard', (call) => {
      const name = String(call.payload.name)
      removed.add(name)
      return ok(discardValue(name))
    })

    const view = renderPanel(harness)
    await settlePanel(view)

    const button = discardButtonOf(rowOf(view, CLEAN.name))
    fireEvent.click(button)
    expect(button.textContent).toBe('Discard now')
    expect(button.getAttribute('data-armed')).toBe('true')
    expect(harness.connection.callsFor('discard')).toHaveLength(0)

    fireEvent.click(button)
    await waitFor(() => { expect(harness.connection.callsFor('discard')).toHaveLength(1) })
    expect(harness.connection.callsFor('discard')[0]!.payload).toEqual({
      path: REPOSITORY,
      name: CLEAN.name,
    })

    await waitFor(() => { expect(view.container.querySelector(`li[data-worktree="${CLEAN.name}"]`)).toBeNull() })
    expect(rowOf(view, DIRTY.name)).toBeTruthy()
    expect(harness.connection.callsFor('discard')).toHaveLength(1)
  })

  it('re-arms on the same row only, so clicking another row first issues nothing', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)
    harness.connection.setAnswer('discard', () => ok(discardValue(CLEAN.name)))

    const view = renderPanel(harness)
    await settlePanel(view)

    const clean = discardButtonOf(rowOf(view, CLEAN.name))
    fireEvent.click(clean)
    expect(clean.textContent).toBe('Discard now')

    // The dirty row cannot be armed, and the clean row stays armed: one click
    // on the clean row is still only an arm.
    expect(discardButtonOf(rowOf(view, DIRTY.name)).disabled).toBe(true)
    expect(harness.connection.callsFor('discard')).toHaveLength(0)
  })

  it('shows the generic panel error line when the host refuses the discard', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)
    harness.connection.setAnswer('discard', () => fail('branch is checked out elsewhere'))

    const view = renderPanel(harness)
    await settlePanel(view)

    const button = discardButtonOf(rowOf(view, CLEAN.name))
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => {
      expect(view.view.getByRole('alert').textContent).toBe(
        'Could not read worktrees: branch is checked out elsewhere',
      )
    })
    // The row is untouched: the host refused, so the copy still exists.
    expect(rowOf(view, CLEAN.name)).toBeTruthy()
  })
})

describe('navigation', () => {
  it('opens the panel from the sidebar icon and returns to the conversation with Back', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const icon = harness.renderSlot('sidebar.panellist', { size: 24, active: false })
    const button = icon.container.querySelector('.dsh-wt-panel-icon')
    if (!(button instanceof HTMLButtonElement)) throw new Error('the sidebar icon is not rendered')
    expect(button.getAttribute('aria-label')).toBe('Worktrees')
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    expect(harness.layout.selected).toEqual([ROOT_PANEL_ID])

    icon.update({ size: 24, active: true })
    expect(icon.container.querySelector('.dsh-wt-panel-icon')!.getAttribute('aria-pressed')).toBe('true')

    const panel = renderPanel(harness)
    await settlePanel(panel)
    fireEvent.click(panel.view.getByText('Back'))
    expect(harness.layout.selected).toEqual([ROOT_PANEL_ID, null])
  })

  it('refreshes the list from the panel header', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const view = renderPanel(harness)
    await settlePanel(view)
    expect(harness.connection.callsFor('list')).toHaveLength(1)

    fireEvent.click(view.view.getByText('Refresh'))
    await waitFor(() => { expect(harness.connection.callsFor('list')).toHaveLength(2) })
  })
})
