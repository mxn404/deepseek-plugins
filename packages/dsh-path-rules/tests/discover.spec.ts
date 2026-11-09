/**
 * Discovery spec: Windows rule-identity normalization without running Windows.
 *
 * {@link RuleWorkspace} takes its platform as an option, so the win32 identity
 * branch (realpath + case fold) runs here on a real temporary rule root instead
 * of being trusted from code review. Two rule files that differ only by case
 * can coexist on a case-sensitive filesystem; on a case-insensitive one the
 * fixture collapses to a single file, so the test states that and skips rather
 * than pretending.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuleWorkspace } from '../src/discover.ts'

/** Distinct rule bodies: which one survives tells which file was discovered. */
const LOWER_BODY = '# Lower\n\nlower-case body\n'
const UPPER_BODY = '# Upper\n\nupper-case body\n'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Temporary project root with a `.git` marker and two case-different rule files. */
async function caseTwinRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-path-rules-discovery-'))
  roots.push(root)
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, '.dsh/rules'), { recursive: true })
  await writeFile(join(root, '.dsh/rules/a.md'), LOWER_BODY)
  await writeFile(join(root, '.dsh/rules/A.md'), UPPER_BODY)
  return root
}

/** Whether both case-different fixture files really exist on this filesystem. */
async function caseTwinExists(root: string): Promise<boolean> {
  const names = await readdir(join(root, '.dsh/rules'))
  return names.includes('a.md') && names.includes('A.md')
}

/** One workspace with the platform semantics a test asks for. */
function workspace(platform: NodeJS.Platform, caseInsensitive: boolean): RuleWorkspace {
  return new RuleWorkspace({
    roots: ['.dsh/rules'],
    maxBytes: 65_536,
    caseInsensitive,
    platform,
    onInvalidRule: () => {},
  })
}

describe('rule identity platform wiring', () => {
  it('dedupes case-different files to one identity on win32 and keeps the display spelling', async (context) => {
    const root = await caseTwinRepo()
    if (!await caseTwinExists(root)) {
      context.skip('this filesystem is case-insensitive, so two case-different rule files cannot coexist')
    }

    const snapshot = await workspace('win32', true).snapshot(root)

    expect(snapshot.rules).toHaveLength(1)
    const survivor = snapshot.rules[0]!
    // Which spelling wins follows discovery order; whichever it is, the body,
    // name, and display path must all belong to that same discovered file.
    expect(['a', 'A']).toContain(survivor.name)
    expect(survivor.body).toBe(survivor.name === 'a' ? LOWER_BODY.trim() : UPPER_BODY.trim())
    expect(survivor.absolutePath.endsWith(`${survivor.name}.md`)).toBe(true)
    expect(survivor.identityKey.endsWith('/.dsh/rules/a.md')).toBe(true)
  })

  it('keeps both rules on a POSIX workspace', async (context) => {
    const root = await caseTwinRepo()
    if (!await caseTwinExists(root)) {
      context.skip('this filesystem is case-insensitive, so two case-different rule files cannot coexist')
    }

    const snapshot = await workspace('linux', false).snapshot(root)

    expect(snapshot.rules).toHaveLength(2)
    expect(snapshot.rules.map(rule => rule.name).sort()).toEqual(['A', 'a'])
    expect(snapshot.rules.map(rule => rule.body).sort()).toEqual([LOWER_BODY.trim(), UPPER_BODY.trim()].sort())
    // POSIX identity is the display path, unchanged by any folding.
    for (const rule of snapshot.rules) expect(rule.identityKey).toBe(rule.absolutePath)
  })
})
