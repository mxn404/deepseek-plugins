/**
 * Contract spec for the browser half's `/new` command.
 *
 * The command is a client-owned action: the composer consumes the token and
 * runs one callback that starts a Session through Workspace navigation. This
 * spec doubles those two services (plus the locale registry) and asserts the
 * contribution the real page would see; the GUI walkthrough in the README is
 * the end-to-end check against the real services.
 *
 * No DOM is involved: the plugin renders nothing, so the default Node
 * environment is enough.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, createNewSessionCommand, name } from '../src/client/index.tsx'

/** One mounted browser half with every service the plugin touches. */
interface Mounted {
  /** Contributions currently registered in the command UI. */
  readonly commands: Map<string, CommandContribution>
  /** The Workspace navigation double. */
  readonly startSession: ReturnType<typeof vi.fn<() => void>>
  /** Dispose every effect `apply` installed, in registration order. */
  disposeAll(): void
}

/**
 * Mount the plugin's real `apply` on a minimal Cordis-context double.
 * @param options - whether the Peer may create Sessions, and the active locale.
 * @returns the registered contributions and their doubles.
 */
function mount(options: {
  readonly canCreate?: boolean
  readonly locale?: 'en' | 'zh'
} = {}): Mounted {
  const locale = options.locale ?? 'zh'
  const commands = new Map<string, CommandContribution>()
  const startSession = vi.fn<() => void>(() => {})
  const disposers: (() => void)[] = []
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()

  const ctx = {
    effect(callback: () => (() => void) | void, _label: string): () => void {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    locale: {
      register(ns: string, dicts: Record<string, Record<string, string>>): () => void {
        dictionaries.set(ns, dicts)
        return () => {}
      },
      bind(ns: string): (key: string) => string {
        return key => dictionaries.get(ns)?.[locale]?.[key] ?? key
      },
    },
    remoteAccess: {
      whenAccess(action: string, callback: () => () => void): () => void {
        expect(action).toBe('session/create')
        if (options.canCreate ?? true) disposers.push(callback())
        return () => {}
      },
    },
    commandUi: {
      register(contribution: CommandContribution): () => void {
        commands.set(contribution.name, contribution)
        return () => { commands.delete(contribution.name) }
      },
    },
    uiWorkspace: { startSession },
  } as unknown as Context

  apply(ctx)

  return {
    commands,
    startSession,
    disposeAll: () => {
      for (const dispose of disposers.toReversed()) dispose()
    },
  }
}

describe('the /new command contribution', () => {
  it('exposes the plugin id', () => {
    expect(name).toBe('dsh-new-session')
  })

  it('registers exactly one silent action named "new"', () => {
    const mounted = mount()
    const command = mounted.commands.get('new')
    expect(mounted.commands.size).toBe(1)
    expect(command?.ui.kind).toBe('action')
  })

  it('localizes its menu row', () => {
    const zhRow = mount({ locale: 'zh' }).commands.get('new')
    expect(zhRow?.label?.()).toBe('新建会话')
    expect(zhRow?.description?.()).toBe('在当前工作区开一个全新的对话')

    const enRow = mount({ locale: 'en' }).commands.get('new')
    expect(enRow?.label?.()).toBe('New session')
  })

  it('starts a Session through Workspace navigation when run', () => {
    const mounted = mount()
    const command = mounted.commands.get('new')
    if (command?.ui.kind !== 'action') throw new Error('expected an action contribution')

    command.ui.run({ sessionId: 'session-under-test' as never })

    expect(mounted.startSession).toHaveBeenCalledTimes(1)
    expect(mounted.startSession).toHaveBeenCalledWith()
  })

  it('is available in every Session it is offered in', () => {
    const command = mount().commands.get('new')
    if (command === undefined) throw new Error('expected the command')

    expect(command.available({ sessionId: 'any-session' as never })).toBe(true)
  })

  it('is not registered when the Peer may not create Sessions', () => {
    const mounted = mount({ canCreate: false })
    expect(mounted.commands.size).toBe(0)
  })

  it('removes its registration when the plugin unloads', () => {
    const mounted = mount()
    expect(mounted.commands.size).toBe(1)

    mounted.disposeAll()

    expect(mounted.commands.size).toBe(0)
  })
})

describe('createNewSessionCommand', () => {
  it('reads row copy from the supplied translator on every pass', () => {
    const labels: string[] = []
    const command = createNewSessionCommand({
      t: (key) => {
        labels.push(key)
        return `translated:${key}`
      },
      start: () => {},
    })

    expect(command.label?.()).toBe('translated:label')
    expect(command.description?.()).toBe('translated:description')
    // Copy is read per candidate pass, so a locale change reaches the next menu
    // open without re-registering the contribution.
    expect(labels).toEqual(['label', 'description'])
  })
})
