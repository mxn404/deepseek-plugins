/**
 * Browser-half build preset: a bundle the Web GUI loads through
 * `window.__ModuleLoader__.load({ id, factory })`.
 *
 * The emitted file is plain CJS wrapped in a factory function. The page passes
 * in `require`, which resolves `react`, `react-dom` and `@deepseek-ai/*` from its
 * frozen platform module table — so those must stay external here.
 *
 * Sourcemaps are not emitted: wrapping the chunk shifts every line, and a wrong
 * map is worse than none. See the harness `packages/client/tsdown.client.ts` for
 * the map-composition approach.
 */
import { readPluginId } from './tsdown.host.mjs'

/**
 * Build the browser-half tsdown config.
 *
 * @param options - optional overrides merged over the defaults.
 * @param options.entry - entry map, defaulting to `{ client: 'src/client/index.tsx' }`.
 * @param options.external - extra externals beyond the platform baseline.
 * @returns the tsdown config.
 */
export function clientConfig(options = {}) {
  const { entry = { client: 'src/client/index.tsx' }, external = [], ...rest } = options
  const id = readPluginId()
  return {
    entry,
    outDir: 'lib',
    format: 'cjs',
    target: 'es2022',
    dts: false,
    // The host build owns cleaning; both configs run from one `tsdown` call.
    clean: false,
    sourcemap: false,
    // Force `lib/client.js`: the manifest exports that exact path, while a
    // `"type": "module"` package would otherwise get `.cjs`.
    outExtensions: () => ({ js: '.js' }),
    // `format: 'cjs'` always targets Node, so the browser platform is requested
    // from the input side; otherwise it is dropped as contradictory.
    inputOptions: { platform: 'browser' },
    deps: { neverBundle: [/^@deepseek-ai\//, /^react($|\/)/, /^react-dom($|\/)/, ...external] },
    // Everything the chunk declares at top level must land inside the factory:
    // `module`, `exports` and `require` are the wrapper's locals, not globals.
    banner: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: function (require) {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
      '',
    ].join('\n'),
    footer: ['', 'return module.exports;', '} });', ''].join('\n'),
    ...rest,
  }
}
