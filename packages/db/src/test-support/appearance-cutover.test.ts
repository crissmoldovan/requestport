import { describe, expect, test } from "vitest";

import {
  appearanceCutoverSharedLocks,
  isIsolatedAppearanceTableStatement,
  isolatedAppearanceSharedLocks,
  isolatedAppearanceStatementNames,
  isolatedAppearanceTableStatements,
  migrationStatements,
  sharedLockStatements,
  sharedTablesNamedBy,
} from "./appearance-cutover.js";

describe("isolated appearance table statements", () => {
  test("names every appearance object 0014 creates", () => {
    // The tenant-bound updater foreign key is the one appearance statement
    // `0014` introduces under an explanatory comment block, and it is the
    // constraint that binds "last_updated_by_user_id" to a membership of the
    // same tenant. A fixture without it cannot catch a regression in that
    // binding, so the expectation names it explicitly.
    expect(isolatedAppearanceStatementNames).toContain(
      '"organization_appearance_defaults_updater_fk"',
    );
    expect(isolatedAppearanceStatementNames).toContain(
      'CREATE TABLE "organization_appearance_defaults"',
    );
    expect(isolatedAppearanceStatementNames).toContain(
      'CREATE TABLE "user_appearance_preferences"',
    );
  });

  test("reproduces the whole checked-in appearance schema in order", async () => {
    const statements = await isolatedAppearanceTableStatements();

    expect(statements).toHaveLength(isolatedAppearanceStatementNames.length);
    for (const [index, name] of isolatedAppearanceStatementNames.entries()) {
      expect(statements[index]).toContain(name);
    }
  });

  test("excludes everything the shared schema owns", async () => {
    for (const statement of await isolatedAppearanceTableStatements()) {
      expect(statement).not.toMatch(/CREATE\s+(?:TRIGGER|FUNCTION)/iu);
      expect(statement).not.toMatch(/^\s*(?:LOCK|SET|WITH|INSERT)\b/iu);
    }
  });

  test("classifies a statement by its SQL, not by its leading comment", () => {
    // `0014` comments its statements heavily. Anchoring the classifier on the
    // raw chunk makes it comment-sensitive: an explanation added above a
    // `CREATE TABLE` would silently drop that table from the isolated schema,
    // and the fixture would resolve it back to `public` through the trailing
    // search_path entry while still reporting green.
    expect(
      isIsolatedAppearanceTableStatement(
        "-- Why this table exists.\n-- A second comment line.\n" +
          'CREATE TABLE "user_appearance_preferences" ("user_id" text)',
      ),
    ).toBe(true);
    expect(
      isIsolatedAppearanceTableStatement(
        'CREATE TABLE "user_appearance_preferences" ("user_id" text)',
      ),
    ).toBe(true);
    expect(
      isIsolatedAppearanceTableStatement(
        '-- Owned by public.\nCREATE TRIGGER "t" AFTER INSERT ON ' +
          '"public"."organization_members" FOR EACH ROW EXECUTE FUNCTION "f"()',
      ),
    ).toBe(false);
  });
});

describe("shared-table locks taken up front", () => {
  test("the isolated statements reach exactly the three foreign-key targets", async () => {
    expect(
      isolatedAppearanceSharedLocks(await isolatedAppearanceTableStatements()),
    ).toEqual([
      {
        schema: "public",
        table: "organizations",
        mode: "SHARE ROW EXCLUSIVE",
      },
      {
        schema: "public",
        table: "organization_members",
        mode: "SHARE ROW EXCLUSIVE",
      },
      { schema: "public", table: "user", mode: "SHARE ROW EXCLUSIVE" },
    ]);
  });

  test("an isolated statement that reaches a shared table another way is refused", () => {
    // Unqualified, the trailing `public` on the search_path would resolve it.
    expect(() =>
      isolatedAppearanceSharedLocks([
        'ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "fk" ' +
          'FOREIGN KEY ("user_id") REFERENCES "user"("id")',
      ]),
    ).toThrow(/reaches outside/u);
    // Unquoted, qualified or not, it matches no quoted target and is refused.
    for (const target of ["organizations(id)", "public.user(id)"]) {
      expect(() =>
        isolatedAppearanceSharedLocks([
          'ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "fk" ' +
            `FOREIGN KEY ("user_id") REFERENCES ${target}`,
        ]),
      ).toThrow(/reaches outside/u);
    }
    expect(() =>
      isolatedAppearanceSharedLocks([
        'CREATE INDEX "i" ON "public"."user" USING btree ("id")',
      ]),
    ).toThrow(/reaches outside/u);
  });

  test("0014's replay names the five shared tables its declared locks cover", async () => {
    const statements = await migrationStatements();

    expect(sharedTablesNamedBy(statements)).toEqual([
      "domain_events",
      "organization_members",
      "organizations",
      "outbox",
      "user",
    ]);
    expect(
      sharedLockStatements(appearanceCutoverSharedLocks(statements)),
    ).toEqual([
      'lock table "public"."domain_events", "public"."outbox" in ROW EXCLUSIVE mode nowait',
      'lock table "public"."organization_members", "public"."organizations", "public"."user" in SHARE ROW EXCLUSIVE mode nowait',
    ]);
  });

  test("a replay that names a shared table with no declared lock is refused", async () => {
    const statements = [
      ...(await migrationStatements()),
      'INSERT INTO "public"."projects" ("id") VALUES (gen_random_uuid())',
    ];

    expect(() => appearanceCutoverSharedLocks(statements)).toThrow(
      /declares locks for/u,
    );
  });
});
