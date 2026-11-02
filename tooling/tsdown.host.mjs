/**
 * Host-half build preset: a Cordis plugin the dsh Host imports as ESM.
 *
 * Output is `lib/index.js` plus `lib/index.d.ts`. The package's own entry is the
 * default; override `entry` only when a package ships more than one host entry.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read the plugin id from the package in the working directory.
 *
 * tsdown runs from the package directory for a package script, so the manifest
 * next to it is the one that owns this build. Keeping the id here means the
 * bundle row, the browser module id and the package name cannot drift.
 *
 * @returns the package name.
 */
export function readPluginId() {
  const manifestPath = join(process.cwd(), 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`run tsdown from a plugin package directory: ${manifestPath} is unreadable (${error.message})`)
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${manifestPath} declares no package name, so the plugin has no id`)
  }
  return manifest.name
}

/**
 * Build the host-half tsdown config.
 *
 * @param options - optional overrides merged over the defaults.
 * @param options.entry - entry map, defaulting to `{ index: 'src/index.ts' }`.
 * @param options.external - extra external specifiers or patterns.
 * @returns the tsdown config.
 */
export function hostConfig(options = {}) {
  const { entry = { index: 'src/index.ts' }, external = [], ...rest } = options
  readPluginId()
  return {
    entry,
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    // The host half runs first and clears the output directory. The client
    // config must not clean, or it would delete these files.
    clean: true,
    sourcemap: true,
    // Force `.js` / `.d.ts` file names: the manifest exports `lib/index.js`
    // regardless of `"type": "module"`, which tsdown would otherwise honour with
    // `.mjs` / `.d.mts` extensions.
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    // Packages supplied by the running dsh install stay external: two copies of a
    // Cordis service definition break `instanceof` and shared singleton state.
    deps: { neverBundle: [/^@deepseek-ai\//, /^node:/, ...external] },
    ...rest,
  }
}
