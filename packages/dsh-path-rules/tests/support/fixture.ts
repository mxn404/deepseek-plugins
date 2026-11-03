/**
 * Per-spec lifecycle for the `dsh-path-rules` integration specs.
 *
 * A spec file owns one fixture; every temporary project root and every mounted
 * harness it creates is tracked so a single `afterEach` disposes the harnesses
 * and deletes the directories.
 */

import { rm } from 'node:fs/promises'
import type * as DshRules from '../../src/index.ts'
import { createRulesHarness, type RulesHarness, type RulesHarnessOptions } from './harness.ts'
import { createRepo } from './project.ts'

/** Row-config overrides one test may pass; omitted fields take schema defaults. */
export type RulesConfigOverrides = Partial<DshRules.Config>

/** Temporary repositories and mounted harnesses owned by one spec file. */
export interface RulesFixture {
  /** Create and track a temporary project root with a `.git` marker. */
  repo(): Promise<string>
  /** Mount and track one rules harness. */
  harness(root: string, config?: RulesConfigOverrides, options?: RulesHarnessOptions): Promise<RulesHarness>
  /** Dispose every tracked harness, then delete every tracked repository. */
  cleanup(): Promise<void>
}

/**
 * Create one spec-file fixture.
 * @returns the tracker; call {@link RulesFixture.cleanup} from `afterEach`.
 */
export function createRulesFixture(): RulesFixture {
  const roots: string[] = []
  const harnesses: RulesHarness[] = []
  return {
    async repo() {
      const root = await createRepo()
      roots.push(root)
      return root
    },
    async harness(root, config = {}, options = {}) {
      const harness = await createRulesHarness(root, config, options)
      harnesses.push(harness)
      return harness
    },
    async cleanup() {
      for (const harness of harnesses.splice(0)) await harness.ctx.fiber.dispose()
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
    },
  }
}
