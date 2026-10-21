import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  invitations,
  organizationMembers,
  organizations,
  projectRepositories,
  projects,
  signupAllowlist,
  user,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createFoundationQueryRepository } from "./foundation-query.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

class QueryTestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new QueryTestRollback();
    });
  } catch (error) {
    if (error instanceof QueryTestRollback) return;
    throw error;
  }
  throw new Error("Expected the query transaction to roll back");
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live tenant-safe foundation query adapter", () => {
  test("scopes every projection to active organization membership and omits secrets", async () => {
    await inRollbackTransaction(async (tx) => {
      const actorId = `user_${crypto.randomUUID()}`;
      const otherUserId = `user_${crypto.randomUUID()}`;
      const actorEmail = `${crypto.randomUUID()}@example.invalid`;
      const otherEmail = `${crypto.randomUUID()}@example.invalid`;
      const organizationId = crypto.randomUUID();
      const otherOrganizationId = crypto.randomUUID();
      const suspendedOrganizationId = crypto.randomUUID();
      await tx.insert(signupAllowlist).values([
        { normalizedEmail: actorEmail, status: "active" },
        { normalizedEmail: otherEmail, status: "active" },
      ]);
      await tx.insert(user).values([
        { id: actorId, name: "Actor", email: actorEmail },
        { id: otherUserId, name: "Other member", email: otherEmail },
      ]);
      await tx.insert(organizations).values([
        {
          id: organizationId,
          name: "Active tenant",
          slug: `active-${crypto.randomUUID()}`,
          status: "active",
        },
        {
          id: otherOrganizationId,
          name: "Other tenant",
          slug: `other-${crypto.randomUUID()}`,
          status: "active",
        },
        {
          id: suspendedOrganizationId,
          name: "Suspended tenant",
          slug: `suspended-${crypto.randomUUID()}`,
          status: "suspended",
        },
      ]);
      await tx.insert(organizationMembers).values([
        {
          organizationId,
          userId: actorId,
          role: "owner",
          status: "active",
        },
        {
          organizationId,
          userId: otherUserId,
          role: "member",
          status: "active",
        },
        {
          organizationId: otherOrganizationId,
          userId: actorId,
          role: "admin",
          status: "revoked",
        },
        {
          organizationId: suspendedOrganizationId,
          userId: actorId,
          role: "admin",
          status: "active",
        },
      ]);
      const [ownProject, otherProject] = await tx
        .insert(projects)
        .values([
          {
            organizationId,
            name: "RequestPort",
            slug: "requestport",
            keyPrefix: "RQP",
            description: "Canonical coordination",
            status: "active",
          },
          {
            organizationId: otherOrganizationId,
            name: "Hidden project",
            slug: "hidden-project",
            keyPrefix: "HID",
            description: "Must not leak",
            status: "active",
          },
        ])
        .returning();
      if (!ownProject || !otherProject) throw new Error("Missing projects");
      await tx.insert(projectRepositories).values([
        {
          organizationId,
          projectId: ownProject.id,
          provider: "github",
          browseUrl: "https://github.com/example-org/requestport",
          cloneUrl: "https://github.com/example-org/requestport.git",
          repositorySlug: "example-org/requestport",
          isDefault: true,
          status: "active",
        },
        {
          organizationId: otherOrganizationId,
          projectId: otherProject.id,
          provider: "github",
          browseUrl: "https://github.com/other/hidden",
          cloneUrl: "https://github.com/other/hidden.git",
          repositorySlug: "other/hidden",
          isDefault: true,
          status: "active",
        },
      ]);
      const invitationTokenHash = `secret-token-hash-${crypto.randomUUID()}`;
      await tx.insert(invitations).values([
        {
          organizationId,
          normalizedEmail: "pending@example.invalid",
          role: "member",
          tokenHash: invitationTokenHash,
          expiresAt: new Date(Date.now() + 60_000),
          createdByUserId: actorId,
        },
        {
          organizationId: otherOrganizationId,
          normalizedEmail: "hidden@example.invalid",
          role: "owner",
          tokenHash: `hidden-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
          createdByUserId: actorId,
        },
      ]);

      const query = createFoundationQueryRepository(tx);
      const organizationsForActor =
        await query.listActiveOrganizationsForUser(actorId);
      expect(organizationsForActor).toEqual([
        {
          id: organizationId,
          name: "Active tenant",
          role: "owner",
          slug: expect.stringMatching(/^active-/u),
        },
      ]);
      await expect(
        query.findActiveOrganizationForUser(actorId, organizationId),
      ).resolves.toEqual(organizationsForActor[0]);
      await expect(
        query.findActiveOrganizationForUser(actorId, otherOrganizationId),
      ).resolves.toBeNull();
      await expect(
        query.findActiveOrganizationForUser(actorId, suspendedOrganizationId),
      ).resolves.toBeNull();

      const projectedProjects = await query.listOrganizationProjects(
        actorId,
        organizationId,
      );
      expect(projectedProjects).toEqual([
        {
          defaultRepository: {
            browseUrl: "https://github.com/example-org/requestport",
            repositorySlug: "example-org/requestport",
          },
          id: ownProject.id,
          keyPrefix: "RQP",
          name: "RequestPort",
          slug: "requestport",
          status: "active",
          canRepresent: true,
        },
      ]);
      expect(JSON.stringify(projectedProjects)).not.toContain("Hidden project");
      expect(JSON.stringify(projectedProjects)).not.toContain(
        "Canonical coordination",
      );
      expect(
        await query.listOrganizationMembers(actorId, organizationId),
      ).toEqual([
        {
          email: actorEmail,
          name: "Actor",
          role: "owner",
          userId: actorId,
          version: 1,
        },
        {
          email: otherEmail,
          name: "Other member",
          role: "member",
          userId: otherUserId,
          version: 1,
        },
      ]);
      const projectedInvitations = await query.listPendingInvitations(
        actorId,
        organizationId,
      );
      expect(projectedInvitations).toEqual([
        expect.objectContaining({
          email: "pending@example.invalid",
          role: "member",
        }),
      ]);
      expect(JSON.stringify(projectedInvitations)).not.toContain(
        invitationTokenHash,
      );
      await expect(
        query.listOrganizationProjects(actorId, otherOrganizationId),
      ).resolves.toEqual([]);
      await expect(
        query.listOrganizationMembers(actorId, otherOrganizationId),
      ).resolves.toEqual([]);
      await expect(
        query.listPendingInvitations(actorId, otherOrganizationId),
      ).resolves.toEqual([]);
      const memberInvitationProjection = await query.listPendingInvitations(
        otherUserId,
        organizationId,
      );
      expect(memberInvitationProjection).toEqual([]);
      expect(JSON.stringify(memberInvitationProjection)).not.toContain(
        "pending@example.invalid",
      );

      expect(
        await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, otherOrganizationId),
              eq(projects.id, otherProject.id),
            ),
          ),
      ).toHaveLength(1);
    });
  });
});
