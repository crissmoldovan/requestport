import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  account,
  apiKeys,
  identitySchema,
  jwks,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  session,
  user,
  verification,
} from "./identity.js";
import * as barrel from "./index.js";
import { invitations } from "./organizations.js";

describe("Better Auth identity schema", () => {
  test("keys every table by the model name Better Auth asks the adapter for", () => {
    // The keys, not the tables, are the contract: the Drizzle adapter resolves
    // a model as `schema[modelName]`, and Better Auth's plugin model names are
    // singular where these Drizzle exports are plural. Getting one wrong is a
    // 500 on the first request that touches the model and nothing earlier.
    //
    // This case can only show the mapping is deliberate. Whether it is *right*
    // is decided against Better Auth's own model list, which lives in
    // `packages/auth/src/adapter-schema.test.ts` — this package cannot see it.
    //
    // Each value is the exported table itself, by identity: the adapter must
    // see the columns 0017 added, and I.1's sweep recognises Better Auth's
    // tables by identity among the schema's exports.
    const expected = {
      user,
      session,
      account,
      verification,
      jwks,
      apikey: apiKeys,
      oauthClient: oauthClients,
      oauthRefreshToken: oauthRefreshTokens,
      oauthAccessToken: oauthAccessTokens,
      oauthConsent: oauthConsents,
      oauthResource: oauthResources,
      oauthClientResource: oauthClientResources,
      oauthClientAssertion: oauthClientAssertions,
    };
    expect(Object.keys(identitySchema).toSorted()).toEqual(
      Object.keys(expected).toSorted(),
    );
    for (const [model, table] of Object.entries(expected)) {
      expect(identitySchema[model as keyof typeof identitySchema]).toBe(table);
    }
  });

  test("uses case-insensitive email equality and uniqueness for adapter-safe lookup", () => {
    const config = getTableConfig(user);
    const email = config.columns.find((column) => column.name === "email");

    expect(email?.getSQLType()).toBe("citext");
    expect(email?.isUnique).toBe(true);
  });

  test("indexes identity foreign keys and verification lookup with snake-case names", () => {
    expect(
      getTableConfig(session).indexes.map((entry) => entry.config.name),
    ).toEqual(["session_user_id_idx"]);
    expect(
      getTableConfig(account).indexes.map((entry) => entry.config.name),
    ).toEqual(["account_user_id_idx", "account_provider_account_unique"]);
    expect(
      getTableConfig(verification).indexes.map((entry) => entry.config.name),
    ).toEqual(["verification_identifier_idx"]);
  });

  test("uses timezone-aware timestamps for every auth instant", () => {
    for (const table of [user, session, account, verification]) {
      const timestampColumns = getTableConfig(table).columns.filter(
        (column) => column.dataType === "date",
      );
      expect(timestampColumns.length).toBeGreaterThan(0);
      expect(timestampColumns.map((column) => column.getSQLType())).toEqual(
        timestampColumns.map(() => "timestamp with time zone"),
      );
    }
  });

  test("indexes the normalized invitation-email eligibility lookup", () => {
    expect(
      getTableConfig(invitations).indexes.map((entry) => entry.config.name),
    ).toContain("invitations_normalized_email_ci_idx");
  });
});

type SnapshotColumn = { name: string; type: string; notNull: boolean };
type Snapshot = {
  tables: Record<string, { columns: Record<string, SnapshotColumn> }>;
};

const migrations = new URL("../../migrations/", import.meta.url);

function snapshotOf(tag: string): Snapshot {
  return JSON.parse(
    readFileSync(
      new URL(`meta/${tag.slice(0, 4)}_snapshot.json`, migrations),
      "utf8",
    ),
  );
}

/**
 * The migration head: the schema a database migrated from this tree holds.
 */
function head() {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrations), "utf8"),
  ) as { entries: { tag: string }[] };
  const last = journal.entries.at(-1);
  if (!last) throw new Error("the migration journal has no head");
  return { tag: last.tag, snapshot: snapshotOf(last.tag) };
}

/**
 * Every column these tables declare that the snapshot does not hold as
 * declared — absent, or present with another type or nullability.
 *
 * Better Auth's Drizzle adapter names every column a table declares in each
 * read and write, so a single declared column the database lacks fails every
 * read of that model.
 */
function undeclaredIn(snapshot: Snapshot, tables: Iterable<PgTable>) {
  const found: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const recorded =
      snapshot.tables[`${config.schema ?? "public"}.${config.name}`];
    for (const column of config.columns) {
      const expected = recorded?.columns[column.name];
      if (
        !expected ||
        expected.type !== column.getSQLType() ||
        expected.notNull !== column.notNull
      ) {
        found.push(`${config.name}.${column.name}`);
      }
    }
  }
  return found.toSorted();
}

const exportedTables = Object.values(barrel).filter((value) =>
  is(value, PgTable),
) as PgTable[];

describe("what Better Auth is handed", () => {
  test("declares no column the migration head lacks", () => {
    const { snapshot } = head();

    expect(undeclaredIn(snapshot, Object.values(identitySchema))).toEqual([]);
  });

  test("notices a table that declares one column too many", () => {
    // The check above can only pass for the right reason if it can fail: a
    // table carrying one column the head lacks must be named.
    const { snapshot } = head();
    const widened = pgTable("oauth_client", {
      id: text("id").primaryKey(),
      notInAnyMigration: text("not_in_any_migration"),
    });

    expect(undeclaredIn(snapshot, [widened])).toEqual([
      "oauth_client.not_in_any_migration",
    ]);
  });

  test("hands over only global tables the schema exports, by identity", () => {
    // I.1's sweep ("gives Better Auth's adapter no tenant table") matches
    // `identitySchema`'s values against the barrel's exports by identity, so
    // a value that is not itself an export — a projection, a copy — is a
    // table the sweep cannot see. Every value must be one, and none may be a
    // tenant table.
    const exported = new Set<unknown>(exportedTables);
    const failures: string[] = [];
    for (const [model, table] of Object.entries(identitySchema)) {
      const name = getTableConfig(table).name;
      if (!exported.has(table)) {
        failures.push(`${model}: ${name} is not an exported table object`);
      }
      if (
        getTableConfig(table).columns.some(
          (column) => column.name === "organization_id",
        )
      ) {
        failures.push(`${model}: ${name} is a tenant table`);
      }
    }

    expect(Object.keys(identitySchema)).toHaveLength(13);
    expect(failures).toEqual([]);
  });

  test("notices a value that is not the exported table", () => {
    // The identity check above fails for a second table object carrying the
    // same SQL name, which is what K.2's projections were.
    const exported = new Set<unknown>(exportedTables);
    const copy = pgTable("oauth_client", { id: text("id").primaryKey() });

    expect(exported.has(oauthClients)).toBe(true);
    expect(exported.has(copy)).toBe(false);
  });
});
