/**
 * Host spec for the adoption verb: only a Session that has not started, and
 * only a directory inside the source Session's own project tree, may be
 * inherited.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createAdoption, isInside } from '../src/host/adopt.ts'

/** One fake session identity used by the doubles. */
function fakeSession(id: string, cwd: string): { readonly session: { readonly id: string; readonly header: { readonly cwd: string } } } {
  return { session: { id, header: { cwd } } }
}

/** Build the Host double the verb runs against. */
function mount(options: {
  readonly sourceCwd: string
  readonly sourceDirectory: string
  readonly targetStarted?: boolean
  readonly sourceId?: string
  readonly targetId?: string
}) {
  const sourceId = options.sourceId ?? 'source'
  const targetId = options.targetId ?? 'target'
  const sessions = new Map<string, ReturnType<typeof fakeSession>>([
    [sourceId, fakeSession(sourceId, options.sourceCwd)],
    [targetId, fakeSession(targetId, options.sourceCwd)],
  ])
  const set = vi.fn(async () => options.sourceDirectory)
  const ctx = {
    get: () => undefined,
    agents: {
      get: (id: string) => sessions.get(id),
      turnBoundaryOf: () => options.targetStarted === true
        ? { lastTurn: 1, openTurnStartSeq: 1, lastStepStartSeq: null, lastStepBoundary: null }
        : { lastTurn: 0, openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null },
    },
    workingDirectory: {
      get: () => options.sourceDirectory,
      set,
    },
  } as unknown as Context
  return { adopt: createAdoption(ctx), set, sourceId, targetId }
}

describe('isInside', () => {
  it('accepts the root itself and descendants', () => {
    expect(isInside('/repo', '/repo')).toBe(true)
    expect(isInside('/repo/.dsh/worktrees/quiet-harbor', '/repo')).toBe(true)
  })

  it('rejects siblings and parents', () => {
    expect(isInside('/repo-2', '/repo')).toBe(false)
    expect(isInside('/other', '/repo')).toBe(false)
    expect(isInside('/home', '/repo')).toBe(false)
  })
})

describe('the adoption verb', () => {
  it('moves a blank target into the source working directory', async () => {
    const { adopt, set, sourceId, targetId } = mount({
      sourceCwd: '/repo',
      sourceDirectory: '/repo/.dsh/worktrees/quiet-harbor',
    })

    await expect(adopt({ sourceSessionId: sourceId, targetSessionId: targetId }, AbortSignal.timeout(1000)))
      .resolves.toEqual({ adopted: true, workingDirectory: '/repo/.dsh/worktrees/quiet-harbor' })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('is a reported no-op when the source works outside its own project tree', async () => {
    const { adopt, set, sourceId, targetId } = mount({
      sourceCwd: '/repo',
      sourceDirectory: '/elsewhere',
    })

    await expect(adopt({ sourceSessionId: sourceId, targetSessionId: targetId }, AbortSignal.timeout(1000)))
      .resolves.toEqual({ adopted: false, workingDirectory: '/elsewhere' })
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a target that already started a turn', async () => {
    const { adopt, set, sourceId, targetId } = mount({
      sourceCwd: '/repo',
      sourceDirectory: '/repo/.dsh/worktrees/quiet-harbor',
      targetStarted: true,
    })

    await expect(adopt({ sourceSessionId: sourceId, targetSessionId: targetId }, AbortSignal.timeout(1000)))
      .rejects.toThrow(/already started/)
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses to adopt a Session into itself', async () => {
    const { adopt, sourceId } = mount({
      sourceCwd: '/repo',
      sourceDirectory: '/repo/.dsh/worktrees/quiet-harbor',
    })

    await expect(adopt({ sourceSessionId: sourceId, targetSessionId: sourceId }, AbortSignal.timeout(1000)))
      .rejects.toThrow(/must differ/)
  })

  it('refuses an unknown Session', async () => {
    const { adopt, sourceId } = mount({
      sourceCwd: '/repo',
      sourceDirectory: '/repo/.dsh/worktrees/quiet-harbor',
    })

    await expect(adopt({ sourceSessionId: sourceId, targetSessionId: 'missing' }, AbortSignal.timeout(1000)))
      .rejects.toThrow(/no live agent/)
  })
})
