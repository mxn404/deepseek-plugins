/**
 * Harness for the browser half of the Worktree switch.
 *
 * Why this file exists instead of `SlotTestRuntime`: the published bench
 * `@deepseek-ai/dsh-client-test-runtime@0.2.1-rc.5` imports
 * `@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts` and
 * `.../src/client/scoped-slots.tsx`, but the published renderer package ships
 * only `lib/`, so Node fails to resolve the bench before a single test runs
 * (`Cannot find module .../src/client/bind.ts`). This harness is the fallback
 * the task allows: the real `SlotRegistry` and a real `LocaleRuntime` are
 * mounted on a real Cordis context, and only the renderer/materialization layer
 * is faked.
 *
 * What is real here: registration into the declared slots (`slot.inject` ->
 * `slot.register`), the ledger read (`entries`/`spec`), entry ids, order, key,
 * locale seat, the inject face, and the plugin's own controllers. What is fake:
 * `renderSlot` below reads the ledger and materializes exactly the props these
 * components consume — the inject face with its `hooks` compartment bound to
 * `use<Name>` selector hooks, the Session standard kit's `useSession` /
 * `sessionId` from a test session store, and `t` from the installed locale.
 * Standard kit members these components never call are not materialized.
 *
 * Known deviation from the production renderer: the renderer installed here
 * (`renderRoot: () => null`) renders nothing, so child slots are rendered by
 * `renderSlot` directly rather than through a root frame, and the ledger's
 * child-declaration authorization is read (`spec`) but not enforced.
 *
 * Two further upstream packaging gaps shape this file. Published browser
 * bundles are `window.__ModuleLoader__` artifacts, not ESM, so the harness
 * plays the page's loader and evaluates the two bundles it needs (SlotRegistry
 * and LocaleRuntime) itself. And `@deepseek-ai/dsh-client-store` imports
 * `zustand`/`immer` that its published manifest lists only as devDependencies,
 * so this package carries them as devDependencies for the tests;
 * `ui-primitives` has the same defect on a much larger dependency set, which is
 * why the specs mock it down to the tooltip wrapper they actually render.
 * @module tests/client-harness
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import * as Cordis from '@deepseek-ai/cordis'
import * as React from 'react'
import type { ComponentType, ReactElement, ReactNode } from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import { createElement, Fragment, useSyncExternalStore } from 'react'
import { render, within } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { onTestFinished } from 'vitest'
import * as UISlots from '@deepseek-ai/dsh-client-ui-slots'
import * as Store from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {
  SlotScope, StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject as pluginInject, PANEL_ID } from '../src/client/index.tsx'
import type {
  ListValue, PrepareValue, StatusValue, WorktreeItem, WorktreeRef,
} from '../src/types.ts'

/** Keyed `main` panel id the plugin registers under. */
export const ROOT_PANEL_ID: string = PANEL_ID

/**
 * One registration a published browser bundle makes with the page's loader.
 *
 * Browser halves are not ESM: each browser-client artifact is a
 * `window.__ModuleLoader__.load({ id, factory })` bundle. The test runner has
 * no page, so this harness plays that page: importing the bundle records its
 * definition here, and {@link loadClientModule} evaluates the factory with the
 * externals the real page supplies.
 */
interface ModuleLoaderDefinition {
  /** Module id the bundle registers under. */
  readonly id: string
  /** Factory receiving the page's `require`. */
  readonly factory: (require: (name: string) => unknown) => unknown
}

const moduleDefinitions = new Map<string, ModuleLoaderDefinition>()

interface ModuleLoaderGlobal {
  /** Page-owned loader the browser bundles call at evaluation time. */
  __ModuleLoader__?: { load(definition: ModuleLoaderDefinition): void }
}

const loaderGlobal = globalThis as unknown as ModuleLoaderGlobal
loaderGlobal.__ModuleLoader__ = {
  load: (definition) => { moduleDefinitions.set(definition.id, definition) },
}

/**
 * The `ui-primitives` slice the browser halves touch. The published package
 * bundles its entire markdown/highlighting toolkit and declares none of it in
 * `dependencies`, so importing it from a fresh consumer fails; the specs mock
 * the module at the plugin's import site and this stub is what the loader
 * externals hand the locale bundle (it only reaches `Menu` and the chevron,
 * both behind the settings row these tests never mount).
 */
const PRIMITIVES_STUB: Readonly<Record<string, unknown>> = {
  Tooltip: (props: { readonly children?: ReactNode }) => props.children,
  Menu: () => null,
  IconChevronDownOutlineRegular: () => null,
}

/** Externals a real page hands the bundles; the test runner's ESM modules. */
const ESM_EXTERNALS: Readonly<Record<string, unknown>> = {
  react: React,
  'react/jsx-runtime': JsxRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  '@deepseek-ai/cordis': Cordis,
  '@deepseek-ai/dsh-client-store': Store,
  '@deepseek-ai/dsh-client-ui-slots': UISlots,
  '@deepseek-ai/dsh-client-ui-primitives': PRIMITIVES_STUB,
}

/**
 * Resolve one external a browser bundle requires.
 * @param name - bare module specifier the bundle asked for.
 * @returns the module namespace.
 */
function requireExternal(name: string): unknown {
  const external = ESM_EXTERNALS[name]
  if (external === undefined) throw new Error(`browser module loader: no external named ${name}`)
  return external
}

/**
 * Import one published browser bundle and evaluate its loader factory.
 * @param specifier - importable package subpath (importing registers the definition).
 * @param id - module id the bundle registers under.
 * @returns the bundle's ESM-style exports.
 */
async function loadClientModule<T>(specifier: string, id: string): Promise<T> {
  await import(/* @vite-ignore */ specifier)
  const definition = moduleDefinitions.get(id)
  if (definition === undefined) {
    throw new Error(`browser module loader: ${specifier} did not register ${id}`)
  }
  return definition.factory(requireExternal) as T
}

/** The wire verbs this plugin's host half answers. */
export type HostVerb = 'status' | 'prepare' | 'list' | 'discard'

/** One recorded host round trip. */
export interface HostCall {
  /** Channel the call went to (`/api`). */
  readonly channel: string
  /** Full endpoint, e.g. `dsh-worktree-switch/status`. */
  readonly endpoint: string
  /** Verb parsed from {@link HostCall.endpoint}. */
  readonly verb: HostVerb
  /** JSON payload sent by the browser half. */
  readonly payload: Record<string, unknown>
  /** Caller cancellation signal, when the browser half passed one. */
  readonly signal: AbortSignal | undefined
}

/** Answers one host verb; return a wire result or a promise for it. */
export type HostAnswerer = (
  call: HostCall,
) => ConnectionRpcResult<unknown> | Promise<ConnectionRpcResult<unknown>>

/** A successful wire result. */
export function ok(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}

/** A refused wire result carrying the host failure's message. */
export function fail(message: string, code = 'failed'): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details: {} } }
}

/** Default repository root every fixture uses. */
export const REPOSITORY = '/fixtures/repo'

/** Default pool path inside {@link REPOSITORY}. */
export const POOL = `${REPOSITORY}/.agents/worktrees`

/** Wire session id every rendered chip binds to. */
export const SESSION = 'session-1'

/**
 * One named copy, as the host names it (name, branch and directory agree).
 * @param name - copy name; defaults to `quiet-harbor-3fa9`.
 * @param repositoryRoot - repository the pool lives in.
 * @returns the copy reference.
 */
export function copyRef(name = 'quiet-harbor-3fa9', repositoryRoot = REPOSITORY): WorktreeRef {
  return {
    name,
    path: `${repositoryRoot}/.agents/worktrees/${name}`,
    branch: name,
  }
}

/**
 * A supported `status` answer for a repository with no existing copy.
 * @param overrides - fields to replace.
 * @returns the status value.
 */
export function supportedStatus(
  overrides: Partial<Extract<StatusValue, { supported: true }>> = {},
): Extract<StatusValue, { supported: true }> {
  return {
    supported: true,
    repositoryRoot: REPOSITORY,
    poolPath: POOL,
    sessionWorktree: null,
    sourceDirty: 0,
    defaultEnabled: true,
    ...overrides,
  }
}

/**
 * An unsupported `status` answer for a directory that is not a repository.
 * @param defaultEnabled - the configured default the host reports.
 * @returns the status value.
 */
export function unsupportedStatus(defaultEnabled = false): Extract<StatusValue, { supported: false }> {
  return { supported: false, reason: 'not-a-git-repository', defaultEnabled }
}

/**
 * A successful `prepare` answer.
 * @param overrides - fields to replace.
 * @returns the prepare value.
 */
export function prepareValue(overrides: Partial<PrepareValue> = {}): PrepareValue {
  return {
    state: 'created',
    worktree: copyRef(),
    repositoryRoot: REPOSITORY,
    sourceDirty: 0,
    ...overrides,
  }
}

/**
 * A supported `list` answer.
 * @param items - copies to list.
 * @returns the list value.
 */
export function listValue(items: readonly WorktreeItem[] = []): Extract<ListValue, { supported: true }> {
  return { supported: true, repositoryRoot: REPOSITORY, poolPath: POOL, items }
}

/**
 * One pool row.
 * @param overrides - fields to replace.
 * @returns the worktree item.
 */
export function worktreeItem(overrides: Partial<WorktreeItem> = {}): WorktreeItem {
  const ref = copyRef(overrides.name)
  return {
    ...ref,
    createdAt: 1_700_000_000_000,
    changedFiles: 0,
    prunable: false,
    ...overrides,
  }
}

/**
 * A discarded-copy answer.
 * @param name - discarded copy name.
 * @returns the discard value.
 */
export function discardValue(name: string): { removed: true; name: string; branch: string; path: string } {
  const ref = copyRef(name)
  return { removed: true, name: ref.name, branch: ref.branch, path: ref.path }
}

/** The session slice the chip reads: the blank-session hero test. */
export interface SessionFixtureState {
  /** Whether the composer is the blank-session hero. */
  readonly blank: boolean
  /** Whether the session view is open. */
  readonly openState: 'open' | 'closed'
}

/** Host round-trip double that records every call and answers per script. */
export class FakeConnection {
  /** Calls in issue order. */
  readonly calls: HostCall[] = []

  private readonly answers = new Map<HostVerb, HostAnswerer>()

  /**
   * Script one verb.
   * @param verb - verb to answer.
   * @param answerer - answer callback (invoked at call time).
   */
  setAnswer(verb: HostVerb, answerer: HostAnswerer): void {
    this.answers.set(verb, answerer)
  }

  /**
   * Recorded calls for one verb.
   * @param verb - verb to filter by.
   * @returns matching calls in issue order.
   */
  callsFor(verb: HostVerb): readonly HostCall[] {
    return this.calls.filter(call => call.verb === verb)
  }

  /** The `ClientConnectionRpc` face `ctx.connection.rpc` exposes. */
  readonly rpc = {
    call: async (
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<ConnectionRpcResult<unknown>> => {
      const verb = endpoint.slice(endpoint.lastIndexOf('/') + 1) as HostVerb
      const call: HostCall = { channel, endpoint, verb, payload: payload as Record<string, unknown>, signal }
      this.calls.push(call)
      const answerer = this.answers.get(verb)
      if (answerer === undefined) return fail(`no answer scripted for ${verb}`)
      return answerer(call)
    },
  }
}

/** Composer-block double: records every `set` and keeps per-session stores. */
export class FakeComposerBlocks {
  /** Every `set` call, with the reason as raised (undefined when cleared). */
  readonly writes: { readonly sessionId: string; readonly reason: string | undefined }[] = []

  private readonly stores = new Map<string, SnapshotStore<ComposerBlock | undefined>>()

  /**
   * Raise or clear a block.
   * @param sessionId - Session whose composer is affected.
   * @param block - block to raise, or undefined to clear it.
   */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void {
    this.writes.push({ sessionId: String(sessionId), reason: block?.reason })
    this.storeFor(sessionId).set(block)
  }

  /**
   * Observable block state for one Session.
   * @param sessionId - Session to observe.
   * @returns the identity-stable block store.
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> {
    const key = String(sessionId)
    const existing = this.stores.get(key)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<ComposerBlock | undefined>(undefined)
    this.stores.set(key, created)
    return created
  }

  /**
   * Drop one Session's store.
   * @param sessionId - Session being released.
   */
  forget(sessionId: SessionId): void {
    this.stores.delete(String(sessionId))
  }

  /**
   * The reason currently raised for one Session.
   * @param sessionId - Session to read.
   * @returns the reason, or undefined when the composer is not blocked.
   */
  reasonFor(sessionId: string = SESSION): string | undefined {
    return this.storeFor(sessionId as SessionId).getSnapshot()?.reason
  }
}

/** Layout double: records panel selection, serves the panel-info hook. */
export class FakeLayout implements ILayout {
  /** Selected panel ids in call order; null is "back to the conversation". */
  readonly selected: (string | null)[] = []

  /** Panel-info source the renderer would expose as `usePanelInfo`. */
  readonly panelInfo: SnapshotStore<PanelInfo> = createSnapshotStore<PanelInfo>({ activePanelId: null })

  /**
   * Select a central panel.
   * @param panelId - panel id, or null for the conversation.
   */
  selectPanel(panelId: MainPanelId | null): void {
    this.selected.push(panelId === null ? null : String(panelId))
    this.panelInfo.set({ activePanelId: panelId })
  }

  /** @returns a never-aborted navigation signal. */
  beginNavigation(): AbortSignal {
    return new AbortController().signal
  }

  /** No-op sidebar toggle. */
  toggleSidebar(): void {}

  /** No-op rightbar report. */
  openRightbar(): void {}

  /** No-op rightbar report. */
  closeRightbar(): void {}
}

/** One workspace the panel reads, in the shape the controller consumes. */
export interface WorkspaceFixture {
  /** Workspace directory path. */
  readonly path: string
  /** Display title. */
  readonly title: string
}

/** Panel view handle returned by {@link ClientHarness.renderSlot}. */
export interface ClientSlotView {
  /** The rendered container (Testing Library root). */
  readonly container: HTMLElement
  /** Testing Library queries scoped to {@link ClientSlotView.container}. */
  readonly view: ReturnType<typeof within>
  /**
   * Re-render with a new owner props share.
   * @param owner - owner props for the slot.
   */
  update(owner: object): void
  /** Unmount this view. */
  unmount(): void
}

/** Options accepted by {@link setup}. */
export interface ClientHarnessOptions {
  /** Workspaces the panel reads; defaults to none. */
  readonly workspaces?: readonly WorkspaceFixture[]
  /** Initial session state; defaults to the blank-session hero. */
  readonly session?: Partial<SessionFixtureState>
  /** Clear `localStorage` before starting; defaults to true. */
  readonly resetStorage?: boolean
}

/** Options for one {@link ClientHarness.renderSlot} call. */
export interface SlotRenderOptions {
  /** Keyed entry cell (the plugin registers `main` under this id). */
  readonly entryKey?: string
}

/** The declaration slice `renderSlot` needs from the ledger. */
interface SlotSpec {
  /** Slot cardinality. */
  readonly kind: string
  /** Declared data scope. */
  readonly scope: SlotScope
}

/** A bare snapshot source, the shape selector hooks are bound to. */
type ObservableSource = ObservableSnapshot<unknown>

/** One bound selector hook prop. */
type SelectorHook = (selector?: (value: unknown) => unknown) => unknown

/**
 * Bind a bare source to the `use<Name>(selector?)` shape the renderer hands a
 * component; the source's snapshot is read at render time through uSES.
 * @param source - observable snapshot source.
 * @returns the selector hook prop.
 */
function selectorHook(source: ObservableSource): SelectorHook {
  return function useBoundSelector(selector?: (value: unknown) => unknown): unknown {
    return useSyncExternalStore(
      listener => source.subscribe(listener),
      () => (selector === undefined ? source.getSnapshot() : selector(source.getSnapshot())),
    )
  }
}

/** Capitalize a hook compartment name (`toggle` -> `Toggle`). */
function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

/** Props the fake materializer hands one registered component. */
interface BoundSlotProps {
  /** Owning harness. */
  readonly harness: ClientHarness
  /** The winning ledger entry. */
  readonly entry: StoredEntry
  /** Declared data scope of the slot. */
  readonly scope: SlotScope
  /** Owner props share from the render site. */
  readonly owner: object
}

/**
 * Materialize one ledger entry's component props from its inject face, locale
 * seat, and the Session standard kit slice the Worktree components read.
 * @param props - entry, scope, owner share, and owning harness.
 * @returns the component element.
 */
function BoundSlot(props: BoundSlotProps): ReactNode {
  const { harness, entry, scope, owner } = props
  const inject = entry.inject as ((...args: unknown[]) => Record<string, unknown>) | undefined
  const sessionId = harness.sessionId as unknown as SessionId
  const face = inject === undefined
    ? {}
    : inject(...scope === 'session' ? [sessionId] : [])
  const composed = Object.assign({}, owner, face) as Record<string, unknown>

  const hooks = (face as { hooks?: Record<string, ObservableSource> }).hooks
  if (hooks !== undefined) {
    delete composed.hooks
    for (const [name, source] of Object.entries(hooks)) {
      composed[`use${capitalize(name)}`] = selectorHook(source)
    }
  }

  if (entry.locale !== undefined) composed.t = harness.locale.bind(entry.locale)
  if (scope === 'session') {
    composed.useSession = selectorHook(harness.session)
    composed.sessionId = sessionId
  }

  const Component = entry.component as ComponentType<Record<string, unknown>>
  return createElement(Component, composed)
}

/**
 * The assembled client-side test bed: real registry, real locale, fake wire,
 * fake conversation/layout/workspace services, and a fake renderer whose
 * `renderSlot` reads the ledger. Create with {@link setup}.
 */
export class ClientHarness {
  /** Readable wire double. */
  readonly connection = new FakeConnection()

  /** Composer-block registry double. */
  readonly blocks = new FakeComposerBlocks()

  /** Layout double. */
  readonly layout = new FakeLayout()

  /** Session snapshot store the fake session kit reads. */
  readonly session: SnapshotStore<SessionFixtureState>

  /** Workspace list snapshot store. */
  readonly workspacesStore: SnapshotStore<WorkspaceSnapshot>

  private readonly views: ClientSlotView[] = []
  private pluginFiber: Fiber | undefined
  private rootDispose: (() => void) | undefined
  private disposed = false

  private constructor(
    /** The runtime context every plugin and service lives on. */
    readonly ctx: Context,
    /** The production slot registry. */
    readonly slots: SlotRegistry,
    /** The production locale runtime. */
    readonly locale: LocaleRuntime,
    session: SnapshotStore<SessionFixtureState>,
    workspaces: SnapshotStore<WorkspaceSnapshot>,
  ) {
    this.session = session
    this.workspacesStore = workspaces
  }

  /** Wire session id every rendered chip binds to. */
  readonly sessionId = SESSION

  /**
   * Assemble the harness and mount the plugin.
   * @param options - fixtures and storage behavior.
   * @returns the mounted harness; disposal is registered with the test.
   */
  static async create(options: ClientHarnessOptions = {}): Promise<ClientHarness> {
    if (options.resetStorage !== false) globalThis.localStorage.clear()

    const { SlotRegistry: SlotRegistryClass } = await loadClientModule<{
      SlotRegistry: new (ctx: Context) => SlotRegistry
    }>('@deepseek-ai/dsh-client-ui-renderer/client', '@deepseek-ai/dsh-client-ui-renderer')
    const { LocaleRuntime: LocaleRuntimeClass } = await loadClientModule<{
      LocaleRuntime: new (ctx: Context) => LocaleRuntime
    }>('@deepseek-ai/dsh-client-locale/client', '@deepseek-ai/dsh-client-locale')

    const ctx = new Context()
    await ctx.plugin(SlotRegistryClass).await()
    const slots = ctx.get('slots') as SlotRegistry

    const locale = new LocaleRuntimeClass(ctx)
    locale.setLocale('en')
    slots.installLocale(locale)
    ctx.provide('locale', locale)

    const session = createSnapshotStore<SessionFixtureState>({
      blank: true,
      openState: 'open',
      ...options.session,
    })
    const workspaces = createSnapshotStore<WorkspaceSnapshot>({
      items: (options.workspaces ?? []).map(workspaceView),
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
    })

    const harness = new ClientHarness(ctx, slots, locale, session, workspaces)

    ctx.provide('connection', harness.connection as unknown as ConnectionHandle)
    ctx.provide('conversation', harness.conversation())
    ctx.provide('layout', harness.layout)
    ctx.provide('workspaces', { list: workspaces } as unknown as IWorkspaces)

    // The fake renderer: `renderSlot` below is this bench's rendering entry.
    slots.install({ renderRoot: () => null })
    harness.declareSlots()

    harness.pluginFiber = ctx.plugin({ inject: [...pluginInject], apply })
    await harness.pluginFiber.await()

    onTestFinished(() => harness.dispose())
    return harness
  }

  /**
   * Set the session snapshot the fake session kit hands the chip.
   * @param patch - fields to replace.
   */
  setSession(patch: Partial<SessionFixtureState>): void {
    this.session.update(draft => Object.assign(draft, patch))
  }

  /**
   * Replace the workspaces the panel reads.
   * @param workspaces - workspace fixtures.
   */
  setWorkspaces(workspaces: readonly WorkspaceFixture[]): void {
    this.workspacesStore.update((draft) => {
      (draft as { items: readonly WorkspaceView[] }).items = workspaces.map(workspaceView)
    })
  }

  /**
   * Render one declared slot's registered entry (or entries) with owner props.
   * @param key - declared slot key.
   * @param owner - owner props share for the render site.
   * @param options - keyed cell selection.
   * @returns the rendered view.
   */
  renderSlot(key: string, owner: object = {}, options: SlotRenderOptions = {}): ClientSlotView {
    const build = (nextOwner: object): ReactElement => {
      const spec = (this.slots.spec as (name: string) => SlotSpec | undefined)(key)
      if (spec === undefined) {
        throw new Error(`renderSlot('${key}') without a declaration — declare the slot first`)
      }
      const entries = this.entriesFor(key, spec.kind, options)
      if (entries.length === 0) throw new Error(`renderSlot('${key}'): no registration on the ledger`)
      return createElement(Fragment, null, entries.map((entry, index) => createElement(BoundSlot, {
        key: `${key}:${String(entry.options.id ?? entry.options.key ?? index)}`,
        harness: this,
        entry,
        scope: spec.scope,
        owner: nextOwner,
      })))
    }

    let result: RenderResult = render(build(owner))
    const view: ClientSlotView = {
      container: result.container,
      view: within(result.container),
      update: (nextOwner) => { result.rerender(build(nextOwner)) },
      unmount: () => { result.unmount() },
    }
    this.views.push(view)
    return view
  }

  /** Unload the plugin fiber while leaving the runtime and its services alive. */
  async unloadPlugin(): Promise<void> {
    await this.pluginFiber?.dispose()
    this.pluginFiber = undefined
  }

  /** Dispose the mount, the React views, and the runtime context. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const view of this.views.splice(0)) view.unmount()
    this.rootDispose?.()
    this.rootDispose = undefined
    await this.pluginFiber?.dispose()
    this.pluginFiber = undefined
    await this.ctx.fiber.dispose()
  }

  /** The `ctx.conversation` face: only `blocks` is read by this plugin. */
  private conversation(): IConversation {
    return {
      input: {} as never,
      blocks: this.blocks,
      send: async () => {},
      updateQueue: async () => {},
      cancel: async () => {},
      loadOlder: async () => {},
    }
  }

  /** Declare the slots the plugin registers into, through the real registry. */
  private declareSlots(): void {
    this.rootDispose = (this.slots.register as unknown as (
      options: object,
      component: unknown,
    ) => () => void)({
      name: 'root',
      children: {
        'conversation.input.left': { kind: 'list', scope: 'session' },
        main: { kind: 'keyed', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
      },
    }, () => null)
  }

  /** Ledger entries to render for one key, honoring list order and keyed cells. */
  private entriesFor(key: string, kind: string, options: SlotRenderOptions): readonly StoredEntry[] {
    const entries = this.slots.entries(key as never)
    if (kind !== 'keyed') return entries
    if (options.entryKey === undefined) {
      throw new Error(`renderSlot('${key}') is a keyed slot — pass options.entryKey`)
    }
    return entries.filter(entry => entry.options.key === options.entryKey)
  }
}

/** Turn one fixture into the WorkspaceView the panel controller reads. */
function workspaceView(workspace: WorkspaceFixture): WorkspaceView {
  return {
    workspaceId: `workspace:${workspace.path}` as WorkspaceView['workspaceId'],
    path: workspace.path,
    title: workspace.title,
    sessionIds: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
}

/**
 * Assemble a mounted client harness for one test.
 * @param options - fixtures and storage behavior.
 * @returns the ready harness.
 */
export async function setup(options: ClientHarnessOptions = {}): Promise<ClientHarness> {
  return ClientHarness.create(options)
}
