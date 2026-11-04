/**
 * Contract spec for hook source path resolution.
 *
 * The user-level layer's location is a user-visible contract (`$DSH_HOME` moves
 * it, otherwise it is `~/.dsh`), and the ancestor chain bounds which project
 * layers a Session may read. Both are pure functions, so they are pinned here
 * without mounting a host; everything a user observes through a Session is
 * covered by `discovery.integration.spec.ts`.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ancestorChain, userHooksSource } from '../src/discovery.ts'

describe('the user-level hooks file', () => {
  it('lives in ~/.dsh when DSH_HOME is not set', () => {
    expect(userHooksSource({})).toBe(join(homedir(), '.dsh', 'hooks.json'))
  })

  it('follows DSH_HOME when it is set', () => {
    expect(userHooksSource({ DSH_HOME: '/custom/dsh-home' })).toBe(join('/custom/dsh-home', 'hooks.json'))
  })

  it('ignores a blank DSH_HOME instead of resolving to the filesystem root', () => {
    expect(userHooksSource({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh', 'hooks.json'))
  })

  it('resolves a relative DSH_HOME to an absolute path', () => {
    expect(userHooksSource({ DSH_HOME: 'relative/home' })).toBe(join(resolve('relative/home'), 'hooks.json'))
  })
})

describe('the ancestor chain', () => {
  it('runs from the project root down to the session directory, inclusive', () => {
    expect(ancestorChain('/repo', '/repo/packages/app')).toEqual([
      '/repo',
      '/repo/packages',
      '/repo/packages/app',
    ])
  })

  it('is just the session directory when it is the project root', () => {
    expect(ancestorChain('/repo', '/repo')).toEqual(['/repo'])
  })

  it('never walks outside the project root', () => {
    expect(ancestorChain('/repo', '/elsewhere/app')).toEqual(['/elsewhere/app'])
  })
})
