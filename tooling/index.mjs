/**
 * Shared tsdown presets for the plugins in this workspace.
 *
 * Both presets read the plugin id from the `package.json` in the working
 * directory, which is the package directory whenever tsdown runs from a package
 * script. That keeps the id in one place: the row in `cordis.patch.yml`, the
 * `__ModuleLoader__` id of the client bundle, and the package name cannot drift.
 */
export { clientConfig } from './tsdown.client.mjs'
export { hostConfig } from './tsdown.host.mjs'
