/*
  `@requestport/core/person-context`: `personCommandContext`, the builder of
  a signed-in person's command context that `execute` runs for a person's
  call (`execute.ts`), for the repository's web (`humanCommandContext`,
  `apps/web/src/lib/server-core-commands.ts`).

  Not published (ruling 230 item 3): `bundle.mjs` builds no entry for it, and
  `scripts/pack-packages.mjs` names it among core's unpublished subpaths, so
  the packed manifest does not export it. `published-types.test.ts` holds it
  out of every published entry. A consumer of the published package builds
  the context by hand, as core's README says. A builder can be published
  later without breaking anything; taking a published one away could not.
*/
export { personCommandContext } from "./command-bus.js";
