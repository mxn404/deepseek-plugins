/**
 * Generate a dsh plugin market index (`format: 1`) from the bundle packages of
 * this workspace.
 *
 * The output is what the Web GUI's **Discover** tab reads. Each plugin picks its
 * source automatically:
 *
 * - **published to npm** → every non-deprecated version listed on the registry,
 *   installed as `name@version`. No build scripts run on the user's machine.
 * - **not published** → the current commit of this repository at the package
 *   path, installed as a git spec. pnpm then builds the package with its
 *   `prepare` script, which the consuming profile must approve through
 *   `allowBuilds` (dsh turns that into a pending approval in the GUI).
 *
 * Publish `site/` on any static host (GitHub Pages is what
 * `.github/workflows/market.yml` does) and add its `index.json` URL as an index
 * source.
 *
 * Deliberate differences from the reference generator in the harness checkout:
 * - versions come from the registry for published packages, and only the current
 *   commit for unpublished ones;
 * - packages whose directory starts with `_` (the template) and packages marked
 *   `"private": true` are skipped, because neither should be installable;
 * - a package must be committed and unchanged, because a git entry pins HEAD.
 *
 * @example
 * ```sh
 * pnpm market --title "My plugins"
 * pnpm market --offline                 # git sources only, no registry lookups
 * pnpm market --registry https://npm.example.com/
 * ```
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

/** The public registry, spelled the way the index format expects a default to be omitted. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
/** Per-request ceiling: a market build should fail loudly rather than hang. */
const REGISTRY_TIMEOUT_MS = 20_000

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

/** Whether a package directory matches HEAD: present there and unchanged in the working tree. */
function headState(dir) {
  const present = spawnSync('git', ['cat-file', '-e', `HEAD:${dir}/package.json`], { cwd: REPO_ROOT })
  if (present.status !== 0) return 'absent'
  const changed = spawnSync('git', ['status', '--porcelain', '--', dir], { cwd: REPO_ROOT, encoding: 'utf8' })
  return (changed.stdout ?? '').trim() === '' ? 'clean' : 'dirty'
}

/**
 * Read one exact SemVer version.
 *
 * The index only accepts exact versions, so anything else is dropped instead of
 * guessed at.
 *
 * @param text - the version string.
 * @returns the parsed parts, or undefined when it is not `X.Y.Z[-pre]`.
 */
function parseSemver(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two prerelease identifiers the way SemVer precedence does. */
function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Compare two exact versions by SemVer precedence.
 *
 * @returns a negative number when `left` precedes `right`, positive when it
 * follows it, and 0 when they are equal.
 */
function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === undefined || b === undefined) return left.localeCompare(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftId = a.prerelease[index]
    const rightId = b.prerelease[index]
    if (leftId === undefined) return -1
    if (rightId === undefined) return 1
    const order = compareIdentifier(leftId, rightId)
    if (order !== 0) return order
  }
  return 0
}

/**
 * Read a package's registry document.
 *
 * @param name - the package name.
 * @param registry - registry base URL.
 * @param warnings - receives failures, which the caller resolves by falling back to git.
 * @returns the document, `null` when the registry does not know the package, or
 * `undefined` when the registry could not be read.
 */
async function fetchPackument(name, registry, warnings) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const url = `${base}${encodeURIComponent(name)}`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
  } catch (error) {
    warnings.push(`${name}: registry request failed (${error.message}); using the git source`)
    return undefined
  }
  if (response.status === 404) return null
  if (!response.ok) {
    warnings.push(`${name}: registry returned ${response.status}; using the git source`)
    return undefined
  }
  try {
    return await response.json()
  } catch (error) {
    warnings.push(`${name}: registry document is not JSON (${error.message}); using the git source`)
    return undefined
  }
}

/**
 * Build the `versions` list for a package that is published to npm.
 *
 * Only versions that are exact SemVer, not deprecated, and declare `dsh.bundle`
 * are listed: the market installs `name@version`, so a version without a bundle
 * would install a package that contributes no config layer.
 *
 * @param name - the package name.
 * @param packument - the registry document.
 * @param registry - registry base URL, recorded only when it is not the default.
 * @param warnings - receives per-version problems.
 * @returns the version entries, newest first.
 */
function publishedVersions(name, packument, registry, warnings) {
  const versions = packument?.versions
  if (versions === null || typeof versions !== 'object') {
    warnings.push(`${name}: registry document has no versions; using the git source`)
    return []
  }
  const times = packument?.time
  const entries = []
  for (const [version, manifest] of Object.entries(versions)) {
    if (parseSemver(version) === undefined) continue
    if (manifest === null || typeof manifest !== 'object') continue
    if (typeof manifest.deprecated === 'string' && manifest.deprecated !== '') continue
    const bundle = manifest.dsh?.bundle
    if (bundle === null || typeof bundle !== 'object') continue
    const published = Date.parse(times?.[version] ?? '')
    if (!Number.isFinite(published)) {
      warnings.push(`${name}@${version}: registry records no publish time; version dropped`)
      continue
    }
    const dsh = manifest.engines?.dsh
    entries.push({
      version,
      publishTimestamp: Math.floor(published / 1000),
      source: { type: 'npm', ...(registry === DEFAULT_REGISTRY ? {} : { registry }) },
      ...(typeof dsh === 'string' && dsh.trim() !== '' ? { engines: { dsh: dsh.trim() } } : {}),
    })
  }
  entries.sort((left, right) => compareSemver(right.version, left.version))
  if (entries.length > 0 && entries.every(entry => entry.engines === undefined)) {
    warnings.push(`${name}: no published version declares engines.dsh, so the market shows no compatibility range`)
  }
  return entries
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
const registry = (() => {
  const value = option('registry', DEFAULT_REGISTRY)
  return value.endsWith('/') ? value : `${value}/`
})()
const offline = process.argv.includes('--offline')
const outputPath = join(REPO_ROOT, outputRelative)
const siteDir = join(outputPath, '..')
const iconsDir = join(siteDir, 'icons')

if (!/^https?:\/\//.test(registry)) {
  console.error(`✗ --registry must be an http(s) URL: ${registry}`)
  process.exit(2)
}

// A git entry pins a commit, so the index must describe a committed tree.
const commit = git(['rev-parse', 'HEAD'])
const commitTimestamp = Number(git(['log', '-1', '--format=%ct']))
if (git(['status', '--porcelain']) !== '') {
  console.warn('! working tree is dirty: git sources pin HEAD, so uncommitted changes are not published')
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
  // A git entry names a commit and a path, so an uncommitted package would
  // publish something the pinned commit does not contain.
  const state = headState(pkg.dir)
  if (state !== 'clean') {
    skipped.push(`${name}: ${state === 'absent' ? 'not committed at HEAD' : 'uncommitted changes'}`)
    continue
  }
  for (const patch of bundlePatchFiles(manifest)) {
    if (!existsSync(join(pkg.path, patch))) warnings.push(`${name}: bundle patch ${patch} does not exist`)
  }

  const english = await localeMeta(pkg.path, 'en')
  const chinese = await localeMeta(pkg.path, 'zh')
  const engines = manifest.engines
  const localDsh = engines !== null && typeof engines === 'object' ? engines.dsh : undefined

  let versions = []
  let origin
  if (offline) {
    origin = 'git (offline)'
  } else {
    const packument = await fetchPackument(name, registry, warnings)
    if (packument === null) {
      origin = 'git (not on the registry)'
    } else if (packument !== undefined) {
      versions = publishedVersions(name, packument, registry, warnings)
      origin = versions.length > 0 ? `npm (${versions.length} version(s))` : 'git (no bundle version on the registry)'
    } else {
      origin = 'git (registry unavailable)'
    }
  }

  if (origin.startsWith('git')) {
    if (typeof localDsh !== 'string') {
      warnings.push(`${name}: engines.dsh is missing, so the git version accepts any DSH release`)
    }
    versions = [
      {
        version: manifest.version,
        publishTimestamp: commitTimestamp,
        source: { type: 'git', url: repoUrl, commit, path: pkg.dir },
        ...(typeof localDsh === 'string' ? { engines: { dsh: localDsh.trim() } } : {}),
      },
    ]
  } else if (!versions.some(entry => entry.version === manifest.version)) {
    warnings.push(`${name}: local ${manifest.version} is not published yet, so the market lists npm versions only`)
  }

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
    versions,
  }
  plugins.push({
    entry: Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)),
    origin,
    name,
  })
}

if (plugins.length === 0) {
  console.error('✗ no installable bundle packages found')
  if (skipped.length > 0) {
    console.error('skipped:')
    for (const line of skipped) console.error(`  · ${line}`)
  }
  console.error('  packages/_template is a copy-ready skeleton, not a published plugin.')
  console.error('  Copy it to packages/dsh-<name>, commit it, then rerun this script.')
  process.exit(1)
}

plugins.sort((left, right) => left.name.localeCompare(right.name))

const index = {
  format: 1,
  title: { en: title, zh: title },
  plugins: plugins.map(plugin => plugin.entry),
}
await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`✓ ${outputRelative}: ${plugins.length} plugin(s) at ${commit.slice(0, 7)}`)
for (const plugin of plugins) {
  const newest = plugin.entry.versions[0]
  console.log(`  · ${plugin.name} ${newest.version} — ${plugin.origin}`)
}
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
