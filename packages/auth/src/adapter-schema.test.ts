import { readFileSync } from "node:fs";
import { getAuthTables } from "@better-auth/core/db";
import {
  runtimeSchemaCheckFor,
  SchemaMismatchError,
} from "@better-auth/core/db/internal";
import { identitySchema } from "@requestport/db";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getTableColumns } from "drizzle-orm";
import {
  getTableConfig,
  type PgTable,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";

import { createAuthOptions } from "./server-options.js";

// Better Auth names the models and columns it asks the adapter for. The Drizzle
// adapter resolves a model as `schema[modelName]` and a column as
// `table[fieldName]`, so anything it names and the schema does not export is a
// runtime failure on the first request that touches it — never a build error.
// Reading those names back out of Better Auth is the only way this test can
// fail for the right reason; a list spelled out here would just restate the
// schema it is meant to check.
const options = createAuthOptions({
  database: {} as never,
  env: {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "a".repeat(32),
    BETTER_AUTH_URL: "https://requestport.com",
  },
  assertSignupAllowed: async () => ({ allowed: true }),
  sendMagicLink: async () => undefined,
});
const authTables = getAuthTables(options);

const schema = identitySchema as unknown as Record<
  string,
  Record<string, unknown> | undefined
>;

function unresolvable() {
  const failures: string[] = [];
  for (const [model, table] of Object.entries(authTables)) {
    const modelName = table.modelName ?? model;
    const drizzleTable = schema[modelName];
    if (!drizzleTable) {
      failures.push(`${modelName}: no such export in identitySchema`);
      continue;
    }
    for (const [field, attributes] of Object.entries(table.fields)) {
      const column = attributes.fieldName ?? field;
      if (!(column in drizzleTable)) {
        failures.push(`${modelName}.${column}: no such column`);
      }
    }
  }
  return failures;
}

describe("the Drizzle schema handed to Better Auth", () => {
  test("exports every model and column Better Auth will ask the adapter for", () => {
    expect(unresolvable()).toEqual([]);
  });

  test("exports nothing Better Auth does not ask for", () => {
    expect(Object.keys(schema).toSorted()).toEqual(
      Object.entries(authTables)
        .map(([model, table]) => table.modelName ?? model)
        .toSorted(),
    );
  });
});

const migrations = new URL("../../db/migrations/", import.meta.url);

function snapshotColumns(tag: string) {
  const snapshot = JSON.parse(
    readFileSync(
      new URL(`meta/${tag.slice(0, 4)}_snapshot.json`, migrations),
      "utf8",
    ),
  ) as { tables: Record<string, { columns: Record<string, unknown> }> };
  return snapshot.tables;
}

/**
 * K.2's projection, rebuilt: each table cut to the columns the migration head
 * before the expand holds. That is what Better Auth 1.6.29 was handed while
 * 0017 waited for production.
 */
function preExpandProjection() {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrations), "utf8"),
  ) as { entries: { tag: string }[] };
  const expand = journal.entries.findIndex(
    (entry) => "public.oauth_resource" in snapshotColumns(entry.tag),
  );
  const previous = journal.entries[expand - 1];
  if (expand < 1 || !previous) throw new Error("no expand in the journal");
  const before = snapshotColumns(previous.tag);
  const projected: Record<string, PgTable> = {};
  for (const [model, table] of Object.entries(identitySchema)) {
    const name = getTableConfig(table).name;
    const held = before[`public.${name}`];
    if (!held) continue;
    projected[model] = pgTable(
      name,
      Object.fromEntries(
        Object.entries(getTableColumns(table))
          .filter(([, column]) => column.name in held.columns)
          .map(([key, column]) => [
            key,
            column.notNull ? text(column.name).notNull() : text(column.name),
          ]),
      ),
    );
  }
  return projected;
}

/**
 * The check Better Auth 1.7 runs when an instance initialises
 * (`advanced.database.validateSchema`, on by default since 1.7.3), taken from
 * the Drizzle adapter it is registered on. It compares the Drizzle schema with
 * the tables this composition writes and needs no database.
 */
function schemaCheck(schema: Record<string, unknown>) {
  const adapter = drizzleAdapter({} as never, { provider: "pg", schema })(
    options,
  );
  const check = runtimeSchemaCheckFor(adapter);
  if (!check) throw new Error("the composition does not validate its schema");
  return check;
}

describe("Better Auth 1.7.6's own schema check", () => {
  test("is on for this composition and passes over the full tables", async () => {
    expect(options.advanced).not.toHaveProperty("database.validateSchema");
    await expect(
      Promise.resolve(schemaCheck(identitySchema)()),
    ).resolves.toBeUndefined();
  });

  test("fires over K.2's pre-expand projection", async () => {
    const projection = { ...identitySchema, ...preExpandProjection() };
    expect(Object.keys(preExpandProjection()).toSorted()).toEqual([
      "account",
      "apikey",
      "jwks",
      "oauthAccessToken",
      "oauthClient",
      "oauthConsent",
      "oauthRefreshToken",
      "session",
      "user",
      "verification",
    ]);

    const failure = await Promise.resolve(schemaCheck(projection)()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SchemaMismatchError);
    expect(String((failure as Error).message)).toMatch(
      /client_discovery_id|clientDiscoveryId/u,
    );
  });
});
