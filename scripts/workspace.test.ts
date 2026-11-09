/**
 * Unit checks for the pure workspace helpers.
 *
 * `scripts/` is not a workspace package and has no vitest dependency, so these
 * use Node's built-in test runner. Only helpers with no filesystem side effects
 * belong here; discovery needs a checkout and is exercised by `pnpm build`.
 *
 * @module scripts/workspace.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pnpmCommand } from './workspace.ts'

test('posix starts pnpm directly, without a shell', () => {
  assert.deepEqual(pnpmCommand('linux'), { command: 'pnpm', shell: false })
  assert.deepEqual(pnpmCommand('darwin'), { command: 'pnpm', shell: false })
})

test('win32 starts the pnpm.cmd shim through a shell', () => {
  assert.deepEqual(pnpmCommand('win32'), { command: 'pnpm.cmd', shell: true })
})
