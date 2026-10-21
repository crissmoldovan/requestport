/**
 * Where this program's modules run from, which a module tells by its own
 * URL's extension:
 *
 * - `repository`: the workspace's TypeScript source, `.ts`, which tsx loads
 *   (`bin/requestport.mjs`) and vitest runs;
 * - `packed`: the JavaScript esbuild writes for the tarball, `.js`
 *   (`apps/requestport/bundle.mjs`). It writes every entry and chunk
 *   directly in `dist/`, so a packed module's `./` is `dist/` and its `../`
 *   the package's root (`scripts/pack-requestport.test.mjs` holds that).
 *
 * Any other extension is refused rather than guessed.
 */
export type ModuleLayout = "repository" | "packed";

export function moduleLayout(moduleUrl: string): ModuleLayout {
  const { pathname } = new URL(moduleUrl);
  if (pathname.endsWith(".ts")) return "repository";
  if (pathname.endsWith(".js")) return "packed";
  throw new Error(
    `requestport: ${moduleUrl} is neither the repository's TypeScript (.ts) nor the packed JavaScript (.js).`,
  );
}
