// @vitest-environment jsdom
/**
 * The persistent header badge, rendered through the real slot ledger.
 *
 * The badge is the only in-page sign of "this session runs in a copy" once the
 * first prompt has been sent, so these cases check when it appears, what it
 * says, that it follows the working-directory projection (no polling), and
 * that clicking it lands on the panel with the copy highlighted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// The published ui-primitives bundle declares none of its runtime
// dependencies, so importing it pulls in an uninstallable markdown toolkit.
// The Worktree UI only needs the tooltip wrapper; stub it at the import site.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
}))

import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { ROOT_PANEL_ID } from './client-harness.ts'
import {
  copyRef, detachedRef, fail, listValue, ok, outOfScope, REPOSITORY, scopeValue, SESSION, setup, worktreeItem,
} from './client-harness.ts'
import type { ClientHarness, ClientSlotView } from './client-harness.ts'

afterEach(cleanup)

const COPY = copyRef()

/** Render the session header utilities slot (where the badge registers). */
function renderBadge(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('conversation.session.header.utilities')
}

/** The badge element, when it rendered. */
function badgeOf(view: ClientSlotView): HTMLElement | null {
  const element = view.container.querySelector('.dsh-wt-badge')
  return element instanceof HTMLElement ? element : null
}

describe('badge visibility', () => {
  it('renders nothing for the blank hero and never asks the host', async () => {
    const harness = await setup()
    harness.connection.setAnswer('scope', () => ok(scopeValue()))

    const view = renderBadge(harness)
    await act(async () => { await Promise.resolve() })

    expect(badgeOf(view)).toBeNull()
    expect(view.container.textContent).toBe('')
    expect(harness.connection.callsFor('scope')).toHaveLength(0)
  })

  it('renders nothing while the session is not in a copy', async () => {
    const harness = await setup({ session: { blank: false } })
    harness.connection.setAnswer('scope', () => ok(outOfScope()))

    const view = renderBadge(harness)
    await waitFor(() => { expect(harness.connection.callsFor('scope')).toHaveLength(1) })
    expect(badgeOf(view)).toBeNull()
  })

  it('renders nothing while the host is still checking, and nothing after a failure', async () => {
    const harness = await setup({ session: { blank: false } })
    let answer: ((result: ConnectionRpcResult<unknown>) => void) | undefined
    harness.connection.setAnswer('scope', () => new Promise<ConnectionRpcResult<unknown>>((resolve) => {
      answer = resolve
    }))

    const view = renderBadge(harness)
    await waitFor(() => { expect(harness.connection.callsFor('scope')).toHaveLength(1) })
    expect(badgeOf(view)).toBeNull()

    await act(async () => {
      answer?.(fail('the session is not reachable'))
      await Promise.resolve()
    })
    expect(badgeOf(view)).toBeNull()
  })
})

describe('badge content', () => {
  it('shows the branch and a hint with the copy path, repository root, and change count', async () => {
    const harness = await setup({ session: { blank: false } })
    harness.connection.setAnswer('scope', () => ok(scopeValue({ changedFiles: 3 })))

    const view = renderBadge(harness)
    await waitFor(() => { expect(view.view.getByText(`⎇ ${COPY.branch}`)).toBeTruthy() })

    const badge = badgeOf(view)
    expect(badge).not.toBeNull()
    expect(badge!.getAttribute('data-phase')).toBe('in')
    expect(badge!.getAttribute('data-branch')).toBe(COPY.branch)
    const hint = badge!.getAttribute('data-hint') ?? ''
    expect(hint).toContain(COPY.path)
    expect(hint).toContain(REPOSITORY)
    expect(hint).toContain('3')

    const calls = harness.connection.callsFor('scope')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload).toEqual({ sessionId: SESSION })
    expect(calls[0]!.endpoint).toBe('dsh-worktree-switch/scope')
  })
})

describe('a detached copy', () => {
  it('says so instead of showing the directory name as a branch', async () => {
    const harness = await setup({ session: { blank: false } })
    harness.connection.setAnswer('scope', () => ok(scopeValue({ worktree: detachedRef() })))

    const view = renderBadge(harness)
    await waitFor(() => { expect(view.view.getByText('⎇ detached copy')).toBeTruthy() })

    const badge = badgeOf(view)!
    expect(badge.getAttribute('data-branch')).toBe('')
    expect(badge.getAttribute('data-hint')).toContain(detachedRef().path)
  })
})

describe('following the working directory', () => {
  it('re-queries when the projection changes and appears once the session enters a copy', async () => {
    const harness = await setup({ session: { blank: false } })
    let inCopy = false
    harness.connection.setAnswer('scope', () => ok(inCopy ? scopeValue() : outOfScope()))

    const view = renderBadge(harness)
    await waitFor(() => { expect(harness.connection.callsFor('scope')).toHaveLength(1) })
    expect(badgeOf(view)).toBeNull()

    inCopy = true
    act(() => { harness.setWorkingDirectory(COPY.path) })

    await waitFor(() => { expect(view.view.getByText(`⎇ ${COPY.branch}`)).toBeTruthy() })
    expect(harness.connection.callsFor('scope')).toHaveLength(2)
  })

  it('disappears again when the session leaves the copy', async () => {
    const harness = await setup({ session: { blank: false } })
    let inCopy = true
    harness.connection.setAnswer('scope', () => ok(inCopy ? scopeValue() : outOfScope()))

    const view = renderBadge(harness)
    await waitFor(() => { expect(view.view.getByText(`⎇ ${COPY.branch}`)).toBeTruthy() })

    inCopy = false
    act(() => { harness.setWorkingDirectory(REPOSITORY) })

    await waitFor(() => { expect(badgeOf(view)).toBeNull() })
    expect(harness.connection.callsFor('scope')).toHaveLength(2)
  })
})

describe('opening the panel from the badge', () => {
  it('selects the panel and marks this copy current in it', async () => {
    const harness = await setup({
      session: { blank: false },
      workspaces: [{ path: REPOSITORY, title: 'repo' }],
    })
    harness.connection.setAnswer('scope', () => ok(scopeValue()))
    harness.connection.setAnswer('list', () => ok(listValue({ items: [worktreeItem()] })))
    harness.setWorkingDirectory(COPY.path)

    const view = renderBadge(harness)
    await waitFor(() => { expect(view.view.getByText(`⎇ ${COPY.branch}`)).toBeTruthy() })

    fireEvent.click(view.view.getByRole('button', { name: `⎇ ${COPY.branch}` }))
    expect(harness.layout.selected).toEqual([ROOT_PANEL_ID])

    const panel = harness.renderSlot('main', {}, { entryKey: ROOT_PANEL_ID })
    await waitFor(() => {
      expect(panel.container.querySelector(`li[data-worktree="${COPY.name}"]`)?.getAttribute('data-current'))
        .toBe('true')
    })
  })
})
