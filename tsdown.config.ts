/**
 * Build the plugin into two bundles:
 * - `lib/index.js` (host half): ESM node bundle of the tools plugin. DSH
 *   packages are type-only at runtime and stay external; all relative modules
 *   are inlined and `node:` builtins stay external.
 * - `lib/client.js` (browser half): CJS closure that registers itself with the
 *   browser module system via `window.__ModuleLoader__.load({ id, factory })`,
 *   resolving React through the injected `require` (the frozen module table).
 *   It mirrors the harness client preset, minus the CSS-modules pipeline: the
 *   row and panel style themselves with inline styles over theme variables.
 *
 * Plain array export with a type-only `tsdown` import, so the config loads
 * even before the package's node_modules contains tsdown.
 */

import type { UserConfig } from 'tsdown'

const ID = '@local/dsh-memory'

/** Externals resolved by the page's module table. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

const host: UserConfig = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  // Keep .js/.d.ts names (the package is type module): matches the exports map.
  fixedExtension: false,
  clean: true,
  dts: true,
  deps: {
    // Every DSH package is provided by the Host and imported type-only, so no
    // runtime dependency is bundled or declared.
    neverBundle: [/^@deepseek-ai\//],
  },
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // The browser bundle lands next to the node half (single lib/ artifact
  // directory; the pinned entryFileNames keeps it exactly lib/client.js).
  // clean stays off so this pass cannot wipe the host output emitted above.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Only the loader module table is external; everything else inlines — a
    // require the table cannot answer is a runtime throw.
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The map is served from /plugins/<id>/client.js.map.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** Build both faces; the host pass cleans `lib/` once before both write. */
export default [host, client]
