/**
 * Where the self-host build of apps/web lands, under `apps/web`: the
 * `distDir` `apps/web/next.config.ts` sets when
 * `REQUESTPORT_SELF_HOST_BUILD` is `1`, never `.next`, which `--e2e` serves
 * (Plan 13, H.5; `self-host-build.ts`).
 *
 * A module of its own, which imports nothing (ruling 190, minor 3):
 * `../serve/web.ts`, which `requestport`'s bundle reaches, takes the name
 * from here, so the bundle reaches neither `self-host-build.ts` nor the
 * seams' module it imports (`test-seams.ts`).
 * `scripts/pack-requestport.test.mjs` holds that neither is an input of the
 * bundle.
 */
export const SELF_HOST_DIST_DIR = ".next-self-host";
