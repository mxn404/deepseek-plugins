/**
 * The plugin's published config contract.
 *
 * `baseRef` is the one setting whose typo would silently change where every new
 * copy starts, so validation is part of the public surface: the schema accepts
 * exactly the two documented constants and rejects anything else, which makes a
 * bad profile fail at mount instead of choosing a base the user never asked for.
 */

import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import type { Config as ConfigShape } from '../src/index.ts'

/**
 * Validate one partial row config the way the loader does: missing fields take
 * their defaults, unknown values fail.
 * @param value - the row config under test.
 * @returns the normalized config.
 */
function parse(value: Record<string, unknown>): ConfigShape {
  return Config(value as unknown as ConfigShape)
}

describe('worktree switch config', () => {
  it('defaults the base point to fresh', () => {
    expect(parse({}).baseRef).toBe('fresh')
  })

  it('accepts the two documented base points', () => {
    expect(parse({ baseRef: 'fresh' }).baseRef).toBe('fresh')
    expect(parse({ baseRef: 'head' }).baseRef).toBe('head')
  })

  it('rejects any other base point, so a typo cannot pick one quietly', () => {
    expect(() => parse({ baseRef: 'remote' })).toThrow()
    expect(() => parse({ baseRef: true })).toThrow()
  })
})
