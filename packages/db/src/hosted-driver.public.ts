import type { PgDatabase } from "drizzle-orm/pg-core";

import type {
  HostedStorageSeam,
  RowsResultHKT,
  Storage,
  StorageOptions,
} from "./client.js";

/**
 * The public variant of `hosted-driver.ts` (Plan 13, Track J:
 * `manifest-j.md` §2.2; J.2b, ruling 175, owner question 3).
 *
 * `release/public-tree.json`'s `substitute` rule names this file as the text
 * the public seed carries at that path in place of the private module, which
 * the seed excludes. The public tree has no hosted driver: its drivers are pg
 * and PGlite, `REQUESTPORT_DATABASE_DRIVER` unset or empty selects pg
 * (`selectDriver` in `client.ts`), and every value but `pg` and `pglite` is
 * refused. A PostgreSQL a service hosts is reached through pg, as any other
 * is.
 *
 * It exports exactly the names the private module exports
 * (`scripts/export-public-tree.test.mjs` reads the two texts,
 * `client.test.ts` the two modules), and `client.test.ts` holds what each of
 * them answers here.
 */

/** `"public"` here, `"private"` in the module this replaces; typed as either, so code that reads it type-checks in both trees. */
export const kind: "private" | "public" = "public";

/** The hosted driver's name: none, in this tree. */
export type HostedDriver = never;

/** The hosted driver's pool: none, in this tree. */
export type HostedPool = never;

/** Every hosted driver this tree has: none. */
export const HOSTED_DRIVERS: readonly HostedDriver[] = Object.freeze([]);

/** Whether `value` names the hosted driver: never, in this tree. */
export function isHostedDriver(_value: unknown): _value is HostedDriver {
  return false;
}

/** The driver `selectDriver` answers when `REQUESTPORT_DATABASE_DRIVER` is unset or empty. */
export const DEFAULT_DRIVER: HostedDriver | "pg" = "pg";

/** What `selectDriver`'s refusal of a value it does not recognise tells a person to do. */
export const UNRECOGNISED_DRIVER_ADVICE =
  'Unset it for pg, or set it to "pg" or "pglite".';

/** The npm packages the hosted driver brings: none, in this tree. */
export const HOSTED_DRIVER_PACKAGES: readonly string[] = Object.freeze([]);

/** The hosted driver's module specifiers: none, in this tree. */
export const HOSTED_DRIVER_MODULES: readonly string[] = Object.freeze([]);

/** The variable a local run names the hosted driver's proxy in: none, in this tree. */
export const LOCAL_PROXY_VARIABLE: string | undefined = undefined;

const NO_HOSTED_DRIVER =
  "This build has no hosted driver: its drivers are pg and PGlite.";

/** Refuses: this tree has no hosted driver to build a storage on. */
export function createHostedStorage(
  _options: StorageOptions,
  _seam: HostedStorageSeam,
): Storage {
  throw new Error(NO_HOSTED_DRIVER);
}

/** Refuses: this tree has no hosted driver to bind a handle over. */
export function drizzleOverHosted<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(_client: unknown, _schemaOf?: TSchema): PgDatabase<RowsResultHKT, TSchema> {
  throw new Error(NO_HOSTED_DRIVER);
}

/** Whether `error` is the hosted driver's server error: never, in this tree. */
export function isHostedServerError(_error: unknown): boolean {
  return false;
}

/** Whether `session` is the hosted driver's Drizzle session: never, in this tree. */
export function isHostedSession(_session: unknown): boolean {
  return false;
}

/** The hosted driver's local proxy: none, in this tree, whatever `env` names. */
export function localProxyTarget(_env: NodeJS.ProcessEnv): string | undefined {
  return undefined;
}

/** Changes nothing, and answers false: this tree has no hosted driver to point at a proxy. */
export function applyLocalProxy(_env: NodeJS.ProcessEnv): boolean {
  return false;
}
