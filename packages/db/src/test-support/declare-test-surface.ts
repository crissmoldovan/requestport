import { declareDatabaseSurface } from "../role-guard.js";

/*
 * The `test` surface (manifest-i2.md §2.2, ruling 45), declared by the
 * Vitest setup of each workspace whose suites reach the default database
 * handle: this package's own configuration (both its default project and
 * the PGlite lane), `packages/auth`, the `integration` project of
 * `packages/jobs` and the `node` project of `apps/web` (track-i2.md §7).
 * Each names this file in `setupFiles`.
 *
 * It is the only module that declares `test`, and a sweep test pins that no
 * other does. The role check does not judge `test`: the local role is a
 * superuser, and a test says so by declaring what it is.
 */
declareDatabaseSurface("test");
