/**
 * Contract spec for reading one hooks file from disk.
 *
 * `format.spec.ts` pins the pure JSON contract; this spec pins the read path
 * around it. Windows editors routinely save `.dsh/hooks.json` as UTF-16 or with
 * a UTF-8 byte-order mark, and the file must still load: the read path decodes
 * the bytes by their BOM before parsing. Real files on disk keep the assertions
 * at what a user observes — the hooks load, or a broken rewrite keeps the last
 * valid layer with one warning.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HookSources, type HookSnapshot } from '../src/hooks-file.ts'

const DEFAULTS = 30_000

/** Byte-order marks of the encodings the read path must accept. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff])

/** UTF-8 bytes, as the no-BOM default. */
function utf8(text: string): Uint8Array {
  return Buffer.from(text, 'utf8')
}

/** UTF-16 LE bytes with the BOM Notepad and PowerShell 5 write. */
function utf16leBom(text: string): Uint8Array {
  return Buffer.concat([UTF16_LE_BOM, Buffer.from(text, 'utf16le')])
}

/** UTF-16 BE bytes with a BOM; Node has no big-endian codec, so swap. */
function utf16beBom(text: string): Uint8Array {
  const body = Buffer.from(text, 'utf16le')
  body.swap16()
  return Buffer.concat([UTF16_BE_BOM, body])
}

/** The user-visible hook every encoding case must produce. */
const EXPECTED_HOOKS = [{
  id: 'no-deletes',
  on: 'tool.pre',
  match: undefined,
  run: { type: 'builtin', action: 'deny', reason: '不要删除文件' },
  timeoutMs: DEFAULTS,
  onFailure: 'open',
}]

/** Encode one valid hooks file; the reason carries non-ASCII text on purpose. */
const HOOKS_TEXT = JSON.stringify({
  version: 1,
  hooks: [{ id: 'no-deletes', on: 'tool.pre', run: { type: 'builtin', action: 'deny', reason: '不要删除文件' } }],
}, null, 2)

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * Write bytes to a fresh temporary file.
 * @param bytes - the file's content.
 * @returns the absolute path.
 */
async function writeTempFile(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-hooks-file-'))
  roots.push(root)
  const path = join(root, 'hooks.json')
  await writeFile(path, bytes)
  return path
}

/** One loader with a warning sink, as the plugin constructs it. */
function loader(): { readonly sources: HookSources; readonly warnings: string[] } {
  const warnings: string[] = []
  const sources = new HookSources({ defaultTimeoutMs: DEFAULTS, warn: message => warnings.push(message) })
  return { sources, warnings }
}

describe('the hooks file encoding', () => {
  it.each([
    ['UTF-8 without a BOM', utf8(HOOKS_TEXT)],
    ['UTF-8 with a BOM', Buffer.concat([UTF8_BOM, utf8(HOOKS_TEXT)])],
    ['UTF-16 LE with a BOM', utf16leBom(HOOKS_TEXT)],
    ['UTF-16 BE with a BOM', utf16beBom(HOOKS_TEXT)],
  ])('loads a hooks file saved as %s', async (_label, bytes) => {
    const path = await writeTempFile(bytes)
    const { sources, warnings } = loader()

    const snapshot = await sources.load(path)

    expect(snapshot?.hooks).toEqual(EXPECTED_HOOKS)
    expect(warnings).toEqual([])
  })

  it('warns instead of throwing when the bytes are not valid UTF-8', async () => {
    // No BOM means UTF-8, so a lone invalid byte decodes to U+FFFD; the result
    // is not JSON, which is a warning, never an exception escaping the loader.
    const path = await writeTempFile(Buffer.from([0x7b, 0x22, 0x76, 0x65, 0xff]))
    const { sources, warnings } = loader()

    const snapshot: HookSnapshot | undefined = await sources.load(path)

    expect(snapshot).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not valid JSON')
  })

  it('keeps the last valid layer when a BOM-less UTF-16 rewrite stops parsing', async () => {
    const path = await writeTempFile(Buffer.from(HOOKS_TEXT, 'utf8'))
    const { sources, warnings } = loader()
    expect((await sources.load(path))?.hooks).toEqual(EXPECTED_HOOKS)

    // A PowerShell 5 `>` redirect writes UTF-16 LE *without* a BOM. The loader
    // has no way to know that, decodes it as UTF-8, and fails to parse it —
    // exactly the broken-edit case that must keep the working rules.
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(path, Buffer.from(HOOKS_TEXT, 'utf16le'))

    const snapshot = await sources.load(path)

    expect(snapshot?.hooks).toEqual(EXPECTED_HOOKS)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not valid JSON')
    expect(warnings[0]).toContain(path)
  })
})
