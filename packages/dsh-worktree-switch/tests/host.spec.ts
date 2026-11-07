/**
 * Host-half spec for the Worktree switch.
 *
 * Every case drives `createWorktreeToggle` over real services and asserts only
 * externally observable behavior: directories and branches on disk, the
 * session's committed working directory, the four verb payloads, and errors.
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { WorktreeToggleError, createWorktreeToggle, detectSessionScope } from '../src/host/handlers.ts'
import type { PrepareValue, WorktreeToggle } from '../src/host/handlers.ts'
import { installWorktreeScope, SessionScopeRegistry } from '../src/host/scope.ts'
import { POOL_DIRECTORY, git, harness, remoteFixture, repository, temporaryDirectory, testAgent } from './harness.ts'
import type { RemoteFixture } from './harness.ts'

let ctx: Context | undefined
const roots: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** One mounted host context, its live Agent, and the toggle under test. */
interface Fixture {
  readonly ctx: Context
  readonly agent: Agent
  readonly toggle: WorktreeToggle
}

/**
 * Mount the harness and build the toggle over one Agent.
 * @param root - repository root the filesystem provider starts in.
 * @param startDirectory - session creation directory; defaults to the root.
 * @param defaultEnabled - row config reported in status; defaults to true.
 * @param baseRef - configured base point; defaults to `fresh`.
 * @returns the live fixture.
 */
async function fixture(
  root: string,
  startDirectory = root,
  defaultEnabled = true,
  baseRef: 'fresh' | 'head' = 'fresh',
): Promise<Fixture> {
  ctx = await harness(root)
  const agent = testAgent(ctx, startDirectory)
  const toggle = createWorktreeToggle(ctx, { defaultEnabled, baseRef })
  return { ctx, agent, toggle }
}

/**
 * Mount the harness with the plugin's model-facing scope context wired the way
 * `apply()` wires it: one registry, the Git-backed detector, and the verbs
 * reporting what they learned.
 * @param root - repository root the filesystem provider starts in.
 * @param startDirectory - session creation directory; defaults to the root.
 * @param defaultEnabled - row config reported in status; defaults to true.
 * @param baseRef - configured base point; defaults to `fresh`.
 * @returns the live fixture plus the registry the prompt context reads.
 */
async function scopeFixture(
  root: string,
  startDirectory = root,
  defaultEnabled = true,
  baseRef: 'fresh' | 'head' = 'fresh',
): Promise<Fixture & { readonly scopes: SessionScopeRegistry }> {
  const host = await harness(root)
  ctx = host
  const agent = testAgent(host, startDirectory)
  const scopes = new SessionScopeRegistry()
  installWorktreeScope(host, {
    registry: scopes,
    detect: (subject, signal) => detectSessionScope(host, subject, signal),
  })
  const toggle = createWorktreeToggle(host, {
    defaultEnabled,
    baseRef,
    onScope: (sessionId, scope) => {
      if (scope === null) scopes.forget(sessionId)
      else scopes.remember(sessionId, scope)
    },
  })
  return { ctx: host, agent, toggle, scopes }
}

/**
 * Register one temp repository for cleanup.
 * @param options - whether the fixture gets its initial commit.
 * @returns the canonical repository root.
 */
async function repo(options: Parameters<typeof repository>[0] = {}): Promise<string> {
  const root = await repository(options)
  roots.push(root)
  return root
}

/**
 * Build a local-remote fixture and register it for cleanup.
 * @param options - default branch name.
 * @returns the fixture, removed after the test.
 */
async function remoteRepo(options: Parameters<typeof remoteFixture>[0] = {}): Promise<RemoteFixture> {
  const fixture = await remoteFixture(options)
  roots.push(fixture.root)
  return fixture
}

/** Register one temp non-repository directory for cleanup. */
async function directory(): Promise<string> {
  const path = await temporaryDirectory()
  roots.push(path)
  return path
}

/**
 * Await one expected rejection and return the toggle error.
 * @param operation - the verb call that must fail.
 * @returns the thrown {@link WorktreeToggleError}.
 */
async function failureOf(operation: () => Promise<unknown>): Promise<WorktreeToggleError> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof WorktreeToggleError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

/**
 * Narrow a prepare result to the copy the call actually created.
 * @param prepared - the prepare value under test.
 * @returns the created branch of the result union.
 */
function created(prepared: PrepareValue): Extract<PrepareValue, { state: 'created' }> {
  if (prepared.state !== 'created') throw new Error(`expected a created copy, got ${prepared.state}`)
  return prepared
}

/**
 * Read the checkout rows of one repository's `git worktree list`.
 * @param root - repository root to inspect.
 * @returns the absolute checkout paths Git reports.
 */
async function worktreePaths(root: string): Promise<string[]> {
  return (await git(root, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
}

/**
 * Count the pool entries that are copies rather than the pool's ignore file.
 * @param poolPath - absolute pool directory.
 * @returns the directory names under the pool.
 */
async function poolEntries(poolPath: string): Promise<string[]> {
  return (await readdir(poolPath)).filter(name => name !== '.gitignore')
}

describe('worktree toggle status', () => {
  it('reports a non-repository project as unsupported instead of failing', async () => {
    const path = await directory()
    const { agent, toggle } = await fixture(path)

    const status = await toggle.status({ sessionId: agent.id })

    expect(status).toEqual({ supported: false, reason: 'not-a-git-repository', defaultEnabled: true })
  })

  it('reports the configured default and an empty pool before any copy exists', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root, root, false)

    const status = await toggle.status({ sessionId: agent.id })
    const listed = await toggle.list({ path: root })

    expect(status).toMatchObject({ supported: true, defaultEnabled: false })
    expect(listed).toEqual({ supported: true, repositoryRoot: root, items: [] })
    await expect(stat(join(root, POOL_DIRECTORY))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('worktree toggle prepare', () => {
  it('creates one copy and moves the session into it', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)

    const prepared = await toggle.prepare({ sessionId: agent.id })

    expect(prepared).toMatchObject({ state: 'created', repositoryRoot: root, sourceDirty: 0 })
    expect(prepared.worktree.name).toBe(prepared.worktree.branch)
    expect(basename(prepared.worktree.path)).toBe(prepared.worktree.name)
    expect(prepared.worktree.path).toBe(join(root, POOL_DIRECTORY, prepared.worktree.name))
    expect((await stat(prepared.worktree.path)).isDirectory()).toBe(true)
    expect(await git(root, 'branch', '--list', prepared.worktree.name)).toContain(prepared.worktree.name)
    expect(await git(prepared.worktree.path, 'symbolic-ref', '--short', 'HEAD')).toBe(prepared.worktree.branch)
    expect(ctx.workingDirectory.get(agent.session)).toBe(prepared.worktree.path)
    expect(await worktreePaths(root)).toEqual([root, prepared.worktree.path])
    expect(await poolEntries(join(root, POOL_DIRECTORY))).toEqual([prepared.worktree.name])
  })

  it('reuses the copy a session already runs in without creating a second one', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)

    const first = await toggle.prepare({ sessionId: agent.id })
    const second = await toggle.prepare({ sessionId: agent.id })

    expect(first.state).toBe('created')
    expect(second.state).toBe('existing')
    expect(second.worktree).toEqual(first.worktree)
    expect(second.repositoryRoot).toBe(first.repositoryRoot)
    expect(await poolEntries(join(root, POOL_DIRECTORY))).toEqual([first.worktree.name])
    expect(await worktreePaths(root)).toEqual([root, first.worktree.path])
    expect(await git(root, 'branch', '--list', first.worktree.branch)).toContain(first.worktree.name)
    expect(ctx.workingDirectory.get(agent.session)).toBe(first.worktree.path)
  })

  it('resolves the repository root when the session starts in a subdirectory', async () => {
    const root = await repo()
    const nested = join(root, 'packages', 'nested')
    await mkdir(nested, { recursive: true })
    const { ctx, agent, toggle } = await fixture(root, nested)

    const status = await toggle.status({ sessionId: agent.id })
    const prepared = await toggle.prepare({ sessionId: agent.id })

    expect(status).toMatchObject({
      supported: true,
      repositoryRoot: root,
      sessionWorktree: null,
    })
    expect(prepared.repositoryRoot).toBe(root)
    expect(prepared.worktree.path).toBe(join(root, POOL_DIRECTORY, prepared.worktree.name))
    expect((await stat(prepared.worktree.path)).isDirectory()).toBe(true)
    expect(ctx.workingDirectory.get(agent.session)).toBe(prepared.worktree.path)
  })

  it('fails without moving the session when the repository has no commits', async () => {
    const root = await repo({ commits: false })
    const { ctx, agent, toggle } = await fixture(root)

    const failure = await failureOf(() => toggle.prepare({ sessionId: agent.id }))

    expect(failure.code).toBe('worktree-create-failed')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await git(root, 'branch', '--list')).toBe('')
    await expect(stat(join(root, POOL_DIRECTORY))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('worktree toggle release', () => {
  it('moves the session back and removes the copy the switch created', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })

    const released = await toggle.release({ sessionId: agent.id })

    expect(released).toEqual({ directory: root, removed: prepared.worktree, kept: null })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    await expect(stat(prepared.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', prepared.worktree.branch)).toBe('')
    expect(await worktreePaths(root)).toEqual([root])
    const listed = await toggle.list({ path: root })
    if (!listed.supported) throw new Error('expected a supported list')
    expect(listed.items).toEqual([])
  })

  it('moves the session back from a subdirectory of a copy and still removes it', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })
    const nested = join(prepared.worktree.path, 'packages', 'nested')
    await mkdir(nested, { recursive: true })
    await ctx.workingDirectory.set(agent, nested)

    const released = await toggle.release({ sessionId: agent.id })

    expect(released).toMatchObject({ directory: root, removed: { name: prepared.worktree.name } })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    await expect(stat(prepared.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a copy the switch did not create and still moves the session back', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)
    const name = 'amber-atlas-b7a3'
    const created = await ctx.worktrees.create(agent, { name, from: 'HEAD' })
    expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)

    const released = await toggle.release({ sessionId: agent.id })

    expect(released.directory).toBe(root)
    expect(released.removed).toBeNull()
    expect(released.kept).toMatchObject({ name, path: created.path })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect((await stat(created.path)).isDirectory()).toBe(true)
    expect(await git(root, 'branch', '--list', name)).toContain(name)
  })

  it('keeps a dirty copy on disk but still moves the session back', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })
    await writeFile(join(prepared.worktree.path, 'untracked.txt'), 'dirty\n')

    const released = await toggle.release({ sessionId: agent.id })

    expect(released.directory).toBe(root)
    expect(released.removed).toBeNull()
    expect(released.kept).toMatchObject({ name: prepared.worktree.name, branch: prepared.worktree.branch })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect((await stat(prepared.worktree.path)).isDirectory()).toBe(true)
    expect(await git(root, 'branch', '--list', prepared.worktree.branch)).toContain(prepared.worktree.name)
  })

  it('is a no-op for a session that never ran in a copy', async () => {
    const root = await repo()
    const { ctx, agent, toggle } = await fixture(root)

    const released = await toggle.release({ sessionId: agent.id })

    expect(released).toEqual({ directory: root, removed: null, kept: null })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
  })
})

describe('worktree session scope context', () => {
  it('narrows the model to the copy once the switch prepared it, and drops the line on release', async () => {
    const root = await repo()
    const { ctx, agent, toggle, scopes } = await scopeFixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })

    expect(scopes.get(agent.id)).toMatchObject({ worktree: { path: prepared.worktree.path } })
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const hint = assembly.contexts.find(entry => entry.name === 'worktree-switch:scope')
    expect(hint?.text).toContain(prepared.worktree.path)
    expect(hint?.text).toContain(JSON.stringify(root))

    await toggle.release({ sessionId: agent.id })

    expect(scopes.get(agent.id)).toBeNull()
    const after = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(after.contexts.find(entry => entry.name === 'worktree-switch:scope')?.text ?? '').toBe('')
  })

  it('stays silent for a session that never entered a copy', async () => {
    const root = await repo()
    const { ctx, agent, toggle, scopes } = await scopeFixture(root, root, false)

    const status = await toggle.status({ sessionId: agent.id })

    expect(status).toMatchObject({ supported: true, sessionWorktree: null })
    expect(scopes.get(agent.id)).toBeNull()
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.contexts.find(entry => entry.name === 'worktree-switch:scope')?.text ?? '').toBe('')
  })

  it('detects a copy the switch did not create, from inside it too', async () => {
    const root = await repo()
    const { ctx, agent } = await scopeFixture(root)
    const created = await ctx.worktrees.create(agent, { name: 'brisk-fern-1a2b', from: 'HEAD' })

    expect(await detectSessionScope(ctx, agent)).toMatchObject({
      worktree: { name: 'brisk-fern-1a2b', path: created.path },
      repositoryRoot: root,
    })

    const nested = join(created.path, 'packages', 'nested')
    await mkdir(nested, { recursive: true })
    await ctx.workingDirectory.set(agent, nested)
    expect((await detectSessionScope(ctx, agent))?.worktree.path).toBe(created.path)

    await ctx.workingDirectory.set(agent, root)
    expect(await detectSessionScope(ctx, agent)).toBeNull()
  })

  it('learns a copy the switch never saw when the next request needs it', async () => {
    const root = await repo()
    const { ctx, agent, scopes } = await scopeFixture(root)
    const created = await ctx.worktrees.create(agent, { name: 'quiet-harbor-3fa9', from: 'HEAD' })

    // The copy was entered without a switch verb: the first assembly has no
    // line yet, derives one in the background, and the next one carries it.
    const first = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(first.contexts.find(entry => entry.name === 'worktree-switch:scope')?.text ?? '').toBe('')
    await vi.waitFor(() => { expect(scopes.get(agent.id)?.worktree.path).toBe(created.path) })
    const second = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(second.contexts.find(entry => entry.name === 'worktree-switch:scope')?.text).toContain(created.path)
  })

  it('drops the line synchronously as soon as the session leaves the copy', async () => {
    const root = await repo()
    const { ctx, agent, toggle, scopes } = await scopeFixture(root)
    await toggle.prepare({ sessionId: agent.id })
    await ctx.workingDirectory.set(agent, root)

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(assembly.contexts.find(entry => entry.name === 'worktree-switch:scope')?.text ?? '').toBe('')
    expect(scopes.get(agent.id)).toBeNull()
  })

  it('does not re-inspect the same non-copy directory on every request', async () => {
    const root = await repo()
    const host = await harness(root)
    ctx = host
    const agent = testAgent(host, root)
    const scopes = new SessionScopeRegistry()
    let detections = 0
    installWorktreeScope(host, {
      registry: scopes,
      detect: async () => { detections += 1; return null },
    })
    const nested = join(root, 'packages', 'nested')
    await mkdir(nested, { recursive: true })
    await host.workingDirectory.set(agent, nested)

    await host.systemPrompt.assemble(assembleContextFor(agent))
    await host.systemPrompt.assemble(assembleContextFor(agent))
    await host.systemPrompt.assemble(assembleContextFor(agent))

    await vi.waitFor(() => { expect(detections).toBe(1) })
    expect(scopes.get(agent.id)).toBeNull()
  })
})

describe('worktree toggle list', () => {
  it('lists the pool copy and never the main checkout', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })

    const listed = await toggle.list({ path: root })

    expect(listed).toMatchObject({ supported: true, repositoryRoot: root })
    if (!listed.supported) throw new Error('expected a supported list')
    expect(listed.items).toHaveLength(1)
    const item = listed.items[0]
    expect(item).toBeDefined()
    expect(item).toMatchObject({
      name: prepared.worktree.name,
      path: prepared.worktree.path,
      branch: prepared.worktree.branch,
      changedFiles: 0,
      prunable: false,
    })
    expect(item?.createdAt).toBeGreaterThan(0)
    expect(listed.items.some(entry => entry.path === root)).toBe(false)
  })
})

describe('worktree toggle discard', () => {
  it('refuses a dirty copy and leaves its directory and branch in place', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })
    await writeFile(join(prepared.worktree.path, 'untracked.txt'), 'dirty\n')

    const failure = await failureOf(() =>
      toggle.discard({ path: root, name: prepared.worktree.name }),
    )

    expect(failure.code).toBe('worktree-dirty')
    expect(failure.details).toMatchObject({ name: prepared.worktree.name, changedFiles: 1 })
    expect((await stat(prepared.worktree.path)).isDirectory()).toBe(true)
    expect(await git(root, 'branch', '--list', prepared.worktree.branch)).toContain(prepared.worktree.name)
    const listed = await toggle.list({ path: root })
    if (!listed.supported) throw new Error('expected a supported list')
    expect(listed.items).toMatchObject([{ name: prepared.worktree.name, changedFiles: 1 }])
  })

  it('removes a clean copy, deletes its branch, and empties the list', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })

    const removed = await toggle.discard({ path: root, name: prepared.worktree.name })

    expect(removed).toEqual({
      removed: true,
      name: prepared.worktree.name,
      branch: prepared.worktree.branch,
      path: prepared.worktree.path,
    })
    await expect(stat(prepared.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', prepared.worktree.branch)).toBe('')
    expect(await worktreePaths(root)).toEqual([root])
    const listed = await toggle.list({ path: root })
    if (!listed.supported) throw new Error('expected a supported list')
    expect(listed.items).toEqual([])
  })

  it('rejects an unknown copy and an invalid name', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })

    const missing = await failureOf(() => toggle.discard({ path: root, name: 'unknown-copy' }))
    const invalid = await failureOf(() => toggle.discard({ path: root, name: '../x' }))

    expect(missing.code).toBe('worktree-not-found')
    expect(missing.details).toMatchObject({ name: 'unknown-copy', repositoryRoot: root })
    expect(invalid.code).toBe('worktree-name-invalid')
    expect((await stat(prepared.worktree.path)).isDirectory()).toBe(true)
    expect(await git(root, 'branch', '--list', prepared.worktree.branch)).toContain(prepared.worktree.name)
  })
})

describe('worktree copy base point', () => {
  it('bases a fresh copy on the fetched remote tip, not the stale local HEAD', async () => {
    const remote = await remoteRepo()
    const { ctx, agent, toggle } = await fixture(remote.clone)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'remote', branch: remote.branch })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD')).toBe(remote.ahead)
    expect(await git(remote.clone, 'rev-parse', 'HEAD')).toBe(remote.behind)
    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.ahead)
    expect(ctx.workingDirectory.get(agent.session)).toBe(prepared.worktree.path)
  })

  it('falls back to local HEAD when the remote default branch cannot be fetched', async () => {
    const remote = await remoteRepo()
    await git(remote.clone, 'remote', 'set-url', 'origin', 'file:///nonexistent/dsh-worktree-origin.git')
    const { agent, toggle } = await fixture(remote.clone)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'fallback' })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD')).toBe(remote.behind)
    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.behind)
  })

  it('bases a head copy on the local checkout without touching the network', async () => {
    const remote = await remoteRepo()
    const { agent, toggle } = await fixture(remote.clone, remote.clone, true, 'head')

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'head' })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD')).toBe(remote.behind)
    // A fetch would have moved origin/main to the remote tip.
    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.behind)
  })

  it('starts silently from local HEAD when the repository has no origin', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'head' })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD'))
      .toBe(await git(root, 'rev-parse', 'HEAD'))
  })

  it('resolves main when the clone lost origin/HEAD', async () => {
    const remote = await remoteRepo()
    await git(remote.clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    const { agent, toggle } = await fixture(remote.clone)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'remote', branch: remote.branch })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD')).toBe(remote.ahead)
  })

  it('resolves master when origin/HEAD is gone and the default branch is master', async () => {
    const remote = await remoteRepo({ branch: 'master' })
    await git(remote.clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    const { agent, toggle } = await fixture(remote.clone)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'remote', branch: 'master' })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD')).toBe(remote.ahead)
  })

  it('honours origin/HEAD when the default branch is not main', async () => {
    const remote = await remoteRepo({ branch: 'develop' })
    const { agent, toggle } = await fixture(remote.clone)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'remote', branch: remote.branch })
    expect(await git(prepared.worktree.path, 'rev-parse', 'HEAD')).toBe(remote.ahead)
  })

  it('fetches only the default branch and drags in no tags', async () => {
    const remote = await remoteRepo()
    const seed = join(remote.root, 'seed')
    await git(seed, 'branch', 'feature')
    await git(seed, 'tag', 'v1')
    await git(seed, 'push', 'origin', 'feature')
    await git(seed, 'push', 'origin', 'v1')
    const { agent, toggle } = await fixture(remote.clone)

    const prepared = created(await toggle.prepare({ sessionId: agent.id }))

    expect(prepared.base).toEqual({ kind: 'remote', branch: remote.branch })
    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.ahead)
    expect(await git(remote.clone, 'tag', '--list')).toBe('')
    await expect(
      git(remote.clone, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature'),
    ).rejects.toThrow()
  })

  it('does not fetch for status', async () => {
    const remote = await remoteRepo()
    const { agent, toggle } = await fixture(remote.clone)

    const status = await toggle.status({ sessionId: agent.id })

    expect(status).toMatchObject({ supported: true, sessionWorktree: null })
    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.behind)
  })

  it('does not fetch for release', async () => {
    const remote = await remoteRepo()
    const seed = join(remote.root, 'seed')
    const { agent, toggle } = await fixture(remote.clone)
    const prepared = created(await toggle.prepare({ sessionId: agent.id }))
    await writeFile(join(seed, 'tracked.txt'), 'further\n')
    await git(seed, 'commit', '-am', 'further')
    await git(seed, 'push', 'origin', 'main')
    const further = await git(seed, 'rev-parse', 'HEAD')

    await toggle.release({ sessionId: agent.id })

    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.ahead)
    expect(further).not.toBe(remote.ahead)
    await expect(stat(prepared.worktree.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not fetch for discard', async () => {
    const remote = await remoteRepo()
    const seed = join(remote.root, 'seed')
    const { agent, toggle } = await fixture(remote.clone)
    const prepared = created(await toggle.prepare({ sessionId: agent.id }))
    await writeFile(join(seed, 'tracked.txt'), 'further\n')
    await git(seed, 'commit', '-am', 'further')
    await git(seed, 'push', 'origin', 'main')
    const further = await git(seed, 'rev-parse', 'HEAD')

    await toggle.discard({ path: remote.clone, name: prepared.worktree.name })

    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.ahead)
    expect(further).not.toBe(remote.ahead)
  })

  it('does not fetch for a session that already runs in a copy', async () => {
    const remote = await remoteRepo()
    const seed = join(remote.root, 'seed')
    const { agent, toggle } = await fixture(remote.clone)
    const first = created(await toggle.prepare({ sessionId: agent.id }))
    expect(first.base).toEqual({ kind: 'remote', branch: remote.branch })
    await writeFile(join(seed, 'tracked.txt'), 'further\n')
    await git(seed, 'commit', '-am', 'further')
    await git(seed, 'push', 'origin', 'main')
    const further = await git(seed, 'rev-parse', 'HEAD')

    const second = await toggle.prepare({ sessionId: agent.id })

    expect(second.state).toBe('existing')
    expect(second).not.toHaveProperty('base')
    expect(second.worktree).toEqual(first.worktree)
    // A fetch on the second call would have moved origin/main to `further`.
    expect(await git(remote.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(remote.ahead)
    expect(further).not.toBe(remote.ahead)
  })
})
