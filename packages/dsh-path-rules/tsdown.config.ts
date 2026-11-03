import { defineConfig } from 'tsdown'
import { hostConfig } from '../../tooling/index.mjs'

/**
 * Host-only build: `lib/index.js` plus `lib/index.d.ts`, a Cordis plugin the
 * Host imports as ESM. This package has no browser half.
 */
export default defineConfig([hostConfig()])
