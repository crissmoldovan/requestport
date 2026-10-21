import { createHash } from "node:crypto";

import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  actorFingerprint,
  canonicalJson,
  createCoreCommandRegistry,
  DomainError,
  importReviewTarget,
  type JsonObject,
  keyedFingerprint,
  normalizedInputHash,
  operatorActor,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  commandReceipts,
  importConflicts,
  importManifestEntries,
  importRuns,
  importSources,
  organizationMembers,
  projects,
  requests,
  session,
  sourceArtifacts,
  sourceSnapshots,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
  endTenantBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createImportReviewCommandRepository } from "./import-repository.js";
import { createOperatorCredentialRepository } from "./operator-credential-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  Import review against a real database (Plan 13, F.2.6; `manifest-f2.md`
  §2.7): the first real-database suite for the import repository's review
  path. Review runs through the command bus the UI and REST share, with the
  real unit of work, the real `importReviewCommands` port and the real
  `assertCurrent`. The split is off the bus; its handler lives in
  `@requestport/core` (`import-split.ts`), which depends on this package, so
  this package cannot import it, and the split cases compose the same four
  steps in the same order
  (`splitAsTheHandlerDoes`), with a stand-in for the legacy parser.

  Each case runs inside a transaction that is rolled back at the end, and
  seeds its own organisation from full random suffixes. The bus opens its own
  transaction per command, which Drizzle turns into a savepoint inside it.
*/

const busSecret = "import-review-live-bus-fingerprint-secret-000000";
const formSecret = "import-review-live-form-fingerprint-secret-00000";

class TestRollback extends Error {}

/**
 * Runs `work` in a transaction that is always rolled back. A failure inside
 * is rethrown as itself, so the report shows the case's own assertion rather
 * than a rollback that did not happen.
 */
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
    values (${userId}, 'Import review user', ${email}, now())
  `);
  const sessionId = `session_${crypto.randomUUID()}`;
  await tx.execute(sql`
    insert into "session" ("id", "expires_at", "token", "updated_at", "user_id")
    values (${sessionId}, now() + interval '1 hour',
      ${`token_${crypto.randomUUID()}`}, now(), ${userId})
  `);
  return { userId, sessionId };
}

async function seedOrganization(tx: Tx) {
  const organizationId = crypto.randomUUID();
  await tx.execute(sql`
    insert into "organizations" ("id", "name", "slug", "status")
    values (${organizationId}, 'Import review tenant',
      ${`import-review-live-${organizationId}`}, 'active')
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
      name: `Import ${suffix}`,
      slug: `import-${suffix}`,
      keyPrefix: `I${suffix.slice(0, 8).toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  return project.id;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A run in review, bound to a source of `projectId`, holding one pending
 * entry whose preserved record is `body`.
 */
async function seedReviewingRun(
  tx: Tx,
  input: {
    organizationId: string;
    projectId: string;
    body: string;
    state?: string;
  },
) {
  const [source] = await tx
    .insert(importSources)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      createdBy: "user:import-review-seed",
    })
    .returning({ id: importSources.id });
  if (!source) throw new Error("no source");
  const [snapshot] = await tx
    .insert(sourceSnapshots)
    .values({
      organizationId: input.organizationId,
      importSourceId: source.id,
      manifestSha256: sha256(crypto.randomUUID()),
      status: "analyzed",
    })
    .returning({ id: sourceSnapshots.id });
  if (!snapshot) throw new Error("no snapshot");
  const bytes = Buffer.from(input.body, "utf8");
  const [artifact] = await tx
    .insert(sourceArtifacts)
    .values({
      organizationId: input.organizationId,
      importSourceId: source.id,
      sourceSnapshotId: snapshot.id,
      relativePath: `requests/${crypto.randomUUID()}.md`,
      mediaType: "text/markdown",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      exactBytes: bytes,
    })
    .returning({ id: sourceArtifacts.id });
  if (!artifact) throw new Error("no artifact");
  const [run] = await tx
    .insert(importRuns)
    .values({
      organizationId: input.organizationId,
      importSourceId: source.id,
      sourceSnapshotId: snapshot.id,
      requestedByType: "user",
      requestedById: "import-review-seed",
      state: input.state ?? "reviewing",
      parserVersion: "legacy-fr@1",
    })
    .returning({ id: importRuns.id });
  if (!run) throw new Error("no run");
  const [entry] = await tx
    .insert(importManifestEntries)
    .values({
      organizationId: input.organizationId,
      importRunId: run.id,
      sourceArtifactId: artifact.id,
      recordIndex: 0,
      proposedKind: "request",
      parsedJson: { kind: "request", bodyMarkdown: input.body },
      confidenceJson: { kind: 0.5 },
    })
    .returning({ id: importManifestEntries.id });
  if (!entry) throw new Error("no entry");
  return {
    sourceId: source.id,
    snapshotId: snapshot.id,
    artifactId: artifact.id,
    runId: run.id,
    entryId: entry.id,
  };
}

/** Three lines, so a split at line 2 leaves two segments. */
const bundle = "First record line\nSecond record line\nThird record line\n";

/**
 * The segments of `body` cut before each of `splitLines` (1-based), as the
 * split form cuts them. The form then parses each segment with the legacy
 * parser, which this package cannot import, so here each segment is taken as
 * one record as it stands.
 */
function segmentsAt(splitLines: number[], body: string) {
  const lineStarts = [0];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\n" && index + 1 < body.length) {
      lineStarts.push(index + 1);
    }
  }
  const offsets = splitLines.map((line) => lineStarts[line - 1]);
  if (offsets.some((offset) => offset === undefined)) {
    throw new DomainError(
      "validation_failed",
      "A split line is outside the preserved record",
    );
  }
  const boundaries = [0, ...(offsets as number[]), body.length];
  return boundaries.slice(0, -1).map((start, index) => ({
    proposedKind: "request",
    parsedJson: {
      kind: "request",
      bodyMarkdown: body.slice(start, boundaries[index + 1]),
      recordIndex: index,
    },
    confidenceJson: { kind: 1 },
  }));
}

/**
 * The deployment's operator switch, as these cases run it: `enabled`, as a
 * deployment with `REQUESTPORT_OPERATOR_CREDENTIALS=enabled` has it. With it
 * off, `assertCurrent` refuses every operator before the port is asked (a
 * case below holds that); a person's context never reads it.
 */
const operatorCredentials = "enabled" as const;

function portFactory(name: string, database: Database | Tx) {
  if (name === "importReviewCommands")
    return createImportReviewCommandRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database, {
      operatorCredentials,
    });
  return undefined;
}

/**
 * The bus as the web composes it. Without the re-check, it is the bus a case
 * uses to show that the command itself refuses a context `assertCurrent`
 * would have refused first.
 */
function bus(tx: Tx, options: { recheck?: boolean } = {}) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for several people or organisations on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(tx as unknown as Database, portFactory),
      tx,
    ),
    fingerprintSecret: busSecret,
    ...(options.recheck === false
      ? {}
      : {
          authorizeContext: (
            context: AuthorizedCommandContext,
            uow: Parameters<
              NonNullable<
                ConstructorParameters<
                  typeof AtomicCommandBus
                >[0]["authorizeContext"]
              >
            >[1],
          ) =>
            uow
              .port<ReturnType<typeof createCommandAuthorizationRepository>>(
                "commandAuthorization",
              )
              .assertCurrent(context),
        }),
  });
}

function humanContext(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
  scopes?: readonly string[];
}): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: input.userId },
    organizationId: input.organizationId,
    scopes: new Set(input.scopes ?? ["import:write"]),
    credentialId: input.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

function key() {
  return `import-review-live-${crypto.randomUUID()}`;
}

async function review(
  tx: Tx,
  input: {
    context: AuthorizedCommandContext;
    runId: string;
    entryId: string;
    fields?: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey?: string;
    recheck?: boolean;
  },
) {
  return bus(tx, { recheck: input.recheck }).execute<unknown, JsonObject>({
    name: "review_legacy_import_entry",
    context: input.context,
    input: {
      organizationId: input.context.organizationId,
      runId: input.runId,
      entryId: input.entryId,
      decision: "skip",
      ...input.fields,
    },
    meta: {
      idempotencyKey: input.idempotencyKey ?? key(),
      expectedVersion: input.expectedVersion ?? 1,
    },
  });
}

/**
 * A split, composed as the split handler composes it
 * (`packages/core/src/import-split.ts`, `splitImportEntry`), in one
 * transaction: the credential re-checked by `assertCurrent` under the
 * deployment's operator switch, then the scope, the organisation and the
 * member acting (`importReviewTarget`), then the port's owner-or-admin check
 * for that member, then the split, recording who acted and confined to a
 * bound operator's project, with the form's fingerprint secret.
 */
async function splitAsTheHandlerDoes(
  tx: Tx,
  input: {
    context: AuthorizedCommandContext;
    organizationId?: string;
    runId: string;
    entryId: string;
    splitLines?: number[];
    expectedVersion?: number;
    idempotencyKey?: string;
    recheck?: boolean;
    operatorCredentials?: "enabled" | "disabled" | undefined;
  },
) {
  // The handler's own transaction ends the binding its re-check and port
  // take; here it is ended when the split settles.
  try {
    if (input.recheck !== false)
      await createCommandAuthorizationRepository(tx, {
        operatorCredentials:
          "operatorCredentials" in input
            ? input.operatorCredentials
            : operatorCredentials,
      }).assertCurrent(input.context);
    const target = importReviewTarget(input.context, {
      organizationId: input.organizationId ?? input.context.organizationId,
    });
    const port = createImportReviewCommandRepository(tx);
    await port.authorize({
      userId: target.userId,
      organizationId: target.organizationId,
    });
    const splitLines = input.splitLines ?? [2];
    return await port.splitEntry({
      organizationId: target.organizationId,
      runId: input.runId,
      entryId: input.entryId,
      splitLines,
      segment: (body) => segmentsAt(splitLines, body),
      userId: target.userId,
      actor: target.actor,
      credentialProjectId: target.credentialProjectId,
      expectedVersion: input.expectedVersion ?? 1,
      idempotencyKey: input.idempotencyKey ?? key(),
      fingerprintSecret: formSecret,
    });
  } finally {
    await endTenantBinding(tx);
  }
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the request was not refused");
}

function expectRefused(
  error: unknown,
  code: string,
  message?: string,
): asserts error is DomainError {
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (message !== undefined)
    expect((error as DomainError).message).toBe(message);
}

async function entriesOf(tx: Tx, runId: string) {
  return tx
    .select({
      id: importManifestEntries.id,
      version: importManifestEntries.version,
      decision: importManifestEntries.decision,
      reviewerId: importManifestEntries.reviewerId,
      proposedCanonicalId: importManifestEntries.proposedCanonicalId,
      bodyMarkdown: sql<string>`${importManifestEntries.parsedJson} ->> 'bodyMarkdown'`,
      targetProjectId: sql<
        string | null
      >`${importManifestEntries.parsedJson} ->> 'targetProjectId'`,
      reviewedRelationships: sql<unknown>`${importManifestEntries.parsedJson} -> 'reviewedRelationships'`,
    })
    .from(importManifestEntries)
    .where(eq(importManifestEntries.importRunId, runId))
    .orderBy(importManifestEntries.recordIndex);
}

async function entryOf(tx: Tx, runId: string, entryId: string) {
  return (await entriesOf(tx, runId)).find((entry) => entry.id === entryId);
}

async function receiptsFor(tx: Tx, commandName: string, userId: string) {
  return tx
    .select({
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
      resultJson: commandReceipts.resultJson,
    })
    .from(commandReceipts)
    .where(
      and(
        eq(commandReceipts.commandName, commandName),
        eq(
          commandReceipts.actorFingerprint,
          actorFingerprint({ type: "user", id: userId }),
        ),
      ),
    );
}

/**
 * Every receipt this case's transaction wrote, under any command name and
 * any actor. A receipt takes `created_at` from `now()`, which inside a
 * transaction is its start time, shared by every savepoint in it; a row
 * another suite committed carries its own transaction's time.
 */
async function receiptsWrittenHere(tx: Tx) {
  return tx
    .select({
      commandName: commandReceipts.commandName,
      actorFingerprint: commandReceipts.actorFingerprint,
      idempotencyFingerprint: commandReceipts.idempotencyFingerprint,
    })
    .from(commandReceipts)
    .where(sql`${commandReceipts.createdAt} = now()`);
}

async function seedRequest(tx: Tx, organizationId: string, projectId: string) {
  const [request] = await tx
    .insert(requests)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      sequenceNumber: Math.floor(Math.random() * 1_000_000_000),
      displayKey: `IMP-${crypto.randomUUID()}`,
      sourceKind: "human_direct",
      sourceProjectId: null,
      targetProjectId: projectId,
      type: "feature",
      title: "An existing request",
      descriptionMd: "Already tracked.",
      state: "submitted",
      reporterType: "user",
      reporterId: "import-review-seed",
      visibility: "organization",
      sensitivity: "normal",
      version: 1,
      submittedAt: new Date(),
    })
    .returning({ id: requests.id });
  if (!request) throw new Error("no request");
  return request.id;
}

/** An organisation with an active owner, a project and a reviewing run. */
async function seedTenant(tx: Tx, role: "owner" | "admin" = "owner") {
  const organizationId = await seedOrganization(tx);
  const actor = await seedUser(tx);
  await seedMembership(tx, organizationId, actor.userId, role);
  const projectId = await seedProject(tx, organizationId);
  const seeded = await seedReviewingRun(tx, {
    organizationId,
    projectId,
    body: bundle,
  });
  return {
    organizationId,
    projectId,
    actor,
    context: humanContext({ ...actor, organizationId }),
    ...seeded,
  };
}

/** A second organisation in which `userId` is also an owner, with its own run. */
async function seedForeignTenant(tx: Tx, userId: string) {
  const organizationId = await seedOrganization(tx);
  await seedMembership(tx, organizationId, userId, "owner");
  const projectId = await seedProject(tx, organizationId);
  const seeded = await seedReviewingRun(tx, {
    organizationId,
    projectId,
    body: bundle,
  });
  return { organizationId, projectId, ...seeded };
}

async function setMembership(
  tx: Tx,
  organizationId: string,
  userId: string,
  change: { role?: "owner" | "admin" | "member"; status?: "revoked" },
) {
  await tx
    .update(organizationMembers)
    .set(change)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
}

async function suspend(tx: Tx, organizationId: string) {
  await tx.execute(
    sql`update "organizations" set "status" = 'suspended' where "id" = ${organizationId}`,
  );
}

async function endSession(tx: Tx, sessionId: string) {
  await tx
    .update(session)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(session.id, sessionId));
}

const machineActors: Array<[string, AuthorizedCommandContext["actor"]]> = [
  ["an agent", { type: "agent", id: crypto.randomUUID() }],
  [
    "a service actor",
    {
      type: "service",
      id: `operator:${crypto.randomUUID()}`,
      originatingActor: { type: "user", id: "user_import_review_origin" },
    },
  ],
];

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("reviewing an import entry through the command bus", () => {
  test.each([
    ["an organisation owner", "owner"],
    ["an organisation admin", "admin"],
  ] as const)("%s records a decision, as the reviewer", async (_, role) => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx, role);

      const result = await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        fields: { decision: "create", targetProjectId: tenant.projectId },
      });

      expect(result).toEqual({ id: tenant.entryId, version: 2 });
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 2,
        decision: "create",
        reviewerId: tenant.actor.userId,
        targetProjectId: tenant.projectId,
      });
    });
  });

  test.each([
    ["an organisation member", "member", undefined],
    ["a revoked owner", "owner", "revoked"],
  ] as const)(
    "%s is refused, and nothing is written",
    async (_, role, status) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const reviewer = await seedUser(tx);
        await seedMembership(
          tx,
          tenant.organizationId,
          reviewer.userId,
          role,
          status,
        );

        const refused = await refusal(
          review(tx, {
            context: humanContext({
              ...reviewer,
              organizationId: tenant.organizationId,
            }),
            runId: tenant.runId,
            entryId: tenant.entryId,
          }),
        );

        expectRefused(refused, "forbidden");
        expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
          version: 1,
          decision: "pending",
          reviewerId: null,
        });
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test("a suspended organisation and an ended session are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const suspended = await seedTenant(tx);
      await suspend(tx, suspended.organizationId);
      expectRefused(
        await refusal(
          review(tx, {
            context: suspended.context,
            runId: suspended.runId,
            entryId: suspended.entryId,
          }),
        ),
        "forbidden",
        "Current human authorization is no longer active",
      );

      const ended = await seedTenant(tx);
      await endSession(tx, ended.actor.sessionId);
      expectRefused(
        await refusal(
          review(tx, {
            context: ended.context,
            runId: ended.runId,
            entryId: ended.entryId,
          }),
        ),
        "forbidden",
        "Current human authorization is no longer active",
      );
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("another organisation's run or entry is not found for an owner of both, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedForeignTenant(tx, home.actor.userId);

      expectRefused(
        await refusal(
          review(tx, {
            context: home.context,
            runId: foreign.runId,
            entryId: foreign.entryId,
          }),
        ),
        "not_found",
        "Import run was not found",
      );
      expectRefused(
        await refusal(
          review(tx, {
            context: home.context,
            runId: home.runId,
            entryId: foreign.entryId,
          }),
        ),
        "not_found",
        "Import entry was not found",
      );
      expect(await entryOf(tx, foreign.runId, foreign.entryId)).toMatchObject({
        version: 1,
        decision: "pending",
      });
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("without import:write the refusal names the scope, and another organisation in the input is refused", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const withoutScope = await refusal(
        review(tx, {
          context: humanContext({
            ...tenant.actor,
            organizationId: tenant.organizationId,
            scopes: ["project:manage"],
          }),
          runId: tenant.runId,
          entryId: tenant.entryId,
        }),
      );
      expectRefused(withoutScope, "forbidden");
      expect(withoutScope.details).toMatchObject({ scope: "import:write" });

      const foreign = await seedForeignTenant(tx, tenant.actor.userId);
      expectRefused(
        await refusal(
          bus(tx).execute({
            name: "review_legacy_import_entry",
            context: tenant.context,
            input: {
              organizationId: foreign.organizationId,
              runId: foreign.runId,
              entryId: foreign.entryId,
              decision: "skip",
            },
            meta: { idempotencyKey: key(), expectedVersion: 1 },
          }),
        ),
        "forbidden",
      );
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test.each(machineActors)(
    "%s holding import:write is refused by the command itself",
    async (_, actor) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        expectRefused(
          await refusal(
            review(tx, {
              context: {
                ...tenant.context,
                actor,
                projectId: tenant.projectId,
              },
              runId: tenant.runId,
              entryId: tenant.entryId,
              recheck: false,
            }),
          ),
          "forbidden",
          "Import review requires a person or an operator credential",
        );
        expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
          version: 1,
          decision: "pending",
        });
      });
    },
  );

  test("a stale version answers version_conflict, and a run no longer in review answers conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expectRefused(
        await refusal(
          review(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            expectedVersion: 2,
          }),
        ),
        "version_conflict",
      );
      await tx
        .update(importRuns)
        .set({ state: "approved" })
        .where(eq(importRuns.id, tenant.runId));
      expectRefused(
        await refusal(
          review(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
          }),
        ),
        "conflict",
      );
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 1,
        decision: "pending",
      });
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("each decision is checked against the organisation's own projects and requests", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const foreign = await seedForeignTenant(tx, tenant.actor.userId);
      const ownRequest = await seedRequest(
        tx,
        tenant.organizationId,
        tenant.projectId,
      );
      const otherRequest = await seedRequest(
        tx,
        tenant.organizationId,
        tenant.projectId,
      );
      const foreignRequest = await seedRequest(
        tx,
        foreign.organizationId,
        foreign.projectId,
      );
      const refusedWith = async (
        fields: Record<string, unknown>,
        message: string,
      ) =>
        expectRefused(
          await refusal(
            review(tx, {
              context: tenant.context,
              runId: tenant.runId,
              entryId: tenant.entryId,
              fields,
            }),
          ),
          "validation_failed",
          message,
        );

      await refusedWith(
        { decision: "create" },
        "A created import entry requires one target project",
      );
      await refusedWith(
        { decision: "create", targetProjectId: foreign.projectId },
        "Import target project is unavailable",
      );
      await refusedWith(
        { decision: "map_existing" },
        "This import decision requires a canonical request",
      );
      await refusedWith(
        { decision: "map_existing", proposedCanonicalId: foreignRequest },
        "Canonical import request is unavailable",
      );
      await refusedWith(
        {
          decision: "map_existing",
          proposedCanonicalId: ownRequest,
          relationships: [
            { type: "related_to", targetRequestId: foreignRequest },
          ],
        },
        "An import relationship target is unavailable",
      );
      await refusedWith(
        {
          decision: "skip",
          relationships: [{ type: "related_to", targetRequestId: ownRequest }],
        },
        "Only imported or mapped requests may define relationships",
      );
      expect(await receiptsWrittenHere(tx)).toEqual([]);

      const relationships = [{ type: "blocks", targetRequestId: otherRequest }];
      expect(
        await review(tx, {
          context: tenant.context,
          runId: tenant.runId,
          entryId: tenant.entryId,
          fields: {
            decision: "map_existing",
            proposedCanonicalId: ownRequest,
            relationships,
          },
        }),
      ).toEqual({ id: tenant.entryId, version: 2 });
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        decision: "map_existing",
        proposedCanonicalId: ownRequest,
        reviewedRelationships: relationships,
      });
    });
  });

  test("a replay answers the first result from the bus's one receipt; other input under the key is idempotency_conflict", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const first = await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });
      const replay = await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });

      expect(replay).toEqual(first);
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 2,
        decision: "skip",
      });
      expectRefused(
        await refusal(
          review(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            fields: { decision: "blocked" },
            idempotencyKey,
          }),
        ),
        "idempotency_conflict",
      );
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 2,
        decision: "skip",
      });
    });
  });

  test("a replay after the reviewer is demoted is refused, not answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });
      await setMembership(tx, tenant.organizationId, tenant.actor.userId, {
        role: "member",
      });

      expectRefused(
        await refusal(
          review(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            idempotencyKey,
          }),
        ),
        "forbidden",
      );
    });
  });

  /*
    The bus answers a replay right after `authorize`, before `execute` reads
    the run. The form's repository write used to read the run and the entry
    first, so a replay after the run left review answered `conflict`, and
    one after the run was gone answered `not_found`. Now both answer the
    first result, and write nothing.
  */
  test("a replay after the run left review, or after it was deleted, answers the first result", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const first = await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });
      await tx
        .update(importRuns)
        .set({ state: "approved" })
        .where(eq(importRuns.id, tenant.runId));
      expect(
        await review(tx, {
          context: tenant.context,
          runId: tenant.runId,
          entryId: tenant.entryId,
          idempotencyKey,
        }),
      ).toEqual(first);

      await tx.delete(importRuns).where(eq(importRuns.id, tenant.runId));
      expect(
        await review(tx, {
          context: tenant.context,
          runId: tenant.runId,
          entryId: tenant.entryId,
          idempotencyKey,
        }),
      ).toEqual(first);
      expect(await entriesOf(tx, tenant.runId)).toEqual([]);
    });
  });

  test("each review leaves exactly one receipt, the bus's, under any name and any actor", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const result = await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });
      await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });

      expect(
        await receiptsFor(
          tx,
          "review_legacy_import_entry",
          tenant.actor.userId,
        ),
      ).toEqual([
        {
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
          resultJson: result,
        },
      ]);
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          commandName: "review_legacy_import_entry",
          actorFingerprint: actorFingerprint({
            type: "user",
            id: tenant.actor.userId,
          }),
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
        },
      ]);
    });
  });

  /*
    Across the deploy. A review submitted before it left the repository's
    receipt, keyed with the form's secret; its retry after it, with the same
    key, misses the bus's receipt and runs, and meets the entry at the
    version the first review left: version_conflict, writing nothing. The
    other way, a retry on the previous build misses this build's receipt, the
    bus's, and meets the same version check.
  */
  test("a review submitted before the deploy and retried after it with the same key answers version_conflict, and writes nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      await tx
        .update(importManifestEntries)
        .set({
          decision: "skip",
          version: 2,
          reviewerId: tenant.actor.userId,
        })
        .where(eq(importManifestEntries.id, tenant.entryId));
      await tx.insert(commandReceipts).values({
        actorFingerprint: actorFingerprint({
          type: "user",
          id: tenant.actor.userId,
        }),
        commandName: "review_legacy_import_entry",
        idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
        normalizedInputHash: normalizedInputHash({
          runId: tenant.runId,
          entryId: tenant.entryId,
          decision: "skip",
          proposedCanonicalId: null,
          targetProjectId: null,
          relationships: [],
        }),
        aggregateId: tenant.entryId,
        resultJson: { id: tenant.entryId, version: 2 },
        expiresAt: new Date(Date.now() + 60_000),
      });

      expectRefused(
        await refusal(
          review(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            idempotencyKey,
          }),
        ),
        "version_conflict",
      );
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 2,
        decision: "skip",
      });
    });
  });

  test("resolves the entry's open conflicts in the reviewer's name", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await tx.insert(importConflicts).values({
        organizationId: tenant.organizationId,
        importRunId: tenant.runId,
        entryId: tenant.entryId,
        kind: "possible_duplicate",
        severity: "blocking",
        details: {},
      });

      await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
      });

      const [conflict] = await tx
        .select({
          resolvedBy: importConflicts.resolvedBy,
          resolution: importConflicts.resolution,
        })
        .from(importConflicts)
        .where(eq(importConflicts.entryId, tenant.entryId));
      expect(conflict).toMatchObject({
        resolvedBy: tenant.actor.userId,
        resolution: { decision: "skip" },
      });
    });
  });
});

describe.sequential("splitting an import entry through its handler", () => {
  test.each([
    ["an organisation owner", "owner"],
    ["an organisation admin", "admin"],
  ] as const)("%s splits a bundle into records", async (_, role) => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx, role);

      const result = await splitAsTheHandlerDoes(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
      });

      expect(result.entryIds).toHaveLength(2);
      expect(result.entryIds[0]).toBe(tenant.entryId);
      expect(
        (await entriesOf(tx, tenant.runId)).map(
          ({ bodyMarkdown, version, decision }) => ({
            bodyMarkdown,
            version,
            decision,
          }),
        ),
      ).toEqual([
        {
          bodyMarkdown: "First record line\n",
          version: 2,
          decision: "pending",
        },
        {
          bodyMarkdown: "Second record line\nThird record line\n",
          version: 1,
          decision: "pending",
        },
      ]);
    });
  });

  test.each([
    ["an organisation member", "member", undefined],
    ["a revoked owner", "owner", "revoked"],
  ] as const)(
    "%s is refused, and nothing is written",
    async (_, role, status) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const reviewer = await seedUser(tx);
        await seedMembership(
          tx,
          tenant.organizationId,
          reviewer.userId,
          role,
          status,
        );

        expectRefused(
          await refusal(
            splitAsTheHandlerDoes(tx, {
              context: humanContext({
                ...reviewer,
                organizationId: tenant.organizationId,
              }),
              runId: tenant.runId,
              entryId: tenant.entryId,
            }),
          ),
          "forbidden",
        );
        expect(await entriesOf(tx, tenant.runId)).toHaveLength(1);
        expect(await receiptsWrittenHere(tx)).toEqual([]);
      });
    },
  );

  test("the port's own split refuses a member even when the caller skipped its check", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const member = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, member.userId, "member");

      expectRefused(
        await refusal(
          createImportReviewCommandRepository(tx).splitEntry({
            organizationId: tenant.organizationId,
            runId: tenant.runId,
            entryId: tenant.entryId,
            splitLines: [2],
            segment: (body) => segmentsAt([2], body),
            userId: member.userId,
            actor: { type: "user", id: member.userId },
            credentialProjectId: null,
            expectedVersion: 1,
            idempotencyKey: key(),
            fingerprintSecret: formSecret,
          }),
        ),
        "forbidden",
      );
      expectRefused(
        await refusal(
          createImportReviewCommandRepository(tx).reviewEntry(
            {
              userId: member.userId,
              organizationId: tenant.organizationId,
              actor: { type: "user", id: member.userId },
              credentialProjectId: null,
              expectedVersion: 1,
            },
            {
              runId: tenant.runId,
              entryId: tenant.entryId,
              decision: "skip",
              proposedCanonicalId: null,
              targetProjectId: null,
              relationships: [],
            },
          ),
        ),
        "forbidden",
      );
      expect(await entriesOf(tx, tenant.runId)).toHaveLength(1);
    });
  });

  test("a suspended organisation and an ended session are refused by the re-check", async () => {
    await inRollbackTransaction(async (tx) => {
      const suspended = await seedTenant(tx);
      await suspend(tx, suspended.organizationId);
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: suspended.context,
            runId: suspended.runId,
            entryId: suspended.entryId,
          }),
        ),
        "forbidden",
        "Current human authorization is no longer active",
      );

      const ended = await seedTenant(tx);
      await endSession(tx, ended.actor.sessionId);
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: ended.context,
            runId: ended.runId,
            entryId: ended.entryId,
          }),
        ),
        "forbidden",
        "Current human authorization is no longer active",
      );
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("another organisation's run or entry is not found for an owner of both, and nothing is written", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedForeignTenant(tx, home.actor.userId);

      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: home.context,
            runId: foreign.runId,
            entryId: foreign.entryId,
          }),
        ),
        "not_found",
        "Import run was not found",
      );
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: home.context,
            runId: home.runId,
            entryId: foreign.entryId,
          }),
        ),
        "not_found",
        "Import entry was not found",
      );
      expect(await entriesOf(tx, foreign.runId)).toHaveLength(1);
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("without import:write, with another organisation in the input, or as a machine, the split is refused before the port is asked", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const foreign = await seedForeignTenant(tx, tenant.actor.userId);
      const withoutScope = await refusal(
        splitAsTheHandlerDoes(tx, {
          context: humanContext({
            ...tenant.actor,
            organizationId: tenant.organizationId,
            scopes: ["project:manage"],
          }),
          runId: tenant.runId,
          entryId: tenant.entryId,
        }),
      );
      expectRefused(withoutScope, "forbidden");
      expect(withoutScope.details).toMatchObject({ scope: "import:write" });
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: tenant.context,
            organizationId: foreign.organizationId,
            runId: foreign.runId,
            entryId: foreign.entryId,
          }),
        ),
        "forbidden",
      );
      for (const [, actor] of machineActors) {
        expectRefused(
          await refusal(
            splitAsTheHandlerDoes(tx, {
              context: { ...tenant.context, actor },
              runId: tenant.runId,
              entryId: tenant.entryId,
              recheck: false,
            }),
          ),
          "forbidden",
          "Import review requires a person or an operator credential",
        );
      }
      expect(await entriesOf(tx, tenant.runId)).toHaveLength(1);
      expect(await entriesOf(tx, foreign.runId)).toHaveLength(1);
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("a stale version, a decided entry, a second split and a line outside the record are refused as today", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            expectedVersion: 2,
          }),
        ),
        "version_conflict",
      );
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            splitLines: [4],
          }),
        ),
        "validation_failed",
        "A split line is outside the preserved record",
      );

      const split = await splitAsTheHandlerDoes(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
      });
      const [, second] = split.entryIds;
      if (!second) throw new Error("no second entry");
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: second,
          }),
        ),
        "conflict",
        "A manually split entry cannot be split a second time",
      );

      const decided = await seedTenant(tx);
      await review(tx, {
        context: decided.context,
        runId: decided.runId,
        entryId: decided.entryId,
      });
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: decided.context,
            runId: decided.runId,
            entryId: decided.entryId,
            expectedVersion: 2,
          }),
        ),
        "conflict",
        "Only an unresolved import entry can be split",
      );
    });
  });

  test("a split retried with its idempotency key answers the split it made, and writes nothing more", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const request = {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      };

      const first = await splitAsTheHandlerDoes(tx, request);
      const afterFirst = await entriesOf(tx, tenant.runId);
      const replay = await splitAsTheHandlerDoes(tx, request);

      expect(replay).toEqual(first);
      expect(await entriesOf(tx, tenant.runId)).toEqual(afterFirst);
      expect(
        await receiptsFor(tx, "split_legacy_import_entry", tenant.actor.userId),
      ).toEqual([
        {
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
          resultJson: first,
        },
      ]);
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          commandName: "split_legacy_import_entry",
          actorFingerprint: actorFingerprint({
            type: "user",
            id: tenant.actor.userId,
          }),
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
        },
      ]);

      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, { ...request, splitLines: [3] }),
        ),
        "idempotency_conflict",
      );
    });
  });

  test("a replay after the reviewer is demoted is refused, not answered", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const request = {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      };
      await splitAsTheHandlerDoes(tx, request);
      await setMembership(tx, tenant.organizationId, tenant.actor.userId, {
        role: "member",
      });

      expectRefused(
        await refusal(splitAsTheHandlerDoes(tx, request)),
        "forbidden",
      );
    });
  });

  /*
    Unlike review's. The bus answers a review's replay before `execute`
    reads the run, so that replay answers the first result whatever became
    of the run. `splitEntry` locks and checks the run and the entry before
    it answers from its receipt, so a split's replay after the run left
    review is refused as `conflict`, and after the run was deleted as
    `not_found`. Either way it writes nothing.
  */
  test("a replay after the run left review answers conflict, and after it was deleted not_found, writing nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const request = {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      };
      await splitAsTheHandlerDoes(tx, request);
      const receipts = await receiptsWrittenHere(tx);
      expect(receipts).toHaveLength(1);

      await tx
        .update(importRuns)
        .set({ state: "approved" })
        .where(eq(importRuns.id, tenant.runId));
      const afterSplit = await entriesOf(tx, tenant.runId);
      expectRefused(
        await refusal(splitAsTheHandlerDoes(tx, request)),
        "conflict",
        "Only a reviewing import can split a bundle",
      );
      expect(await entriesOf(tx, tenant.runId)).toEqual(afterSplit);
      expect(await receiptsWrittenHere(tx)).toEqual(receipts);

      await tx.delete(importRuns).where(eq(importRuns.id, tenant.runId));
      expectRefused(
        await refusal(splitAsTheHandlerDoes(tx, request)),
        "not_found",
        "Import run was not found",
      );
      expect(await entriesOf(tx, tenant.runId)).toEqual([]);
      expect(await receiptsWrittenHere(tx)).toEqual(receipts);
    });
  });

  /*
    Across the deploy that re-keyed the split's receipt (`splitEntry`'s
    comment). A split submitted before it left a receipt keyed by the
    segments' hashes; its retry after it, with the same key, is keyed by the
    lines and meets that receipt as other input. Before the deploy that
    retry was refused too, because the entry no longer held the record it
    had cut.
  */
  test("a retry of a split made before the receipt was re-keyed answers idempotency_conflict, and writes nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const idempotencyKey = key();
      const earlierSegments = segmentsAt([2], bundle);
      await tx.insert(commandReceipts).values({
        actorFingerprint: actorFingerprint({
          type: "user",
          id: tenant.actor.userId,
        }),
        commandName: "split_legacy_import_entry",
        idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
        normalizedInputHash: normalizedInputHash({
          runId: tenant.runId,
          entryId: tenant.entryId,
          segmentHashes: earlierSegments.map((segment) =>
            createHash("sha256").update(canonicalJson(segment)).digest("hex"),
          ),
        }),
        aggregateId: tenant.entryId,
        resultJson: { entryIds: [tenant.entryId, crypto.randomUUID()] },
        expiresAt: new Date(Date.now() + 60_000),
      });
      const before = await entriesOf(tx, tenant.runId);

      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            idempotencyKey,
          }),
        ),
        "idempotency_conflict",
      );
      expect(await entriesOf(tx, tenant.runId)).toEqual(before);
    });
  });
});

/*
  Plan 13, F.2.6's registry half: an operator credential reviews and splits
  through the same bus and the same handler composition, acting with its
  issuing member's live role and recorded as its own `service` actor —
  the entry's reviewer, a conflict's resolver and the receipt's holder are
  `operator:<lineage>`, never the member. A credential bound to a project is
  held to the runs whose source is that project, and to that project and its
  requests as a decision's targets. Credentials are issued for real through
  F.3's repository, with the switch on.
*/

/**
 * Issues an operator credential for `userId` in `organizationId`, holding
 * `import:write` unless told otherwise, as F.3's repository writes one, with
 * the Better Auth key row it is bound to.
 */
async function issueOperator(
  tx: Tx,
  input: {
    organizationId: string;
    userId: string;
    projectId?: string | null;
    scopes?: string[];
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
    name: "Import review operator",
    prefix: "rpo_f26",
    fingerprint: `fingerprint_${crypto.randomUUID()}`,
    scopes: input.scopes ?? ["import:write"],
    expiresInDays: 30,
    correlationId: crypto.randomUUID(),
  });
  return { ...credential, apiKeyId };
}

/** The context `authenticateApiBearer` builds for an operator credential. */
function operatorContext(
  credential: Awaited<ReturnType<typeof issueOperator>>,
): AuthorizedCommandContext {
  return {
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
}

async function conflictsOf(tx: Tx, runId: string) {
  return tx
    .select({
      entryId: importConflicts.entryId,
      resolvedBy: importConflicts.resolvedBy,
    })
    .from(importConflicts)
    .where(eq(importConflicts.importRunId, runId));
}

async function seedOpenConflict(
  tx: Tx,
  tenant: { organizationId: string; runId: string; entryId: string },
) {
  await tx.insert(importConflicts).values({
    organizationId: tenant.organizationId,
    importRunId: tenant.runId,
    entryId: tenant.entryId,
    kind: "possible_duplicate",
    severity: "blocking",
    details: {},
  });
}

type Changed = {
  organizationId: string;
  userId: string;
  credentialId: string;
  apiKeyId: string;
};

const operatorChanges: Array<
  [string, (tx: Tx, ids: Changed) => Promise<void>]
> = [
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
      await setMembership(tx, organizationId, userId, { role: "member" });
    },
  ],
  [
    "its member's membership is revoked",
    async (tx, { organizationId, userId }) => {
      await setMembership(tx, organizationId, userId, { status: "revoked" });
    },
  ],
  [
    "the organisation is suspended",
    async (tx, { organizationId }) => {
      await suspend(tx, organizationId);
    },
  ],
];

/** A second reviewing run in the tenant, whose source is `projectId`. */
async function seedRunIn(
  tx: Tx,
  tenant: { organizationId: string },
  projectId: string,
) {
  return seedReviewingRun(tx, {
    organizationId: tenant.organizationId,
    projectId,
    body: bundle,
  });
}

describe.sequential("an operator credential reviewing an import entry", () => {
  test("an owner's organisation-wide operator records a decision as itself, and the receipt is its own", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
      });
      const context = operatorContext(credential);
      await seedOpenConflict(tx, tenant);
      const idempotencyKey = key();

      const first = await review(tx, {
        context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        fields: { decision: "create", targetProjectId: tenant.projectId },
        idempotencyKey,
      });

      expect(first).toEqual({ id: tenant.entryId, version: 2 });
      const operatorId = `operator:${credential.lineageId}`;
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 2,
        decision: "create",
        reviewerId: operatorId,
        targetProjectId: tenant.projectId,
      });
      expect(await conflictsOf(tx, tenant.runId)).toEqual([
        { entryId: tenant.entryId, resolvedBy: operatorId },
      ]);

      // The operator's replay is answered from its own receipt.
      expect(
        await review(tx, {
          context: operatorContext(credential),
          runId: tenant.runId,
          entryId: tenant.entryId,
          fields: { decision: "create", targetProjectId: tenant.projectId },
          idempotencyKey,
        }),
      ).toEqual(first);
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          commandName: "review_legacy_import_entry",
          actorFingerprint: actorFingerprint(context.actor),
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
        },
      ]);
      // The member's own retry with the operator's key is not answered from
      // it: it runs, and meets the version the operator left.
      expectRefused(
        await refusal(
          review(tx, {
            context: tenant.context,
            runId: tenant.runId,
            entryId: tenant.entryId,
            fields: { decision: "create", targetProjectId: tenant.projectId },
            idempotencyKey,
          }),
        ),
        "version_conflict",
      );
      expect(
        await receiptsFor(
          tx,
          "review_legacy_import_entry",
          tenant.actor.userId,
        ),
      ).toEqual([]);
    });
  });

  test("a person's review still records the person, as a user", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await seedOpenConflict(tx, tenant);
      const idempotencyKey = key();
      await review(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        reviewerId: tenant.actor.userId,
      });
      expect(await conflictsOf(tx, tenant.runId)).toEqual([
        { entryId: tenant.entryId, resolvedBy: tenant.actor.userId },
      ]);
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          commandName: "review_legacy_import_entry",
          actorFingerprint: actorFingerprint({
            type: "user",
            id: tenant.actor.userId,
          }),
          idempotencyFingerprint: keyedFingerprint(busSecret, idempotencyKey),
        },
      ]);
    });
  });

  test("an admin's operator reviews, and a member's is refused, writing nothing", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const admin = await seedUser(tx);
      await seedMembership(tx, tenant.organizationId, admin.userId, "admin");
      const adminOperator = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: admin.userId,
      });
      expect(
        await review(tx, {
          context: operatorContext(adminOperator),
          runId: tenant.runId,
          entryId: tenant.entryId,
        }),
      ).toEqual({ id: tenant.entryId, version: 2 });

      // F.3 issues no credential to a plain member, so the admin is demoted
      // after issuance: the credential stays, the member's role does not.
      const second = await seedRunIn(tx, tenant, tenant.projectId);
      await setMembership(tx, tenant.organizationId, admin.userId, {
        role: "member",
      });
      expectRefused(
        await refusal(
          review(tx, {
            context: operatorContext(adminOperator),
            runId: second.runId,
            entryId: second.entryId,
          }),
        ),
        "forbidden",
      );
      expect(await entryOf(tx, second.runId, second.entryId)).toMatchObject({
        version: 1,
        decision: "pending",
        reviewerId: null,
      });
    });
  });

  test("an operator bound to a project reviews that project's runs, and finds no run of another project of its organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const otherProjectId = await seedProject(tx, tenant.organizationId);
      const elsewhere = await seedRunIn(tx, tenant, otherProjectId);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
        projectId: tenant.projectId,
      });

      expect(
        await review(tx, {
          context: operatorContext(credential),
          runId: tenant.runId,
          entryId: tenant.entryId,
          fields: { decision: "create", targetProjectId: tenant.projectId },
        }),
      ).toEqual({ id: tenant.entryId, version: 2 });
      expectRefused(
        await refusal(
          review(tx, {
            context: operatorContext(credential),
            runId: elsewhere.runId,
            entryId: elsewhere.entryId,
          }),
        ),
        "not_found",
        "Import run was not found",
      );
      expect(
        await entryOf(tx, elsewhere.runId, elsewhere.entryId),
      ).toMatchObject({ version: 1, decision: "pending", reviewerId: null });
    });
  });

  test("an operator bound to a project may name only that project and its requests as a decision's targets", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const otherProjectId = await seedProject(tx, tenant.organizationId);
      const ownRequest = await seedRequest(
        tx,
        tenant.organizationId,
        tenant.projectId,
      );
      const otherRequest = await seedRequest(
        tx,
        tenant.organizationId,
        otherProjectId,
      );
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
        projectId: tenant.projectId,
      });
      const refusedWith = async (
        fields: Record<string, unknown>,
        message: string,
      ) =>
        expectRefused(
          await refusal(
            review(tx, {
              context: operatorContext(credential),
              runId: tenant.runId,
              entryId: tenant.entryId,
              fields,
            }),
          ),
          "validation_failed",
          message,
        );

      await refusedWith(
        { decision: "create", targetProjectId: otherProjectId },
        "Import target project is unavailable",
      );
      await refusedWith(
        { decision: "map_existing", proposedCanonicalId: otherRequest },
        "Canonical import request is unavailable",
      );
      await refusedWith(
        {
          decision: "create",
          targetProjectId: tenant.projectId,
          relationships: [
            { type: "related_to", targetRequestId: otherRequest },
          ],
        },
        "An import relationship target is unavailable",
      );
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 1,
        decision: "pending",
      });

      // An organisation-wide operator of the same member names either.
      const wide = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
      });
      expect(
        await review(tx, {
          context: operatorContext(wide),
          runId: tenant.runId,
          entryId: tenant.entryId,
          fields: {
            decision: "map_existing",
            proposedCanonicalId: otherRequest,
            relationships: [
              { type: "related_to", targetRequestId: ownRequest },
            ],
          },
        }),
      ).toEqual({ id: tenant.entryId, version: 2 });

      // And the bound one names its own project's.
      expect(
        await review(tx, {
          context: operatorContext(credential),
          runId: tenant.runId,
          entryId: tenant.entryId,
          fields: {
            decision: "map_existing",
            proposedCanonicalId: ownRequest,
          },
          expectedVersion: 2,
        }),
      ).toEqual({ id: tenant.entryId, version: 3 });
    });
  });

  test("an operator issued for one organisation finds no run of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedForeignTenant(tx, home.actor.userId);
      const credential = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.actor.userId,
      });
      expectRefused(
        await refusal(
          review(tx, {
            context: operatorContext(credential),
            runId: foreign.runId,
            entryId: foreign.entryId,
          }),
        ),
        "not_found",
        "Import run was not found",
      );
      expectRefused(
        await refusal(
          bus(tx).execute({
            name: "review_legacy_import_entry",
            context: operatorContext(credential),
            input: {
              organizationId: foreign.organizationId,
              runId: foreign.runId,
              entryId: foreign.entryId,
              decision: "skip",
            },
            meta: { idempotencyKey: key(), expectedVersion: 1 },
          }),
        ),
        "forbidden",
      );
      expect(await entryOf(tx, foreign.runId, foreign.entryId)).toMatchObject({
        version: 1,
        decision: "pending",
      });
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test("an operator without import:write is refused, naming the scope", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
        scopes: ["project:read"],
      });
      const refused = await refusal(
        review(tx, {
          context: operatorContext(credential),
          runId: tenant.runId,
          entryId: tenant.entryId,
        }),
      );
      expectRefused(refused, "forbidden");
      expect(refused.details).toMatchObject({ scope: "import:write" });
    });
  });

  test.each(operatorChanges)(
    "is refused once %s, having succeeded before, and writes nothing",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.actor.userId,
        });
        const second = await seedRunIn(tx, tenant, tenant.projectId);
        await review(tx, {
          context: operatorContext(credential),
          runId: tenant.runId,
          entryId: tenant.entryId,
        });
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.actor.userId,
          credentialId: credential.id,
          apiKeyId: credential.apiKeyId,
        });
        expectRefused(
          await refusal(
            review(tx, {
              context: operatorContext(credential),
              runId: second.runId,
              entryId: second.entryId,
            }),
          ),
          "forbidden",
        );
        expect(await entryOf(tx, second.runId, second.entryId)).toMatchObject({
          version: 1,
          decision: "pending",
          reviewerId: null,
        });
      });
    },
  );

  test("with the deployment's switch off, an operator is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
      });
      const switchedOff = new AtomicCommandBus({
        registry: createCoreCommandRegistry(),
        transactions: createCommandTransactionManager(
          tx as unknown as Database,
          (name, database) =>
            name === "importReviewCommands"
              ? createImportReviewCommandRepository(database)
              : name === "commandAuthorization"
                ? createCommandAuthorizationRepository(database)
                : undefined,
        ),
        fingerprintSecret: busSecret,
        authorizeContext: (context, uow) =>
          uow
            .port<ReturnType<typeof createCommandAuthorizationRepository>>(
              "commandAuthorization",
            )
            .assertCurrent(context),
      });
      expectRefused(
        await refusal(
          switchedOff.execute({
            name: "review_legacy_import_entry",
            context: operatorContext(credential),
            input: {
              organizationId: tenant.organizationId,
              runId: tenant.runId,
              entryId: tenant.entryId,
              decision: "skip",
            },
            meta: { idempotencyKey: key(), expectedVersion: 1 },
          }),
        ),
        "forbidden",
      );
      expect(await entryOf(tx, tenant.runId, tenant.entryId)).toMatchObject({
        version: 1,
        decision: "pending",
      });
    });
  });
});

describe.sequential("an operator credential splitting an import entry", () => {
  test("an owner's organisation-wide operator splits as itself, under a receipt of its own", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
      });
      const context = operatorContext(credential);
      await seedOpenConflict(tx, tenant);
      const idempotencyKey = key();
      const request = {
        context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      };

      const first = await splitAsTheHandlerDoes(tx, request);
      expect(first.entryIds).toHaveLength(2);
      const operatorId = `operator:${credential.lineageId}`;
      expect(
        (await conflictsOf(tx, tenant.runId)).filter(
          (conflict) => conflict.resolvedBy !== null,
        ),
      ).toEqual([{ entryId: tenant.entryId, resolvedBy: operatorId }]);

      const afterFirst = await entriesOf(tx, tenant.runId);
      expect(
        await splitAsTheHandlerDoes(tx, {
          ...request,
          context: operatorContext(credential),
        }),
      ).toEqual(first);
      expect(await entriesOf(tx, tenant.runId)).toEqual(afterFirst);
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          commandName: "split_legacy_import_entry",
          actorFingerprint: actorFingerprint(context.actor),
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
        },
      ]);

      // The member's own retry with the operator's key is not answered from
      // it: it runs, and meets the version the split left.
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, { ...request, context: tenant.context }),
        ),
        "version_conflict",
      );
      expect(
        await receiptsFor(tx, "split_legacy_import_entry", tenant.actor.userId),
      ).toEqual([]);
    });
  });

  test("a person's split still records the person, as a user", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      await seedOpenConflict(tx, tenant);
      const idempotencyKey = key();
      await splitAsTheHandlerDoes(tx, {
        context: tenant.context,
        runId: tenant.runId,
        entryId: tenant.entryId,
        idempotencyKey,
      });
      expect(
        (await conflictsOf(tx, tenant.runId)).filter(
          (conflict) => conflict.resolvedBy !== null,
        ),
      ).toEqual([{ entryId: tenant.entryId, resolvedBy: tenant.actor.userId }]);
      expect(await receiptsWrittenHere(tx)).toEqual([
        {
          commandName: "split_legacy_import_entry",
          actorFingerprint: actorFingerprint({
            type: "user",
            id: tenant.actor.userId,
          }),
          idempotencyFingerprint: keyedFingerprint(formSecret, idempotencyKey),
        },
      ]);
    });
  });

  test("an operator bound to a project splits that project's runs, and finds no run of another project of its organisation", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const otherProjectId = await seedProject(tx, tenant.organizationId);
      const elsewhere = await seedRunIn(tx, tenant, otherProjectId);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
        projectId: tenant.projectId,
      });

      expect(
        (
          await splitAsTheHandlerDoes(tx, {
            context: operatorContext(credential),
            runId: tenant.runId,
            entryId: tenant.entryId,
          })
        ).entryIds,
      ).toHaveLength(2);
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: operatorContext(credential),
            runId: elsewhere.runId,
            entryId: elsewhere.entryId,
          }),
        ),
        "not_found",
        "Import run was not found",
      );
      expect(await entriesOf(tx, elsewhere.runId)).toHaveLength(1);
    });
  });

  test("an operator issued for one organisation finds no run of another, though its member owns both", async () => {
    await inRollbackTransaction(async (tx) => {
      const home = await seedTenant(tx);
      const foreign = await seedForeignTenant(tx, home.actor.userId);
      const credential = await issueOperator(tx, {
        organizationId: home.organizationId,
        userId: home.actor.userId,
      });
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: operatorContext(credential),
            runId: foreign.runId,
            entryId: foreign.entryId,
          }),
        ),
        "not_found",
        "Import run was not found",
      );
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: operatorContext(credential),
            organizationId: foreign.organizationId,
            runId: foreign.runId,
            entryId: foreign.entryId,
          }),
        ),
        "forbidden",
      );
      expect(await entriesOf(tx, foreign.runId)).toHaveLength(1);
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });

  test.each(operatorChanges)(
    "is refused once %s, having succeeded before, and writes nothing",
    async (_, change) => {
      await inRollbackTransaction(async (tx) => {
        const tenant = await seedTenant(tx);
        const credential = await issueOperator(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.actor.userId,
        });
        const second = await seedRunIn(tx, tenant, tenant.projectId);
        await splitAsTheHandlerDoes(tx, {
          context: operatorContext(credential),
          runId: tenant.runId,
          entryId: tenant.entryId,
        });
        await change(tx, {
          organizationId: tenant.organizationId,
          userId: tenant.actor.userId,
          credentialId: credential.id,
          apiKeyId: credential.apiKeyId,
        });
        expectRefused(
          await refusal(
            splitAsTheHandlerDoes(tx, {
              context: operatorContext(credential),
              runId: second.runId,
              entryId: second.entryId,
            }),
          ),
          "forbidden",
        );
        expect(await entriesOf(tx, second.runId)).toHaveLength(1);
      });
    },
  );

  test("with the deployment's switch unset, an operator is refused before anything is read", async () => {
    await inRollbackTransaction(async (tx) => {
      const tenant = await seedTenant(tx);
      const credential = await issueOperator(tx, {
        organizationId: tenant.organizationId,
        userId: tenant.actor.userId,
      });
      expectRefused(
        await refusal(
          splitAsTheHandlerDoes(tx, {
            context: operatorContext(credential),
            runId: tenant.runId,
            entryId: tenant.entryId,
            operatorCredentials: undefined,
          }),
        ),
        "forbidden",
      );
      expect(await entriesOf(tx, tenant.runId)).toHaveLength(1);
      expect(await receiptsWrittenHere(tx)).toEqual([]);
    });
  });
});
