// @vitest-environment jsdom
/**
 * The frame-level one-shot notice, rendered through the real slot ledger.
 *
 * A leave that keeps a copy or fails must be visible outside the switch, with a
 * way into the panel and a way to dismiss it. The notice lives in
 * `shell.overlay`, so these cases render that root slot beside the chip and
 * drive the switch with real clicks.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// The published ui-primitives bundle declares none of its runtime
// dependencies, so importing it pulls in an uninstallable markdown toolkit.
// The Worktree UI only needs the tooltip wrapper; stub it at the import site.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: { children?: unknown }) => props.children,
}))

import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import {
  copyRef, fail, keptReleaseValue, ok, prepareValue, releaseValue, ROOT_PANEL_ID, setup, supportedStatus,
} from './client-harness.ts'
import type { ClientHarness, ClientSlotView } from './client-harness.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const COPY = copyRef()

/** Render the chip slot (the switch whose leave raises the notice). */
function renderChip(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('conversation.input.left')
}

/** Render the frame overlay slot (where the notice registers). */
function renderOverlay(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('shell.overlay')
}

/** The notice element, when one is showing. */
function noticeOf(view: ClientSlotView): HTMLElement | null {
  const element = view.container.querySelector('.dsh-wt-notice')
  return element instanceof HTMLElement ? element : null
}

/** Turn the switch off from the chip and wait for the leave to settle. */
async function turnOff(chip: ClientSlotView): Promise<void> {
  fireEvent.click(chip.view.getByRole('switch'))
  await waitFor(() => { expect(chip.view.getByText('Worktree off')).toBeTruthy() })
}

describe('notice visibility', () => {
  it('shows nothing until a leave reports something', async () => {
    const harness = await setup()
    harness.connection.setAnswer('status', () => ok(supportedStatus()))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(releaseValue()))

    const overlay = renderOverlay(harness)
    const chip = renderChip(harness)
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(noticeOf(overlay)).toBeNull()
  })
})

describe('a leave that kept a copy', () => {
  it('explains that it was kept for its own content, and opens the panel', async () => {
    const harness = await setup()
    harness.connection.setAnswer('status', () => ok(supportedStatus()))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(keptReleaseValue('dirty')))

    const overlay = renderOverlay(harness)
    const chip = renderChip(harness)
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    await turnOff(chip)
    await waitFor(() => { expect(noticeOf(overlay)).not.toBeNull() })

    const notice = noticeOf(overlay)!
    expect(notice.getAttribute('data-kind')).toBe('kept')
    const text = notice.querySelector('.dsh-wt-notice-text')
    expect(text?.textContent).toBe(en['notice.keptDirty'].replace('{name}', COPY.name))
    // The host's English detail is a tooltip, never spliced into the sentence.
    expect(text?.getAttribute('title')).toBe('1 file with uncommitted changes')

    fireEvent.click(overlay.view.getByText('Open panel'))
    expect(harness.layout.selected).toEqual([ROOT_PANEL_ID])
    // Opening the panel consumes the notice: it is one-shot, not a log.
    await waitFor(() => { expect(noticeOf(overlay)).toBeNull() })
  })

  it('explains an unprovable owner differently', async () => {
    const harness = await setup()
    harness.connection.setAnswer('status', () => ok(supportedStatus()))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(keptReleaseValue('not-owned', { error: null })))

    const overlay = renderOverlay(harness)
    const chip = renderChip(harness)
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    await turnOff(chip)
    await waitFor(() => { expect(noticeOf(overlay)).not.toBeNull() })

    const notice = noticeOf(overlay)!
    expect(notice.getAttribute('data-kind')).toBe('kept')
    expect(notice.textContent).toContain(en['notice.keptNotOwned'].replace('{name}', COPY.name))
    expect(notice.textContent).not.toContain('1 file with uncommitted changes')
  })

  it('can be dismissed by hand', async () => {
    const harness = await setup()
    harness.connection.setAnswer('status', () => ok(supportedStatus()))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(keptReleaseValue('dirty')))

    const overlay = renderOverlay(harness)
    const chip = renderChip(harness)
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    await turnOff(chip)
    await waitFor(() => { expect(noticeOf(overlay)).not.toBeNull() })

    fireEvent.click(overlay.view.getByLabelText('Dismiss'))
    await waitFor(() => { expect(noticeOf(overlay)).toBeNull() })
    expect(harness.layout.selected).toEqual([])
  })

  it('keeps one notice at a time, keyed by the event that raised it', async () => {
    const harness = await setup()
    harness.connection.setAnswer('status', () => ok(supportedStatus()))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(keptReleaseValue('dirty')))

    const overlay = renderOverlay(harness)
    const chip = renderChip(harness)
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    await turnOff(chip)

    await waitFor(() => { expect(noticeOf(overlay)).not.toBeNull() })
    const notices = overlay.container.querySelectorAll('.dsh-wt-notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.getAttribute('data-seq')).toBe('1')
  })
})

describe('a leave that failed', () => {
  it('shows the host message with the open-panel action, and the switch stays honest', async () => {
    const harness = await setup()
    // The refused delete left the copy in place, so the re-read says so.
    harness.connection.setAnswer('status', () => ok(supportedStatus({ sessionWorktree: COPY })))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => fail('permission denied removing the checkout'))

    const overlay = renderOverlay(harness)
    const chip = renderChip(harness)
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(chip.view.getByRole('switch'))
    await waitFor(() => { expect(noticeOf(overlay)).not.toBeNull() })

    const notice = noticeOf(overlay)!
    expect(notice.getAttribute('data-kind')).toBe('failed')
    expect(notice.textContent).toContain(
      en['notice.failed'].replace('{message}', 'permission denied removing the checkout'),
    )
    // The switch itself still shows the ready face with the reason: the copy is
    // still there, so "off" would be a lie.
    await waitFor(() => { expect(chip.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(chip.container.querySelector('.dsh-wt-chip')!.getAttribute('data-phase')).toBe('ready')

    fireEvent.click(overlay.view.getByText('Open panel'))
    expect(harness.layout.selected).toEqual([ROOT_PANEL_ID])
  })
})
