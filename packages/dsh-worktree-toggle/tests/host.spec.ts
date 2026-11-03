/**
 * Host-half spec for the Worktree toggle.
 *
 * Every case drives `createWorktreeToggle` over real services and asserts only
 * externally observable behavior: directories and branches on disk, the
 * session's committed working directory, the four verb payloads, and errors.
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { POOL_DIRECTORY, WorktreeToggleError, createWorktreeToggle } from '../src/host/handlers.ts'
import type { WorktreeToggle } from '../src/host/handlers.ts'
import { git, harness, repository, temporaryDirectory, testAgent } from './harness.ts'

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
 * @returns the live fixture.
 */
async function fixture(root: string, startDirectory = root, defaultEnabled = true): Promise<Fixture> {
  ctx = await harness(root)
  const agent = testAgent(ctx, startDirectory)
  const toggle = createWorktreeToggle(ctx, { defaultEnabled, poolDirectory: POOL_DIRECTORY })
  return { ctx, agent, toggle }
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
    expect(listed).toEqual({
      supported: true,
      repositoryRoot: root,
      poolPath: join(root, POOL_DIRECTORY),
      items: [],
    })
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
      poolPath: join(root, POOL_DIRECTORY),
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

describe('worktree toggle list', () => {
  it('lists the pool copy and never the main checkout', async () => {
    const root = await repo()
    const { agent, toggle } = await fixture(root)
    const prepared = await toggle.prepare({ sessionId: agent.id })

    const listed = await toggle.list({ path: root })

    expect(listed).toMatchObject({
      supported: true,
      repositoryRoot: root,
      poolPath: join(root, POOL_DIRECTORY),
    })
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
    expect(missing.details).toMatchObject({ name: 'unknown-copy', poolPath: join(root, POOL_DIRECTORY) })
    expect(invalid.code).toBe('worktree-name-invalid')
    expect((await stat(prepared.worktree.path)).isDirectory()).toBe(true)
    expect(await git(root, 'branch', '--list', prepared.worktree.branch)).toContain(prepared.worktree.name)
  })
})
