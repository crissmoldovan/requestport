/**
 * The public variant of `shared-databases.ts` (Plan 13, Track J:
 * `manifest-j.md` §2.2 and §2.4 item 2; ruling 91, option (d)).
 *
 * `release/public-tree.json`'s `substitute` rule names this file as the text
 * the public seed carries at that path in place of the private module, which
 * the seed excludes. It names no shared database, so in the seed the pg path's
 * refusal (`refuseUnapprovedSharedPgDatabase` in `database-url.ts`) compares
 * against an empty list and refuses nothing (owner question 15).
 *
 * It exports exactly the names the private module exports
 * (`scripts/export-public-tree.test.mjs`), and
 * `scripts/workspace-contract.test.mjs` pins it to `kind: "public"` with no
 * entry.
 */
export interface SharedDatabase {
  readonly name: string;
  readonly hostSha256: string;
  readonly databaseNameSha256: string | null;
  readonly optIn: string;
}

/** `"public"` here, `"private"` in the module this replaces; typed as either, so code that reads it type-checks in both trees. */
export const kind: "private" | "public" = "public";

export const entries: readonly SharedDatabase[] = Object.freeze([]);
