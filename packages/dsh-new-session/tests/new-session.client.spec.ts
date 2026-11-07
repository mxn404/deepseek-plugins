/**
 * Contract spec for the browser half's `/clear` and `/new` commands.
 *
 * Both are client-owned actions: the composer consumes the token and runs one
 * callback. The callback resolves the current Workspace, asks the Host to
 * create/reuse its blank Session, adopts the source Session's working
 * directory through the Host route, and navigates. These cases double the
 * services so the flow and its failure fallbacks are pinned without a browser.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, createCommands, name } from '../src/client/index.tsx'

/** Session the command is invoked from. */
const SOURCE = 'session-under-test' as never

/** Blank Session `connectWorkspace` resolves. */
const TARGET = 'session-target' as never

/** Workspace id the source Session belongs to. */
const WORKSPACE = 'workspace-1'

/** One mounted browser half with every service the commands touch. */
interface Mounted {
  /** Contributions currently registered in the command UI. */
  readonly commands: Map<string, CommandContribution>
  /** Plain navigation fallback. */
  readonly startSession: ReturnType<typeof vi.fn<() => void>>
  /** Blank-Session resolution. */
  readonly connectWorkspace: ReturnType<typeof vi.fn<(workspaceId: string) => Promise<unknown>>>
  /** Navigation into the new Session. */
  readonly openSession: ReturnType<typeof vi.fn<(target: unknown) => void>>
  /** Every Host route call made through the connection double. */
  readonly rpcCalls: readonly { readonly channel: string; readonly method: string; readonly payload: Record<string, unknown> }[]
  /** Dispose every effect `apply` installed. */
  disposeAll(): void
}

/**
 * Mount the plugin's real `apply` on a Cordis-context double.
 * @param options - access, locale, Workspace shape and failure switches.
 * @returns the registered contributions and their doubles.
 */
function mount(options: {
  readonly canCreate?: boolean
  readonly locale?: 'en' | 'zh'
  readonly workspace?: boolean
  readonly connectFails?: boolean
  readonly adoptFails?: boolean
} = {}): Mounted {
  const locale = options.locale ?? 'zh'
  const commands = new Map<string, CommandContribution>()
  const startSession = vi.fn<() => void>(() => {})
  const connectWorkspace = vi.fn<(workspaceId: string) => Promise<unknown>>(async () => TARGET)
  const openSession = vi.fn<(target: unknown) => void>(() => {})
  const rpcCalls: { channel: string; method: string; payload: Record<string, unknown> }[] = []
  const disposers: (() => void)[] = []
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()

  const connection = {
    rpc: {
      call: async (channel: string, method: string, payload: Record<string, unknown>) => {
        rpcCalls.push({ channel, method, payload })
        return options.adoptFails === true
          ? { ok: false, error: { code: 'adopt-failed', message: 'refused', details: {} } }
          : { ok: true, value: { adopted: true, workingDirectory: '/repo/.dsh/worktrees/quiet-harbor' } }
      },
    },
  }

  const ctx = {
    get: (name: string) => name === 'connection' ? connection : undefined,
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
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          items: options.workspace === false
            ? []
            : [{
                workspaceId: WORKSPACE,
                path: '/repo',
                title: 'repo',
                sessionIds: [SOURCE],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              }],
          archivedSessionIds: [],
        }),
      },
    },
    connection,
    uiWorkspace: {
      startSession,
      connectWorkspace: options.connectFails === true
        ? vi.fn(async () => { throw new Error('could not create') })
        : connectWorkspace,
      openSession,
    },
  } as unknown as Context

  apply(ctx)

  return {
    commands,
    startSession,
    connectWorkspace,
    openSession,
    rpcCalls,
    disposeAll: () => {
      for (const dispose of disposers.toReversed()) dispose()
    },
  }
}

/** Run one contribution the way a bare menu pick / Enter does. */
function run(command: CommandContribution): void {
  if (command.ui.kind !== 'action') throw new Error('expected an action contribution')
  command.ui.run({ sessionId: SOURCE })
}

describe('the conversation-reset commands', () => {
  it('exposes the plugin id', () => {
    expect(name).toBe('dsh-new-session')
  })

  it('registers /clear as the primary and /new as its alias', () => {
    const mounted = mount()
    expect([...mounted.commands.keys()].sort()).toEqual(['clear', 'new'])
    for (const command of mounted.commands.values()) expect(command.ui.kind).toBe('action')
  })

  it('localizes both menu rows', () => {
    const zhRows = mount({ locale: 'zh' }).commands
    expect(zhRows.get('clear')?.label?.()).toBe('清除对话')
    expect(zhRows.get('new')?.label?.()).toBe('新建会话')
    expect(zhRows.get('new')?.description?.()).toContain('/clear')

    const enRows = mount({ locale: 'en' }).commands
    expect(enRows.get('clear')?.label?.()).toBe('Clear conversation')
    expect(enRows.get('new')?.label?.()).toBe('New session')
  })

  it.each(['clear', 'new'])('%s adopts the source directory and navigates', async (name) => {
    const mounted = mount()
    const command = mounted.commands.get(name)
    if (command === undefined) throw new Error(`missing /${name}`)

    run(command)

    await vi.waitFor(() => { expect(mounted.openSession).toHaveBeenCalledWith(TARGET) })
    expect(mounted.connectWorkspace).toHaveBeenCalledWith(WORKSPACE)
    expect(mounted.rpcCalls).toEqual([{
      channel: '/api',
      method: 'dsh-new-session/adopt',
      payload: { sourceSessionId: SOURCE, targetSessionId: TARGET },
    }])
    expect(mounted.startSession).not.toHaveBeenCalled()
  })

  it('still navigates when the Host refuses the adoption', async () => {
    const mounted = mount({ adoptFails: true })
    run(mounted.commands.get('clear')!)

    await vi.waitFor(() => { expect(mounted.openSession).toHaveBeenCalledWith(TARGET) })
  })

  it('falls back to plain navigation for a Session outside any Workspace', async () => {
    const mounted = mount({ workspace: false })
    run(mounted.commands.get('clear')!)

    await vi.waitFor(() => { expect(mounted.startSession).toHaveBeenCalledTimes(1) })
    expect(mounted.connectWorkspace).not.toHaveBeenCalled()
    expect(mounted.openSession).not.toHaveBeenCalled()
  })

  it('does not navigate when the blank Session cannot be created', async () => {
    const mounted = mount({ connectFails: true })
    run(mounted.commands.get('clear')!)

    await vi.waitFor(() => { expect(mounted.commands.size).toBe(2) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mounted.openSession).not.toHaveBeenCalled()
    expect(mounted.startSession).not.toHaveBeenCalled()
  })

  it('is not registered when the Peer may not create Sessions', () => {
    expect(mount({ canCreate: false }).commands.size).toBe(0)
  })

  it('removes both registrations when the plugin unloads', () => {
    const mounted = mount()
    expect(mounted.commands.size).toBe(2)
    mounted.disposeAll()
    expect(mounted.commands.size).toBe(0)
  })
})

describe('createCommands', () => {
  it('runs the supplied starter with the invoked session id', () => {
    const start = vi.fn()
    const [clear, alias] = createCommands({ t: key => key, start })

    for (const command of [clear, alias]) {
      if (command?.ui.kind !== 'action') throw new Error('expected an action contribution')
      command.ui.run({ sessionId: SOURCE })
    }

    expect(start).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledWith(SOURCE)
  })
})
