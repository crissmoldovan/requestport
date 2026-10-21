/**
 * The public variant of `hosted-migrator.ts` (Plan 13, Track J:
 * `manifest-j.md` §2.2; J.2b, ruling 175, owner question 3).
 *
 * `release/public-tree.json`'s `substitute` rule names this file as the text
 * the public seed carries at that path in place of the private module, which
 * the seed excludes. The public tree has no hosted driver, so `migrate()`
 * (`migrate.ts`) never reaches this: it migrates a pg or a PGlite storage.
 *
 * It exports exactly the names the private module exports
 * (`scripts/export-public-tree.test.mjs`; `client.test.ts`).
 */

/** `"public"` here, `"private"` in the module this replaces; typed as either, so code that reads it type-checks in both trees. */
export const kind: "private" | "public" = "public";

/** Refuses: this tree has no hosted driver to migrate through. */
export async function migrateHosted(
  _bound: object,
  _config: { migrationsFolder: string },
): Promise<void> {
  throw new Error(
    "This build has no hosted driver: migrate() takes a pg or a PGlite storage.",
  );
}
