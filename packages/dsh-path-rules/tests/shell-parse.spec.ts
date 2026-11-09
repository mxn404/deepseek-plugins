/**
 * Pure-format spec: shell single-file read parsing.
 *
 * The parser is the contract between a model-written bash command and a rule
 * trigger. It deliberately fails closed: every shape it cannot prove touches
 * exactly one file must return `undefined`, so a wrong guess never loads an
 * unrelated rule.
 */

import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSingleFileReadCommand } from '../src/shell.ts'
import { shellReadPath } from '../src/shell-tools.ts'

describe('parseSingleFileReadCommand', () => {
  it.each([
    ['cat', 'cat src/app.ts', 'src/app.ts'],
    ['cat with a flag', 'cat -n src/app.ts', 'src/app.ts'],
    ['cat after the option terminator', 'cat -- src/app.ts', 'src/app.ts'],
    ['head without flags', 'head src/app.ts', 'src/app.ts'],
    ['head -n with a separate count', 'head -n 2 src/app.ts', 'src/app.ts'],
    ['head -n with an attached count', 'head -n2 src/app.ts', 'src/app.ts'],
    ['head with a short numeric count', 'head -5 src/app.ts', 'src/app.ts'],
    ['head -c with a byte count', 'head -c 200 src/app.ts', 'src/app.ts'],
    ['head with a long count option', 'head --lines=2 src/app.ts', 'src/app.ts'],
    ['tail -n with a separate count', 'tail -n 2 src/app.ts', 'src/app.ts'],
    ['tail with a negative count', 'tail -n -2 src/app.ts', 'src/app.ts'],
    ['sed -n with a quoted range script', "sed -n '1,2p' src/app.ts", 'src/app.ts'],
    ['sed -n with an unquoted range script', 'sed -n 1,2p src/app.ts', 'src/app.ts'],
    ['sed -n with a single-line script', "sed --quiet '5p' src/app.ts", 'src/app.ts'],
    ['grep with a pattern and a file', 'grep APP src/app.ts', 'src/app.ts'],
    ['grep with flags', 'grep -n APP src/app.ts', 'src/app.ts'],
    ['grep -e with a separate pattern', 'grep -e APP src/app.ts', 'src/app.ts'],
    ['grep -e with an attached pattern', 'grep -eAPP src/app.ts', 'src/app.ts'],
    ['grep with clustered boolean flags', 'grep -in APP src/app.ts', 'src/app.ts'],
    ['grep with a long pattern option', 'grep --regexp=APP src/app.ts', 'src/app.ts'],
    ['grep with a quoted pattern', "grep 'APP' src/app.ts", 'src/app.ts'],
  ])('accepts %s', (_name, command, path) => {
    expect(parseSingleFileReadCommand(command)).toEqual({ command: command.split(' ')[0], path })
  })

  it('accepts an absolute file operand', () => {
    expect(parseSingleFileReadCommand('cat /repo/src/app.ts')).toEqual({
      command: 'cat',
      path: '/repo/src/app.ts',
    })
  })

  it('accepts a quoted path with spaces', () => {
    expect(parseSingleFileReadCommand('cat "src/my app.ts"')).toEqual({
      command: 'cat',
      path: 'src/my app.ts',
    })
  })

  it('accepts a path with `..` segments', () => {
    expect(parseSingleFileReadCommand('cat ../shared/app.ts')).toEqual({
      command: 'cat',
      path: '../shared/app.ts',
    })
  })

  it.each([
    ['an empty command', ''],
    ['whitespace only', '   '],
    ['an unknown command', 'ls src'],
    ['a non-read command', 'echo src/app.ts'],
    ['a pipe', 'cat src/app.ts | head'],
    ['a logical and', 'cat src/app.ts && rm src/app.ts'],
    ['a logical or', 'cat src/app.ts || true'],
    ['a semicolon', 'cat src/app.ts; rm src/app.ts'],
    ['output redirection', 'cat src/app.ts > out.txt'],
    ['input redirection', 'cat < src/app.ts'],
    ['command substitution', 'cat $(ls)'],
    ['backtick substitution', 'cat `ls`'],
    ['variable expansion', 'cat $FILE'],
    ['a wildcard star', 'cat src/*.ts'],
    ['a wildcard question mark', 'cat src/app?.ts'],
    ['a wildcard class', 'cat src/app[0-9].ts'],
    ['brace expansion', 'cat src/{app,main}.ts'],
    ['a tilde', 'cat ~/app.ts'],
    ['a newline', 'cat src/app.ts\ncat src/other.ts'],
    ['an escaped space', 'cat src/my\\ app.ts'],
    ['a subshell', '(cat src/app.ts)'],
    ['stdin instead of a file', 'cat -'],
    ['a directory operand', 'cat src/'],
    ['two files for cat', 'cat src/a.ts src/b.ts'],
    ['no file for cat', 'cat'],
    ['a flag that looks like a file', 'cat -x'],
    ['an unterminated quote', "cat 'src/app.ts"],
    ['grep recursion', 'grep -r APP src'],
    ['grep recursive capitals', 'grep -R APP src'],
    ['grep recursive cluster', 'grep -rn APP src'],
    ['grep recursive long flag', 'grep --recursive APP src'],
    ['grep pattern file list', 'grep -f patterns.txt src/app.ts'],
    ['grep long file list', 'grep --file=patterns.txt src/app.ts'],
    ['grep without a file', 'grep APP'],
    ['grep without a pattern', 'grep src/app.ts'],
    ['grep with two candidate files', 'grep APP src/a.ts src/b.ts'],
    ['sed without -n', "sed '1,2p' src/app.ts"],
    ['sed with -e', "sed -n -e '1p' src/app.ts"],
    ['sed with -i', "sed -n -i '1p' src/app.ts"],
    ['sed with a substitution script', "sed -n 's/a/b/p' src/app.ts"],
    ['sed with a deletion script', "sed -n '1,2d' src/app.ts"],
    ['sed with two files', "sed -n '1,2p' src/a.ts src/b.ts"],
    ['sed with two scripts', "sed -n '1p' '2p' src/app.ts"],
    ['head with a missing count', 'head -n src/app.ts'],
    ['head with two files', 'head -n 2 src/a.ts src/b.ts'],
    ['tail without a file', 'tail -n 2'],
    ['cat a flag after the file', 'cat src/app.ts -n'],
  ])('rejects %s', (_name, command) => {
    expect(parseSingleFileReadCommand(command)).toBeUndefined()
  })
})

/** The win32 lane runs this spec too: exact expectations are POSIX-only there. */
const IS_WIN32 = process.platform === 'win32'

/**
 * Assert one resolved read path.
 *
 * POSIX compares the exact expected absolute path. On win32 `node:path.resolve`
 * can spell the same location with the current drive, so the Windows lane pins
 * the absolute form and the separator-normalized tail instead of recomputing
 * the resolution the code performs.
 */
function expectResolvedPath(actual: string | undefined, posixExpectedPath: string): void {
  expect(actual).toBeDefined()
  if (actual === undefined) return
  expect(isAbsolute(actual)).toBe(true)
  if (IS_WIN32) {
    expect(actual.replaceAll('\\', '/').endsWith(posixExpectedPath)).toBe(true)
    return
  }
  expect(actual).toBe(posixExpectedPath)
}

describe('shellReadPath', () => {
  it.each([
    ['bash `cat`', 'bash', { command: 'cat src/app.ts' }, '/repo/src/app.ts'],
    ['bash with a relative workdir', 'bash', { command: 'cat app.ts', workdir: 'src' }, '/repo/src/app.ts'],
    ['bash with an absolute workdir', 'bash', { command: 'cat app.ts', workdir: '/srv/app' }, '/srv/app/app.ts'],
    ['bash with a blank workdir', 'bash', { command: 'cat src/app.ts', workdir: '  ' }, '/repo/src/app.ts'],
    ['pwsh `Get-Content`', 'pwsh', { command: 'Get-Content src/app.ts' }, '/repo/src/app.ts'],
    ['pwsh alias with -Path and a relative workdir', 'pwsh', { command: 'gc -Path app.ts', workdir: 'src' }, '/repo/src/app.ts'],
    ['pwsh absolute operand', 'pwsh', { command: 'type -LiteralPath /repo/src/app.ts' }, '/repo/src/app.ts'],
  ])('resolves %s against the session directory', (_name, tool, args, expected) => {
    expectResolvedPath(shellReadPath(tool, args, '/repo'), expected)
  })

  it.each([
    ['a non-shell tool', 'read', { file_path: 'src/app.ts' }],
    ['an unrelated tool', 'run_code', { command: 'cat src/app.ts' }],
    ['bash with an unprovable command', 'bash', { command: 'cat src/app.ts | head -n 1' }],
    ['pwsh with an unprovable command', 'pwsh', { command: 'Get-Content src/*.ts' }],
    ['pwsh with two files', 'pwsh', { command: 'Get-Content src/a.ts src/b.ts' }],
    ['bash with a pwsh-only command', 'bash', { command: 'Get-Content src/app.ts' }],
    ['pwsh with a bash-only command', 'pwsh', { command: 'head -n 2 src/app.ts' }],
    ['non-object arguments', 'bash', 'cat src/app.ts'],
    ['null arguments', 'bash', null],
    ['missing arguments', 'bash', undefined],
    ['missing command', 'bash', { workdir: 'src' }],
    ['a non-string command', 'bash', { command: 42 }],
  ])('returns undefined for %s', (_name, tool, args) => {
    expect(shellReadPath(tool, args, '/repo')).toBeUndefined()
  })
})
