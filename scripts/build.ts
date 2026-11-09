/**
 * Build every plugin package and verify the artifacts a dsh profile actually
 * resolves.
 *
 * `pnpm -r build` runs each package's own tsdown build; the checks afterwards are
 * the point of this script: a package can build "successfully" while its
 * manifest points at a file nobody produced, and the Host would only find out at
 * activation time.
 *
 * Checks, per bundle package:
 * - `main` / `exports["."]` resolve to a built file;
 * - `exports["./client"]` exists whenever `dsh.client` is declared;
 * - every `dsh.bundle.patch` file exists;
 * - `engines.dsh` is declared, so the market can state compatibility.
 *
 * @throws nothing; a failure exits the process with status 1.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO_ROOT,
  bundlePatchFiles,
  hasClientHalf,
  isBundlePackage,
  listPackages,
  pnpmCommand,
  readJson,
} from './workspace.ts'

/** Resolve the file a consumer imports from an exports entry. */
function exportTarget(entry) {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return undefined
  for (const condition of ['default', 'import', 'node', 'require']) {
    const target = entry[condition]
    if (typeof target === 'string') return target
  }
  return undefined
}

const root = await readJson(join(REPO_ROOT, 'package.json'))
if (isBundlePackage(root)) {
  console.error('✗ the root package.json declares dsh.bundle; the market would then list only the root package')
  process.exit(1)
}

console.log('› pnpm -r build')
const pnpm = pnpmCommand()
const build = spawnSync(pnpm.command, ['-r', '--workspace-concurrency=4', 'build'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: pnpm.shell,
})
// A spawn that never started has `status === null` and the real reason in
// `error`; reporting "exit code signal" would hide it.
if (build.error !== undefined) {
  console.error(`✗ could not start ${pnpm.command}: ${build.error.message}`)
  process.exit(1)
}
if (build.status !== 0) {
  console.error(build.status === null
    ? '✗ build was killed by a signal'
    : `✗ build failed with exit code ${build.status}`)
  process.exit(build.status ?? 1)
}

const packages = await listPackages()
const failures = []
const plugins = []
const helpers = []

for (const pkg of packages) {
  const name = typeof pkg.manifest.name === 'string' ? pkg.manifest.name : undefined
  if (name === undefined) {
    failures.push(`${pkg.dir}: package.json has no name`)
    continue
  }
  if (!isBundlePackage(pkg.manifest)) {
    helpers.push(`${name} (${pkg.dir})`)
    continue
  }

  const expected = []
  const entry = exportTarget(pkg.manifest.exports?.['.']) ?? pkg.manifest.main
  if (typeof entry === 'string') expected.push(entry)
  if (hasClientHalf(pkg.manifest)) {
    const client = exportTarget(pkg.manifest.exports?.['./client'])
    if (client === undefined) {
      failures.push(`${name}: declares dsh.client but exports no "./client" entry`)
    } else {
      expected.push(client)
    }
  }
  for (const patch of bundlePatchFiles(pkg.manifest)) expected.push(patch)

  const engines = pkg.manifest.engines
  if (engines === null || typeof engines !== 'object' || typeof engines.dsh !== 'string') {
    failures.push(`${name}: engines.dsh is missing, so the market cannot state compatibility`)
  }

  const produced = []
  for (const file of expected) {
    if (existsSync(join(pkg.path, file))) produced.push(file)
    else failures.push(`${name}: ${file} is declared but missing after the build`)
  }
  plugins.push(`${name} (${pkg.dir}) → ${produced.join(', ')}`)
}

console.log('')
console.log(`bundle packages (installable plugins): ${plugins.length}`)
for (const line of plugins) console.log(`  ✓ ${line}`)
if (helpers.length > 0) {
  console.log(`other workspace packages (no dsh.bundle, not listed in the market): ${helpers.length}`)
  for (const line of helpers) console.log(`  · ${line}`)
}

if (failures.length > 0) {
  console.error('')
  console.error(`✗ ${failures.length} problem(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('')
console.log('✓ build artifacts verified')
