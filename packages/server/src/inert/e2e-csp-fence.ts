/**
 * The inert stand-in for the CSP's E2E fence (Plan 13, H.7; rulings 174 and
 * 193 item 2). The builds that leave the test seams out put this module
 * where the real one, `../e2e-csp-fence.ts`, would be:
 * `@requestport/server`'s bundle, and requestport's self-host Next build,
 * which `@requestport/web` carries, each by `packages/core/bundle.mjs`'s
 * `testSeams`. requestport's esbuild bundle leaves `@requestport/server`
 * external, so the fence it runs is this package's.
 * Here the fence is never open, so the policy drops
 * `upgrade-insecure-requests` only for the public URL, never for E2E mode.
 * Nothing else of the real module is here. It is in this package, beside
 * the real one, because `bundle.mjs`'s `buildPackage` refuses a build of a
 * package that inlines a module of another.
 */
export function isE2ECspFenceOpen(_env?: unknown): boolean {
  return false;
}
