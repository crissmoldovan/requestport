import type { E2EScenarioDefinition } from "../test/e2e-scenarios.js";
import {
  type E2EScenarioRun,
  type E2EScenarioTable,
  e2eScenarioFailures,
  e2eScenarioTables,
} from "./e2e-scenario.js";

/**
 * The executor that turns the closed catalogue's row-creating cases into real
 * rows, and the deleter that removes them again.
 *
 * `createScenarioRouteHandlers` takes both as ports, and their checked-in
 * defaults refuse to do anything at all: a scenario that quietly created
 * nothing is the one failure mode a seeded browser case must never have, so an
 * unwired hook answers with a fixed failure instead of a namespace. This module
 * is the wiring. It is written against one SQL port rather than against the
 * repositories so the plans can be proven statement by statement — which rows,
 * in which order, recorded when — without a database standing in for the
 * argument.
 *
 * Three properties are structural rather than conventional:
 *
 * - **every value travels as a parameter.** Nothing a case carries is
 *   interpolated into SQL, because a scenario hook that composed a statement
 *   out of its input would be the general-purpose primitive the guard exists to
 *   prevent, whatever the guard said;
 * - **a row is recorded immediately after the statement that created it.**
 *   Recording up front would leave the ledger asking for a delete of a row the
 *   database never received; recording at the end would strand every row a
 *   half-way failure had already written. Both are the same defect from
 *   opposite sides, and the `finally` that cleans up cannot fix either;
 * - **no driver error escapes.** A rejected insert carries the connection, the
 *   identifiers, and the row values that caused it, and this module is invoked
 *   from a route whose answers reach CI logs and screenshots. Every catch
 *   replaces what it caught with the lifecycle's own fixed vocabulary.
 */

/** One parameterised statement. The text is fixed; every value is bound. */
export type E2EScenarioStatement = Readonly<{
  text: string;
  values: readonly unknown[];
}>;

export type E2EScenarioSqlExecutor = (
  statement: E2EScenarioStatement,
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Who the guarded request is, as far as a tenant-scoped case needs to know.
 *
 * A case that seeds project data has to put it in the tenant the browser is
 * looking at, or the surface under test shows someone else's empty state and
 * the case proves nothing. The identity comes from the request's own session
 * rather than from anything the caller sent, so a scenario cannot name a tenant
 * it is not already inside.
 */
export type E2EScenarioViewer = Readonly<{
  organizationId: string;
  userId: string;
}>;

export type E2EScenarioSeedPorts = Readonly<{
  execute: E2EScenarioSqlExecutor;
  readViewer: (request: Request) => Promise<E2EScenarioViewer | null>;
  /** Overridable only so a test can pin the identifiers a plan generates. */
  createId?: () => string;
}>;

export type E2EScenarioSeedInput = Readonly<{
  definition: E2EScenarioDefinition;
  request: Request;
  run: E2EScenarioRun;
}>;

/**
 * The column that addresses one row of each table in the cleanup order.
 *
 * Two of these tables are keyed by the entity they belong to rather than by a
 * surrogate — an organization has exactly one appearance default and a user has
 * exactly one preference row — so "the id" is not one column name across the
 * list. Naming them here keeps the deleter's statement derived from the schema
 * rather than from an assumption about it.
 */
export const e2eScenarioRowKeys = {
  answers: "id",
  organization_appearance_defaults: "organization_id",
  organization_members: "id",
  organizations: "id",
  project_members: "id",
  project_repositories: "id",
  projects: "id",
  requests: "id",
  session: "id",
  signup_allowlist: "id",
  user: "id",
  user_appearance_preferences: "user_id",
  verification: "id",
  webhook_subscriptions: "id",
  questions: "id",
} as const satisfies Record<E2EScenarioTable, string>;

const cleanupOrder = new Set<string>(e2eScenarioTables);

function fixedFailure(failure: string): Error {
  return new Error(failure);
}

/**
 * Remove one table's batch.
 *
 * The comparison is made in `text` on both sides. The tables here are keyed by
 * `uuid` and by `text` in roughly equal measure, and a single array parameter
 * cannot be both; casting the column rather than guessing the parameter's type
 * keeps one statement correct for every table in the order.
 */
export function createE2EScenarioRowDeleter(execute: E2EScenarioSqlExecutor) {
  return async (
    batch: Readonly<{ table: E2EScenarioTable; ids: readonly string[] }>,
  ): Promise<void> => {
    if (!cleanupOrder.has(batch.table)) {
      throw fixedFailure(e2eScenarioFailures.table);
    }
    const key = e2eScenarioRowKeys[batch.table];

    try {
      await execute({
        text: `DELETE FROM "public"."${batch.table}" WHERE "${key}"::text = ANY($1::text[])`,
        values: [[...batch.ids]],
      });
    } catch {
      // Named here as well as in the caller, because this is the layer that
      // knows the table without having to be told — and the database's own
      // message still stops here.
      throw new Error(`${e2eScenarioFailures.cleanup}: ${batch.table}`);
    }
  };
}

/** A short, stable suffix so seeded names stay inside every column's bounds. */
function shortNamespace(namespace: string): string {
  return namespace.replaceAll("-", "").slice(0, 12);
}

type Writer = (
  table: E2EScenarioTable,
  id: string,
  text: string,
  values: readonly unknown[],
) => Promise<void>;

async function seedOwnerIdentity(
  write: Writer,
  run: E2EScenarioRun,
  viewer: E2EScenarioViewer | null,
  createId: () => string,
) {
  const short = shortNamespace(run.namespace);
  const email = `e2e-${short}@example.invalid`;
  const userId = `e2e-user-${short}`;
  const organizationId = createId();

  await write(
    "signup_allowlist",
    createId(),
    'INSERT INTO "public"."signup_allowlist" ("id", "normalized_email", "status") VALUES ($1, $2, \'active\')',
    [email],
  );
  await write(
    "user",
    userId,
    'INSERT INTO "public"."user" ("id", "name", "email", "email_verified") VALUES ($1, $2, $3, true)',
    [`E2E identity ${short}`, email],
  );
  await write(
    "organizations",
    organizationId,
    'INSERT INTO "public"."organizations" ("id", "name", "slug", "status") VALUES ($1, $2, $3, \'active\')',
    [`E2E tenant ${short}`, `e2e-tenant-${short}`],
  );
  // Both memberships are administrators rather than owners, and that is the
  // whole reason this case can clean up after itself. `0014`'s initializer
  // fires on an *active owner* membership and writes an appearance default, a
  // `domain_events` row, and an outbox row; `domain_events` is append-only, so
  // a tenant that ever had an active owner can never be deleted again. Seeding
  // the default below explicitly keeps the row this case declares while leaving
  // the trigger — and the append-only event it would write — untouched.
  await write(
    "organization_members",
    createId(),
    'INSERT INTO "public"."organization_members" ("id", "organization_id", "user_id", "role", "status") VALUES ($1, $2, $3, \'admin\', \'active\')',
    [organizationId, userId],
  );
  // The signed-in viewer joins the seeded tenant when there is one, and that
  // membership is what lets a browser case switch into a tenant with nothing in
  // it. An isolated call with no session — the route's own lifecycle proof —
  // seeds the identity and the tenant and stops there rather than failing: the
  // rows this case is *about* are the identity's, not the viewer's.
  if (viewer !== null) {
    await write(
      "organization_members",
      createId(),
      'INSERT INTO "public"."organization_members" ("id", "organization_id", "user_id", "role", "status") VALUES ($1, $2, $3, \'admin\', \'active\')',
      [organizationId, viewer.userId],
    );
  }
  await write(
    "organization_appearance_defaults",
    organizationId,
    'INSERT INTO "public"."organization_appearance_defaults" ("organization_id", "theme", "density", "mode", "last_updated_by_user_id", "version") VALUES ($1, \'requestport\', \'ultra-compact\', \'system\', $2, 1)',
    [userId],
  );
}

async function seedProjectData(
  write: Writer,
  run: E2EScenarioRun,
  viewer: E2EScenarioViewer,
  createId: () => string,
) {
  const short = shortNamespace(run.namespace);
  const projectId = createId();
  const repositorySlug = `example-org/e2e-${short}`;

  await write(
    "projects",
    projectId,
    'INSERT INTO "public"."projects" ("id", "organization_id", "name", "slug", "key_prefix", "description", "status") VALUES ($1, $2, $3, $4, $5, $6, \'active\')',
    [
      viewer.organizationId,
      `E2E project ${short}`,
      `e2e-project-${short}`,
      `E${short.slice(0, 4).toUpperCase()}`,
      "Seeded by the guarded local acceptance hook.",
    ],
  );
  await write(
    "project_members",
    createId(),
    'INSERT INTO "public"."project_members" ("id", "organization_id", "project_id", "user_id", "role", "status") VALUES ($1, $2, $3, $4, \'maintainer\', \'active\')',
    [viewer.organizationId, projectId, viewer.userId],
  );
  await write(
    "project_repositories",
    createId(),
    'INSERT INTO "public"."project_repositories" ("id", "organization_id", "project_id", "provider", "browse_url", "clone_url", "repository_slug", "is_default", "status") VALUES ($1, $2, $3, \'github\', $4, $5, $6, true, \'active\')',
    [
      viewer.organizationId,
      projectId,
      `https://github.com/${repositorySlug}`,
      `https://github.com/${repositorySlug}.git`,
      repositorySlug,
    ],
  );
  // A draft: the schema requires a draft to carry neither a sequence number nor
  // a display key, and a seeded row that skipped the workflow has no business
  // claiming one. It also keeps the row deletable — a submitted request is the
  // product of commands that write append-only events.
  await write(
    "requests",
    createId(),
    'INSERT INTO "public"."requests" ("id", "organization_id", "source_kind", "target_project_id", "type", "title", "description_md", "priority", "state", "reporter_type", "reporter_id", "version") VALUES ($1, $2, \'human_direct\', $3, \'feature\', $4, $5, \'normal\', \'draft\', \'user\', $6, 1)',
    [
      viewer.organizationId,
      projectId,
      `E2E seeded request ${short}`,
      "Seeded by the guarded local acceptance hook.",
      viewer.userId,
    ],
  );
}

async function seedCleanupProbe(
  write: Writer,
  run: E2EScenarioRun,
  createId: () => string,
) {
  const short = shortNamespace(run.namespace);
  const organizationId = createId();

  await write(
    "organizations",
    organizationId,
    'INSERT INTO "public"."organizations" ("id", "name", "slug", "status") VALUES ($1, $2, $3, \'active\')',
    [`E2E cleanup ${short}`, `e2e-cleanup-${short}`],
  );
  await write(
    "projects",
    createId(),
    'INSERT INTO "public"."projects" ("id", "organization_id", "name", "slug", "key_prefix", "status") VALUES ($1, $2, $3, $4, $5, \'active\')',
    [
      organizationId,
      `E2E cleanup project ${short}`,
      `e2e-cleanup-project-${short}`,
      `C${short.slice(0, 4).toUpperCase()}`,
    ],
  );
}

/** The cases whose rows can only be written into the viewer's own tenant. */
const tenantScoped = new Set(["seeded-project-data"]);

export function createE2EScenarioRowSeeder(ports: E2EScenarioSeedPorts) {
  const createId = ports.createId ?? (() => crypto.randomUUID());

  return async ({
    definition,
    request,
    run,
  }: E2EScenarioSeedInput): Promise<void> => {
    if (definition.tables.length === 0) return;

    const write: Writer = async (table, id, text, values) => {
      await ports.execute({ text, values: [id, ...values] });
      run.record(table, id);
    };

    try {
      if (definition.id === "scenario-cleanup") {
        await seedCleanupProbe(write, run, createId);
        return;
      }

      const viewer = await ports.readViewer(request);
      if (viewer === null && tenantScoped.has(definition.id)) {
        throw fixedFailure(e2eScenarioFailures.seed);
      }

      if (definition.id === "seeded-owner-identity") {
        await seedOwnerIdentity(write, run, viewer, createId);
        return;
      }
      if (definition.id === "seeded-project-data" && viewer !== null) {
        await seedProjectData(write, run, viewer, createId);
        return;
      }

      throw fixedFailure(e2eScenarioFailures.seed);
    } catch {
      throw fixedFailure(e2eScenarioFailures.seed);
    }
  };
}
