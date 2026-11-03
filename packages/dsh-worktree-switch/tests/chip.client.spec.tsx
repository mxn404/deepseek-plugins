// @vitest-environment jsdom
/**
 * The Worktree switch, rendered through the real slot ledger.
 *
 * Every case mounts the plugin's real `apply` on a real Cordis context and
 * renders the registered entry the renderer would render; only the host wire,
 * the conversation block registry, and the layout service are doubles (see
 * tests/client-harness.ts for why the published bench is not used).
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
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import { INTENT_STORAGE_KEY } from '../src/client/intent.ts'
import {
  copyRef, fail, ok, prepareValue, REPOSITORY, SESSION, setup, supportedStatus,
  unsupportedStatus,
} from './client-harness.ts'
import type { ClientHarness, ClientSlotView } from './client-harness.ts'
import type { StatusValue } from '../src/types.ts'

afterEach(cleanup)

const COPY = copyRef()

/** Render the chip slot of a harness. */
function renderChip(harness: ClientHarness): ClientSlotView {
  return harness.renderSlot('conversation.input.left')
}

/** The chip's root element. */
function chipOf(view: ClientSlotView): HTMLElement {
  const element = view.container.querySelector('.dsh-wt-chip')
  if (!(element instanceof HTMLElement)) throw new Error('the chip is not rendered')
  return element
}

/** The chip's switch button. */
function switchOf(view: ClientSlotView): HTMLButtonElement {
  const element = view.view.getByRole('switch')
  if (!(element instanceof HTMLButtonElement)) throw new Error('the switch is not a button')
  return element
}

/** Read the persisted intent map. */
function storedIntent(): Record<string, boolean> {
  const raw = globalThis.localStorage.getItem(INTENT_STORAGE_KEY)
  return raw === null ? {} : JSON.parse(raw) as Record<string, boolean>
}

/** Script a status answer for one harness. */
function scriptStatus(harness: ClientHarness, status: StatusValue): void {
  harness.connection.setAnswer('status', () => ok(status))
}

describe('switch registration', () => {
  it('registers the chip, the panel page, and the sidebar entry, and drops them with the plugin', async () => {
    const harness = await setup()

    const chips = harness.slots.entries('conversation.input.left')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.options.id).toBe('dsh-worktree-switch')
    expect(chips[0]!.options.order).toBe(40)
    expect(chips[0]!.locale).toBe('worktreeToggle')

    const panels = harness.slots.entries('main')
    expect(panels).toHaveLength(1)
    expect(panels[0]!.options.key).toBe('dsh-worktree-switch')
    expect(panels[0]!.locale).toBe('worktreeToggle')

    const sidebar = harness.slots.entries('sidebar.panellist')
    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]!.options.id).toBe('dsh-worktree-switch')
    expect(sidebar[0]!.options.order).toBe(30)
    expect(resolveSlotLabel(sidebar[0]!.options.label)).toBe('Worktrees')

    await harness.unloadPlugin()
    expect(harness.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(harness.slots.entries('main')).toHaveLength(0)
    expect(harness.slots.entries('sidebar.panellist')).toHaveLength(0)
  })
})

describe('outside the blank-session hero', () => {
  it('renders nothing and never reads the host when the session already has history', async () => {
    const harness = await setup({ session: { blank: false } })
    scriptStatus(harness, supportedStatus())

    const view = renderChip(harness)
    await act(async () => { await Promise.resolve() })

    expect(view.container.querySelector('.dsh-wt-chip')).toBeNull()
    expect(view.container.textContent).toBe('')
    expect(harness.connection.calls).toHaveLength(0)
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })
})

describe('the checking face', () => {
  it('shows a disabled switch and blocks the composer while the host is answering', async () => {
    const harness = await setup()
    let release: ((result: ConnectionRpcResult<unknown>) => void) | undefined
    harness.connection.setAnswer('status', () => new Promise(resolve => { release = resolve }))

    const view = renderChip(harness)
    const chip = chipOf(view)
    const button = switchOf(view)

    expect(chip.getAttribute('data-phase')).toBe('checking')
    expect(chip.getAttribute('data-intent')).toBe('off')
    expect(chip.getAttribute('data-hint')).toBe(en['chip.hint.checking'])
    expect(button.disabled).toBe(true)
    expect(view.view.getByText('Worktree…')).toBeTruthy()
    expect(harness.blocks.reasonFor()).toBe(en['chip.blocked.checking'])

    await act(async () => {
      release?.(ok(supportedStatus({ defaultEnabled: false })))
      await Promise.resolve()
    })
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })
})

describe('the creating face', () => {
  it('keeps the composer blocked and the label busy until the host answers', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    let release: ((result: ConnectionRpcResult<unknown>) => void) | undefined
    harness.connection.setAnswer('prepare', () => new Promise(resolve => { release = resolve }))

    const view = renderChip(harness)
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('creating') })
    expect(view.view.getByText('Creating worktree…')).toBeTruthy()
    expect(chipOf(view).getAttribute('data-hint')).toBe('Creating a checkout inside the project…')
    expect(harness.blocks.reasonFor()).toBe('Creating the worktree before the first prompt…')

    await act(async () => {
      release?.(ok(prepareValue()))
      await Promise.resolve()
    })
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })
})

describe('default on', () => {
  it('creates the copy once and shows the ready face', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('ready')
    expect(chip.getAttribute('data-intent')).toBe('on')
    expect(switchOf(view).getAttribute('aria-checked')).toBe('true')
    expect(switchOf(view).disabled).toBe(false)

    const prepares = harness.connection.callsFor('prepare')
    expect(prepares).toHaveLength(1)
    expect(prepares[0]!.payload).toEqual({ sessionId: SESSION })
    expect(prepares[0]!.endpoint).toBe('dsh-worktree-switch/prepare')

    expect(chip.getAttribute('data-hint')).toContain(`Branch ${COPY.branch}`)
    expect(chip.getAttribute('data-hint')).toContain(COPY.path)
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })
})

describe('default off', () => {
  it('does not create anything until the switch is turned on', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus({ defaultEnabled: false }))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    expect(harness.connection.callsFor('prepare')).toHaveLength(0)
    expect(switchOf(view).getAttribute('aria-checked')).toBe('false')
    expect(chipOf(view).getAttribute('data-hint')).toBe(en['chip.hint.off'])

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(harness.connection.callsFor('prepare')).toHaveLength(1)
    expect(storedIntent()).toEqual({ [REPOSITORY]: true })
  })
})

describe('the failed face', () => {
  it('blocks the composer with the localized reason and retries to success', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    let attempts = 0
    harness.connection.setAnswer('prepare', () => {
      attempts += 1
      return attempts === 1 ? fail('the pool directory could not be created') : ok(prepareValue())
    })

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText('Worktree failed')).toBeTruthy() })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('failed')
    expect(view.container.querySelector('.dsh-wt-retry')).not.toBeNull()
    expect(view.view.getByText('Retry')).toBeTruthy()
    expect(chip.getAttribute('data-hint')).toContain('the pool directory could not be created')
    expect(harness.blocks.reasonFor()).toBe('The worktree could not be created. Retry, turn the switch off, or discard the failed copy first.')
    expect(switchOf(view).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(view.view.getByText('Retry'))
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(harness.connection.callsFor('prepare')).toHaveLength(2)
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })

  it('turning the switch off while failed leaves the failed face and releases the composer', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => fail('the copy could not be created'))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText('Worktree failed')).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('off') })
    expect(view.view.getByText('Worktree off')).toBeTruthy()
    expect(switchOf(view).getAttribute('aria-checked')).toBe('false')
    expect(harness.blocks.reasonFor()).toBeUndefined()
    expect(storedIntent()).toEqual({ [REPOSITORY]: false })
  })

  it('surfaces a rejected host call as the failed face', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => Promise.reject(new Error('git worktree add exited 128')))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText('Worktree failed')).toBeTruthy() })
    expect(chipOf(view).getAttribute('data-hint')).toContain('git worktree add exited 128')
    expect(harness.blocks.reasonFor()).toBe(en['chip.blocked.failed'])
  })
})

describe('the disabled face', () => {
  it('disables the switch for a project that is not a Git repository and never creates anything', async () => {
    const harness = await setup()
    scriptStatus(harness, unsupportedStatus(false))

    const view = renderChip(harness)
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('disabled') })

    const chip = chipOf(view)
    expect(view.view.getByText('Worktree unavailable')).toBeTruthy()
    expect(switchOf(view).disabled).toBe(true)
    expect(switchOf(view).getAttribute('aria-checked')).toBe('false')
    expect(chip.getAttribute('data-hint')).toBe(en['chip.hint.disabled'])
    expect(harness.connection.callsFor('prepare')).toHaveLength(0)
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })
})

describe('turning isolation off for later sessions', () => {
  it('keeps this session in its copy, remembers the choice, and a fresh page never prepares', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(switchOf(view).getAttribute('aria-checked')).toBe('false') })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-intent')).toBe('off')
    expect(chip.getAttribute('data-phase')).toBe('ready')
    expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy()
    expect(chip.getAttribute('data-hint')).toContain(
      `Applies to the next session; this one keeps ${COPY.name}.`,
    )
    expect(storedIntent()).toEqual({ [REPOSITORY]: false })

    // A fresh runtime reusing the same storage remembers "off" for the project.
    const fresh = await setup({ resetStorage: false })
    scriptStatus(fresh, supportedStatus())
    fresh.connection.setAnswer('prepare', () => ok(prepareValue()))
    const freshView = renderChip(fresh)
    await waitFor(() => { expect(freshView.view.getByText('Worktree off')).toBeTruthy() })
    expect(switchOf(freshView).getAttribute('aria-checked')).toBe('false')
    expect(fresh.connection.callsFor('prepare')).toHaveLength(0)
  })
})
