#!/usr/bin/env node
import { runRequestPortCli } from "./cli.js";

/*
 * The `requestport` program as the tarball runs it: esbuild bundles this
 * module into `dist/requestport.js` (`apps/requestport/bundle.mjs`), keeping
 * the line above as its first. In the repository, `bin/requestport.mjs` runs
 * `cli.ts` through tsx instead.
 */
process.exit(await runRequestPortCli(process.argv.slice(2), process.env));
