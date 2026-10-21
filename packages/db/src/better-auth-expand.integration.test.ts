import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "./client.js";
import { identitySchema, oauthClients } from "./schema/index.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import type { Tx } from "./transaction.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/**
 * The Better Auth 1.7 expand (plan 13, K.2), applied the way production will
 * meet it: to a database at the previous head that holds the rows the driver's
 * read-only production read found on 2026-09-28 (`r9-rulings.md`, ruling 24).
 *
 * Every case runs in one transaction that is rolled back, and replays the
 * expand into a schema made for that case rather than into `public`. Other
 * workspaces' suites run Better Auth's flows against the same database at the
 * same time (packages/db/vitest.config.ts says why they are unordered), and
 * they take ROW EXCLUSIVE on these tables; the DDL of an expand run in
 * `public` takes ACCESS EXCLUSIVE on the same tables, and on 2026-09-28 three
 * of six runs beside the auth suites died with `deadlock detected` (40P01).
 *
 * So the five tables the expand changes are copied into the scratch schema
 * with `CREATE TABLE ... (LIKE ... INCLUDING ALL)`, which takes ACCESS SHARE on
 * its source, and whatever the expand adds is dropped from the copies — from
 * the copies only — and whatever a later contract dropped from the tables
 * (0022, K.4: `oauth_client`'s `public` and `type`) is added back to them.
 * That leaves the previous head whether the database has applied the expand
 * or the contract or not, and the case then checks it against the previous
 * head's snapshot, column for column, so "the previous head" is a measured
 * precondition rather than an assumption. Nothing is written to `public`, and
 * each case ends by asserting that it holds no lock there stronger than
 * ACCESS SHARE.
 */

const migrations = new URL("../migrations/", import.meta.url);
const expandSuffix = "_better_auth_1_7_expand";
const breakpoint = "--> statement-breakpoint";

class ExpandTestRollback extends Error {}

type Journal = { entries: { tag: string }[] };
type SnapshotColumn = { name: string; type: string; notNull: boolean };
type Snapshot = {
  tables: Record<
    string,
    { name: string; columns: Record<string, SnapshotColumn> }
  >;
};

async function journal(): Promise<Journal> {
  return JSON.parse(
    await readFile(new URL("meta/_journal.json", migrations), "utf8"),
  );
}

async function expandTag() {
  const tag = (await journal()).entries.find((entry) =>
    entry.tag.endsWith(expandSuffix),
  )?.tag;
  if (!tag) throw new Error("the expand migration is not in the journal");
  return tag;
}

async function statements() {
  return (
    await readFile(new URL(`${await expandTag()}.sql`, migrations), "utf8")
  )
    .split(breakpoint)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * The expand's statements, aimed at `schema`. They name their tables without
 * a schema, which the case's `search_path` resolves; only the foreign keys
 * qualify theirs, as `"public".`, and those are rewritten. A statement that
 * still mentions `public` afterwards would run DDL there, so it stops the case
 * instead.
 */
async function statementsFor(schema: string) {
  return (await statements()).map((statement) => {
    const aimed = statement.replaceAll('"public".', `"${schema}".`);
    if (/\bpublic\b/iu.test(aimed.replace(/^--[^\n]*$/gmu, ""))) {
      throw new Error(`the expand statement names public: ${statement}`);
    }
    return aimed;
  });
}

/** The data statements: everything the expand does that is not DDL. */
async function backfillStatements() {
  return (await statements()).filter((statement) =>
    /^(?:--[^\n]*\n\s*)*UPDATE\b/iu.test(statement),
  );
}

async function previousHead(): Promise<Snapshot> {
  const { entries } = await journal();
  const index = entries.findIndex((entry) => entry.tag.endsWith(expandSuffix));
  const previous = entries[index - 1];
  if (!previous) throw new Error("the expand has no previous head");
  return JSON.parse(
    await readFile(
      new URL(`meta/${previous.tag.slice(0, 4)}_snapshot.json`, migrations),
      "utf8",
    ),
  );
}

async function inRollbackTransaction(
  run: (tx: Tx, schema: string) => Promise<void>,
) {
  const schema = `k2_expand_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await suiteStorage.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schema}", public`));
      await run(tx, schema);
      throw new ExpandTestRollback();
    });
  } catch (error) {
    // Anything but the deliberate rollback is rethrown, so a failed
    // expectation reports itself.
    if (error instanceof ExpandTestRollback) return;
    throw error;
  }
  throw new Error("Expected the expand transaction to roll back");
}

/**
 * Drizzle wraps a driver error and hangs the PostgreSQL one off `cause`, so
 * the SQLSTATE is read down the chain.
 */
async function sqlState(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = (current as { cause?: unknown }).cause;
    }
    return "no SQLSTATE";
  }
  return "no error";
}

const createdTable = /^CREATE TABLE "([a-z_]+)"/u;
const addedColumn = /^ALTER TABLE "([a-z_]+)" ADD COLUMN "([a-z_]+)"/u;

/**
 * Builds the previous head in `schema`: a copy of each table the expand
 * changes, less whatever the expand adds to it, plus whatever the previous
 * head's snapshot holds that the table no longer does.
 *
 * Derived from the migration file rather than written out, so a column added
 * to the expand is left out without anyone remembering to. The expand only
 * adds, so a copy without what it adds is the previous head, once the columns
 * a later contract dropped (0022's two) are back — which `expectPreviousHead`
 * then checks. The tables it creates are not copied, and every DROP and ADD
 * here lands on the copies.
 */
async function toPreviousHead(tx: Tx, schema: string) {
  const expand = await statements();
  const altered = new Set(
    expand.flatMap((statement) => addedColumn.exec(statement)?.[1] ?? []),
  );
  for (const table of altered) {
    await tx.execute(
      sql.raw(
        `CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`,
      ),
    );
  }
  for (const statement of expand) {
    const column = addedColumn.exec(statement);
    if (column) {
      await tx.execute(
        sql.raw(
          `ALTER TABLE "${schema}"."${column[1]}" DROP COLUMN IF EXISTS "${column[2]}"`,
        ),
      );
    }
  }
  // Put back, with the snapshot's type and nullability, each column the
  // previous head holds that the copy lacks.
  const head = await previousHead();
  for (const table of altered) {
    const present = new Set(await columnsOf(tx, table));
    for (const column of Object.values(
      head.tables[`public.${table}`]?.columns ?? {},
    )) {
      if (present.has(column.name)) continue;
      await tx.execute(
        sql.raw(
          `ALTER TABLE "${schema}"."${table}" ADD COLUMN "${column.name}" ${column.type}${column.notNull ? " NOT NULL" : ""}`,
        ),
      );
    }
  }
}

async function columnsOf(tx: Tx, table: string) {
  const found = await tx.execute(sql`
    select "column_name" from "information_schema"."columns"
    where "table_schema" = current_schema() and "table_name" = ${table}
  `);
  return (found.rows as { column_name: string }[])
    .map((row) => row.column_name)
    .toSorted();
}

const changedTables = [
  "jwks",
  "oauth_client",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
];
const newTables = [
  "oauth_resource",
  "oauth_client_resource",
  "oauth_client_assertion",
];

async function expectPreviousHead(tx: Tx) {
  const head = await previousHead();
  // Every table the expand changes is copied, so a table missing from this
  // list is a copy never compared.
  expect(
    [
      ...new Set(
        (await statements()).flatMap(
          (statement) => addedColumn.exec(statement)?.[1] ?? [],
        ),
      ),
    ].toSorted(),
  ).toEqual(changedTables.toSorted());
  expect(
    (await statements())
      .flatMap((statement) => createdTable.exec(statement)?.[1] ?? [])
      .toSorted(),
  ).toEqual(newTables.toSorted());
  for (const table of changedTables) {
    expect(await columnsOf(tx, table), table).toEqual(
      Object.keys(head.tables[`public.${table}`]?.columns ?? {}).toSorted(),
    );
  }
  for (const table of newTables) {
    expect(await columnsOf(tx, table), table).toEqual([]);
  }
}

/**
 * Other workspaces' suites run Better Auth's flows against this database at
 * the same time, taking ROW EXCLUSIVE on these tables. A stronger lock held
 * here on a table in `public` is what turned the two into `deadlock detected`.
 */
async function expectNoStrongLockInPublic(tx: Tx) {
  const held = await tx.execute(sql`
    select c."relname" as "relation", l."mode" as "mode"
    from "pg_locks" l
    join "pg_class" c on c."oid" = l."relation"
    join "pg_namespace" n on n."oid" = c."relnamespace"
    where l."pid" = pg_backend_pid() and n."nspname" = 'public'
      and l."mode" <> 'AccessShareLock'
    order by 1, 2
  `);
  expect(held.rows).toEqual([]);
}

async function applyExpand(tx: Tx, schema: string) {
  for (const statement of await statementsFor(schema)) {
    await tx.execute(sql.raw(statement));
  }
}

const loopback = sql`array['http://127.0.0.1:41234/callback']`;
const codeAndRefresh = sql`array['authorization_code', 'refresh_token']`;

/**
 * Production as read on 2026-09-28: two public clients, `type` NULL, method
 * `none`, both grants, one of them disabled; four refresh tokens, one live and
 * carrying `offline_access`. Plus one `web` and one `native` client, which
 * production does not hold, so that the `type` backfill is seen to act.
 */
async function seedProductionShape(tx: Tx) {
  // The copies carry no foreign keys, so the token's user need not exist, and
  // nothing is written to `public`.
  const userId = `user_${crypto.randomUUID()}`;
  const client = (label: string) => `client_${label}_${crypto.randomUUID()}`;
  const clients = {
    enabled: client("enabled"),
    disabled: client("disabled"),
    web: client("web"),
    native: client("native"),
  };
  for (const [label, clientId] of Object.entries(clients)) {
    await tx.execute(sql`
      insert into "oauth_client"
        ("id", "client_id", "redirect_uris", "disabled", "public",
         "token_endpoint_auth_method", "grant_types", "type")
      values (${clientId}, ${clientId}, ${loopback}, ${label === "disabled"},
        true, 'none', ${codeAndRefresh},
        ${label === "web" || label === "native" ? label : null})
    `);
  }
  const refreshTokens = {
    live: `refresh_live_${crypto.randomUUID()}`,
    revoked: `refresh_revoked_${crypto.randomUUID()}`,
    expired: `refresh_expired_${crypto.randomUUID()}`,
    revokedAndExpired: `refresh_both_${crypto.randomUUID()}`,
  };
  for (const [state, id] of Object.entries(refreshTokens)) {
    await tx.execute(sql`
      insert into "oauth_refresh_token"
        ("id", "token", "client_id", "user_id", "expires_at", "created_at",
         "revoked", "scopes")
      values (${id}, ${`token_${id}`}, ${clients.enabled}, ${userId},
        ${state === "expired" || state === "revokedAndExpired" ? sql`now() - interval '1 day'` : sql`now() + interval '29 days'`},
        now() - interval '1 day',
        ${state === "revoked" || state === "revokedAndExpired" ? sql`now()` : sql`null`},
        ${state === "live" ? sql`array['openid', 'offline_access', 'request:read']` : sql`array['openid', 'request:read']`})
    `);
  }
  return { clients, refreshTokens };
}

async function rowsOf(tx: Tx, table: string, ids: string[]) {
  const found = await tx.execute(sql`
    select to_jsonb(t) as "row" from ${sql.identifier(table)} t
    where t."id" in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    order by t."id"
  `);
  return (found.rows as { row: Record<string, unknown> }[]).map(
    (entry) => entry.row,
  );
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("the Better Auth 1.7 expand", () => {
  test("applies over production's rows and backfills only what it should", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx, schema) => {
      await toPreviousHead(tx, schema);
      await expectPreviousHead(tx);
      const { clients, refreshTokens } = await seedProductionShape(tx);
      const refreshIds = Object.values(refreshTokens);
      const refreshBefore = await rowsOf(tx, "oauth_refresh_token", refreshIds);

      await applyExpand(tx, schema);

      const applied = await tx
        .select({
          clientId: oauthClients.clientId,
          applicationType: oauthClients.applicationType,
          clientCredentialsScopes: oauthClients.clientCredentialsScopes,
        })
        .from(oauthClients)
        .where(inArray(oauthClients.clientId, Object.values(clients)));
      const byId = new Map(applied.map((row) => [row.clientId, row]));
      expect(byId.get(clients.enabled)?.applicationType).toBeNull();
      expect(byId.get(clients.disabled)?.applicationType).toBeNull();
      expect(byId.get(clients.web)?.applicationType).toBe("web");
      expect(byId.get(clients.native)?.applicationType).toBe("native");
      for (const row of applied) {
        expect(row.clientCredentialsScopes, row.clientId).toEqual([]);
      }

      // Nothing is backfilled on refresh tokens: the live one keeps `resources`
      // NULL, which 1.7.6 reads as "no narrowing check".
      const refreshAfter = await rowsOf(tx, "oauth_refresh_token", refreshIds);
      expect(refreshAfter).toHaveLength(4);
      for (const [index, row] of refreshAfter.entries()) {
        const {
          authorization_code_id,
          resources,
          requested_user_info_claims,
          rotated_at,
          rotation_replay_response,
          rotation_replay_expires_at,
          confirmation,
          ...unchanged
        } = row;
        expect(unchanged).toEqual(refreshBefore[index]);
        expect({
          authorization_code_id,
          resources,
          requested_user_info_claims,
          rotated_at,
          rotation_replay_response,
          rotation_replay_expires_at,
          confirmation,
        }).toEqual({
          authorization_code_id: null,
          resources: null,
          requested_user_info_claims: null,
          rotated_at: null,
          rotation_replay_response: null,
          rotation_replay_expires_at: null,
          confirmation: null,
        });
      }

      // The launcher applies twice and requires the second pass to change
      // nothing, and a client registered between the apply and K.3 is caught
      // by running the backfill again. Either way, a second run is a no-op.
      const clientIds = Object.values(clients);
      const clientsOnce = await rowsOf(tx, "oauth_client", clientIds);
      const backfill = await backfillStatements();
      expect(backfill.length).toBeGreaterThan(0);
      for (const statement of backfill) {
        await tx.execute(sql.raw(statement));
      }
      expect(await rowsOf(tx, "oauth_client", clientIds)).toEqual(clientsOnce);
      expect(await rowsOf(tx, "oauth_refresh_token", refreshIds)).toEqual(
        refreshAfter,
      );
      await expectNoStrongLockInPublic(tx);
    });
  });

  test("gives Better Auth 1.7.6's tables the columns they read, and only after the expand (R2)", {
    timeout: 120_000,
  }, async () => {
    await inRollbackTransaction(async (tx, schema) => {
      await toPreviousHead(tx, schema);
      await expectPreviousHead(tx);
      // What `identitySchema` hands Better Auth 1.7.6 since K.3: the full
      // table, whose adapter reads and inserts with `returning` every column
      // it declares.
      const handed = identitySchema.oauthClient;
      expect(handed).toBe(oauthClients);
      const register = (clientId: string) =>
        tx
          .insert(handed)
          .values({
            id: clientId,
            clientId,
            redirectUris: ["http://127.0.0.1:41234/callback"],
            tokenEndpointAuthMethod: "none",
          })
          .returning();

      // Before the expand, the same write fails with 42703: this is why K.3's
      // code may run only once production holds 0017.
      const before = `client_before_${crypto.randomUUID()}`;
      expect(
        await sqlState(() =>
          tx.transaction((savepoint) =>
            savepoint
              .insert(handed)
              .values({
                id: before,
                clientId: before,
                redirectUris: ["http://127.0.0.1:41234/callback"],
              })
              .returning(),
          ),
        ),
      ).toBe("42703");

      await applyExpand(tx, schema);

      // After it, the full table reads and writes, and a client written
      // without 1.7's columns takes their defaults, which is what 1.7.6 reads.
      const after = `client_after_${crypto.randomUUID()}`;
      await expect(register(after)).resolves.toHaveLength(1);
      const [full] = await tx
        .select()
        .from(handed)
        .where(eq(handed.clientId, after));
      expect(full).toMatchObject({
        clientCredentialsScopes: [],
        dpopBoundAccessTokens: false,
        applicationType: null,
        clientDiscoveryId: null,
      });
      await expectNoStrongLockInPublic(tx);
    });
  });
});
