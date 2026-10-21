import { type E2EEnvironment, isE2EEmailMode } from "@requestport/auth/e2e";

/**
 * The CSP's E2E fence (Plan 13, H.7; ruling 174): whether the content
 * security policy drops `upgrade-insecure-requests` because the process is in
 * E2E mode. It is auth's E2E predicate (`isE2EEmailMode`: a run-time
 * `NODE_ENV` of `development` or `test`, `REQUESTPORT_E2E_MODE=1` and a
 * `REQUESTPORT_E2E_TOKEN` of at least 32 characters), read off the
 * environment object it is handed, and nothing else.
 *
 * The host (`host.ts`) and apps/web's proxy (`apps/web/src/proxy.ts`) read
 * the fence through this module alone, so that the builds that leave the
 * test seams out can put an inert module in its place, one whose fence is
 * never open (`inert/e2e-csp-fence.ts`): `@requestport/server`'s bundle (G's
 * row) and requestport's self-host Next build, which `@requestport/web`
 * carries, each by `packages/core/bundle.mjs`'s `testSeams`. requestport's
 * esbuild bundle leaves `@requestport/server` external, so it replaces
 * nothing: the fence it runs is the published `@requestport/server`'s, the
 * inert one.
 * Everywhere else, apps/web's own build among them, it is this module.
 */
export function isE2ECspFenceOpen(env: E2EEnvironment = process.env): boolean {
  return isE2EEmailMode(env);
}
