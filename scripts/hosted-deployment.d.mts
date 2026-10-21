/*
 * The types of `hosted-deployment.mjs`, for the TypeScript that imports it
 * (Plan 13, Track J: `manifest-j.md` §2.4 item 6; ruling 92).
 *
 * One declaration serves both trees, so it needs no `substitute` pair: it
 * types the union of the private module and its public variant,
 * `hosted-deployment.public.mjs`, which the public seed carries at the
 * module's path. It holds no value. `apps/web`'s tests read `kind` through it
 * to skip, in the public tree only, the cases that read a path the seed
 * excludes; `trigger`'s test setup and preflight test and `packages/config`'s
 * server test read `databaseProjectVariables` through it.
 * `hosted-deployment.test.mjs` fails if it declares a name that either
 * variant does not export, or misses one they do.
 */

/** `"private"` in the private tree's module, `"public"` in its public variant. */
export declare const kind: "private" | "public";

/** The shared databases the guard refuses without an opt-in; empty in the public variant. */
export declare const sharedDatabases: readonly {
  readonly name: string;
  readonly hostSha256: string;
  readonly databaseNameSha256: string | null;
  readonly optIn: string;
}[];

/** The production migration state's file, from the repository's root; `null` in the public variant. */
export declare const migrationState: string | null;

/** The hosted database driver's npm packages; empty in the public variant. */
export declare const hostedDriverPackages: readonly string[];

/** The variable the hosted driver reads a local proxy's address from; `null` in the public variant. */
export declare const localProxyVariable: string | null;

/** The variables naming the hosted database's project: the expected id's, production's and a Preview's. */
type DatabaseProjectVariables = {
  readonly expected: string;
  readonly production: string;
  readonly preview: string;
};

/** The hosted database's project variables; `null` in the public variant. */
export declare const databaseProjectVariables: DatabaseProjectVariables | null;

/** Prefixes of the database service's variables dropped beside `PG*` and `POSTGRES_*`; empty in the public variant. */
export declare const providerVariablePrefixes: readonly string[];

/** A pool on the hosted driver, for the journal reads of the production launcher and the preview journal command. */
type CreateHostedPool = (options: {
  readonly connectionString: string;
}) => unknown;

/** `CreateHostedPool`; it throws in the public variant. */
export declare const createHostedPool: CreateHostedPool;
