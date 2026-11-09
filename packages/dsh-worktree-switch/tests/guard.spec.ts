/**
 * Unit spec for the source-checkout guard's decision table. The listener
 * itself is a thin adapter over these functions and is typechecked against the
 * host's `tools/pre-execute` event.
 *
 * Windows cases use plain path strings, as the host would hand them over on
 * win32; no Windows runner is needed to exercise the decision.
 */

import { describe, expect, it } from 'vitest'
import { shellCall, sourceCheckoutDenial } from '../src/host/guard.ts'
import type { SessionScope } from '../src/types.ts'

const PROJECT = '/work/project'
const CHECKOUT = '/work/project/.dsh/worktrees/quiet-harbor-3fa9'
const SCOPE: SessionScope = {
  worktree: { name: 'quiet-harbor-3fa9', path: CHECKOUT, branch: 'quiet-harbor-3fa9' },
  repositoryRoot: PROJECT,
}

/** Deny reason for one command run at the copy root. */
function denialFor(command: string, workdir?: string, cwd = CHECKOUT): string | null {
  return sourceCheckoutDenial(command, workdir, cwd, SCOPE)
}

/** Deny reason for one command under explicit POSIX semantics. */
function posixDenial(command: string, workdir?: string): string | null {
  return sourceCheckoutDenial(command, workdir, CHECKOUT, SCOPE, 'posix')
}

const WINDOWS_PROJECT = 'C:\\Users\\Maria\\项目 文件\\my project'
const WINDOWS_CHECKOUT = `${WINDOWS_PROJECT}\\.dsh\\worktrees\\quiet-harbor-3fa9`
const WINDOWS_SCOPE: SessionScope = {
  worktree: { name: 'quiet-harbor-3fa9', path: WINDOWS_CHECKOUT, branch: 'quiet-harbor-3fa9' },
  repositoryRoot: WINDOWS_PROJECT,
}

/** Deny reason for one Windows command run at the copy root. */
function windowsDenial(command: string, workdir?: string, cwd = WINDOWS_CHECKOUT): string | null {
  return sourceCheckoutDenial(command, workdir, cwd, WINDOWS_SCOPE, 'win32')
}

const UNC_PROJECT = '\\\\server\\share\\team project'
const UNC_CHECKOUT = `${UNC_PROJECT}\\.dsh\\worktrees\\calm-island-9c1d`
const UNC_SCOPE: SessionScope = {
  worktree: { name: 'calm-island-9c1d', path: UNC_CHECKOUT, branch: 'calm-island-9c1d' },
  repositoryRoot: UNC_PROJECT,
}

/** Deny reason for one UNC-path command run at the copy root. */
function uncDenial(command: string, workdir?: string, cwd = UNC_CHECKOUT): string | null {
  return sourceCheckoutDenial(command, workdir, cwd, UNC_SCOPE, 'win32')
}

describe('shell tool arguments', () => {
  it('reads command and workdir from bash and pwsh calls', () => {
    expect(shellCall('bash', { command: 'git status' })).toEqual({ command: 'git status' })
    expect(shellCall('pwsh', { command: 'git pull origin main', workdir: 'C:\\work\\copy' }))
      .toEqual({ command: 'git pull origin main', workdir: 'C:\\work\\copy' })
  })

  it('ignores every other tool and malformed shell arguments', () => {
    expect(shellCall('Get-ChildItem', { command: 'git status' })).toBeNull()
    expect(shellCall('read', { command: 'git status' })).toBeNull()
    expect(shellCall('bash', null)).toBeNull()
    expect(shellCall('pwsh', { command: 42 })).toBeNull()
    expect(shellCall('bash', { command: '   ' })).toBeNull()
    expect(shellCall('pwsh', { command: 'git status', workdir: '' })).toEqual({ command: 'git status' })
    expect(shellCall('pwsh', { command: 'git status', workdir: 7 })).toEqual({ command: 'git status' })
  })
})

describe('source checkout guard', () => {
  it('leaves non-Git commands alone even when they name the checkout', () => {
    expect(denialFor('ls /work/project')).toBeNull()
    expect(denialFor('grep -r TODO /work/project/src')).toBeNull()
    expect(denialFor('cat /work/project/README.md')).toBeNull()
  })

  it('allows Git that stays inside the copy', () => {
    expect(denialFor('git status')).toBeNull()
    expect(denialFor('git pull origin main')).toBeNull()
    expect(denialFor(`git -C ${CHECKOUT} log --oneline -3`)).toBeNull()
    expect(denialFor('git log', 'packages/web')).toBeNull()
  })

  it('denies Git that targets the project checkout by absolute path', () => {
    const denial = denialFor(`git -C ${PROJECT} pull origin main`)
    expect(denial).not.toBeNull()
    expect(denial).toContain(PROJECT)
    expect(denial).toContain(CHECKOUT)
    expect(denial).toContain('git fetch origin main')
    expect(denialFor(`cd ${PROJECT} && git pull origin main`)).not.toBeNull()
    expect(denialFor(`git --git-dir=${PROJECT}/.git status`)).not.toBeNull()
  })

  it('denies Git run with the project checkout as an explicit workdir', () => {
    expect(denialFor('git pull origin main', PROJECT)).not.toBeNull()
    expect(denialFor('git status', '/work/project/packages/web')).not.toBeNull()
    expect(denialFor('git pull origin main', '../..')).not.toBeNull()
    expect(denialFor('git status', '/work/elsewhere')).toBeNull()
  })

  it('keeps the denial out of the copy itself even when the project root is mentioned', () => {
    // A command may legitimately quote the project path while operating in the
    // copy (e.g. a script argument); the literal-path rule is what catches the
    // checkout, and that is the accepted false-positive surface.
    expect(denialFor(`git log --grep ${CHECKOUT}`)).toBeNull()
  })

  it('denies Windows drive-letter paths in the command text', () => {
    expect(windowsDenial(`git -C ${WINDOWS_PROJECT} pull origin main`)).not.toBeNull()
    expect(windowsDenial(`cd "${WINDOWS_PROJECT}" && git pull origin main`)).not.toBeNull()
    expect(windowsDenial(`git --git-dir=${WINDOWS_PROJECT}\\.git status`)).not.toBeNull()
  })

  it('folds Windows case and separator spelling before matching', () => {
    expect(windowsDenial('git -C c:\\users\\maria\\项目 文件\\MY PROJECT status')).not.toBeNull()
    expect(windowsDenial('git -C C:/Users/Maria/项目 文件/my project status')).not.toBeNull()
    expect(windowsDenial('git -C C:\\Users/Maria\\项目 文件/my project status')).not.toBeNull()
    expect(windowsDenial('git -C C:\\USERS\\MARIA\\项目 文件\\My Project status')).not.toBeNull()
  })

  it('matches the git token case-sensitively on POSIX and case-insensitively on Windows', () => {
    // POSIX command names are case-sensitive: `Git` is a different program,
    // so the guard must not treat it as the git the checkout owns.
    expect(posixDenial(`Git -C ${PROJECT} status`)).toBeNull()
    expect(posixDenial(`GIT -C ${PROJECT} status`)).toBeNull()
    // Windows command names are not, and `GIT.EXE` is the executable spelling.
    expect(windowsDenial(`Git -C ${WINDOWS_PROJECT} status`)).not.toBeNull()
    expect(windowsDenial(`GIT -C ${WINDOWS_PROJECT} status`)).not.toBeNull()
    expect(windowsDenial(`GIT.EXE -C ${WINDOWS_PROJECT} status`)).not.toBeNull()
    expect(windowsDenial(`git -C ${WINDOWS_PROJECT} status`)).not.toBeNull()
  })

  it('denies UNC paths in the command text', () => {
    expect(uncDenial('git -C \\\\server\\share\\team project pull origin main')).not.toBeNull()
    expect(uncDenial('git -C \\\\SERVER\\Share\\team project status')).not.toBeNull()
    expect(uncDenial('git -C //server/share/team project status')).not.toBeNull()
  })

  it('denies Git run with a Windows project directory as an explicit workdir', () => {
    expect(windowsDenial('git status', WINDOWS_PROJECT)).not.toBeNull()
    expect(windowsDenial('git status', 'c:\\users\\maria\\项目 文件\\my project')).not.toBeNull()
    expect(windowsDenial('git status', `${WINDOWS_PROJECT}\\packages\\web`)).not.toBeNull()
    expect(windowsDenial('git pull origin main', '..\\..\\..')).not.toBeNull()
    expect(uncDenial('git status', UNC_PROJECT)).not.toBeNull()
  })

  it('allows Windows Git that stays inside the copy', () => {
    expect(windowsDenial('git status')).toBeNull()
    expect(windowsDenial('git log', WINDOWS_CHECKOUT)).toBeNull()
    expect(windowsDenial('git log', 'packages\\web')).toBeNull()
    expect(windowsDenial(`git -C ${WINDOWS_CHECKOUT} rebase origin/main`)).toBeNull()
    expect(windowsDenial('git status', 'C:\\work\\elsewhere')).toBeNull()
    expect(uncDenial('git status', UNC_CHECKOUT)).toBeNull()
  })

  it('keeps the copy-path mention out of the Windows denial', () => {
    expect(windowsDenial(`git log --grep ${WINDOWS_CHECKOUT}`)).toBeNull()
    expect(windowsDenial('git log --grep c:/users/maria/项目 文件/my project/.dsh/worktrees/quiet-harbor-3fa9'))
      .toBeNull()
    expect(uncDenial(`git log --grep ${UNC_CHECKOUT}`)).toBeNull()
  })

  it('leaves Windows non-Git commands alone', () => {
    expect(windowsDenial(`Get-ChildItem ${WINDOWS_PROJECT}`)).toBeNull()
    expect(windowsDenial(`Copy-Item ${WINDOWS_PROJECT}\\a.txt ${WINDOWS_PROJECT}\\b.txt`)).toBeNull()
    expect(windowsDenial(`Remove-Item -Recurse ${WINDOWS_PROJECT}\\node_modules`)).toBeNull()
    expect(windowsDenial(`Get-Content ${WINDOWS_PROJECT}\\README.md`)).toBeNull()
    expect(uncDenial(`Get-ChildItem ${UNC_PROJECT}`)).toBeNull()
  })
})
