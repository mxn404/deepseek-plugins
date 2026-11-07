// @vitest-environment jsdom
/**
 * The Worktrees panel and its sidebar entry, rendered through the real slot
 * ledger. The discard confirmation, the dirty-row refusal, per-project errors,
 * leftover-branch deletion, the current-copy highlight, the pending-cleanup
 * count, and the open/back navigation are all driven by real clicks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// The published ui-primitives bundle declares none of its runtime
// dependencies, so importing it pulls in an uninstallable markdown toolkit.
// The Worktree UI only needs the tooltip wrapper; stub it at the import site.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
}))

import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { copyRef, ok, prepareValue, releaseValue, ROOT_PANEL_ID } from './client-harness.ts'
import {
  discardBranchValue, discardValue, fail, keptReleaseValue, listValue, orphanBranch, REPOSITORY, setup,
  supportedStatus, worktreeItem,
} from './client-harness.ts'
import type { ClientHarness, ClientSlotView } from './client-harness.ts'
import type { ListValue, OrphanBranch, WorktreeItem } from '../src/types.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const COPY = copyRef()
const CLEAN = worktreeItem({ name: 'quiet-harbor-3fa9', changedFiles: 0 })
const DIRTY = worktreeItem({ name: 'brisk-anchor-1a2b', changedFiles: 2 })
const PRUNABLE = worktreeItem({ name: 'stale-reef-77aa', prunable: true })
const DETACHED = worktreeItem({ name: 'brisk-fern-1a2b', branch: null })
const PLAIN = '/fixtures/plain'

/** Render the panel page (the keyed `main` occupant). */
function renderPanel(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('main', {}, { entryKey: ROOT_PANEL_ID })
}

/** Render the sidebar entry. */
function renderIcon(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('sidebar.panellist', { size: 24, active: false })
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

/** One leftover branch row by branch name. */
function orphanOf(view: ClientSlotView, branch: string): HTMLElement {
  const element = view.container.querySelector(`li[data-branch="${branch}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no leftover row for ${branch}`)
  return element
}

/** One row's discard button. */
function discardButtonOf(row: HTMLElement): HTMLButtonElement {
  const element = row.querySelector('.dsh-wt-discard')
  if (!(element instanceof HTMLButtonElement)) throw new Error('no discard button')
  return element
}

/** One leftover row's delete button. */
function deleteButtonOf(row: HTMLElement): HTMLButtonElement {
  const element = row.querySelector('.dsh-wt-orphan-delete')
  if (!(element instanceof HTMLButtonElement)) throw new Error('no delete button')
  return element
}

/** What one `list` answer should contain. */
interface ListScript {
  /** Copies to list; defaults to the clean and dirty fixture copies. */
  readonly items?: readonly WorktreeItem[]
  /** Copy names the discard verb already removed. */
  readonly removed?: Set<string>
  /** Leftover branches to list. */
  readonly orphans?: readonly OrphanBranch[]
  /** Branch names the delete verb already removed. */
  readonly removedBranches?: Set<string>
  /** Copies this host instance kept. */
  readonly keptCopies?: number
}

/** Script a two-workspace list answer; the non-repository workspace is unsupported. */
function scriptList(harness: ClientHarness, script: ListScript = {}): void {
  const items = script.items ?? [CLEAN, DIRTY]
  const removed = script.removed ?? new Set<string>()
  const removedBranches = script.removedBranches ?? new Set<string>()
  harness.connection.setAnswer('list', (call) => {
    if (String(call.payload.path) === REPOSITORY) {
      return ok(listValue({
        items: items.filter(item => !removed.has(item.name)),
        orphans: (script.orphans ?? []).filter(orphan => !removedBranches.has(orphan.branch)),
        keptCopies: script.keptCopies ?? 0,
      }))
    }
    const unsupported: ListValue = { supported: false, reason: 'not-a-git-repository' }
    return ok(unsupported)
  })
}

/** Wait until the first refresh has published a panel with one named row. */
async function settlePanel(view: ClientSlotView, name: string = CLEAN.name): Promise<void> {
  await waitFor(() => { expect(panelOf(view).getAttribute('data-loading')).toBe('false') })
  await waitFor(() => { expect(view.container.querySelector(`li[data-worktree="${name}"]`)).not.toBeNull() })
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
    // The count is not the point; reading both projects (the repository and the
    // plain directory) is, and at least one read per workspace happened.
    const listed = new Set(harness.connection.callsFor('list').map(call => String(call.payload.path)))
    expect(listed).toEqual(new Set([REPOSITORY, PLAIN]))
  })

  it('labels a detached copy instead of putting its directory name under Branch', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    harness.connection.setAnswer('list', () => ok(listValue({ items: [CLEAN, DETACHED] })))

    const view = renderPanel(harness)
    await settlePanel(view)

    const row = rowOf(view, DETACHED.name)
    expect(row.textContent).toContain('detached')
    expect(row.textContent).not.toContain(`Branch ${DETACHED.name}`)
    expect(row.querySelector('.dsh-wt-branch')?.textContent).toBe('Branch detached')
  })

  it('states what the cleanup count includes, including its host-restart caveat', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const view = renderPanel(harness)
    await settlePanel(view)

    expect(view.container.querySelector('[data-cleanup-hint]')?.textContent).toBe(en['panel.cleanupHint'])
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
    scriptList(harness, { removed })
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

  it('marks a copy whose directory is gone and still discards it through the same verb', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    const removed = new Set<string>()
    scriptList(harness, { items: [CLEAN, PRUNABLE], removed })
    harness.connection.setAnswer('discard', (call) => {
      const name = String(call.payload.name)
      removed.add(name)
      return ok(discardValue(name))
    })

    const view = renderPanel(harness)
    await settlePanel(view, PRUNABLE.name)

    const row = rowOf(view, PRUNABLE.name)
    expect(row.getAttribute('data-prunable')).toBe('true')
    expect(row.textContent).toContain(en['panel.prunable'])
    expect(row.querySelector('[data-prunable="true"]')).not.toBeNull()

    const button = discardButtonOf(row)
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => { expect(harness.connection.callsFor('discard')).toHaveLength(1) })
    expect(harness.connection.callsFor('discard')[0]!.payload).toEqual({
      path: REPOSITORY,
      name: PRUNABLE.name,
    })
    await waitFor(() => {
      expect(view.container.querySelector(`li[data-worktree="${PRUNABLE.name}"]`)).toBeNull()
    })
  })
})

describe('leftover branches', () => {
  const FIRST = orphanBranch()
  const SECOND = orphanBranch({
    branch: 'wise-comet-d5cb',
    commits: 0,
    subject: 'Merge the settings panel copy',
    committedAt: 1_700_000_100_000,
  })

  it('lists branch name, commit count, latest subject, and time, and stays hidden when empty', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const view = renderPanel(harness)
    await settlePanel(view)
    expect(view.container.querySelector('.dsh-wt-orphans')).toBeNull()

    scriptList(harness, { orphans: [FIRST] })
    fireEvent.click(view.view.getByText('Refresh'))
    await waitFor(() => { expect(view.container.querySelector('.dsh-wt-orphans')).not.toBeNull() })

    const row = orphanOf(view, FIRST.branch)
    expect(row.getAttribute('data-commits')).toBe(String(FIRST.commits))
    expect(row.textContent).toContain(FIRST.branch)
    expect(row.textContent).toContain(en['panel.orphanCommits'].replace('{count}', String(FIRST.commits)))
    expect(row.textContent).toContain(FIRST.subject)
    expect(row.textContent).toContain('2023-11-14 22:13')
    expect(view.view.getByText('Leftover branches')).toBeTruthy()
  })

  it('needs a second click and issues exactly one discardBranch', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    const removedBranches = new Set<string>()
    scriptList(harness, { orphans: [FIRST, SECOND], removedBranches })
    harness.connection.setAnswer('discardBranch', (call) => {
      const branch = String(call.payload.branch)
      removedBranches.add(branch)
      return ok(discardBranchValue(branch))
    })

    const view = renderPanel(harness)
    await waitFor(() => { expect(view.container.querySelector(`li[data-branch="${FIRST.branch}"]`)).not.toBeNull() })

    const button = deleteButtonOf(orphanOf(view, FIRST.branch))
    fireEvent.click(button)
    expect(button.getAttribute('data-armed')).toBe('true')
    expect(button.textContent).toBe('Delete branch now')
    expect(harness.connection.callsFor('discardBranch')).toHaveLength(0)

    fireEvent.click(button)
    await waitFor(() => { expect(harness.connection.callsFor('discardBranch')).toHaveLength(1) })
    expect(harness.connection.callsFor('discardBranch')[0]!.payload).toEqual({
      path: REPOSITORY,
      branch: FIRST.branch,
    })
    await waitFor(() => {
      expect(view.container.querySelector(`li[data-branch="${FIRST.branch}"]`)).toBeNull()
    })
    // The other leftover stays, so one delete did not clear the group.
    expect(view.container.querySelector(`li[data-branch="${SECOND.branch}"]`)).not.toBeNull()
  })

  it('survives a host refusal that means the branch is already gone: error line plus a re-read', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    const removedBranches = new Set<string>()
    scriptList(harness, { orphans: [FIRST], removedBranches })
    harness.connection.setAnswer('discardBranch', () => {
      // The second click races a delete that already happened: the host says so
      // and the list catches up on the next read.
      removedBranches.add(FIRST.branch)
      return fail('branch not found')
    })

    const view = renderPanel(harness)
    await waitFor(() => { expect(view.container.querySelector(`li[data-branch="${FIRST.branch}"]`)).not.toBeNull() })

    const button = deleteButtonOf(orphanOf(view, FIRST.branch))
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => {
      expect(view.view.getByRole('alert').textContent).toBe('Could not read worktrees: branch not found')
    })
    await waitFor(() => {
      expect(view.container.querySelector(`li[data-branch="${FIRST.branch}"]`)).toBeNull()
    })
  })
})

describe('the current copy', () => {
  it('marks the copy the visible session runs in, and one directory inside it', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)
    harness.setWorkingDirectory(`${COPY.path}/src/components`)

    const view = renderPanel(harness)
    await settlePanel(view)

    const current = rowOf(view, COPY.name)
    expect(current.getAttribute('data-current')).toBe('true')
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.textContent).toContain(en['panel.current'])
    expect(rowOf(view, DIRTY.name).getAttribute('data-current')).toBe('false')
  })

  it('drops the mark once the session leaves the copy and the panel is refreshed', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)
    harness.setWorkingDirectory(COPY.path)

    const view = renderPanel(harness)
    await settlePanel(view)
    expect(rowOf(view, COPY.name).getAttribute('data-current')).toBe('true')

    harness.setWorkingDirectory(REPOSITORY)
    fireEvent.click(view.view.getByText('Refresh'))
    await waitFor(() => { expect(rowOf(view, COPY.name).getAttribute('data-current')).toBe('false') })
  })
})

describe('navigation', () => {
  it('opens the panel from the sidebar icon and returns to the conversation with Back', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const icon = renderIcon(harness)
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

    const before = harness.connection.callsFor('list').length
    fireEvent.click(view.view.getByText('Refresh'))
    await waitFor(() => { expect(harness.connection.callsFor('list').length).toBeGreaterThan(before) })
    await waitFor(() => { expect(panelOf(view).getAttribute('data-loading')).toBe('false') })
  })
})

describe('the sidebar cleanup count', () => {
  it('counts leftover branches plus kept copies without opening the panel', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness, { orphans: [orphanBranch(), orphanBranch({ branch: 'wise-comet-d5cb' })], keptCopies: 1 })

    const icon = renderIcon(harness)
    // Adding a project re-reads every pool without any panel being mounted.
    harness.setWorkspaces([{ path: REPOSITORY, title: 'repo' }])
    await waitFor(() => {
      expect(icon.container.querySelector('.dsh-wt-panel-icon-count')?.textContent).toBe('3')
    })
    expect(icon.container.querySelector('.dsh-wt-panel-icon')!.getAttribute('data-cleanup')).toBe('3')
  })

  it('stays silent when nothing needs cleanup', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    scriptList(harness)

    const icon = renderIcon(harness)
    harness.setWorkspaces([{ path: REPOSITORY, title: 'repo' }])
    await waitFor(() => { expect(harness.connection.callsFor('list').length).toBeGreaterThanOrEqual(2) })
    await waitFor(() => {
      expect(icon.container.querySelector('.dsh-wt-panel-icon')!.getAttribute('data-cleanup')).toBe('0')
    })
    expect(icon.container.querySelector('.dsh-wt-panel-icon-count')).toBeNull()
  })

  it('re-counts after a leave that kept its copy', async () => {
    const harness = await setup({ workspaces: [{ path: REPOSITORY, title: 'repo' }] })
    let keptCopies = 0
    harness.connection.setAnswer('list', () => ok(listValue({ items: [], keptCopies })))
    harness.connection.setAnswer('status', () => ok(supportedStatus()))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => {
      keptCopies = 1
      return ok(keptReleaseValue('dirty'))
    })

    const icon = renderIcon(harness)
    const chip = harness.renderSlot('conversation.input.left')
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(chip.view.getByRole('switch'))
    await waitFor(() => {
      expect(icon.container.querySelector('.dsh-wt-panel-icon-count')?.textContent).toBe('1')
    })
  })
})
