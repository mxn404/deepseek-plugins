/**
 * Per-spec lifecycle for the `dsh-lifecycle-hooks` integration specs.
 *
 * A spec file owns one fixture; every temporary project root and every mounted
 * harness it creates is tracked so a single `afterEach` disposes the harnesses
 * and deletes the directories.
 */

import { rm } from 'node:fs/promises'
import { vi } from 'vitest'
import type * as DshLifecycleHooks from '../../src/index.ts'
import { createHooksHarness, type HooksHarness, type HooksHarnessOptions } from './harness.ts'
import { createRepo, createPlainDir } from './project.ts'

/** Row-config overrides one test may pass; omitted fields take schema defaults. */
export type HooksConfigOverrides = Partial<DshLifecycleHooks.Config>

/** Temporary repositories and mounted harnesses owned by one spec file. */
export interface HooksFixture {
  /** Create and track a temporary project root with a `.git` marker. */
  repo(): Promise<string>
  /** Create and track a temporary directory with no `.git` marker of its own. */
  plainDir(): Promise<string>
  /** Mount and track one hooks harness. */
  harness(root: string, config?: HooksConfigOverrides, options?: HooksHarnessOptions): Promise<HooksHarness>
  /** Dispose every tracked harness, then delete every tracked repository. */
  cleanup(): Promise<void>
}

/**
 * Create one spec-file fixture.
 * @returns the tracker; call {@link HooksFixture.cleanup} from `afterEach`.
 */
export function createHooksFixture(): HooksFixture {
  const roots: string[] = []
  const harnesses: HooksHarness[] = []
  return {
    async repo() {
      const root = await createRepo()
      roots.push(root)
      return root
    },
    async plainDir() {
      const root = await createPlainDir()
      roots.push(root)
      return root
    },
    async harness(root, config = {}, options = {}) {
      const harness = await createHooksHarness(root, config, options)
      harnesses.push(harness)
      return harness
    },
    async cleanup() {
      vi.unstubAllEnvs()
      for (const harness of harnesses.splice(0)) await harness.ctx.fiber.dispose()
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
    },
  }
}
