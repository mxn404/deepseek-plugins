/**
 * Unit spec for the platform-dependent Git invocation and the helpers around
 * it: the null device, the fixed config and environment every plugin Git call
 * carries, and the pure classifier behind copy-removal retries.
 *
 * No Git runs here; the host spec covers the real commands.
 */

import { describe, expect, it } from 'vitest'
import { gitInvocation } from '../src/host/git.ts'
import { classifyRemoveFailure } from '../src/host/handlers.ts'
import { contains } from '../src/host/paths.ts'
import { hostPlatform, nullDevice } from '../src/host/platform.ts'
import type { GitResult } from '../src/host/git.ts'

describe('null device', () => {
  it('picks the OS device name from the platform', () => {
    expect(nullDevice('win32')).toBe('NUL')
    expect(nullDevice('posix')).toBe('/dev/null')
  })

  it('selects the real host device name', () => {
    // This case runs on the native Windows runner too, so it is where the
    // production `NUL` selection is verified on the OS that needs it.
    if (process.platform === 'win32') expect(nullDevice()).toBe('NUL')
    else expect(nullDevice()).toBe('/dev/null')
  })

  it('reports the real host platform', () => {
    if (process.platform === 'win32') expect(hostPlatform()).toBe('win32')
    else expect(hostPlatform()).toBe('posix')
  })
})

describe('host path dialect', () => {
  it('defaults containment to the real host', () => {
    if (process.platform === 'win32') {
      expect(contains('C:\\Work\\Project', 'c:\\work\\project\\sub')).toBe(true)
      expect(contains('C:\\work\\project', 'C:\\work\\other')).toBe(false)
    } else {
      expect(contains('/work/project', '/work/project/sub')).toBe(true)
      expect(contains('/work/project', '/work/other')).toBe(false)
    }
  })
})

describe('fixed Git invocation', () => {
  it('prefixes every call with no hooks, no fsmonitor, and long paths enabled', () => {
    const invocation = gitInvocation('git', ['status', '--porcelain'], 'posix')
    expect(invocation.argv).toEqual([
      'git',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.longpaths=true',
      'status', '--porcelain',
    ])
  })

  it('names the Windows null device and keeps the same fixed config', () => {
    const invocation = gitInvocation('git.exe', ['worktree', 'list', '--porcelain'], 'win32')
    expect(invocation.argv[0]).toBe('git.exe')
    expect(invocation.argv).toContain('core.hooksPath=NUL')
    expect(invocation.argv).toContain('core.fsmonitor=false')
    expect(invocation.argv).toContain('core.longpaths=true')
    expect(invocation.argv.slice(7)).toEqual(['worktree', 'list', '--porcelain'])
  })

  it('sets the environment that keeps a UI action non-interactive and lock-free', () => {
    const { env } = gitInvocation('git', ['status'], 'posix')
    expect(env['GIT_OPTIONAL_LOCKS']).toBe('0')
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
    expect(env['GIT_LFS_SKIP_SMUDGE']).toBe('1')
    expect(env['GIT_NO_LAZY_FETCH']).toBe('1')
  })

  it('builds the real host invocation by default', () => {
    // Executed on the Windows runner: the default platform must produce the
    // host's null device, not a POSIX `/dev/null` baked into the builder.
    const invocation = gitInvocation('git', [])
    expect(invocation.argv).toContain(`core.hooksPath=${nullDevice()}`)
    expect(invocation.argv).toContain('core.fsmonitor=false')
    expect(invocation.argv).toContain('core.longpaths=true')
    expect(invocation.env['GIT_OPTIONAL_LOCKS']).toBe('0')
  })

  it('clears every inherited repository selector', () => {
    const { env } = gitInvocation('git', ['status'], 'posix')
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS']) {
      expect(env[key]).toBeUndefined()
    }
  })
})

/** A captured Git failure result with the given stderr. */
function failure(stderr: string, exitCode = 128): GitResult {
  return { stdout: '', stderr, exitCode }
}

describe('remove-failure classification', () => {
  it.each([
    'error: failed to delete \'../copy\': Permission denied',
    'fatal: could not remove ../copy: Device or resource busy',
    'fatal: unable to unlink \'file\': EBUSY',
    'fatal: unable to unlink \'file\': EPERM',
    'fatal: unable to remove directory: ENOTEMPTY',
    'fatal: cannot delete the directory: it is in use',
    'fatal: the process cannot access the file because it is being used by another process',
    'fatal: failed to delete: Read-only file system',
    'error: Access is denied.',
  ])('treats a lock or permission message as retryable: %s', stderr => {
    expect(classifyRemoveFailure(failure(stderr))).toBe('retryable')
  })

  it.each([
    'fatal: \'../copy\' contains modified or untracked files, use --force to delete it',
    'fatal: \'../copy\' is a locked working tree, lock reason: fixture',
    'fatal: \'../copy\' is not a working tree',
    '',
    'fatal: something nobody has classified yet',
  ])('treats anything else as fatal: %s', stderr => {
    expect(classifyRemoveFailure(failure(stderr))).toBe('fatal')
  })
})
