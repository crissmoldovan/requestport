import { and, eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  organizationMembers,
  organizations,
  projectMembers,
  projectRepositories,
  projects,
  securityAuditRecords,
} from "./index.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

afterAll(async () => {
  await suiteStorage.close();
});

class TestRollback extends Error {}

function databaseError(error: unknown) {
  if (typeof error === "object" && error !== null && "cause" in error) {
    return error.cause;
  }

  return error;
}

async function expectDatabaseError(
  action: () => Promise<unknown>,
  assertion: (error: unknown) => void,
) {
  let error: unknown;

  try {
    await action();
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeDefined();
  assertion(databaseError(error));
}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

test("enforces tenant slugs and one default repository per project", async () => {
  await inRollbackTransaction(async (tx) => {
    const suffix = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const organizationSlug = `example-org-${suffix}`;

    await tx.insert(organizations).values({
      id: organizationId,
      name: "CUE++",
      slug: organizationSlug,
      status: "active",
    });

    await expectDatabaseError(
      () =>
        tx.transaction((constraintTx) =>
          constraintTx.insert(organizations).values({
            id: crypto.randomUUID(),
            name: "Duplicate",
            slug: organizationSlug.toUpperCase(),
            status: "active",
          }),
        ),
      (error) => expect(error).toMatchObject({ code: "23505" }),
    );

    const projectId = crypto.randomUUID();
    await tx.insert(projects).values({
      id: projectId,
      organizationId,
      name: "Meadow",
      slug: `meadow-${suffix}`,
      keyPrefix: `C${suffix.slice(0, 5)}`,
      status: "active",
    });

    await tx.insert(projectRepositories).values({
      id: crypto.randomUUID(),
      organizationId,
      projectId,
      provider: "github",
      browseUrl: `https://github.com/example-org/meadow-${suffix}`,
      cloneUrl: `https://github.com/example-org/meadow-${suffix}.git`,
      repositorySlug: `example-org/meadow-${suffix}`,
      isDefault: true,
      status: "active",
    });

    await expectDatabaseError(
      () =>
        tx.transaction((constraintTx) =>
          constraintTx.insert(projectRepositories).values({
            id: crypto.randomUUID(),
            organizationId,
            projectId,
            provider: "github",
            browseUrl: `https://github.com/example-org/meadow-docs-${suffix}`,
            cloneUrl: `https://github.com/example-org/meadow-docs-${suffix}.git`,
            repositorySlug: `example-org/meadow-docs-${suffix}`,
            isDefault: true,
            status: "active",
          }),
        ),
      (error) => expect(error).toMatchObject({ code: "23505" }),
    );
  });
});

test("allows repository slugs to be omitted or null", async () => {
  await inRollbackTransaction(async (tx) => {
    const suffix = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();

    await tx.insert(organizations).values({
      id: organizationId,
      name: "Optional repository slug test",
      slug: `optional-repository-slug-${suffix}`,
      status: "active",
    });
    await tx.insert(projects).values({
      id: projectId,
      organizationId,
      name: "Optional repository slug project",
      slug: `optional-repository-slug-project-${suffix}`,
      keyPrefix: `O${suffix.slice(0, 5)}`,
      status: "active",
    });

    await tx.insert(projectRepositories).values({
      id: crypto.randomUUID(),
      organizationId,
      projectId,
      provider: "github",
      browseUrl: `https://github.com/example-org/no-slug-${suffix}`,
      cloneUrl: `https://github.com/example-org/no-slug-${suffix}.git`,
      isDefault: false,
      status: "active",
    });
    await tx.insert(projectRepositories).values({
      id: crypto.randomUUID(),
      organizationId,
      projectId,
      provider: "github",
      browseUrl: `https://github.com/example-org/null-slug-${suffix}`,
      cloneUrl: `https://github.com/example-org/null-slug-${suffix}.git`,
      repositorySlug: null,
      isDefault: false,
      status: "active",
    });
  });
});

test("keeps revoked memberships and their identity references", async () => {
  await inRollbackTransaction(async (tx) => {
    const suffix = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const userId = `user_${suffix}`;

    await tx.insert(organizations).values({
      id: organizationId,
      name: "Membership test",
      slug: `membership-${suffix}`,
      status: "active",
    });
    await tx.insert(projects).values({
      id: projectId,
      organizationId,
      name: "Membership project",
      slug: `membership-project-${suffix}`,
      keyPrefix: `M${suffix.slice(0, 5)}`,
      status: "active",
    });

    const organizationMemberId = crypto.randomUUID();
    const projectMemberId = crypto.randomUUID();
    await tx.insert(organizationMembers).values({
      id: organizationMemberId,
      organizationId,
      userId,
      role: "member",
      status: "active",
    });
    await tx.insert(projectMembers).values({
      id: projectMemberId,
      organizationId,
      projectId,
      userId,
      role: "contributor",
      status: "active",
    });

    await tx
      .update(organizationMembers)
      .set({ status: "revoked" })
      .where(eq(organizationMembers.id, organizationMemberId));
    await tx
      .update(projectMembers)
      .set({ status: "revoked" })
      .where(eq(projectMembers.id, projectMemberId));

    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    const [organizationMember] = await tx
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.id, organizationMemberId),
          eq(organizationMembers.organizationId, organizationId),
        ),
      );
    const [projectMember] = await tx
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.id, projectMemberId),
          eq(projectMembers.organizationId, organizationId),
          eq(projectMembers.projectId, projectId),
        ),
      );

    expect(organization).toBeDefined();
    expect(project).toBeDefined();
    expect(organizationMember).toMatchObject({ status: "revoked", userId });
    expect(projectMember).toMatchObject({ status: "revoked", userId });
  });
});

test("rejects updates and deletes of security audit records", async () => {
  await inRollbackTransaction(async (tx) => {
    const suffix = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const auditId = crypto.randomUUID();

    await tx.insert(organizations).values({
      id: organizationId,
      name: "Audit test",
      slug: `audit-${suffix}`,
      status: "active",
    });
    await tx.insert(securityAuditRecords).values({
      id: auditId,
      organizationId,
      actorType: "user",
      actorId: `user_${suffix}`,
      action: "organization.created",
      targetType: "organization",
      targetId: organizationId,
      reason: "integration test",
      fieldNames: [],
      correlationId: `corr_${suffix}`,
      occurredAt: new Date(),
    });

    await expectDatabaseError(
      () =>
        tx.transaction((constraintTx) =>
          constraintTx
            .update(securityAuditRecords)
            .set({ reason: "changed" })
            .where(eq(securityAuditRecords.id, auditId)),
        ),
      (error) =>
        expect(error).toHaveProperty(
          "message",
          expect.stringMatching(/append-only/),
        ),
    );
    await expectDatabaseError(
      () =>
        tx.transaction((constraintTx) =>
          constraintTx
            .delete(securityAuditRecords)
            .where(eq(securityAuditRecords.id, auditId)),
        ),
      (error) =>
        expect(error).toHaveProperty(
          "message",
          expect.stringMatching(/append-only/),
        ),
    );
  });
});
