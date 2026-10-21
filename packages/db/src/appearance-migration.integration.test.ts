import { readFile } from "node:fs/promises";
import { createCoreEventSchemaRegistry } from "@requestport/domain";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "./client.js";
import {
  appearanceDensityValues,
  appearanceInitializedEventType,
  appearanceModeValues,
  appearanceThemeValues,
} from "./schema/appearance.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import type { Tx } from "./transaction.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

const migrationUrl = new URL(
  "../migrations/0014_requestport_appearance.sql",
  import.meta.url,
);
const fallbackTriple = {
  theme: "requestport",
  density: "ultra-compact",
  mode: "system",
};
const initializerActor = {
  type: "service",
  id: "requestport-appearance-default-initializer",
};

class MigrationTestRollback extends Error {}

async function migrationSql() {
  return readFile(migrationUrl, "utf8");
}

async function migrationStatements() {
  return (await migrationSql())
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new MigrationTestRollback();
    }),
  ).rejects.toBeInstanceOf(MigrationTestRollback);
}

/**
 * Drizzle wraps a driver error in a generic `Failed query: …` Error and hangs
 * the PostgreSQL error off `cause`, so a matcher against the top-level message
 * silently never sees the constraint or the guard that actually fired.
 */
async function failureChain(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;

    while (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }

    return messages.join(" | ");
  }

  return "";
}

const backfillStatement =
  /^WITH\s+"backfilled"\s+AS\s*\(\s*INSERT\s+INTO\s+"public"\."organization_appearance_defaults"/iu;

/**
 * Whether the connected database already carries `0014`.
 *
 * These cases must not be green only on a database where the migration they
 * test has never been applied. Replaying bare `CREATE TABLE`/`CREATE FUNCTION`/
 * `CREATE TRIGGER` against a migrated database raises 42P07 — and CI runs the
 * whole suite against exactly such a database, the one its own migration lane
 * just took to `0014`. So every behavioural case establishes its precondition
 * instead of assuming one: replay on a pre-cutover database, use the installed
 * objects on a migrated one.
 */
async function cutoverInstalled(tx: Tx) {
  const result = await tx.execute(sql`
    select to_regclass('public.organization_appearance_defaults') is not null
      as "installed"
  `);

  return (result.rows[0] as { installed: boolean }).installed === true;
}

/** Brings the transaction to a post-`0014` schema, replaying only if needed. */
async function ensureCutover(tx: Tx) {
  if (await cutoverInstalled(tx)) return;

  for (const statement of await migrationStatements()) {
    await tx.execute(sql.raw(statement));
  }
}

/**
 * Everything `0014` installs except its backfill, so a test can seed the
 * pre-cutover rows the backfill is supposed to find before the trigger exists.
 */
async function installCutoverWithoutBackfill(tx: Tx) {
  for (const statement of await migrationStatements()) {
    if (backfillStatement.test(statement)) return;
    await tx.execute(sql.raw(statement));
  }
}

async function runBackfill(tx: Tx) {
  const statements = await migrationStatements();
  const backfill = statements.find((statement) =>
    backfillStatement.test(statement),
  );

  expect(backfill, "0014 has no backfill statement").toBeDefined();
  await tx.execute(sql.raw(backfill ?? ""));
}

async function seedOrganization(
  tx: Tx,
  { status = "active" }: { status?: string } = {},
) {
  const organizationId = crypto.randomUUID();

  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Appearance migration tenant',
      ${`appearance-${organizationId}`}, ${status})
  `);

  return organizationId;
}

async function seedMembership(
  tx: Tx,
  organizationId: string,
  {
    role = "owner",
    status = "active",
  }: { role?: string; status?: string } = {},
) {
  const userId = `user_${crypto.randomUUID()}`;

  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);

  return userId;
}

async function readDefault(tx: Tx, organizationId: string) {
  const result = await tx.execute(sql`
    select "organization_id", "aggregate_id", "theme", "density", "mode",
      "last_updated_by_user_id", "version"
    from "organization_appearance_defaults"
    where "organization_id" = ${organizationId}
  `);

  return result.rows as Record<string, unknown>[];
}

async function readInitializationEvents(
  tx: Tx,
  organizationId: string,
  aggregateId?: unknown,
) {
  const result = await tx.execute(sql`
    select e."id", e."type", e."schema_version", e."aggregate_type",
      e."aggregate_id", e."aggregate_version", e."actor", e."correlation_id",
      e."causation_id", e."data", e."links", o."state" as "outbox_state",
      count(o."id") over () as "outbox_rows"
    from "domain_events" e
    left join "outbox" o on o."event_id" = e."id"
    where e."organization_id" = ${organizationId}
      and e."type" = 'appearance.organization_defaults_initialized.v1'
      and (${aggregateId ?? null}::uuid is null
        or e."aggregate_id" = ${aggregateId ?? null}::uuid)
  `);

  return result.rows as Record<string, unknown>[];
}

afterAll(async () => {
  await suiteStorage.close();
});

describe("0014 appearance migration SQL", () => {
  test("is generated under the exact reviewed name and appends after 0013", async () => {
    const journal = JSON.parse(
      await readFile(
        new URL("../migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };
    // Positional rather than last-in-journal: this test is about where 0014
    // sits in history, and pinning it to the end made it fail the moment a
    // later migration landed — which says nothing about the appearance
    // migration and everything about the assertion.
    const appearance = journal.entries.find(
      (entry) => entry.tag === "0014_requestport_appearance",
    );
    const previous = journal.entries.find((entry) => entry.idx === 13);

    expect(previous).toMatchObject({ idx: 13, tag: "0013_mean_hobgoblin" });
    expect(appearance).toMatchObject({ idx: 14 });
  });

  test("creates both appearance tables without touching existing data", async () => {
    const statements = await migrationStatements();

    expect(
      statements.some((statement) =>
        statement.startsWith('CREATE TABLE "user_appearance_preferences"'),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.startsWith('CREATE TABLE "organization_appearance_defaults"'),
      ),
    ).toBe(true);
    expect(await migrationSql()).not.toMatch(
      /(?:^|\n)\s*(?:DROP\s+TABLE\b|DROP\s+COLUMN\b|DELETE\s+FROM\b|TRUNCATE\b|ALTER\s+TABLE\s+"[^"]+"\s+DROP\b)/iu,
    );
  });

  test("takes the narrow membership write lock with a bounded timeout before it installs anything", async () => {
    const statements = await migrationStatements();
    const timeout = statements.findIndex((statement) =>
      /SET\s+LOCAL\s+lock_timeout/iu.test(statement),
    );
    const lock = statements.findIndex((statement) =>
      /LOCK\s+TABLE\s+"public"\."organization_members"\s+IN\s+SHARE\s+ROW\s+EXCLUSIVE\s+MODE/iu.test(
        statement,
      ),
    );
    const trigger = statements.findIndex((statement) =>
      /CREATE\s+TRIGGER\s+"requestport_initialize_organization_appearance"/iu.test(
        statement,
      ),
    );
    const backfill = statements.findIndex((statement) =>
      /^WITH\s+"backfilled"\s+AS\s*\(\s*INSERT\s+INTO\s+"public"\."organization_appearance_defaults"/iu.test(
        statement,
      ),
    );

    // Ordering relative to the *explicit* lock statement is not the property
    // that matters. `ALTER TABLE ... ADD CONSTRAINT` and `CREATE TRIGGER` take
    // SHARE ROW EXCLUSIVE on the table they name all by themselves, so any
    // statement naming a tenant table that runs before `SET LOCAL lock_timeout`
    // acquires that lock with the server default (0 — wait forever) still in
    // force. The bound must therefore precede every such statement, and the
    // membership lock must be the first statement that names the membership
    // table at all.
    const tenantTables = /"organization_members"|"organizations"/u;
    const membershipTable = /"organization_members"/u;
    const namesTenantTable = statements.flatMap((statement, index) =>
      tenantTables.test(statement) ? [index] : [],
    );
    const namesMembershipTable = statements.flatMap((statement, index) =>
      membershipTable.test(statement) ? [index] : [],
    );

    expect(timeout).toBe(0);
    expect(namesTenantTable.length).toBeGreaterThan(0);
    expect(Math.min(...namesTenantTable)).toBeGreaterThan(timeout);
    expect(namesMembershipTable.length).toBeGreaterThan(0);
    expect(Math.min(...namesMembershipTable)).toBe(lock);
    expect(trigger).toBeGreaterThan(lock);
    expect(backfill).toBeGreaterThan(trigger);

    // SHARE ROW EXCLUSIVE is the narrowest mode that conflicts with the ROW
    // EXCLUSIVE that INSERT/UPDATE/DELETE take: it waits for prior membership
    // writers and blocks later ones, while leaving plain reads and SELECT FOR
    // UPDATE alone. ACCESS EXCLUSIVE would also block readers for no reason.
    const lockStatement = statements[lock];
    expect(lockStatement).not.toMatch(/ACCESS\s+EXCLUSIVE/iu);
    expect(lockStatement).not.toMatch(/\bNOWAIT\b/iu);
  });

  test("fires the compatibility trigger only on transitions into active ownership", async () => {
    const source = await migrationSql();

    expect(source).toMatch(
      /CREATE\s+TRIGGER\s+"requestport_initialize_organization_appearance"\s+AFTER\s+INSERT\s+OR\s+UPDATE\s+ON\s+"public"\."organization_members"/u,
    );
    expect(source).toMatch(/FOR\s+EACH\s+ROW/u);
    expect(source).toMatch(
      /WHEN\s*\(\s*NEW\."role"\s*=\s*'owner'\s+AND\s+NEW\."status"\s*=\s*'active'\s*\)/u,
    );
    // AFTER timing is mandatory: the default's composite updater foreign key
    // references the very membership row being inserted or activated.
    expect(source).not.toMatch(
      /BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+"public"\."organization_members"/u,
    );
    expect(source).toMatch(
      /TG_OP\s*=\s*'UPDATE'[\s\S]{0,240}OLD\."role"\s*=\s*'owner'[\s\S]{0,80}OLD\."status"\s*=\s*'active'/u,
    );
  });

  test("lets a removed membership null the updater instead of blocking the delete", async () => {
    const source = await migrationSql();

    // A plain `no action` updater foreign key makes the recorded last updater
    // undeletable for as long as the default row names it. Membership removal
    // is an exercised path — the E2E fixture tears its scenario tenants down
    // that way — so the reference has to degrade to "unknown" instead. The
    // column list matters: a bare `ON DELETE SET NULL` would also try to null
    // the organization id, which is this table's NOT NULL primary key.
    expect(source).toMatch(
      /ADD\s+CONSTRAINT\s+"organization_appearance_defaults_updater_fk"[\s\S]*?ON\s+DELETE\s+SET\s+NULL\s*\(\s*"last_updated_by_user_id"\s*\)/u,
    );
  });

  test("derives every initialization envelope from fixed service identity and the organization UUID alone", async () => {
    const source = await migrationSql();

    expect(source).toContain(
      '{"type": "service", "id": "requestport-appearance-default-initializer"}',
    );
    // Correlation and causation may not carry an initiating user, a session, or
    // any transaction-local actor guess: only the tenant UUID.
    const derivations = [
      ...source.matchAll(/'appearance-default-init:'\s*\|\|\s*([^\n,)]+)/gu),
    ];
    expect(derivations.length).toBeGreaterThan(0);
    for (const derivation of derivations) {
      expect(derivation[1]).toMatch(/"?id"?::text|"organization_id"::text/u);
    }
    expect(source).not.toMatch(/current_setting\s*\(/iu);
    expect(source).not.toMatch(/"type"\s*:\s*"user"/u);
  });

  test("registers the initialization event for every value the check constraints allow", () => {
    const registry = createCoreEventSchemaRegistry();
    const organizationId = crypto.randomUUID();

    // The database vocabulary and the registered event schema are declared in
    // different packages. If they drift, the trigger writes a row the outbox
    // worker terminally dead-letters — so assert the whole cross-product the
    // check constraints permit, not just the fallback triple.
    for (const theme of appearanceThemeValues) {
      for (const density of appearanceDensityValues) {
        for (const mode of appearanceModeValues) {
          expect(
            registry.parse(appearanceInitializedEventType, {
              organizationId,
              theme,
              density,
              mode,
            }),
            `${theme}/${density}/${mode}`,
          ).toEqual({ organizationId, theme, density, mode });
        }
      }
    }
  });
});

describe.sequential("0014 appearance migration behaviour", () => {
  test("backfills owners, installs the trigger, and seeds exactly one version-1 envelope", {
    timeout: 60_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const installed = await cutoverInstalled(tx);
      // A membership that already exists when the migration runs must be
      // backfilled; the trigger alone would never see it.
      const backfilledId = await seedOrganization(tx);
      const backfilledOwner = await seedMembership(tx, backfilledId);
      // A valid stage-one bootstrap tenant has no membership yet and is
      // deliberately skipped rather than given an invented identity.
      const bootstrapId = await seedOrganization(tx);
      const revokedId = await seedOrganization(tx);
      await seedMembership(tx, revokedId, { status: "revoked" });
      const memberOnlyId = await seedOrganization(tx);
      await seedMembership(tx, memberOnlyId, { role: "member" });

      if (installed) {
        // On a database that already carries 0014 the installed trigger has
        // just seeded the very row the backfill is supposed to find, so drop it
        // to reproduce the pre-backfill state. Its event stays — domain_events
        // is append-only — which is why the assertions below scope events to
        // the aggregate the backfill creates rather than to the tenant.
        await tx.execute(sql`
          delete from "organization_appearance_defaults"
          where "organization_id" = any(array[${backfilledId}, ${bootstrapId},
            ${revokedId}, ${memberOnlyId}]::uuid[])
        `);
      } else {
        await installCutoverWithoutBackfill(tx);
      }

      await runBackfill(tx);

      const [backfilled] = await readDefault(tx, backfilledId);
      expect(backfilled).toMatchObject({
        ...fallbackTriple,
        last_updated_by_user_id: backfilledOwner,
        version: 1,
      });
      expect(backfilled.aggregate_id).toMatch(/^[0-9a-f-]{36}$/u);

      expect(await readDefault(tx, bootstrapId)).toEqual([]);
      expect(await readDefault(tx, revokedId)).toEqual([]);
      expect(await readDefault(tx, memberOnlyId)).toEqual([]);
      expect(await readInitializationEvents(tx, bootstrapId)).toEqual([]);
      expect(await readInitializationEvents(tx, revokedId)).toEqual([]);
      expect(await readInitializationEvents(tx, memberOnlyId)).toEqual([]);

      const backfillEvents = await readInitializationEvents(
        tx,
        backfilledId,
        backfilled.aggregate_id,
      );
      expect(backfillEvents).toHaveLength(1);
      expect(backfillEvents[0]).toMatchObject({
        schema_version: 1,
        aggregate_type: "organization_appearance",
        aggregate_id: backfilled.aggregate_id,
        aggregate_version: 1,
        actor: initializerActor,
        correlation_id: `appearance-default-init:${backfilledId}`,
        causation_id: `appearance-default-init:${backfilledId}`,
        data: { organizationId: backfilledId, ...fallbackTriple },
        links: {},
        outbox_state: "pending",
      });
      expect(backfillEvents[0].outbox_rows).toBe("1");

      // The bytes the migration actually wrote have to survive the same
      // registry trigger/src/outbox-delivery.ts runs them through. An
      // unregistered type there is a terminal dead letter, not a retry, and
      // 0014 cannot be edited afterwards to fix it.
      expect(
        createCoreEventSchemaRegistry().parse(
          String(backfillEvents[0].type),
          backfillEvents[0].data,
        ),
      ).toEqual({ organizationId: backfilledId, ...fallbackTriple });

      // Post-migration owner activation goes through the trigger instead.
      const activatedId = await seedOrganization(tx);
      const activatedOwner = await seedMembership(tx, activatedId, {
        status: "revoked",
      });
      expect(await readDefault(tx, activatedId)).toEqual([]);

      await tx.execute(sql`
          update "organization_members" set "status" = 'active'
          where "organization_id" = ${activatedId}
            and "user_id" = ${activatedOwner}
        `);

      const [activated] = await readDefault(tx, activatedId);
      expect(activated).toMatchObject({
        ...fallbackTriple,
        last_updated_by_user_id: activatedOwner,
        version: 1,
      });
      expect(await readInitializationEvents(tx, activatedId)).toHaveLength(1);

      // A redundant activation, a second owner, and a plain update must not
      // duplicate the row, the event, or the outbox entry.
      await tx.execute(sql`
          update "organization_members" set "updated_at" = now()
          where "organization_id" = ${activatedId}
        `);
      await seedMembership(tx, activatedId);

      expect(await readDefault(tx, activatedId)).toHaveLength(1);
      expect(await readInitializationEvents(tx, activatedId)).toHaveLength(1);
      expect((await readDefault(tx, activatedId))[0]).toMatchObject({
        last_updated_by_user_id: activatedOwner,
        version: 1,
      });
    });
  });

  test("enforces the locked vocabulary, positive versions, tombstones, and membership-bound updaters", {
    timeout: 60_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureCutover(tx);

      const userId = `user_${crypto.randomUUID()}`;

      await tx.execute(sql`
          insert into "signup_allowlist" ("normalized_email", "status")
          values (${`${userId}@example.invalid`}, 'active')
        `);
      await tx.execute(sql`
          insert into "user" ("id", "name", "email", "updated_at")
          values (${userId}, 'Appearance user',
            ${`${userId}@example.invalid`}, now())
        `);

      // An all-null personal row is the retained inherit tombstone, not an
      // absent row: it keeps version and aggregate identity from resetting.
      await tx.execute(sql`
          insert into "user_appearance_preferences" ("user_id")
          values (${userId})
        `);
      const stored = await tx.execute(sql`
          select "aggregate_id", "theme", "density", "mode", "version"
          from "user_appearance_preferences" where "user_id" = ${userId}
        `);
      expect(stored.rows[0]).toMatchObject({
        theme: null,
        density: null,
        mode: null,
        version: 1,
      });

      await expect(
        tx.execute(sql`
            update "user_appearance_preferences" set "version" = 0
            where "user_id" = ${userId}
          `),
      ).rejects.toThrow();
    });

    await inRollbackTransaction(async (tx) => {
      await ensureCutover(tx);
      const userId = `user_${crypto.randomUUID()}`;

      await tx.execute(sql`
          insert into "signup_allowlist" ("normalized_email", "status")
          values (${`${userId}@example.invalid`}, 'active')
        `);
      await tx.execute(sql`
          insert into "user" ("id", "name", "email", "updated_at")
          values (${userId}, 'Appearance user',
            ${`${userId}@example.invalid`}, now())
        `);

      await expect(
        tx.execute(sql`
            insert into "user_appearance_preferences" ("user_id", "theme")
            values (${userId}, 'midnight')
          `),
      ).rejects.toThrow();
    });

    await inRollbackTransaction(async (tx) => {
      await ensureCutover(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId);
      const outsider = `user_${crypto.randomUUID()}`;

      // The updater must be a membership of this very tenant.
      await expect(
        tx.execute(sql`
            update "organization_appearance_defaults"
            set "last_updated_by_user_id" = ${outsider}
            where "organization_id" = ${organizationId}
          `),
      ).rejects.toThrow();
    });
  });

  test("keeps membership removal working and leaves tenant teardown to archival", {
    timeout: 60_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      await ensureCutover(tx);
      const organizationId = await seedOrganization(tx);
      const ownerId = await seedMembership(tx, organizationId);

      expect((await readDefault(tx, organizationId))[0]).toMatchObject({
        last_updated_by_user_id: ownerId,
        version: 1,
      });

      // Deleting the membership a default records as its last updater is an
      // exercised path: apps/web/tests/fixtures/auth.ts tears scenario tenants
      // down exactly this way, and three foundation-repository races do the
      // same. 0014 must not turn it into a foreign-key violation.
      await tx.execute(sql`
        delete from "organization_members"
        where "organization_id" = ${organizationId}
      `);

      const [orphaned] = await readDefault(tx, organizationId);
      expect(orphaned).toMatchObject({
        last_updated_by_user_id: null,
        version: 1,
      });
      // Nulling the updater is not a version event: the row is unchanged as far
      // as the appearance aggregate is concerned.
      expect(orphaned.aggregate_id).toMatch(/^[0-9a-f-]{36}$/u);

      // Archival is the supported teardown and stays available.
      await tx.execute(sql`
        update "organizations" set "status" = 'archived'
        where "id" = ${organizationId}
      `);
      expect(await readDefault(tx, organizationId)).toHaveLength(1);
    });

    await inRollbackTransaction(async (tx) => {
      await ensureCutover(tx);
      const organizationId = await seedOrganization(tx);
      await seedMembership(tx, organizationId);

      // Hard-deleting the tenant is a different matter, and one 0014 cannot
      // restore: the seeded initialization event makes the pre-existing
      // append-only guard refuse the organizations cascade. Tenants that have
      // ever had an active owner are archived, never deleted — the contract
      // apps/web/tests/fixtures/auth.ts already followed and the one the
      // foundation-repository cleanups now follow too.
      expect(
        await failureChain(() =>
          tx.execute(sql`
            delete from "organizations" where "id" = ${organizationId}
          `),
        ),
      ).toMatch(/domain_events is append-only/u);
    });
  });
});
