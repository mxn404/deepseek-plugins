/**
 * Generate a dsh plugin market index (`format: 1`) from the bundle packages of
 * this workspace, pointing every version at this repository at the current
 * commit.
 *
 * The output is what the Web GUI's **Discover** tab reads: it lists one entry per
 * bundle package, with the Git source, path and DSH compatibility range that
 * `dsh plugin add` needs. Publish `site/` on any static host (GitHub Pages is
 * what `.github/workflows/market.yml` does) and add its `index.json` URL as an
 * index source.
 *
 * Deliberate differences from the reference generator in the harness checkout:
 * - no network access: it reads this checkout, not tags or registries;
 * - it publishes the current commit only, not one version per release tag;
 * - packages whose directory starts with `_` (the template) and packages marked
 *   `"private": true` are skipped, because neither should be installable.
 *
 * @example
 * ```sh
 * pnpm market --title "My plugins"
 * ```
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { REPO_ROOT, bundlePatchFiles, isBundlePackage, listPackages, readJson } from './workspace.ts'

/** Icon formats the index accepts, with the size ceiling the format enforces. */
const ICON_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
const ICON_MAX_BYTES = 256 * 1024

/** Read one `--name value` option. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}

/** Run git in the repository root and return trimmed stdout. */
function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return result.stdout.trim()
}

/**
 * Turn a `package.json` repository field into the https web URL the index wants.
 *
 * @param value - a string or `{ url }` object, as npm accepts.
 * @returns the https URL, without `git+` or a `.git` suffix.
 */
function repositoryUrl(value) {
  const raw = typeof value === 'string' ? value : value?.url
  if (typeof raw !== 'string' || raw === '') throw new Error('the root package.json declares no repository')
  const withoutGit = raw.replace(/^git\+/, '')
  const scp = /^git@([^:]+):(.+)$/.exec(withoutGit)
  const url = scp === null ? withoutGit : `https://${scp[1]}/${scp[2]}`
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '')
  if (!cleaned.startsWith('https://')) throw new Error(`repository URL is not https: ${raw}`)
  return cleaned
}

/** Read `meta.title` / `meta.description` from one locale file, if it exists. */
async function localeMeta(dir, language) {
  const path = join(dir, 'locale', `${language}.json`)
  if (!existsSync(path)) return {}
  try {
    const parsed = await readJson(path)
    const meta = parsed?.meta
    return {
      title: typeof meta?.title === 'string' ? meta.title : undefined,
      description: typeof meta?.description === 'string' ? meta.description : undefined,
    }
  } catch (error) {
    console.warn(`  ! ${path}: unreadable locale file (${error.message})`)
    return {}
  }
}

/** Build the `LocalizedText` object for one field, or undefined when untranslated. */
function localized(english, chinese) {
  if (english === undefined) return undefined
  return chinese === undefined || chinese === english ? { en: english } : { en: english, zh: chinese }
}

/** Copy one icon into the published tree and return its URL relative to the index. */
async function publishIcon(name, dir, manifest, iconsDir, warnings) {
  const declared = manifest.icon
  if (typeof declared !== 'string' || declared === '') return undefined
  const source = join(dir, declared)
  if (!existsSync(source)) {
    warnings.push(`${name}: icon ${declared} does not exist`)
    return undefined
  }
  const extension = extname(declared).toLowerCase()
  if (!ICON_TYPES.has(extension)) {
    warnings.push(`${name}: icon ${declared} is not an accepted format`)
    return undefined
  }
  const bytes = await readFile(source)
  if (bytes.byteLength > ICON_MAX_BYTES) {
    warnings.push(`${name}: icon ${declared} exceeds ${ICON_MAX_BYTES} bytes`)
    return undefined
  }
  const file = `${name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-')}${extension}`
  await copyFile(source, join(iconsDir, file))
  return `icons/${file}`
}

const title = option('title', 'DeepSeek Plugins')
const outputRelative = option('output', 'site/index.json')
const outputPath = join(REPO_ROOT, outputRelative)
const siteDir = join(outputPath, '..')
const iconsDir = join(siteDir, 'icons')

// The index points at a commit, so it must describe a committed tree.
let commit
try {
  commit = git(['rev-parse', 'HEAD'])
} catch (error) {
  console.error(`✗ ${error.message}`)
  console.error('  commit the repository before generating the index: the source pins a commit SHA.')
  process.exit(1)
}
const commitTimestamp = Number(git(['log', '-1', '--format=%ct']))
if (git(['status', '--porcelain']) !== '') {
  console.warn('! working tree is dirty: the index pins HEAD, so uncommitted changes are not included')
}

const root = await readJson(join(REPO_ROOT, 'package.json'))
const repoUrl = repositoryUrl(root.repository)
const packages = await listPackages()
const warnings = []
const skipped = []
const plugins = []

await rm(iconsDir, { recursive: true, force: true })
await mkdir(iconsDir, { recursive: true })

for (const pkg of packages) {
  const manifest = pkg.manifest
  const name = typeof manifest.name === 'string' ? manifest.name : undefined

  if (name === undefined) {
    skipped.push(`${pkg.dir}: no package name`)
    continue
  }
  if (!isBundlePackage(manifest)) {
    skipped.push(`${name}: no dsh.bundle`)
    continue
  }
  if (manifest.private === true) {
    skipped.push(`${name}: private`)
    continue
  }
  if (basename(pkg.dir).startsWith('_')) {
    skipped.push(`${name}: underscore-prefixed directory (template)`)
    continue
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    skipped.push(`${name}: no version`)
    continue
  }
  for (const patch of bundlePatchFiles(manifest)) {
    if (!existsSync(join(pkg.path, patch))) warnings.push(`${name}: bundle patch ${patch} does not exist`)
  }

  const english = await localeMeta(pkg.path, 'en')
  const chinese = await localeMeta(pkg.path, 'zh')
  const engines = manifest.engines
  const dsh = engines !== null && typeof engines === 'object' ? engines.dsh : undefined
  if (typeof dsh !== 'string') warnings.push(`${name}: engines.dsh is missing, the version accepts any DSH release`)

  const entry = {
    name,
    title: localized(english.title, chinese.title),
    description: localized(english.description ?? (typeof manifest.description === 'string' ? manifest.description : undefined), chinese.description),
    icon: await publishIcon(name, pkg.path, manifest, iconsDir, warnings),
    author: typeof manifest.author === 'string'
      ? manifest.author.replace(/\s*<[^>]*>|\s*\([^)]*\)/g, '')
      : (typeof manifest.author?.name === 'string' ? manifest.author.name : undefined),
    homepage: typeof manifest.homepage === 'string' && /^https?:\/\//.test(manifest.homepage) ? manifest.homepage : undefined,
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter(word => typeof word === 'string') : undefined,
    repository: { url: repoUrl, directory: pkg.dir },
    versions: [
      {
        version: manifest.version,
        publishTimestamp: commitTimestamp,
        source: { type: 'git', url: repoUrl, commit, path: pkg.dir },
        ...(typeof dsh === 'string' ? { engines: { dsh: dsh.trim() } } : {}),
      },
    ],
  }
  plugins.push(Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)))
}

if (plugins.length === 0) {
  console.error('✗ no installable bundle packages found')
  console.error('  packages/_template is a copy-ready skeleton, not a published plugin.')
  console.error('  Copy it to packages/dsh-<name>, fill in the manifest, then rerun this script.')
  process.exit(1)
}

plugins.sort((left, right) => String(left.name).localeCompare(String(right.name)))

const index = {
  format: 1,
  title: { en: title, zh: title },
  plugins,
}
await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`✓ ${outputRelative}: ${plugins.length} plugin(s) at ${commit.slice(0, 7)}`)
for (const plugin of plugins) console.log(`  · ${plugin.name} ${plugin.versions[0].version} → ${plugin.versions[0].source.path}`)
if (skipped.length > 0) {
  console.log(`skipped ${skipped.length} package(s):`)
  for (const line of skipped) console.log(`  · ${line}`)
}
if (warnings.length > 0) {
  console.warn('')
  console.warn(`! ${warnings.length} warning(s)`)
  for (const line of warnings) console.warn(`  - ${line}`)
}
console.log('')
console.log(`next: publish ${relative(REPO_ROOT, siteDir)}/ on a static host and add ${basename(outputPath)} as an index source`)
