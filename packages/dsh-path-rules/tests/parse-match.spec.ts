/**
 * Pure-format spec: rule parsing and glob matching.
 *
 * These two functions are the contract a rule author writes against. Every
 * case goes through the exported functions only, so a refactor inside the
 * matcher cannot break the assertions.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildRule,
  compileGlob,
  matchRules,
  parseRuleMarkdown,
  ruleIdentity,
  type Rule,
} from '../src/rule.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REFERENCE_RULES = join(HERE, 'fixtures/reference-rules')

function ruleFromMarkdown(markdown: string, root = '/repo/.dsh/rules', baseDir = '/repo'): Rule {
  return buildRule(ruleIdentity(join(root, 'rule.md'), root, baseDir), markdown)
}

describe('parseRuleMarkdown', () => {
  it.each([
    ['no frontmatter', '# Always on\n\nBe careful.\n', { paths: [], body: '# Always on\n\nBe careful.', title: 'Always on' }],
    [
      'YAML list paths',
      '---\npaths:\n  - "web/**"\n  - "docs/web/**"\n---\n\n# Web rules\nbody\n',
      { paths: ['web/**', 'docs/web/**'], body: '# Web rules\nbody', title: 'Web rules' },
    ],
    [
      'comma-separated string paths',
      '---\npaths: "web/**, docs/web/**"\n---\nbody\n',
      { paths: ['web/**', 'docs/web/**'], body: 'body', title: 'body' },
    ],
    [
      'unknown fields are ignored',
      '---\ndescription: only for humans\npaths: [web/**]\n---\nbody\n',
      { paths: ['web/**'], body: 'body', title: 'body' },
    ],
    [
      'empty frontmatter is always-on',
      '---\n---\nbody\n',
      { paths: [], body: 'body', title: 'body' },
    ],
    [
      'empty paths list behaves as an always-on rule',
      '---\npaths: []\n---\nbody\n',
      { paths: [], body: 'body', title: 'body' },
    ],
    [
      'BOM is ignored',
      '\uFEFF---\npaths: [src/**]\n---\nbody\n',
      { paths: ['src/**'], body: 'body', title: 'body' },
    ],
  ])('parses %s', (_name, markdown, expected) => {
    expect(parseRuleMarkdown(markdown)).toEqual({ status: 'ok', ...expected })
  })

  it.each([
    ['invalid YAML', '---\npaths: [unterminated\n---\nbody\n'],
    ['non-mapping frontmatter', '---\n- a\n- b\n---\nbody\n'],
    ['non-string paths entry', '---\npaths:\n  - 42\n---\nbody\n'],
    ['paths is a mapping', '---\npaths:\n  web: true\n---\nbody\n'],
    ['unterminated frontmatter', '---\npaths: [web/**]\nbody without close\n'],
  ])('fails closed on %s', (_name, markdown) => {
    const parsed = parseRuleMarkdown(markdown)
    expect(parsed.status).toBe('parse-error')
    if (parsed.status === 'parse-error') expect(parsed.reason.length).toBeGreaterThan(0)
  })

  it('strips frontmatter even when the body starts with a horizontal rule', () => {
    const parsed = parseRuleMarkdown('---\npaths: [a/**]\n---\n---\nnot frontmatter\n')
    expect(parsed.status).toBe('ok')
    if (parsed.status === 'ok') expect(parsed.body).toBe('---\nnot frontmatter')
  })
})

describe('matchRules glob semantics', () => {
  function matchedNames(rules: Rule[], touched: string[], cwd = '/repo'): string[] {
    return matchRules(rules, touched, cwd).map(hit => hit.rule.name)
  }

  it('reports every triggering file once, sorted, as absolute paths', () => {
    const rule = ruleFromMarkdown('---\npaths: [src/**]\n---\nbody\n')
    const hits = matchRules(
      [rule],
      ['/repo/src/b.ts', '/repo/src/a.ts', '/repo/src/b.ts', '/elsewhere/src/a.ts'],
      '/repo',
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.triggeredBy).toEqual(['/repo/src/a.ts', '/repo/src/b.ts'])
  })

  it('`**` crosses directories and `*` does not', () => {
    const deep = ruleFromMarkdown('---\npaths: [src/**]\n---\nbody\n')
    const flat = ruleFromMarkdown('---\npaths: [src/*.ts]\n---\nbody\n')
    expect(matchedNames([deep], ['/repo/src/a.ts'])).toEqual(['rule'])
    expect(matchedNames([deep], ['/repo/src/deep/a.ts'])).toEqual(['rule'])
    expect(matchedNames([deep], ['/repo/other/a.ts'])).toEqual([])
    expect(matchedNames([flat], ['/repo/src/a.ts'])).toEqual(['rule'])
    expect(matchedNames([flat], ['/repo/src/deep/a.ts'])).toEqual([])
  })

  it('`**/` matches zero or more segments', () => {
    const rule = ruleFromMarkdown('---\npaths: ["**/hooks/*.py"]\n---\nbody\n')
    expect(matchedNames([rule], ['/repo/hooks/a.py'])).toEqual(['rule'])
    expect(matchedNames([rule], ['/repo/pkg/deep/hooks/a.py'])).toEqual(['rule'])
    expect(matchedNames([rule], ['/repo/pkg/hooks/deep/a.py'])).toEqual([])
  })

  it('supports `?`, character classes and `{a,b}` alternatives', () => {
    const question = ruleFromMarkdown('---\npaths: ["a?.ts"]\n---\nbody\n')
    const charClass = ruleFromMarkdown('---\npaths: ["[ab].ts"]\n---\nbody\n')
    const braces = ruleFromMarkdown('---\npaths: ["{src,lib}/**"]\n---\nbody\n')
    expect(matchedNames([question], ['/repo/ab.ts'])).toEqual(['rule'])
    expect(matchedNames([question], ['/repo/abc.ts'])).toEqual([])
    expect(matchedNames([charClass], ['/repo/a.ts'])).toEqual(['rule'])
    expect(matchedNames([charClass], ['/repo/c.ts'])).toEqual([])
    expect(matchedNames([braces], ['/repo/src/a.ts'])).toEqual(['rule'])
    expect(matchedNames([braces], ['/repo/lib/a.ts'])).toEqual(['rule'])
    expect(matchedNames([braces], ['/repo/other/a.ts'])).toEqual([])
  })

  it('unions multiple paths and reports a rule once', () => {
    const rule = ruleFromMarkdown('---\npaths: [web/**, docs/web/**]\n---\nbody\n')
    expect(matchedNames([rule], ['/repo/docs/web/readme.md'])).toEqual(['rule'])
    expect(matchedNames([rule], ['/repo/web/a.ts', '/repo/docs/web/b.ts'])).toEqual(['rule'])
  })

  it('resolves globs against the directory that owns the rule root', () => {
    const nestedRoot = '/repo/pkg/.dsh/rules'
    const nested = buildRule(
      ruleIdentity(join(nestedRoot, 'nested.md'), nestedRoot, '/repo/pkg'),
      '---\npaths: [src/**]\n---\nbody\n',
    )
    expect(matchedNames([nested], ['/repo/pkg/src/a.ts'])).toEqual(['nested'])
    expect(matchedNames([nested], ['/repo/src/a.ts'])).toEqual([])
    // A cwd-relative touch resolves against the supplied cwd.
    expect(matchedNames([nested], ['src/a.ts'], '/repo/pkg')).toEqual(['nested'])
    expect(matchedNames([nested], ['src/a.ts'], '/repo')).toEqual([])
  })

  it('never matches always-on or failed rules', () => {
    const alwaysOn = ruleFromMarkdown('---\n---\nbody\n')
    const invalid = ruleFromMarkdown('---\npaths: [\n---\nbody\n')
    expect(matchedNames([alwaysOn, invalid], ['/repo/src/a.ts'])).toEqual([])
  })

  it('treats a leading `!` as a literal character, not negation', () => {
    const rule = ruleFromMarkdown('---\npaths: ["!src/a.ts"]\n---\nbody\n')
    expect(matchedNames([rule], ['/repo/src/a.ts'])).toEqual([])
  })

  it('fails a rule closed when brace expansion exceeds the budget', () => {
    const pattern = Array.from({ length: 9 }, () => '{a,b}').join('')
    const rule = ruleFromMarkdown(`---\npaths: ["${pattern}"]\n---\nbody\n`)
    expect(rule.status).toBe('pattern-error')
    expect(rule.reason).toContain('alternatives')
    expect(compileGlob(pattern).ok).toBe(false)
  })

  it('matches through a literal unmatched brace', () => {
    const rule = ruleFromMarkdown('---\npaths: ["{a,b"]\n---\nbody\n')
    expect(rule.status).toBe('ok')
    expect(matchedNames([rule], ['/repo/{a,b'])).toEqual(['rule'])
  })

  it('does not match files outside the rule base directory', () => {
    const rule = ruleFromMarkdown('---\npaths: [src/**]\n---\nbody\n')
    expect(matchedNames([rule], ['/elsewhere/src/a.ts'])).toEqual([])
  })
})

describe('reference rules from security_audit_tool', () => {
  async function referenceRules(): Promise<Map<string, Rule>> {
    const names = [
      'code-scan-rules',
      'component-layout',
      'data-model',
      'delivery-process',
      'orchestration-design',
      'plugin-hosts',
      'runtime-instructions',
      'web-driver',
      'workflow-orchestration',
    ]
    const rules = new Map<string, Rule>()
    for (const name of names) {
      const content = await readFile(join(REFERENCE_RULES, `${name}.md`), 'utf8')
      const rule = buildRule(
        ruleIdentity(join(REFERENCE_RULES, `${name}.md`), REFERENCE_RULES, dirname(REFERENCE_RULES)),
        content,
      )
      expect(rule.status, `${name} parses`).toBe('ok')
      if (name !== 'delivery-process') {
        expect(rule.paths.length, `${name} is path-scoped`).toBeGreaterThan(0)
      }
      rules.set(name, rule)
    }
    return rules
  }

  it('treats delivery-process as the only always-on reference rule', async () => {
    const content = await readFile(join(REFERENCE_RULES, 'delivery-process.md'), 'utf8')
    const rule = buildRule(
      ruleIdentity(join(REFERENCE_RULES, 'delivery-process.md'), REFERENCE_RULES, dirname(REFERENCE_RULES)),
      content,
    )
    expect(rule.status).toBe('ok')
    expect(rule.paths).toEqual([])
  })

  it.each([
    ['web/index.html', ['web-driver']],
    ['docs/web/README.md', ['component-layout', 'web-driver']],
    ['docs/adr/0001.md', ['component-layout', 'data-model']],
    ['sectest-threat/skills/code-scan/scan-rules/semgrep.yaml', ['code-scan-rules', 'component-layout']],
    [
      'sectest-threat/skills/code-scan/scan-rules/deep/plugin.py',
      ['code-scan-rules', 'component-layout', 'data-model', 'orchestration-design'],
    ],
    ['sectest-threat/skills/foo/SKILL.md', ['component-layout', 'orchestration-design', 'runtime-instructions']],
    ['pkg/scripts/build.py', ['workflow-orchestration']],
    ['pkg/x.workflow.js', ['orchestration-design', 'workflow-orchestration']],
    ['.claude-plugin/plugin.json', ['plugin-hosts']],
    ['sectest-threat/hooks/run.py', ['component-layout', 'plugin-hosts']],
    ['unrelated/readme.md', []],
  ])('maps %s to its rule set', async (relativePath, expectedNames) => {
    const rules = await referenceRules()
    const hit = matchRules([...rules.values()], [join(dirname(REFERENCE_RULES), relativePath)], dirname(REFERENCE_RULES))
    expect(hit.map(entry => entry.rule.name).sort()).toEqual([...expectedNames].sort())
  })
})
