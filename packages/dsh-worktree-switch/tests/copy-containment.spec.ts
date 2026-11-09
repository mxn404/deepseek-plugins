/**
 * Unit spec for the browser half's "is this session inside that copy?" test.
 *
 * The panel compares the session's committed working directory with the copy
 * paths the host listed. Windows sends `\` where the host may have sent `/`
 * (and vice versa), so the pure helper folds both before the prefix test. The
 * helper must stay free of `node:path`: it runs in the page bundle.
 */

import { describe, expect, it } from 'vitest'
import { isInsideCopy } from '../src/client/state.ts'

const POSIX_COPY = '/work/project/.dsh/worktrees/quiet-harbor-3fa9'
const WINDOWS_COPY = 'C:\\Users\\Maria\\项目 文件\\my project\\.dsh\\worktrees\\quiet-harbor-3fa9'

describe('current copy containment', () => {
  it('accepts the copy itself and any directory below it', () => {
    expect(isInsideCopy(POSIX_COPY, POSIX_COPY)).toBe(true)
    expect(isInsideCopy(POSIX_COPY, `${POSIX_COPY}/packages/web`)).toBe(true)
    expect(isInsideCopy(WINDOWS_COPY, WINDOWS_COPY)).toBe(true)
    expect(isInsideCopy(WINDOWS_COPY, `${WINDOWS_COPY}\\packages\\web`)).toBe(true)
  })

  it('rejects the source checkout, a sibling copy, and a name-prefix neighbour', () => {
    expect(isInsideCopy(POSIX_COPY, '/work/project')).toBe(false)
    expect(isInsideCopy(POSIX_COPY, '/work/project/.dsh/worktrees/calm-island-9c1d')).toBe(false)
    expect(isInsideCopy(POSIX_COPY, `${POSIX_COPY}-other`)).toBe(false)
    expect(isInsideCopy(WINDOWS_COPY, 'C:\\Users\\Maria\\项目 文件\\my project')).toBe(false)
    expect(isInsideCopy(WINDOWS_COPY, `${WINDOWS_COPY}-other`)).toBe(false)
  })

  it('treats backslashes and forward slashes as the same separator', () => {
    expect(isInsideCopy(WINDOWS_COPY, WINDOWS_COPY.replaceAll('\\', '/'))).toBe(true)
    expect(isInsideCopy(WINDOWS_COPY, `${WINDOWS_COPY.replaceAll('\\', '/')}/packages/web`)).toBe(true)
    expect(isInsideCopy(WINDOWS_COPY.replaceAll('\\', '/'), `${WINDOWS_COPY}\\packages\\web`)).toBe(true)
    expect(isInsideCopy('\\\\server\\share\\copy', '//server/share/copy/sub')).toBe(true)
  })

  it('tolerates a trailing separator on the copy path', () => {
    expect(isInsideCopy(`${POSIX_COPY}/`, POSIX_COPY)).toBe(true)
    expect(isInsideCopy(`${POSIX_COPY}/`, `${POSIX_COPY}/packages/web`)).toBe(true)
    expect(isInsideCopy(`${WINDOWS_COPY}\\`, `${WINDOWS_COPY}\\packages\\web`)).toBe(true)
    expect(isInsideCopy(`${WINDOWS_COPY}/`, `${WINDOWS_COPY}\\packages\\web`)).toBe(true)
  })

  it('rejects empty paths', () => {
    expect(isInsideCopy('', POSIX_COPY)).toBe(false)
    expect(isInsideCopy(POSIX_COPY, '')).toBe(false)
    expect(isInsideCopy('', '')).toBe(false)
  })
})
