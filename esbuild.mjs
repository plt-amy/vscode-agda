#!/usr/bin/env node

import esbuild from "esbuild";

const isProduction = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @typedef {import('esbuild').BuildOptions} BuildOptions
 */

/** @type BuildOptions */
const sharedOptions = {
  logLevel: "info",
  metafile: true,
  sourcemap: true,

  bundle: true,
  define: {
    "process.env.NODE_ENV": `"${isProduction ? "production" : "development"}"`,
  },

  external: ['vscode'],
  target: 'es2020',
  sourcemap: true,

  minify: isProduction,
  legalComments: "none",
};

/** @type BuildOptions */
const sharedWebOptions = {
  platform: 'browser',
  ...sharedOptions,
};

/** @type BuildOptions */
const sharedDesktopOptions = {
  platform: 'node',
  ...sharedOptions,
};

/** @type BuildOptions[] */
const files = [
  // Infoview
  {
    entryPoints: ['src/infoview/index.tsx'],
    outfile: 'out/infoview/index.js',
    format: 'iife',
    ...sharedWebOptions,
  },
  {
    entryPoints: ['src/infoview/styles.css'],
    outfile: 'out/infoview/styles.css',
    ...sharedWebOptions,
  },

  // Desktop
  {
    entryPoints: ['src/desktop/extension.ts'],
    outfile: 'out/desktop/extension.js',
    format: 'cjs',
    ...sharedDesktopOptions,
  },

  // Web
  {
    entryPoints: ['src/web/extension.ts'],
    outfile: 'out/web/extension.js',
    format: 'cjs',
    ...sharedWebOptions,
  },
  {
    entryPoints: ['src/web/wasm/browserWorker.ts'],
    outfile: 'out/web/mainWorker.js',
    format: 'iife',
    ...sharedWebOptions,
  },
]

Promise.all(files.map(x => esbuild.context(x))).then(async contexts => {
  if (watch) {
    await Promise.all(contexts.map(x => x.watch()));
  } else {
    await Promise.all(contexts.map(x => x.rebuild()));
    await Promise.all(contexts.map(x => x.dispose()));
  }
}).catch(e => {
  console.error(e);
  process.exit(1)
});
