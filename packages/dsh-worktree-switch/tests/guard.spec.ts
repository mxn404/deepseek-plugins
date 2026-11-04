/**
 * Unit spec for the source-checkout guard's decision table. The listener
 * itself is a thin adapter over this function and is typechecked against the
 * host's `tools/pre-execute` event.
 */

import { describe, expect, it } from 'vitest'
import { sourceCheckoutDenial } from '../src/host/guard.ts'
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
})
