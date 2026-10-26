import {
  type AuditRecordInput,
  BOOTSTRAP_OWNER_ACTOR,
  bootstrapOwner,
  type FoundationRepository,
  OrganizationService,
  ProjectService,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  domainEvents,
  invitations,
  organizationAppearanceDefaults,
  organizationMembers,
  organizations,
  outbox,
  projectRepositories,
  projects,
  securityAuditRecords,
  signupAllowlist,
  user,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { ensureAppearanceCutover } from "../test-support/appearance-cutover.js";
import { openSession, type TestSession } from "../testing.js";
import type { Tx } from "../transaction.js";
import { createFoundationRepository } from "./foundation-repository.js";
import { createOrganizationManagementRepository } from "./organization-management-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

// Each case below choreographs several independent database connections through
// explicit lock barriers, and every barrier is a network round trip. Vitest's
// 5s default is a local-Postgres budget: against a remote branch these are the
// suites that time out in CI while passing locally. Bound them explicitly.
const lockChoreographyTimeoutMs = 30_000;

class TestRollback extends Error {}

const userContext = (
  userId: string,
  correlationId = `corr_${crypto.randomUUID()}`,
) => ({
  actor: { type: "user" as const, userId },
  correlationId,
});

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    });
  } catch (error) {
    if (error instanceof TestRollback) return;
    throw error;
  }
  throw new Error("Expected the foundation transaction to roll back");
}

async function rollback(client: TestSession) {
  await client.query("ROLLBACK").catch(() => undefined);
}

function databaseFailure(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "55000") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

async function waitForBlocked(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return settled;
}

function withoutAudit(repository: FoundationRepository): FoundationRepository {
  return {
    transaction: (run) =>
      repository.transaction((tx) =>
        run({
          ...tx,
          appendAuditRecord: async () => undefined,
          appendDomainEvent: async () => undefined,
        }),
      ),
  };
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live foundation repository", () => {
  test("commits organization, owner membership, and exactly one audit atomically", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const repository = createFoundationRepository(outerTx);
      const service = new OrganizationService({ repository });
      const result = await service.create(
        userContext(`user_${crypto.randomUUID()}`),
        {
          name: "Live organization",
          slug: `live-${crypto.randomUUID()}`,
        },
      );

      const memberships = await outerTx
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, result.id));
      const audits = await outerTx
        .select()
        .from(securityAuditRecords)
        .where(eq(securityAuditRecords.organizationId, result.id));
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ role: "owner", status: "active" });
      expect(audits.map((audit) => audit.action)).toEqual([
        "organization.created",
      ]);
    });
  });

  test("gives a newly created organization its required appearance default", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      await ensureAppearanceCutover(outerTx);
      const repository = createFoundationRepository(outerTx);
      const service = new OrganizationService({ repository });
      const result = await service.create(
        userContext(`user_${crypto.randomUUID()}`),
        {
          name: "Appearance organization",
          slug: `appearance-${crypto.randomUUID()}`,
        },
      );

      // The compatibility trigger — not the service — owns initialization, so
      // the default and its seed envelope commit in the same transaction as the
      // organization and its owner membership. Its seed is 0026's (ruling 255).
      const defaults = await outerTx
        .select()
        .from(organizationAppearanceDefaults)
        .where(eq(organizationAppearanceDefaults.organizationId, result.id));
      expect(defaults).toHaveLength(1);
      expect(defaults[0]).toMatchObject({
        theme: "cue",
        density: "normal",
        mode: "system",
        font: "match",
        look: "match",
        paint: "match",
        version: 1,
      });

      const seeded = await outerTx
        .select({
          id: domainEvents.id,
          type: domainEvents.type,
          aggregateId: domainEvents.aggregateId,
          aggregateVersion: domainEvents.aggregateVersion,
          actor: domainEvents.actor,
        })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.organizationId, result.id),
            eq(
              domainEvents.type,
              "appearance.organization_defaults_initialized.v1",
            ),
          ),
        );
      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toMatchObject({
        aggregateId: defaults[0]?.aggregateId,
        aggregateVersion: 1,
        actor: {
          type: "service",
          id: "requestport-appearance-default-initializer",
        },
      });
      expect(
        await outerTx
          .select({ state: outbox.state })
          .from(outbox)
          .where(eq(outbox.eventId, seeded[0]?.id ?? "")),
      ).toEqual([{ state: "pending" }]);
    });
  });

  test("defers the appearance default until bootstrap activates its owner", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      await ensureAppearanceCutover(outerTx);
      const repository = createFoundationRepository(outerTx);
      const normalizedEmail = `${crypto.randomUUID()}@example.invalid`;
      const input = {
        email: normalizedEmail,
        organizationSlug: `bootstrap-appearance-${crypto.randomUUID()}`,
        organizationName: "Bootstrap appearance",
      };
      const context = {
        actor: BOOTSTRAP_OWNER_ACTOR,
        correlationId: `corr_${crypto.randomUUID()}`,
      };

      const stageOne = await bootstrapOwner(repository, context, input);
      expect(stageOne.status).toBe("awaiting_authentication");
      // A valid stage-one tenant has no user, no membership, and therefore no
      // invented identity to record as its default's last updater.
      expect(
        await outerTx
          .select()
          .from(organizationAppearanceDefaults)
          .where(
            eq(
              organizationAppearanceDefaults.organizationId,
              stageOne.organizationId,
            ),
          ),
      ).toEqual([]);

      // Stage one already activated the allowlist entry; only the
      // authenticated identity is still missing.
      const userId = `user_${crypto.randomUUID()}`;
      await outerTx.insert(user).values({
        id: userId,
        name: "Bootstrap appearance owner",
        email: normalizedEmail,
      });
      const stageTwo = await bootstrapOwner(repository, context, input);
      expect(stageTwo).toMatchObject({ status: "owner_active", userId });

      const defaults = await outerTx
        .select()
        .from(organizationAppearanceDefaults)
        .where(
          eq(
            organizationAppearanceDefaults.organizationId,
            stageOne.organizationId,
          ),
        );
      expect(defaults).toHaveLength(1);
      expect(defaults[0]).toMatchObject({
        version: 1,
        lastUpdatedByUserId: userId,
      });
      expect(
        await outerTx
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.organizationId, stageOne.organizationId),
              eq(
                domainEvents.type,
                "appearance.organization_defaults_initialized.v1",
              ),
            ),
          ),
      ).toHaveLength(1);

      // A repeated activation must not duplicate the row or the envelope.
      await bootstrapOwner(repository, context, input);
      expect(
        await outerTx
          .select()
          .from(organizationAppearanceDefaults)
          .where(
            eq(
              organizationAppearanceDefaults.organizationId,
              stageOne.organizationId,
            ),
          ),
      ).toHaveLength(1);
    });
  });

  test("rolls back project and repository when the audit write fails", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const realRepository = createFoundationRepository(outerTx);
      const repository: FoundationRepository = {
        transaction: (run) =>
          realRepository.transaction((tx) =>
            run({
              ...tx,
              appendAuditRecord: async (_input: AuditRecordInput) => {
                throw new Error("fixed audit failure");
              },
            }),
          ),
      };
      const organizationId = crypto.randomUUID();
      const userId = `user_${crypto.randomUUID()}`;
      await outerTx.insert(organizations).values({
        id: organizationId,
        name: "Atomic organization",
        slug: `atomic-${crypto.randomUUID()}`,
        status: "active",
      });
      await outerTx.insert(organizationMembers).values({
        organizationId,
        userId,
        role: "owner",
        status: "active",
      });

      await expect(
        new ProjectService(repository).create(userContext(userId), {
          organizationId,
          name: "Atomic project",
          slug: "atomic-project",
          keyPrefix: "ATM",
          repositoryUrl: "https://github.com/example-org/atomic-project",
        }),
      ).rejects.toThrow("Foundation persistence failed");

      expect(
        await outerTx
          .select()
          .from(projects)
          .where(eq(projects.organizationId, organizationId)),
      ).toEqual([]);
      expect(
        await outerTx
          .select()
          .from(projectRepositories)
          .where(eq(projectRepositories.organizationId, organizationId)),
      ).toEqual([]);
      expect(
        await outerTx
          .select()
          .from(securityAuditRecords)
          .where(eq(securityAuditRecords.organizationId, organizationId)),
      ).toEqual([]);
    });
  });

  test("keeps authorization tenant-scoped and maps case-insensitive conflicts safely", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const repository = createFoundationRepository(outerTx);
      const service = new ProjectService(repository);
      const ownerId = `user_${crypto.randomUUID()}`;
      const firstOrgId = crypto.randomUUID();
      const otherOrgId = crypto.randomUUID();
      await outerTx.insert(organizations).values([
        {
          id: firstOrgId,
          name: "First",
          slug: `first-${crypto.randomUUID()}`,
          status: "active",
        },
        {
          id: otherOrgId,
          name: "Other",
          slug: `other-${crypto.randomUUID()}`,
          status: "active",
        },
      ]);
      await outerTx.insert(organizationMembers).values({
        organizationId: otherOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
      });

      await expect(
        service.create(userContext(ownerId), {
          organizationId: firstOrgId,
          name: "Cross tenant",
          slug: "cross-tenant",
          keyPrefix: "CRO",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      await outerTx.insert(organizationMembers).values({
        organizationId: firstOrgId,
        userId: ownerId,
        role: "owner",
        status: "active",
      });
      await service.create(userContext(ownerId), {
        organizationId: firstOrgId,
        name: "Canonical",
        slug: "canonical",
        keyPrefix: "CAN",
      });
      await expect(
        service.create(userContext(ownerId), {
          organizationId: firstOrgId,
          name: "Conflict",
          slug: "CANONICAL",
          keyPrefix: "OTHER",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "slug" },
      });
      expect(
        await outerTx
          .select()
          .from(projects)
          .where(eq(projects.organizationId, firstOrgId)),
      ).toHaveLength(1);
      expect(
        await outerTx
          .select()
          .from(securityAuditRecords)
          .where(eq(securityAuditRecords.organizationId, firstOrgId)),
      ).toHaveLength(1);
    });
  });

  test("uses database time for invitation expiry and exact active retry", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const repository = createFoundationRepository(outerTx);
      const ownerId = `user_${crypto.randomUUID()}`;
      const organizationId = crypto.randomUUID();
      await outerTx.insert(organizations).values({
        id: organizationId,
        name: "Invitation organization",
        slug: `invitation-${crypto.randomUUID()}`,
        status: "active",
      });
      await outerTx.insert(organizationMembers).values({
        organizationId,
        userId: ownerId,
        role: "owner",
        status: "active",
      });
      const service = new OrganizationService({
        repository,
        invitationTokenHash: () => `sha256:${crypto.randomUUID()}`,
      });
      const before = await outerTx.execute<{ now: Date }>(
        sql`select clock_timestamp() as now`,
      );
      const input = {
        organizationId,
        email: `CASE-${crypto.randomUUID()}@Example.Invalid`,
        role: "member" as const,
        expiresInSeconds: 60,
      };
      const first = await service.inviteUser(userContext(ownerId), input);
      const retry = await service.inviteUser(userContext(ownerId), {
        ...input,
        email: input.email.toLowerCase(),
      });
      const [stored] = await outerTx
        .select()
        .from(invitations)
        .where(eq(invitations.id, first.invitation.id));
      const after = await outerTx.execute<{ now: Date }>(
        sql`select clock_timestamp() as now`,
      );

      expect(retry.created).toBe(false);
      const databaseNowRow = before.rows[0];
      const databaseAfterRow = after.rows[0];
      if (!databaseNowRow || !databaseAfterRow)
        throw new Error("Missing database time");
      const databaseBefore = new Date(databaseNowRow.now).getTime();
      const databaseAfter = new Date(databaseAfterRow.now).getTime();
      expect(stored?.expiresAt.getTime()).toBeGreaterThanOrEqual(
        databaseBefore + 60_000,
      );
      expect(stored?.expiresAt.getTime()).toBeLessThanOrEqual(
        databaseAfter + 60_000,
      );
      expect(stored?.tokenHash).toMatch(/^sha256:/u);
      expect(JSON.stringify(first)).not.toContain(
        stored?.tokenHash ?? "impossible",
      );
      expect(
        await outerTx
          .select()
          .from(securityAuditRecords)
          .where(eq(securityAuditRecords.organizationId, organizationId)),
      ).toHaveLength(1);
    });
  });

  test("finalizes bootstrap once and leaves append-only audit records immutable", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const repository = createFoundationRepository(outerTx);
      const normalizedEmail = `${crypto.randomUUID()}@example.invalid`;
      await outerTx.insert(signupAllowlist).values({
        normalizedEmail,
        status: "active",
      });
      const userId = `user_${crypto.randomUUID()}`;
      await outerTx.insert(user).values({
        id: userId,
        name: "Bootstrap owner",
        email: normalizedEmail,
      });
      const input = {
        email: normalizedEmail.toUpperCase(),
        organizationSlug: `bootstrap-${crypto.randomUUID()}`,
        organizationName: "Bootstrap live",
      };
      const commandContext = {
        actor: BOOTSTRAP_OWNER_ACTOR,
        correlationId: `corr_${crypto.randomUUID()}`,
      };
      const first = await bootstrapOwner(repository, commandContext, input);
      const retry = await bootstrapOwner(repository, commandContext, input);

      expect(first).toMatchObject({ status: "owner_active", userId });
      expect(retry).toEqual(first);
      const audits = await outerTx
        .select()
        .from(securityAuditRecords)
        .where(eq(securityAuditRecords.organizationId, first.organizationId));
      expect(audits.map((audit) => audit.action)).toEqual([
        "organization.owner_bootstrapped",
      ]);
      const audit = audits[0];
      if (!audit) throw new Error("Missing bootstrap audit");
      let mutationError: unknown;
      try {
        await outerTx.transaction(async (mutationTx) => {
          await mutationTx.execute(
            sql`update ${securityAuditRecords}
                set "reason" = 'changed'
                where ${securityAuditRecords.id} = ${audit.id}`,
          );
        });
      } catch (error) {
        mutationError = error;
      }
      expect(databaseFailure(mutationError)).toMatchObject({
        code: "55000",
        message: expect.stringMatching(/append-only/u),
      });
    });
  });

  test("serializes same normalized bootstrap slug without blocking unrelated slugs", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const firstClient = await openSession(suiteStorage);
    const sameSlugClient = await openSession(suiteStorage);
    const unrelatedClient = await openSession(suiteStorage);
    const normalizedSlug = `lock-${crypto.randomUUID()}`;
    const firstDb = firstClient.db;
    const sameSlugDb = sameSlugClient.db;
    const unrelatedDb = unrelatedClient.db;
    const passthrough = <T>(
      database: typeof firstDb,
      run: (tx: Tx) => Promise<T>,
    ) => run(database as unknown as Tx);
    try {
      await Promise.all([
        firstClient.query("BEGIN"),
        sameSlugClient.query("BEGIN"),
        unrelatedClient.query("BEGIN"),
      ]);
      const firstRepository = createFoundationRepository(
        firstDb as unknown as Tx,
        (run) => passthrough(firstDb, run),
      );
      const sameRepository = createFoundationRepository(
        sameSlugDb as unknown as Tx,
        (run) => passthrough(sameSlugDb, run),
      );
      const unrelatedRepository = createFoundationRepository(
        unrelatedDb as unknown as Tx,
        (run) => passthrough(unrelatedDb, run),
      );
      const commandContext = {
        actor: BOOTSTRAP_OWNER_ACTOR,
        correlationId: `corr_${crypto.randomUUID()}`,
      };
      await bootstrapOwner(firstRepository, commandContext, {
        email: `${crypto.randomUUID()}@example.invalid`,
        organizationSlug: normalizedSlug,
        organizationName: "Lock first",
      });
      const sameCall = bootstrapOwner(sameRepository, commandContext, {
        email: `${crypto.randomUUID()}@example.invalid`,
        organizationSlug: normalizedSlug.toUpperCase(),
        organizationName: "Lock first",
      });
      expect(await waitForBlocked(sameCall)).toBe(false);

      await expect(
        bootstrapOwner(unrelatedRepository, commandContext, {
          email: `${crypto.randomUUID()}@example.invalid`,
          organizationSlug: `unrelated-${crypto.randomUUID()}`,
          organizationName: "Lock unrelated",
        }),
      ).resolves.toMatchObject({ status: "awaiting_authentication" });

      await firstClient.query("ROLLBACK");
      await expect(sameCall).resolves.toMatchObject({
        status: "awaiting_authentication",
        organizationSlug: normalizedSlug,
      });
      const storedOrganizations = await sameSlugDb
        .select()
        .from(organizations)
        .where(eq(organizations.slug, normalizedSlug));
      const storedOrganization = storedOrganizations[0];
      if (!storedOrganization)
        throw new Error("Missing serialized organization");
      const storedAudits = await sameSlugDb
        .select()
        .from(securityAuditRecords)
        .where(
          and(
            eq(securityAuditRecords.organizationId, storedOrganization.id),
            eq(securityAuditRecords.action, "organization.bootstrap_requested"),
          ),
        );
      expect(storedOrganizations).toHaveLength(1);
      expect(storedAudits).toHaveLength(1);
    } finally {
      await Promise.all([
        rollback(firstClient),
        rollback(sameSlugClient),
        rollback(unrelatedClient),
      ]);
      firstClient.release();
      sameSlugClient.release();
      unrelatedClient.release();
    }
  });

  test("activates one allowlist row safely across unrelated bootstrap slug locks", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const firstClient = await openSession(suiteStorage);
    const secondClient = await openSession(suiteStorage);
    const normalizedEmail = `${crypto.randomUUID()}@example.invalid`;
    const firstDb = firstClient.db;
    const secondDb = secondClient.db;
    const passthrough = <T>(
      database: typeof firstDb,
      run: (tx: Tx) => Promise<T>,
    ) => run(database as unknown as Tx);
    try {
      await Promise.all([
        firstClient.query("BEGIN"),
        secondClient.query("BEGIN"),
      ]);
      const firstRepository = createFoundationRepository(
        firstDb as unknown as Tx,
        (run) => passthrough(firstDb, run),
      );
      const secondRepository = createFoundationRepository(
        secondDb as unknown as Tx,
        (run) => passthrough(secondDb, run),
      );
      await expect(
        firstRepository.transaction((tx) =>
          tx.ensureActiveAllowlist(normalizedEmail),
        ),
      ).resolves.toEqual({ changed: true });
      const secondActivation = secondRepository.transaction((tx) =>
        tx.ensureActiveAllowlist(normalizedEmail),
      );
      expect(await waitForBlocked(secondActivation)).toBe(false);
      await firstClient.query("COMMIT");
      await expect(secondActivation).resolves.toEqual({ changed: false });
      await secondClient.query("COMMIT");
      const rows = await suiteStorage.db
        .select()
        .from(signupAllowlist)
        .where(
          sql`lower(${signupAllowlist.normalizedEmail}) = ${normalizedEmail}`,
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "active", expiresAt: null });
    } finally {
      await rollback(firstClient);
      await rollback(secondClient);
      firstClient.release();
      secondClient.release();
      await suiteStorage.db
        .delete(signupAllowlist)
        .where(
          sql`lower(${signupAllowlist.normalizedEmail}) = ${normalizedEmail}`,
        );
    }
  });

  test("serializes exact and conflicting concurrent invitation payloads per tenant and email", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const firstClient = await openSession(suiteStorage);
    const contenderClient = await openSession(suiteStorage);
    const organizationId = crypto.randomUUID();
    const ownerId = `user_${crypto.randomUUID()}`;
    const organizationSlug = `invite-race-${crypto.randomUUID()}`;
    await suiteStorage.db.insert(organizations).values({
      id: organizationId,
      name: "Invitation race",
      slug: organizationSlug,
      status: "active",
    });
    await suiteStorage.db.insert(organizationMembers).values({
      organizationId,
      userId: ownerId,
      role: "owner",
      status: "active",
    });
    const firstDb = firstClient.db;
    const contenderDb = contenderClient.db;
    const passthrough = <T>(
      database: typeof firstDb,
      run: (tx: Tx) => Promise<T>,
    ) => run(database as unknown as Tx);

    async function race(email: string, contenderRole: "member" | "admin") {
      await Promise.all([
        firstClient.query("BEGIN"),
        contenderClient.query("BEGIN"),
      ]);
      const firstRepository = withoutAudit(
        createFoundationRepository(firstDb as unknown as Tx, (run) =>
          passthrough(firstDb, run),
        ),
      );
      const contenderRepository = withoutAudit(
        createFoundationRepository(contenderDb as unknown as Tx, (run) =>
          passthrough(contenderDb, run),
        ),
      );
      const firstService = new OrganizationService({
        repository: firstRepository,
        invitationTokenHash: () => `sha256:first:${crypto.randomUUID()}`,
      });
      const contenderService = new OrganizationService({
        repository: contenderRepository,
        invitationTokenHash: () => `sha256:contender:${crypto.randomUUID()}`,
      });
      await firstService.inviteUser(userContext(ownerId), {
        organizationId,
        email,
        role: "member",
        expiresInSeconds: 3_600,
      });
      const contender = contenderService.inviteUser(userContext(ownerId), {
        organizationId,
        email: email.toUpperCase(),
        role: contenderRole,
        expiresInSeconds: 3_600,
      });
      expect(await waitForBlocked(contender)).toBe(false);
      await firstClient.query("COMMIT");
      return { contender };
    }

    try {
      const exactEmail = `${crypto.randomUUID()}@example.invalid`;
      const exact = await race(exactEmail, "member");
      await expect(exact.contender).resolves.toMatchObject({ created: false });
      await contenderClient.query("ROLLBACK");

      const conflictingEmail = `${crypto.randomUUID()}@example.invalid`;
      const conflicting = await race(conflictingEmail, "admin");
      await expect(conflicting.contender).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "already_invited" },
      });
      await contenderClient.query("ROLLBACK");

      const stored = await suiteStorage.db
        .select()
        .from(invitations)
        .where(eq(invitations.organizationId, organizationId));
      expect(stored).toHaveLength(2);
    } finally {
      await rollback(firstClient);
      await rollback(contenderClient);
      firstClient.release();
      contenderClient.release();
      await suiteStorage.db
        .delete(invitations)
        .where(eq(invitations.organizationId, organizationId));
      await suiteStorage.db
        .delete(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId));
      // After `0014` an organization that has ever had an active owner also has
      // an appearance initialization event, and "domain_events" is append-only,
      // so the organizations cascade is refused. Archive instead of delete —
      // the same teardown contract apps/web/tests/fixtures/auth.ts follows.
      await suiteStorage.db
        .update(organizations)
        .set({ status: "archived" })
        .where(eq(organizations.id, organizationId));
    }
  });

  test("a revoke that reaches an invitation a renewal holds waits, and is refused once the renewal commits", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    // The organisation row does not order these two: since F.2.7 the revoke
    // reads it FOR SHARE, as inviting does, and takes no organisation-wide
    // lock. On every path, only findInvitation's row lock (and
    // renewInvitation's version guard behind it) stands between a renewal and
    // a revoke. The renewal here takes the invitation's advisory lock and that
    // row lock, and that row lock is what this case proves.
    const renewalClient = await openSession(suiteStorage);
    const revokeClient = await openSession(suiteStorage);
    const organizationId = crypto.randomUUID();
    const ownerId = `user_${crypto.randomUUID()}`;
    const email = `renewal-race-${crypto.randomUUID()}@example.invalid`;
    await suiteStorage.db.insert(organizations).values({
      id: organizationId,
      name: "Invitation renewal race",
      slug: `renewal-race-${crypto.randomUUID()}`,
      status: "active",
    });
    await suiteStorage.db.insert(organizationMembers).values({
      organizationId,
      userId: ownerId,
      role: "owner",
      status: "active",
    });
    // Expired but never revoked: renewable, and still revocable.
    const [expired] = await suiteStorage.db
      .insert(invitations)
      .values({
        organizationId,
        normalizedEmail: email,
        role: "member",
        tokenHash: `sha256:expired:${crypto.randomUUID()}`,
        createdAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
        createdByUserId: ownerId,
      })
      .returning();
    if (!expired) throw new Error("Missing expired invitation");
    const renewalDb = renewalClient.db;
    const renewalRepository = withoutAudit(
      createFoundationRepository(renewalDb as unknown as Tx, (run) =>
        run(renewalDb as unknown as Tx),
      ),
    );
    const management = createOrganizationManagementRepository(revokeClient.db);
    const renewedHash = `sha256:renewed:${crypto.randomUUID()}`;
    let revoke: Promise<unknown> | undefined;

    try {
      await renewalClient.query("BEGIN");
      // Assertions stay outside the callback: the repository maps any error
      // thrown inside it that is not a DomainError or a known constraint
      // violation to "Foundation persistence failed", assertion errors too.
      const held = await renewalRepository.transaction(async (tx) => {
        await tx.lockInvitation(organizationId, email);
        const found = await tx.findInvitation(organizationId, email);
        revoke = management.revokeInvitation(
          {
            organizationId,
            userId: ownerId,
            correlationId: `corr_${crypto.randomUUID()}`,
            expectedVersion: 1,
            actor: { type: "user", id: ownerId },
          },
          expired.id,
        );
        const revokeSettledWhileHeld = await waitForBlocked(revoke);
        const renewed = await tx.renewInvitation({
          organizationId,
          invitationId: expired.id,
          expectedVersion: 1,
          role: "admin",
          tokenHash: renewedHash,
          expiresInSeconds: 3_600,
          createdByUserId: ownerId,
        });
        return { found, revokeSettledWhileHeld, renewed };
      });
      await renewalClient.query("COMMIT");

      expect(held.found).toMatchObject({
        id: expired.id,
        active: false,
        version: 1,
      });
      expect(held.revokeSettledWhileHeld).toBe(false);
      expect(held.renewed).toMatchObject({ version: 2, role: "admin" });
      await expect(revoke).rejects.toMatchObject({
        code: "version_conflict",
        details: { currentVersion: 2, expectedVersion: 1 },
      });
      const [stored] = await suiteStorage.db
        .select()
        .from(invitations)
        .where(eq(invitations.id, expired.id));
      expect(stored).toMatchObject({
        version: 2,
        role: "admin",
        tokenHash: renewedHash,
        acceptedAt: null,
        revokedAt: null,
      });
    } finally {
      await rollback(renewalClient);
      // The revoke runs its own transaction on its session; let it end before
      // the connection goes back to the pool.
      await revoke?.catch(() => undefined);
      renewalClient.release();
      revokeClient.release();
      await suiteStorage.db
        .delete(invitations)
        .where(eq(invitations.organizationId, organizationId));
      await suiteStorage.db
        .delete(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId));
      await suiteStorage.db
        .update(organizations)
        .set({ status: "archived" })
        .where(eq(organizations.id, organizationId));
    }
  });

  test("revocation that locks first wins against project authorization", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const policyClient = await openSession(suiteStorage);
    const commandClient = await openSession(suiteStorage);
    const organizationId = crypto.randomUUID();
    const ownerId = `user_${crypto.randomUUID()}`;
    await suiteStorage.db.insert(organizations).values({
      id: organizationId,
      name: "Revocation race",
      slug: `revocation-race-${crypto.randomUUID()}`,
      status: "active",
    });
    await suiteStorage.db.insert(organizationMembers).values({
      organizationId,
      userId: ownerId,
      role: "owner",
      status: "active",
    });
    const commandDb = commandClient.db;
    const repository = createFoundationRepository(
      commandDb as unknown as Tx,
      (run) => run(commandDb as unknown as Tx),
    );

    try {
      await Promise.all([
        policyClient.query("BEGIN"),
        commandClient.query("BEGIN"),
      ]);
      await policyClient.query(
        "UPDATE organization_members SET status = 'revoked' WHERE organization_id = $1 AND user_id = $2",
        [organizationId, ownerId],
      );

      const command = new ProjectService(repository).create(
        userContext(ownerId),
        {
          organizationId,
          name: "Denied after revocation",
          slug: "denied-after-revocation",
          keyPrefix: "DAR",
        },
      );
      expect(await waitForBlocked(command)).toBe(false);
      await policyClient.query("COMMIT");
      await expect(command).rejects.toMatchObject({ code: "forbidden" });

      expect(
        await commandDb
          .select()
          .from(projects)
          .where(eq(projects.organizationId, organizationId)),
      ).toEqual([]);
      expect(
        await commandDb
          .select()
          .from(securityAuditRecords)
          .where(eq(securityAuditRecords.organizationId, organizationId)),
      ).toEqual([]);
    } finally {
      await rollback(commandClient);
      await rollback(policyClient);
      policyClient.release();
      commandClient.release();
      await suiteStorage.db
        .delete(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId));
      // After `0014` an organization that has ever had an active owner also has
      // an appearance initialization event, and "domain_events" is append-only,
      // so the organizations cascade is refused. Archive instead of delete —
      // the same teardown contract apps/web/tests/fixtures/auth.ts follows.
      await suiteStorage.db
        .update(organizations)
        .set({ status: "archived" })
        .where(eq(organizations.id, organizationId));
    }
  });

  test("suspension that locks first wins against invitation authorization", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const policyClient = await openSession(suiteStorage);
    const commandClient = await openSession(suiteStorage);
    const organizationId = crypto.randomUUID();
    const ownerId = `user_${crypto.randomUUID()}`;
    await suiteStorage.db.insert(organizations).values({
      id: organizationId,
      name: "Suspension race",
      slug: `suspension-race-${crypto.randomUUID()}`,
      status: "active",
    });
    await suiteStorage.db.insert(organizationMembers).values({
      organizationId,
      userId: ownerId,
      role: "owner",
      status: "active",
    });
    const commandDb = commandClient.db;
    const repository = createFoundationRepository(
      commandDb as unknown as Tx,
      (run) => run(commandDb as unknown as Tx),
    );

    try {
      await Promise.all([
        policyClient.query("BEGIN"),
        commandClient.query("BEGIN"),
      ]);
      await policyClient.query(
        "UPDATE organizations SET status = 'suspended' WHERE id = $1",
        [organizationId],
      );

      const command = new OrganizationService({
        repository,
        invitationTokenHash: () => `sha256:${crypto.randomUUID()}`,
      }).inviteUser(userContext(ownerId), {
        organizationId,
        email: `${crypto.randomUUID()}@example.invalid`,
        role: "member",
      });
      expect(await waitForBlocked(command)).toBe(false);
      await policyClient.query("COMMIT");
      await expect(command).rejects.toMatchObject({ code: "forbidden" });

      expect(
        await commandDb
          .select()
          .from(invitations)
          .where(eq(invitations.organizationId, organizationId)),
      ).toEqual([]);
      expect(
        await commandDb
          .select()
          .from(securityAuditRecords)
          .where(eq(securityAuditRecords.organizationId, organizationId)),
      ).toEqual([]);
    } finally {
      await rollback(commandClient);
      await rollback(policyClient);
      policyClient.release();
      commandClient.release();
      await suiteStorage.db
        .delete(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId));
      // After `0014` an organization that has ever had an active owner also has
      // an appearance initialization event, and "domain_events" is append-only,
      // so the organizations cascade is refused. Archive instead of delete —
      // the same teardown contract apps/web/tests/fixtures/auth.ts follows.
      await suiteStorage.db
        .update(organizations)
        .set({ status: "archived" })
        .where(eq(organizations.id, organizationId));
    }
  });

  test("bootstrap re-evaluates a locked organization after suspension waits", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    const policyClient = await openSession(suiteStorage);
    const commandClient = await openSession(suiteStorage);
    const organizationId = crypto.randomUUID();
    const organizationSlug = `bootstrap-suspend-${crypto.randomUUID()}`;
    const normalizedEmail = `${crypto.randomUUID()}@example.invalid`;
    await suiteStorage.db.insert(organizations).values({
      id: organizationId,
      name: "Bootstrap suspension",
      slug: organizationSlug,
      status: "active",
    });
    const commandDb = commandClient.db;
    const repository = createFoundationRepository(
      commandDb as unknown as Tx,
      (run) => run(commandDb as unknown as Tx),
    );

    try {
      await Promise.all([
        policyClient.query("BEGIN"),
        commandClient.query("BEGIN"),
      ]);
      await policyClient.query(
        "UPDATE organizations SET status = 'suspended' WHERE id = $1",
        [organizationId],
      );

      const command = bootstrapOwner(
        repository,
        {
          actor: BOOTSTRAP_OWNER_ACTOR,
          correlationId: `corr_${crypto.randomUUID()}`,
        },
        {
          email: normalizedEmail,
          organizationSlug,
          organizationName: "Bootstrap suspension",
        },
      );
      expect(await waitForBlocked(command)).toBe(false);
      await policyClient.query("COMMIT");
      await expect(command).rejects.toMatchObject({ code: "forbidden" });

      expect(
        await commandDb
          .select()
          .from(signupAllowlist)
          .where(eq(signupAllowlist.normalizedEmail, normalizedEmail)),
      ).toEqual([]);
      expect(
        await commandDb
          .select()
          .from(securityAuditRecords)
          .where(eq(securityAuditRecords.organizationId, organizationId)),
      ).toEqual([]);
    } finally {
      await rollback(commandClient);
      await rollback(policyClient);
      policyClient.release();
      commandClient.release();
      await suiteStorage.db
        .delete(organizations)
        .where(eq(organizations.id, organizationId));
    }
  });
});
