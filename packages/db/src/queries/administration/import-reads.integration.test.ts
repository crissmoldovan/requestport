import { createHash } from "node:crypto";

import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../../client.js";
import { createImportReviewCommandRepository } from "../../repositories/import-repository.js";
import { createOperatorCredentialRepository } from "../../repositories/operator-credential-repository.js";
import {
  importManifestEntries,
  importRuns,
  importSources,
  projects,
  sourceArtifacts,
  sourceSnapshots,
} from "../../schema/index.js";
import { tenantWrappingEnabled } from "../../tenant-context.js";
import { endingEachMethodBinding } from "../../test-support/tenant-binding.js";
import type { Tx } from "../../transaction.js";
import {
  getAdministrationImportRun,
  listAdministrationImportRuns,
  readImportRunForOperator,
  readImportRunsForOperator,
} from "./import-reads.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `list_administration_import_runs` and `get_administration_import_run` (Plan
  13, F.2.6; `manifest-f2.md` §4.1), at the repository: what they return, and
  whom they refuse. `/api/v1` reaches them for an operator credential through
  `readImportRunsForOperator` and `readImportRunForOperator`, which hand them
  the member F.3's `memberAuthority` names and the credential's organisation
  and project, inside the transaction in which the bus's `assertCurrent` has
  re-checked the credential (the last describe below).

  Every case runs in a transaction that is rolled back at the end, and seeds
  its own organisations from full random suffixes.
*/

class TestRollback extends Error {}

async function inRollbackTransaction(work: (tx: Tx) => Promise<void>) {
  let failure: unknown;
  await expect(
    suiteStorage.transaction(async (tx) => {
      try {
        await work(tx);
      } catch (error) {
        failure = error;
      }
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
  if (failure !== undefined) throw failure;
}

async function seedUser(tx: Tx) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, 'Import read user', ${email}, now())
  `);
  return userId;
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Import read tenant',
      ${`import-read-${organizationId}`}, 'active')
  `);
  return organizationId;
}

async function seedMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
  status: "active" | "revoked" = "active",
) {
  await tx.execute(sql`
    insert into "organization_members"
      ("organization_id", "user_id", "role", "status")
    values (${organizationId}, ${userId}, ${role}, ${status})
  `);
}

async function seedProject(tx: Tx, organizationId: string) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Import read ${suffix}`,
      slug: `import-read-${suffix}`,
      keyPrefix: `R${suffix.slice(0, 8).toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

const record = "# A legacy request\n\nIts preserved body.\n";

/** A source of `projectId` with one snapshot and one artifact. */
async function seedSource(tx: Tx, organizationId: string, projectId: string) {
  const [source] = await tx
    .insert(importSources)
    .values({ organizationId, projectId, createdBy: "user:import-read-seed" })
    .returning({ id: importSources.id });
  if (!source) throw new Error("no source");
  const [snapshot] = await tx
    .insert(sourceSnapshots)
    .values({
      organizationId,
      importSourceId: source.id,
      manifestSha256: sha256(crypto.randomUUID()),
      status: "analyzed",
    })
    .returning({ id: sourceSnapshots.id });
  if (!snapshot) throw new Error("no snapshot");
  const bytes = Buffer.from(record, "utf8");
  const [artifact] = await tx
    .insert(sourceArtifacts)
    .values({
      organizationId,
      importSourceId: source.id,
      sourceSnapshotId: snapshot.id,
      relativePath: `requests/${crypto.randomUUID()}.md`,
      mediaType: "text/markdown",
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
      exactBytes: bytes,
    })
    .returning({ id: sourceArtifacts.id });
  if (!artifact) throw new Error("no artifact");
  return {
    sourceId: source.id,
    snapshotId: snapshot.id,
    artifactId: artifact.id,
  };
}

/** A run of `source`, created at `createdAt`, with `entries` entries. */
async function seedRun(
  tx: Tx,
  organizationId: string,
  source: Awaited<ReturnType<typeof seedSource>>,
  input: { createdAt: Date; entries?: number; state?: string },
) {
  const [run] = await tx
    .insert(importRuns)
    .values({
      organizationId,
      importSourceId: source.sourceId,
      sourceSnapshotId: source.snapshotId,
      requestedByType: "user",
      requestedById: "import-read-seed",
      state: input.state ?? "reviewing",
      parserVersion: "legacy-fr@1",
      manifestSha256: sha256(crypto.randomUUID()),
      createdAt: input.createdAt,
    })
    .returning({ id: importRuns.id });
  if (!run) throw new Error("no run");
  const entryIds: string[] = [];
  for (let index = 0; index < (input.entries ?? 0); index += 1) {
    const [entry] = await tx
      .insert(importManifestEntries)
      .values({
        organizationId,
        importRunId: run.id,
        sourceArtifactId: source.artifactId,
        recordIndex: index,
        proposedKind: "request",
        parsedJson: { kind: "request", bodyMarkdown: record, title: "Legacy" },
        confidenceJson: { kind: 0.5 },
      })
      .returning({ id: importManifestEntries.id });
    if (!entry) throw new Error("no entry");
    entryIds.push(entry.id);
  }
  return { runId: run.id, entryIds };
}

/**
 * An organisation with an owner, two projects, a source for each, and a run
 * of each: the first project's older, with two entries, the second's newer,
 * with none.
 */
async function seedTenant(tx: Tx, owner?: string) {
  const organizationId = await seedOrganization(tx);
  const ownerId = owner ?? (await seedUser(tx));
  await seedMembership(tx, organizationId, ownerId, "owner");
  const projectP = await seedProject(tx, organizationId);
  const projectQ = await seedProject(tx, organizationId);
  const sourceP = await seedSource(tx, organizationId, projectP);
  const sourceQ = await seedSource(tx, organizationId, projectQ);
  const runP = await seedRun(tx, organizationId, sourceP, {
    createdAt: new Date("2026-09-01T00:00:00Z"),
    entries: 2,
  });
  const runQ = await seedRun(tx, organizationId, sourceQ, {
    createdAt: new Date("2026-09-02T00:00:00Z"),
    state: "approved",
  });
  return {
    organizationId,
    ownerId,
    projectP,
    projectQ,
    sourceP,
    runP,
    runQ,
  };
}

function reader(
  tenant: { organizationId: string; ownerId: string },
  overrides: {
    memberUserId?: string;
    credentialProjectId?: string | null;
  } = {},
) {
  return {
    memberUserId: overrides.memberUserId ?? tenant.ownerId,
    organizationId: tenant.organizationId,
    credentialProjectId: overrides.credentialProjectId ?? null,
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read was not refused");
}

function expectRefused(error: unknown, code: string) {
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

/** The transaction still answers: nothing raised inside PostgreSQL. */
async function expectUsable(tx: Tx) {
  expect(await tx.execute(sql`select 1 as "one"`)).toBeTruthy();
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("list_administration_import_runs", () => {
  test("answers an owner with exactly each run's id, source project, state and version, newest first", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      expect(await listAdministrationImportRuns(tx, reader(tenant))).toEqual([
        {
          id: tenant.runQ.runId,
          projectId: tenant.projectQ,
          state: "approved",
          version: 1,
        },
        {
          id: tenant.runP.runId,
          projectId: tenant.projectP,
          state: "reviewing",
          version: 1,
        },
      ]);
    });
  });

  test("answers an admin", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, admin, "admin");

      expect(
        await listAdministrationImportRuns(
          tx,
          reader(tenant, { memberUserId: admin }),
        ),
      ).toHaveLength(2);
    });
  });

  test("holds at most 200 runs, the newest", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await tx.insert(importRuns).values(
        Array.from({ length: 200 }, (_, index) => ({
          organizationId: tenant.organizationId,
          importSourceId: tenant.sourceP.sourceId,
          sourceSnapshotId: tenant.sourceP.snapshotId,
          requestedByType: "user",
          requestedById: "import-read-seed",
          parserVersion: "legacy-fr@1",
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
        })),
      );

      const runs = await listAdministrationImportRuns(tx, reader(tenant));
      expect(runs).toHaveLength(200);
      expect(runs.map(({ id }) => id)).not.toContain(tenant.runP.runId);
      expect(runs.map(({ id }) => id)).not.toContain(tenant.runQ.runId);
    });
  });

  test("a credential bound to a project sees only the runs whose source is that project", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      expect(
        await listAdministrationImportRuns(
          tx,
          reader(tenant, { credentialProjectId: tenant.projectP }),
        ),
      ).toEqual([
        {
          id: tenant.runP.runId,
          projectId: tenant.projectP,
          state: "reviewing",
          version: 1,
        },
      ]);
      expect(
        await listAdministrationImportRuns(
          tx,
          reader(tenant, { credentialProjectId: "not-a-project" }),
        ),
      ).toEqual([]);
      await expectUsable(tx);
    });
  });

  test("never answers with another organisation's runs, for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedTenant(tx, home.ownerId);

      const ids = (await listAdministrationImportRuns(tx, reader(home))).map(
        ({ id }) => id,
      );
      expect(ids.sort()).toEqual([home.runP.runId, home.runQ.runId].sort());
      expect(ids).not.toContain(foreign.runP.runId);
      expect(
        await listAdministrationImportRuns(
          tx,
          reader(home, { credentialProjectId: foreign.projectP }),
        ),
      ).toEqual([]);
    });
  });

  test("refuses a member below admin, a revoked owner, a stranger, anyone in a suspended organisation, and an operator's actor id", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member, "member");
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        tenant.organizationId,
        revoked,
        "owner",
        "revoked",
      );
      const stranger = await seedUser(tx);

      for (const memberUserId of [
        member,
        revoked,
        stranger,
        `operator:${crypto.randomUUID()}`,
      ]) {
        expectRefused(
          await refusal(
            listAdministrationImportRuns(tx, reader(tenant, { memberUserId })),
          ),
          "forbidden",
        );
      }
      await tx.execute(
        sql`update "organizations" set "status" = 'suspended' where "id" = ${tenant.organizationId}`,
      );
      expectRefused(
        await refusal(listAdministrationImportRuns(tx, reader(tenant))),
        "forbidden",
      );
      await expectUsable(tx);
    });
  });
});

describe.sequential("get_administration_import_run", () => {
  test("answers an owner with exactly the run's id, state and version and each entry's id, decision, canonical request and version", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const [first, second] = tenant.runP.entryIds;
      const canonical = crypto.randomUUID();
      await tx
        .update(importManifestEntries)
        .set({ decision: "skip", version: 3 })
        .where(eq(importManifestEntries.id, first ?? ""));
      await tx.execute(sql`
        update "import_manifest_entries"
        set "proposed_canonical_id" = ${canonical}
        where "id" = ${second ?? ""}
      `);

      const read = await getAdministrationImportRun(tx, {
        ...reader(tenant),
        runId: tenant.runP.runId,
      });

      expect(read).toEqual({
        id: tenant.runP.runId,
        state: "reviewing",
        version: 1,
        entries: [
          {
            id: first,
            decision: "skip",
            proposedCanonicalId: null,
            version: 3,
          },
          {
            id: second,
            decision: "pending",
            proposedCanonicalId: canonical,
            version: 1,
          },
        ],
      });
      expect(JSON.stringify(read)).not.toContain("legacy request");
      expect(JSON.stringify(read)).not.toContain("Legacy");
    });
  });

  test("answers an admin, and a run with no entries", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, admin, "admin");

      expect(
        await getAdministrationImportRun(tx, {
          ...reader(tenant, { memberUserId: admin }),
          runId: tenant.runQ.runId,
        }),
      ).toEqual({
        id: tenant.runQ.runId,
        state: "approved",
        version: 1,
        entries: [],
      });
    });
  });

  test("another organisation's run is not found for an owner of both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedTenant(tx, home.ownerId);

      expectRefused(
        await refusal(
          getAdministrationImportRun(tx, {
            ...reader(home),
            runId: foreign.runP.runId,
          }),
        ),
        "not_found",
      );
    });
  });

  test("a credential bound to a project reads that project's run and no other", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      expect(
        await getAdministrationImportRun(tx, {
          ...reader(tenant, { credentialProjectId: tenant.projectP }),
          runId: tenant.runP.runId,
        }),
      ).toMatchObject({ id: tenant.runP.runId });
      expectRefused(
        await refusal(
          getAdministrationImportRun(tx, {
            ...reader(tenant, { credentialProjectId: tenant.projectQ }),
            runId: tenant.runP.runId,
          }),
        ),
        "not_found",
      );
      expectRefused(
        await refusal(
          getAdministrationImportRun(tx, {
            ...reader(tenant, { credentialProjectId: "not-a-project" }),
            runId: tenant.runP.runId,
          }),
        ),
        "not_found",
      );
      await expectUsable(tx);
    });
  });

  test("a run id that is not a UUID is not found, before any query", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);

      expectRefused(
        await refusal(
          getAdministrationImportRun(tx, {
            ...reader(tenant),
            runId: "operator:lineage",
          }),
        ),
        "not_found",
      );
      await expectUsable(tx);
    });
  });

  test("refuses a member below admin, a revoked owner, anyone in a suspended organisation, and an operator's actor id", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member, "member");
      const revoked = await seedUser(tx);
      await seedMembership(
        tx,
        tenant.organizationId,
        revoked,
        "owner",
        "revoked",
      );

      for (const memberUserId of [
        member,
        revoked,
        `operator:${crypto.randomUUID()}`,
      ]) {
        expectRefused(
          await refusal(
            getAdministrationImportRun(tx, {
              ...reader(tenant, { memberUserId }),
              runId: tenant.runP.runId,
            }),
          ),
          "forbidden",
        );
      }
      await tx.execute(
        sql`update "organizations" set "status" = 'suspended' where "id" = ${tenant.organizationId}`,
      );
      expectRefused(
        await refusal(
          getAdministrationImportRun(tx, {
            ...reader(tenant),
            runId: tenant.runP.runId,
          }),
        ),
        "forbidden",
      );
      await expectUsable(tx);
    });
  });

  test("what the reads answer is what review takes: the run and entry ids, and each entry's version", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const [listed] = (
        await listAdministrationImportRuns(
          tx,
          reader(tenant, { credentialProjectId: tenant.projectP }),
        )
      ).map(({ id }) => id);
      const read = await getAdministrationImportRun(tx, {
        ...reader(tenant),
        runId: listed ?? "",
      });
      const [entry] = read.entries;
      if (!entry) throw new Error("no entry read");
      const port = createImportReviewCommandRepository(tx);
      const reviewing = {
        runId: read.id,
        entryId: entry.id,
        decision: "skip" as const,
        proposedCanonicalId: null,
        targetProjectId: null,
        relationships: [],
      };

      expectRefused(
        await refusal(
          port.reviewEntry(
            {
              userId: tenant.ownerId,
              organizationId: tenant.organizationId,
              actor: { type: "user", id: tenant.ownerId },
              credentialProjectId: null,
              expectedVersion: entry.version + 1,
            },
            reviewing,
          ),
        ),
        "version_conflict",
      );
      expect(
        await port.reviewEntry(
          {
            userId: tenant.ownerId,
            organizationId: tenant.organizationId,
            actor: { type: "user", id: tenant.ownerId },
            credentialProjectId: null,
            expectedVersion: entry.version,
          },
          reviewing,
        ),
      ).toEqual({ id: entry.id, version: entry.version + 1 });
    });
  });
});

/*
  Plan 13, F.2.6's registry half: the two reads as `/api/v1` dispatches them
  for an operator credential, each in the caller's one transaction — first
  the bus's own `assertCurrent` under the deployment's switch, then the read
  for the member `memberAuthority` names, the credential's organisation and
  its bound project. Credentials are issued for real through F.3's
  repository.
*/

/**
 * Issues an operator credential for `userId`, holding `import:write`, as
 * F.3's repository writes one, and the context `authenticateApiBearer`
 * builds for it.
 */
async function issueOperator(
  tx: Tx,
  input: {
    organizationId: string;
    userId: string;
    projectId?: string | null;
  },
) {
  const apiKeyId = `apikey_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "apikey"
      ("id", "config_id", "reference_id", "key", "enabled", "expires_at",
       "created_at", "updated_at")
    values (${apiKeyId}, 'requestport-operator', ${input.userId},
      ${`secret_${crypto.randomUUID()}`}, true, now() + interval '30 days',
      now(), now())
  `);
  // Issuance binds the credential's organisation; ended with the call, as
  // the issuing service's own transaction ends it.
  const credential = await endingEachMethodBinding(
    createOperatorCredentialRepository(tx),
    tx,
  ).createCredential({
    organizationId: input.organizationId,
    memberUserId: input.userId,
    projectId: input.projectId ?? null,
    betterAuthApiKeyId: apiKeyId,
    name: "Import read operator",
    prefix: "rpo_f26r",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: ["import:write"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  const context: AuthorizedCommandContext = {
    actor: operatorActor({
      lineageId: credential.lineageId,
      memberUserId: credential.memberUserId,
    }),
    credentialKind: "operator",
    organizationId: credential.organizationId,
    projectId: credential.projectId,
    laneIds: new Set(),
    scopes: new Set(credential.scopes),
    credentialId: credential.id,
    correlationId: crypto.randomUUID(),
  };
  return { credential, context, apiKeyId };
}

type Switch = "enabled" | "disabled" | undefined;

// A switch passed explicitly, `undefined` included, is used as passed; none
// passed means `enabled`. (A default parameter would turn an explicit
// `undefined` into `enabled`.)
function listAsOperator(
  tx: Tx,
  context: AuthorizedCommandContext,
  ...setting: [Switch?]
) {
  return readImportRunsForOperator(tx, {
    context,
    operatorCredentials: setting.length > 0 ? setting[0] : "enabled",
  });
}

function getAsOperator(
  tx: Tx,
  context: AuthorizedCommandContext,
  runId: string,
  ...setting: [Switch?]
) {
  return readImportRunForOperator(tx, {
    context,
    runId,
    operatorCredentials: setting.length > 0 ? setting[0] : "enabled",
  });
}

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

const changes: Array<[string, (tx: Tx, at: Changed) => Promise<void>]> = [
  [
    "the credential is revoked",
    async (tx, { credentialId }) => {
      await tx.execute(sql`
        update "operator_credentials" set "revoked_at" = now()
        where "id" = ${credentialId}
      `);
    },
  ],
  [
    "the credential has expired",
    async (tx, { credentialId }) => {
      await tx.execute(sql`
        update "operator_credentials"
        set "created_at" = now() - interval '2 days',
            "expires_at" = now() - interval '1 second'
        where "id" = ${credentialId}
      `);
    },
  ],
  [
    "its key has expired",
    async (tx, { apiKeyId }) => {
      await tx.execute(sql`
        update "apikey" set "expires_at" = now() - interval '1 second'
        where "id" = ${apiKeyId}
      `);
    },
  ],
  [
    "its member is demoted below the rule",
    async (tx, { organizationId, userId }) => {
      await tx.execute(sql`
        update "organization_members" set "role" = 'member'
        where "organization_id" = ${organizationId} and "user_id" = ${userId}
      `);
    },
  ],
  [
    "its member's membership is revoked",
    async (tx, { organizationId, userId }) => {
      await tx.execute(sql`
        update "organization_members" set "status" = 'revoked'
        where "organization_id" = ${organizationId} and "user_id" = ${userId}
      `);
    },
  ],
  [
    "the organisation is suspended",
    async (tx, { organizationId }) => {
      await tx.execute(sql`
        update "organizations" set "status" = 'suspended'
        where "id" = ${organizationId}
      `);
    },
  ],
];

describe.sequential("the two reads, as REST dispatches them for an operator", () => {
  test("answer an owner's operator with exactly what its member would be answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerId,
      });
      expect(await listAsOperator(tx, context)).toEqual(
        await listAdministrationImportRuns(tx, reader(tenant)),
      );
      expect(await getAsOperator(tx, context, tenant.runP.runId)).toEqual(
        await getAdministrationImportRun(tx, {
          ...reader(tenant),
          runId: tenant.runP.runId,
        }),
      );
    });
  });

  test.each(changes)(
    "refuse once %s, having answered before",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const { credential, context, apiKeyId } = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerId,
        });
        expect(await listAsOperator(tx, context)).toHaveLength(2);
        expect((await getAsOperator(tx, context, tenant.runP.runId)).id).toBe(
          tenant.runP.runId,
        );
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.ownerId,
          credentialId: credential.id,
          apiKeyId,
        });
        expectRefused(await refusal(listAsOperator(tx, context)), "forbidden");
        expectRefused(
          await refusal(getAsOperator(tx, context, tenant.runP.runId)),
          "forbidden",
        );
      });
    },
  );

  test("refuse every operator while operator credentials are switched off", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerId,
      });
      expect(await listAsOperator(tx, context, "enabled")).toHaveLength(2);
      for (const setting of ["disabled", undefined] as const) {
        expectRefused(
          await refusal(listAsOperator(tx, context, setting)),
          "forbidden",
        );
        expectRefused(
          await refusal(getAsOperator(tx, context, tenant.runP.runId, setting)),
          "forbidden",
        );
      }
    });
  });

  test("an operator issued for one organisation lists none of another's runs and finds none by id, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedTenant(tx, home.ownerId);
      const { context } = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.ownerId,
      });
      const listed = (await listAsOperator(tx, context)).map(({ id }) => id);
      expect(listed.sort()).toEqual([home.runP.runId, home.runQ.runId].sort());
      expectRefused(
        await refusal(getAsOperator(tx, context, foreign.runP.runId)),
        "not_found",
      );
    });
  });

  test("an operator bound to a project lists and reads that project's runs, and finds no other", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerId,
        projectId: tenant.projectP,
      });
      expect((await listAsOperator(tx, context)).map(({ id }) => id)).toEqual([
        tenant.runP.runId,
      ]);
      expect((await getAsOperator(tx, context, tenant.runP.runId)).id).toBe(
        tenant.runP.runId,
      );
      expectRefused(
        await refusal(getAsOperator(tx, context, tenant.runQ.runId)),
        "not_found",
      );
    });
  });

  test("a path's run id that is not a UUID is not found, and the transaction stays usable", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const { context } = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.ownerId,
      });
      expectRefused(
        await refusal(getAsOperator(tx, context, "not-a-uuid")),
        "not_found",
      );
      await expectUsable(tx);
    });
  });

  test("refuse a context that is not an operator's before anything is read", async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error("the read touched the transaction");
        },
      },
    ) as Tx;
    const organizationId = crypto.randomUUID();
    const contexts: Array<[string, AuthorizedCommandContext]> = [
      [
        "a person",
        {
          actor: { type: "user", id: "user_import_read_person" },
          organizationId,
          scopes: new Set(["import:write"]),
          credentialId: "session_import_read",
          correlationId: crypto.randomUUID(),
        },
      ],
      [
        "an agent holding import:write",
        {
          actor: { type: "agent", id: crypto.randomUUID() },
          organizationId,
          projectId: crypto.randomUUID(),
          scopes: new Set(["import:write"]),
          credentialId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
        },
      ],
      [
        "a context that says operator without an operator's actor",
        {
          actor: { type: "service", id: "operator:probe" },
          credentialKind: "operator",
          organizationId,
          scopes: new Set(["import:write"]),
          credentialId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
        },
      ],
    ];
    for (const [name, context] of contexts) {
      const listed = await refusal(listAsOperator(untouchable, context));
      expect((listed as DomainError).code, name).toBe("forbidden");
      const got = await refusal(
        getAsOperator(untouchable, context, crypto.randomUUID()),
      );
      expect((got as DomainError).code, name).toBe("forbidden");
    }
  });
});
