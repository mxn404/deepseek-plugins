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
import { en, zh } from '../src/client/locales.ts'
import { INTENT_STORAGE_KEY } from '../src/client/intent.ts'
import {
  copyRef, detachedRef, fail, keptReleaseValue, ok, prepareValue, releaseValue, REPOSITORY, SESSION, setup,
  supportedStatus, unsupportedStatus,
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

    const badge = harness.slots.entries('conversation.session.header.utilities')
    expect(badge).toHaveLength(1)
    expect(badge[0]!.options.id).toBe('dsh-worktree-switch.badge')
    expect(badge[0]!.locale).toBe('worktreeToggle')

    const notice = harness.slots.entries('shell.overlay')
    expect(notice).toHaveLength(1)
    expect(notice[0]!.options.id).toBe('dsh-worktree-switch.notice')
    expect(notice[0]!.locale).toBe('worktreeToggle')

    await harness.unloadPlugin()
    expect(harness.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(harness.slots.entries('main')).toHaveLength(0)
    expect(harness.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(harness.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(harness.slots.entries('shell.overlay')).toHaveLength(0)
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
    expect(chip.getAttribute('data-position')).toBe('off')
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

describe('an inherited copy on mount', () => {
  it('shows the switch on, names the copy, and never moves the session out of it', async () => {
    const harness = await setup()
    // The project's isolation default is off, yet this session already runs in
    // a copy — the state `/new` inherits. Mounting must report that, not undo it.
    scriptStatus(harness, supportedStatus({ sessionWorktree: COPY, defaultEnabled: false }))
    harness.connection.setAnswer('release', () => ok(releaseValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('ready')
    expect(chip.getAttribute('data-position')).toBe('on')
    expect(switchOf(view).getAttribute('aria-checked')).toBe('true')
    expect(switchOf(view).disabled).toBe(false)
    expect(harness.connection.callsFor('release')).toHaveLength(0)
    expect(harness.connection.callsFor('prepare')).toHaveLength(0)
    // The project default is off, but this session is not moving: the hover
    // says where new sessions start instead of claiming a failed leave.
    const hint = chip.getAttribute('data-hint') ?? ''
    expect(hint).toContain(en['chip.hint.isolationOff'])
    expect(hint).not.toContain(en['chip.hint.intentOff'].replace('{name}', COPY.name))
  })
})

describe('following the working-directory projection', () => {
  it('turns itself on when a reused blank session is adopted into a copy', async () => {
    const harness = await setup()
    let cwd = REPOSITORY
    // The project's isolation default is off, so the first check leaves the
    // blank session in the source checkout.
    harness.connection.setAnswer('status', () => ok(supportedStatus({
      defaultEnabled: false,
      sessionWorktree: cwd === REPOSITORY ? null : COPY,
    })))
    harness.connection.setAnswer('release', () => ok(releaseValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    const statusCalls = harness.connection.callsFor('status').length

    // The host adopts the blank session into an existing copy (`/new`).
    cwd = COPY.path
    await act(async () => { harness.setWorkingDirectory(COPY.path) })
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    expect(chipOf(view).getAttribute('data-phase')).toBe('ready')
    expect(chipOf(view).getAttribute('data-position')).toBe('on')
    expect(switchOf(view).getAttribute('aria-checked')).toBe('true')
    expect(harness.connection.callsFor('status').length).toBeGreaterThan(statusCalls)
    // A session that already has a copy is never moved out of it on a recheck.
    expect(harness.connection.callsFor('release')).toHaveLength(0)
    expect(harness.connection.callsFor('prepare')).toHaveLength(0)
  })

  it('keeps an inherited copy on when the recheck a projection change causes fails', async () => {
    const harness = await setup()
    let refuse = false
    harness.connection.setAnswer('status', () => refuse
      ? fail('the status read timed out')
      : ok(supportedStatus({ sessionWorktree: COPY, defaultEnabled: false })))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    // The session is demonstrably still in the copy, so a failed recheck must
    // not flip the face: "failed" would derive the isolation default (off here)
    // as the position and claim the session is back in the project directory.
    refuse = true
    await act(async () => { harness.setWorkingDirectory(COPY.path) })
    await waitFor(() => {
      expect(chipOf(view).getAttribute('data-hint')).toContain('the status read timed out')
    })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('ready')
    expect(chip.getAttribute('data-position')).toBe('on')
    expect(switchOf(view).getAttribute('aria-checked')).toBe('true')
    expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy()
    expect(view.container.querySelector('.dsh-wt-retry')).toBeNull()
    expect(view.view.queryByText('Worktree failed')).toBeNull()

    // The error is the failed check's; no leave was attempted, so the hover
    // explains the isolation default instead of claiming it could not leave.
    const hint = chip.getAttribute('data-hint') ?? ''
    expect(hint).toContain('the status read timed out')
    expect(hint).toContain(en['chip.hint.isolationOff'])
    expect(hint).not.toContain(en['chip.hint.intentOff'].replace('{name}', COPY.name))
  })

  it('rebuilds a vanished copy exactly once while isolation is on', async () => {
    const harness = await setup()
    let cwd = REPOSITORY
    harness.connection.setAnswer('status', () => ok(supportedStatus({
      sessionWorktree: cwd === REPOSITORY ? null : COPY,
      sourceDirty: cwd === REPOSITORY ? 0 : 2,
    })))
    harness.connection.setAnswer('prepare', () => {
      cwd = COPY.path
      return ok(prepareValue())
    })

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(harness.connection.callsFor('prepare')).toHaveLength(1)

    // The projection then moves to the copy the prepare just made, as `/new`
    // adoption does. The recheck lands on the same copy, must not prepare
    // again, and must publish the new facts (the dirty count) instead.
    await act(async () => { harness.setWorkingDirectory(COPY.path) })
    await waitFor(() => {
      expect(chipOf(view).getAttribute('data-hint'))
        .toContain(en['chip.hint.dirty'].replace('{count}', '2'))
    })
    expect(harness.connection.callsFor('prepare')).toHaveLength(1)

    // The host self-heals the session back to the source checkout (for example
    // the copy's directory disappeared); the promised copy must come back.
    cwd = REPOSITORY
    await act(async () => { harness.setWorkingDirectory(REPOSITORY) })
    await waitFor(() => { expect(harness.connection.callsFor('prepare')).toHaveLength(2) })

    expect(chipOf(view).getAttribute('data-phase')).toBe('ready')
    expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy()
  })

  it('never creates for a session that stopped being blank during the check', async () => {
    const harness = await setup()
    let statusCalls = 0
    let settle: ((result: ConnectionRpcResult<unknown>) => void) | undefined
    harness.connection.setAnswer('status', () => {
      statusCalls += 1
      // The mount answer says the session already runs in a copy; the recheck
      // the projection change causes is held open while the first prompt lands.
      return statusCalls === 1
        ? ok(supportedStatus({ sessionWorktree: COPY }))
        : new Promise(resolve => { settle = resolve })
    })
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    await act(async () => { harness.setWorkingDirectory(REPOSITORY) })
    await waitFor(() => { expect(statusCalls).toBe(2) })
    await act(async () => { harness.setSession({ blank: false }) })
    expect(view.container.querySelector('.dsh-wt-chip')).toBeNull()

    await act(async () => {
      settle?.(ok(supportedStatus({ sessionWorktree: null, defaultEnabled: true })))
      await Promise.resolve()
    })
    // The answer promised a copy to a session that is no longer blank: the
    // switch lets it be, because only the hero may isolate a session.
    expect(harness.connection.callsFor('prepare')).toHaveLength(0)
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
    expect(chip.getAttribute('data-position')).toBe('on')
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
  it('shows the failed face when the first check cannot even find where the session runs', async () => {
    const harness = await setup()
    harness.connection.setAnswer('status', () => fail('the host is not reachable'))

    const view = renderChip(harness)
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('failed') })

    expect(view.view.getByText('Worktree failed')).toBeTruthy()
    expect(view.container.querySelector('.dsh-wt-retry')).not.toBeNull()
    expect(chipOf(view).getAttribute('data-hint')).toContain('the host is not reachable')
    expect(harness.connection.callsFor('prepare')).toHaveLength(0)
  })

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

  it('turning the switch off after a failure undoes whatever the host may have left', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => fail('the copy could not be created'))
    harness.connection.setAnswer('release', () => ok(releaseValue({ removed: null })))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText('Worktree failed')).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    expect(chipOf(view).getAttribute('data-phase')).toBe('off')
    expect(switchOf(view).getAttribute('aria-checked')).toBe('false')
    expect(harness.connection.callsFor('release')).toHaveLength(1)
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

describe('turning isolation off before the first prompt', () => {
  it('moves the session back to the project and drops the copy the switch made', async () => {
    const harness = await setup()
    let cwd = REPOSITORY
    harness.connection.setAnswer('status', () => ok(supportedStatus({
      sessionWorktree: cwd === REPOSITORY ? null : COPY,
    })))
    harness.connection.setAnswer('prepare', () => {
      cwd = COPY.path
      return ok(prepareValue())
    })
    harness.connection.setAnswer('release', () => {
      cwd = REPOSITORY
      return ok(releaseValue())
    })

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })

    const releases = harness.connection.callsFor('release')
    expect(releases).toHaveLength(1)
    expect(releases[0]!.payload).toEqual({ sessionId: SESSION })
    expect(cwd).toBe(REPOSITORY)
    expect(chipOf(view).getAttribute('data-phase')).toBe('off')
    expect(chipOf(view).getAttribute('data-position')).toBe('off')
    expect(harness.blocks.reasonFor()).toBeUndefined()
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

  it('keeps the composer inert and the switch busy while the session leaves', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    let finish: ((result: ConnectionRpcResult<unknown>) => void) | undefined
    harness.connection.setAnswer('release', () => new Promise(resolve => { finish = resolve }))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('reverting') })
    expect(view.view.getByText('Leaving worktree…')).toBeTruthy()
    expect(switchOf(view).disabled).toBe(true)
    expect(harness.blocks.reasonFor()).toBe(en['chip.blocked.reverting'])

    await act(async () => {
      finish?.(ok(releaseValue()))
      await Promise.resolve()
    })
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    expect(harness.blocks.reasonFor()).toBeUndefined()
  })

  it('turning off while the copy is still being created leaves it once the host answers', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    let finishPrepare: ((result: ConnectionRpcResult<unknown>) => void) | undefined
    harness.connection.setAnswer('prepare', () => new Promise(resolve => { finishPrepare = resolve }))
    harness.connection.setAnswer('release', () => ok(releaseValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('creating') })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('reverting') })

    await act(async () => {
      finishPrepare?.(ok(prepareValue()))
      await Promise.resolve()
    })
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    expect(harness.connection.callsFor('release')).toHaveLength(1)
  })

  it('a refused release keeps the ready face and shows the reason', async () => {
    const harness = await setup()
    // The host refused the delete, so the copy is still the session's directory:
    // the status re-read after the failure must report it.
    scriptStatus(harness, supportedStatus({ sessionWorktree: COPY }))
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => fail('permission denied removing the checkout'))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(chipOf(view).getAttribute('data-phase')).toBe('ready') })
    const hint = chipOf(view).getAttribute('data-hint')
    expect(hint).toContain('permission denied removing the checkout')
    expect(hint).toContain(en['chip.hint.intentOff'].replace('{name}', COPY.name))
    expect(hint).not.toContain(en['chip.hint.isolationOff'])
  })

  it('forgets the failed leave once a later check succeeds', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus({ sessionWorktree: COPY, defaultEnabled: false }))
    harness.connection.setAnswer('release', () => fail('permission denied removing the checkout'))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => {
      expect(chipOf(view).getAttribute('data-hint'))
        .toContain(en['chip.hint.intentOff'].replace('{name}', COPY.name))
    })

    // A later check succeeds (the projection moved): the refused leave's error
    // and its "could not leave" sentence are both gone, even though this
    // inherited copy still leaves the isolation default off.
    await act(async () => { harness.setWorkingDirectory(COPY.path) })
    await waitFor(() => {
      expect(chipOf(view).getAttribute('data-hint'))
        .not.toContain('permission denied removing the checkout')
    })

    const hint = chipOf(view).getAttribute('data-hint') ?? ''
    expect(hint).toContain(en['chip.hint.isolationOff'])
    expect(hint).not.toContain(en['chip.hint.intentOff'].replace('{name}', COPY.name))
  })
})

describe('the off face after a leave', () => {
  it('says the copy was kept, and why, instead of pretending the undo was clean', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(keptReleaseValue('dirty')))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('off')
    expect(chip.getAttribute('data-kept')).toBe('dirty')
    const hint = chip.getAttribute('data-hint') ?? ''
    expect(hint).toContain(en['chip.hint.keptDirty'].replace('{name}', COPY.name))
    // The host's English detail stays out of the localized sentence.
    expect(hint).not.toContain('1 file with uncommitted changes')
  })

  it('re-reads the host after a refused release, so a copy that is gone does not stay on screen', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    // The checkout was removed before the branch delete was refused: the next
    // status must say the session is back in the project directory.
    harness.connection.setAnswer('release', () => fail('cannot lock ref'))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })
    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('off')
    expect(chip.getAttribute('data-hint')).toContain('cannot lock ref')
  })

  it('shows an inherited copy as left behind, not deleted, when another session owns it', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus({ sessionWorktree: COPY, defaultEnabled: false }))
    harness.connection.setAnswer('release', () => ok(keptReleaseValue('not-owned', { error: null })))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(switchOf(view).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-phase')).toBe('off')
    expect(chip.getAttribute('data-position')).toBe('off')
    expect(chip.getAttribute('data-kept')).toBe('not-owned')
    expect(chip.getAttribute('data-hint')).toContain(en['chip.hint.keptNotOwned'].replace('{name}', COPY.name))
    expect(storedIntent()).toEqual({ [REPOSITORY]: false })
  })

  it('leaves no kept text after a clean undo', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))
    harness.connection.setAnswer('release', () => ok(releaseValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    fireEvent.click(switchOf(view))
    await waitFor(() => { expect(view.view.getByText('Worktree off')).toBeTruthy() })

    const chip = chipOf(view)
    expect(chip.getAttribute('data-kept')).toBe('false')
    expect(chip.getAttribute('data-hint')).toBe(en['chip.hint.off'])
  })
})

describe('the ready face reports a degraded base', () => {
  it('adds the fallback sentence to the hover hint only when the fetch failed', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue({ base: { kind: 'fallback' } })))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    const hint = chipOf(view).getAttribute('data-hint') ?? ''
    expect(hint).toContain(`Branch ${COPY.branch}`)
    expect(hint).toContain(en['chip.hint.baseFallback'])
  })

  it('keeps the fallback sentence when a recheck lands on the same copy', async () => {
    const harness = await setup()
    let status: StatusValue = supportedStatus()
    harness.connection.setAnswer('status', () => ok(status))
    harness.connection.setAnswer('prepare', () => ok(prepareValue({ base: { kind: 'fallback' } })))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })
    expect(chipOf(view).getAttribute('data-hint')).toContain(en['chip.hint.baseFallback'])

    // The projection change this page's own prepare caused: the recheck lands on
    // the same copy and must publish the new facts without forgetting the base.
    status = supportedStatus({ sessionWorktree: COPY, sourceDirty: 5 })
    await act(async () => { harness.setWorkingDirectory(COPY.path) })
    await waitFor(() => {
      expect(chipOf(view).getAttribute('data-hint'))
        .toContain(en['chip.hint.dirty'].replace('{count}', '5'))
    })

    const hint = chipOf(view).getAttribute('data-hint') ?? ''
    expect(chipOf(view).getAttribute('data-phase')).toBe('ready')
    expect(hint).toContain(`Branch ${COPY.branch}`)
    expect(hint).toContain(en['chip.hint.baseFallback'])
  })

  it('keeps the hint at the fetched base when the fetch succeeded', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue()))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${COPY.name}`)).toBeTruthy() })

    expect(chipOf(view).getAttribute('data-hint')).not.toContain(en['chip.hint.baseFallback'])
  })

  it('localizes the fallback sentence', async () => {
    const harness = await setup()
    harness.locale.setLocale('zh')
    scriptStatus(harness, supportedStatus())
    harness.connection.setAnswer('prepare', () => ok(prepareValue({ base: { kind: 'fallback' } })))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree：${COPY.name}`)).toBeTruthy() })

    expect(chipOf(view).getAttribute('data-hint')).toContain(zh['chip.hint.baseFallback'])
  })
})

describe('a detached copy as the session copy', () => {
  it('says it has no branch instead of naming the directory', async () => {
    const harness = await setup()
    scriptStatus(harness, supportedStatus({ sessionWorktree: detachedRef() }))

    const view = renderChip(harness)
    await waitFor(() => { expect(view.view.getByText(`Worktree: ${detachedRef().name}`)).toBeTruthy() })

    const hint = chipOf(view).getAttribute('data-hint') ?? ''
    expect(hint).toContain(en['chip.hint.detached'].replace('{path}', detachedRef().path))
    expect(hint).not.toContain('Branch brisk-fern-1a2b')
  })
})
