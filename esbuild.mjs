#!/usr/bin/env node

import esbuild from "esbuild";

const isProduction = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

(async () => {
  const context = await esbuild.context({
    logLevel: "info",
    metafile: true,
    sourcemap: true,

    // Input options
    entryPoints: ["src/extension.ts", "infoview/index.tsx"],

    external: [
      "vscode",
      "path",
    ],

    // Processing options
    bundle: true,
    define: {
      "process.env.NODE_ENV": `"${isProduction ? "production" : "development"}"`,
    },

    // Output options
    outdir: "out",
    platform: 'node',
    format: "cjs",
    minify: isProduction,
    legalComments: "none",
    target: "es6",
  });
  if (watch) {
    await context.watch();
  } else {
    await context.rebuild();
    await context.dispose();
  }
})().catch(e => {
  console.error(e);
  process.exit(1)
});
