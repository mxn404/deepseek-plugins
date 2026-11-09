/**
 * Pure-format spec: PowerShell single-file read parsing.
 *
 * The parser is the contract between a model-written pwsh command and a rule
 * trigger. PowerShell's full grammar is far larger than the bash one, so the
 * accepted shape is deliberately narrower: exactly one `Get-Content` call (or
 * one of its aliases) on exactly one file, with no other statement, no
 * pipeline, and no option that could change which file is read. Every shape it
 * cannot prove must return `undefined`, so a wrong guess never loads an
 * unrelated rule.
 */

import { describe, expect, it } from 'vitest'
import { parsePwshSingleFileReadCommand } from '../src/pwsh.ts'

describe('parsePwshSingleFileReadCommand', () => {
  it.each([
    ['the cmdlet with a positional file', 'Get-Content src/app.ts', 'get-content', 'src/app.ts'],
    ['a lowercase cmdlet', 'get-content src/app.ts', 'get-content', 'src/app.ts'],
    ['an uppercase cmdlet', 'GET-CONTENT src/app.ts', 'get-content', 'src/app.ts'],
    ['the gc alias', 'gc src/app.ts', 'gc', 'src/app.ts'],
    ['the cat alias', 'cat src/app.ts', 'cat', 'src/app.ts'],
    ['the type alias', 'type src/app.ts', 'type', 'src/app.ts'],
    ['an uppercase alias', 'TYPE src/app.ts', 'type', 'src/app.ts'],
    ['-Path with a separate value', 'Get-Content -Path src/app.ts', 'get-content', 'src/app.ts'],
    ['-LiteralPath with a separate value', 'Get-Content -LiteralPath src/app.ts', 'get-content', 'src/app.ts'],
    ['a lowercase flag', 'Get-Content -path src/app.ts', 'get-content', 'src/app.ts'],
    ['-Raw', 'Get-Content -Raw src/app.ts', 'get-content', 'src/app.ts'],
    ['-Force', 'type -Force src/app.ts', 'type', 'src/app.ts'],
    ['several read-only flags', 'Get-Content -Force -Raw src/app.ts', 'get-content', 'src/app.ts'],
    ['-Encoding with a separate value', 'Get-Content -Encoding UTF8 src/app.ts', 'get-content', 'src/app.ts'],
    ['-Encoding with an attached value', 'Get-Content -Encoding:UTF8 src/app.ts', 'get-content', 'src/app.ts'],
    ['-Encoding with a multi-word value', 'Get-Content -Encoding:utf8NoBOM src/app.ts', 'get-content', 'src/app.ts'],
    ['-Encoding with a quoted value', 'Get-Content -Encoding "UTF8" src/app.ts', 'get-content', 'src/app.ts'],
    ['a flag cluster in any order', 'gc -Encoding ascii -Force -Raw app.ts', 'gc', 'app.ts'],
    ['a tab as the separator', 'Get-Content\t-Path\tsrc/app.ts', 'get-content', 'src/app.ts'],
    ['a double-quoted path with spaces', 'Get-Content "src/my app.ts"', 'get-content', 'src/my app.ts'],
    ['a single-quoted path with spaces', "Get-Content 'src/my app.ts'", 'get-content', 'src/my app.ts'],
    ['a quoted -Path value', 'Get-Content -Path "src/my app.ts"', 'get-content', 'src/my app.ts'],
    ['a path with `..` segments', 'Get-Content ../shared/app.ts', 'get-content', '../shared/app.ts'],
    ['a dot-relative path', 'Get-Content ./src/app.ts', 'get-content', './src/app.ts'],
    ['a backslash-relative path', 'Get-Content .\\src\\app.ts', 'get-content', '.\\src\\app.ts'],
    ['a drive-letter path', 'Get-Content C:\\repo\\src\\app.ts', 'get-content', 'C:\\repo\\src\\app.ts'],
    ['a quoted drive-letter path with spaces', 'Get-Content "C:\\Program Files\\app.ts"', 'get-content', 'C:\\Program Files\\app.ts'],
    ['a UNC path', 'Get-Content \\\\server\\share\\dir\\app.ts', 'get-content', '\\\\server\\share\\dir\\app.ts'],
    ['a quoted UNC path with spaces', 'Get-Content "\\\\server\\share\\my dir\\app.ts"', 'get-content', '\\\\server\\share\\my dir\\app.ts'],
    ['a quoted path with Chinese characters', 'Get-Content "C:\\Users\\张三\\项目\\app.ts"', 'get-content', 'C:\\Users\\张三\\项目\\app.ts'],
    ['an absolute POSIX path', 'Get-Content /repo/src/app.ts', 'get-content', '/repo/src/app.ts'],
  ])('accepts %s', (_name, command, expectedCommand, path) => {
    expect(parsePwshSingleFileReadCommand(command)).toEqual({ command: expectedCommand, path })
  })

  it.each([
    ['an empty command', ''],
    ['whitespace only', '   '],
    ['an unknown cmdlet', 'Get-Item src/app.ts'],
    ['a non-read command', 'ls src/app.ts'],
    ['another read cmdlet (out of v1 scope)', 'Select-String APP src/app.ts'],
    ['no file', 'Get-Content'],
    ['two positional files', 'Get-Content src/a.ts src/b.ts'],
    ['two -Path values', 'Get-Content -Path src/a.ts src/b.ts'],
    ['-Path and -LiteralPath together', 'Get-Content -Path src/a.ts -LiteralPath src/b.ts'],
    ['a pipe', 'Get-Content src/app.ts | Select-Object -First 1'],
    ['a semicolon', 'Get-Content src/app.ts; Remove-Item src/app.ts'],
    ['a call operator', '& Get-Content src/app.ts'],
    ['a chain operator', 'Get-Content src/app.ts && Get-Content src/b.ts'],
    ['output redirection', 'Get-Content src/app.ts > out.txt'],
    ['input redirection', 'Get-Content < src/app.ts'],
    ['a variable', 'Get-Content $file'],
    ['a braced variable', 'Get-Content ${file}'],
    ['a backtick escape', 'Get-Content "src/app`t.ts"'],
    ['a wildcard star', 'Get-Content src/*.ts'],
    ['a wildcard question mark', 'Get-Content src/app?.ts'],
    ['a wildcard class', 'Get-Content src/app[0-9].ts'],
    ['a comma-separated array', 'Get-Content src/a.ts,src/b.ts'],
    ['a parenthesised command', '(Get-Content src/app.ts)'],
    ['a script block', 'Get-Content {src/app.ts}'],
    ['a home-directory path', 'Get-Content ~/app.ts'],
    ['a comment', 'Get-Content src/app.ts # note'],
    ['a comment instead of a file', 'Get-Content #src/app.ts'],
    ['-Tail', 'Get-Content -Tail 1 src/app.ts'],
    ['-TotalCount', 'Get-Content -TotalCount 2 src/app.ts'],
    ['-Head', 'Get-Content -Head 2 src/app.ts'],
    ['-Wait', 'Get-Content -Wait src/app.ts'],
    ['-Stream', 'Get-Content -Stream error src/app.ts'],
    ['-Delimiter', "Get-Content -Delimiter ';' src/app.ts"],
    ['-ReadCount', 'Get-Content -ReadCount 0 src/app.ts'],
    ['-AsByteStream', 'Get-Content -AsByteStream src/app.ts'],
    ['-Filter', "Get-Content -Filter '*.ts' src/app.ts"],
    ['-Include', "Get-Content -Include '*.ts' src/app.ts"],
    ['-Exclude', "Get-Content -Exclude '*.md' src/app.ts"],
    ['an unknown flag', 'Get-Content -Frobnicate src/app.ts'],
    ['an abbreviated flag', 'Get-Content -Enc UTF8 src/app.ts'],
    ['-Encoding without a value', 'Get-Content -Encoding'],
    ['-Encoding with an unknown name', 'Get-Content -Encoding ROT13 src/app.ts'],
    ['-Encoding swallowing another flag', 'Get-Content -Encoding -Raw src/app.ts'],
    ['-Path without a value', 'Get-Content -Path'],
    ['a flag after the file', 'Get-Content src/app.ts -Raw'],
    ['an attached -Path value', 'Get-Content -Path:src/app.ts'],
    ['the option terminator', 'Get-Content -- src/app.ts'],
    ['a file operand that starts with a dash', 'Get-Content -weird'],
    ['the current directory', 'Get-Content .'],
    ['the parent directory', 'Get-Content ..'],
    ['a trailing forward slash', 'Get-Content src/'],
    ['a trailing backslash', 'Get-Content src\\'],
    ['a drive root', 'Get-Content C:\\'],
    ['a drive-relative path', 'Get-Content C:app.ts'],
    ['an empty quoted operand', 'Get-Content ""'],
    ['an unterminated quote', 'Get-Content "src/app.ts'],
    ['doubled quotes (a PowerShell escape)', 'Get-Content "src/a""b.ts"'],
    ['a second line', 'Get-Content src/a.ts\nGet-Content src/b.ts'],
  ])('rejects %s', (_name, command) => {
    expect(parsePwshSingleFileReadCommand(command)).toBeUndefined()
  })
})
