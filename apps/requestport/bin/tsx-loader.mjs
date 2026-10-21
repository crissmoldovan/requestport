// tsx's ESM loader, for a child process the repository's `requestport`
// starts on TypeScript source: `requestport start` preloads this module in its
// operator child (`node --import <this file> <entry> <data directory>`,
// src/operator/command.ts). It lives here, outside src/, so that no module
// esbuild bundles for the tarball names tsx, which the tarball does not
// declare; the packed child runs dist/operator.js with no loader.
import "tsx/esm";
