import { defineConfig } from 'tsdown'
import { clientConfig, hostConfig } from '../../tooling/index.mjs'

/**
 * Two builds per plugin package:
 *
 * - host half → `lib/index.js`, a Cordis plugin the Host imports (ESM, Node).
 * - browser half → `lib/client.js`, a `window.__ModuleLoader__.load({id, factory})`
 *   artifact the Web GUI serves at `/plugins`.
 *
 * The presets read the plugin id from `package.json` in the working directory.
 * Only override entries when a package needs more than one file per half.
 */
export default defineConfig([
  hostConfig(),
  clientConfig(),
])
