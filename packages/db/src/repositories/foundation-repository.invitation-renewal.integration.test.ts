import { randomUUID } from "node:crypto";

import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  type DomainEvent,
  inviteOrganizationMemberCommandName,
  type JsonObject,
  OrganizationService,
  revokeOrganizationInvitationCommandName,
  setOrganizationMemberCommandName,
} from "@requestport/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  commandReceipts,
  domainEvents,
  invitations,
  notificationIntents,
  organizationMembers,
  organizations,
  outbox,
  securityAuditRecords,
  user,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import {
  endingEachCommandBinding,
  endingEachMethodBinding,
  endTenantBinding,
} from "../test-support/tenant-binding.js";
import type { Tx } from "../transaction.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createFoundationRepository } from "./foundation-repository.js";
import { createNotificationRepository } from "./notification-repository.js";
import { createOrganizationManagementRepository } from "./organization-management-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  X15: an address could be invited only once per organisation.
  `invitations_organization_email_ci_unique` keeps one row per
  (organisation, lower(email)), and `inviteUser` answered `conflict` for that
  row in any state, so an expired invitation could never be renewed and a
  member whose access was removed could never be invited back. The ruling:
  inviting an address whose invitation is not pending renews that row — new
  token hash, new expiry, pending, the new role, the new inviter, version + 1 —
  audited and evented, with the invitation email queued as for a new one. A
  pending invitation and an active member are still refused, on `email`.

  Round 2: only the signup trigger accepts an invitation, and it runs when the
  person's "user" row is inserted. So a renewal is made only while no "user"
  row exists for the address; when one does — a removed member, or someone who
  signed up through another organisation — the address is refused on `email`
  as `existing_account`, and nothing is renewed, audited, evented or emailed.

  Round 3: the same holds for a first invitation. With no pending invitation,
  an active member is refused as `already_member` and an existing account as
  `existing_account` before anything is created.

  Everything here runs inside one transaction that is rolled back, against the
  real schema and its signup trigger (the only thing that accepts an
  invitation), through the real revoke and member-removal repositories.
*/

const timeoutMs = 60_000;
const baseUrl = "https://requestport.invalid";

class TestRollback extends Error {}

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
  throw new Error("Expected the renewal transaction to roll back");
}

const userContext = (userId: string) => ({
  actor: { type: "user" as const, userId },
  correlationId: `corr_${randomUUID()}`,
});

/**
 * The tenant bus as the web builds it, on the case's transaction, without the
 * session re-check (`authorizeContext`): the people seeded here have no
 * session rows. `committed` receives what the bus hands its after-commit
 * dispatch, which is what starts the invitation email.
 */
function commandBus(outerTx: Tx, committed: DomainEvent[] = []) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    // A case runs commands for several people and organisations on one
    // transaction; each command's binding ends with it, as its own
    // transaction ends it in production (test-support/tenant-binding.ts).
    transactions: endingEachCommandBinding(
      createCommandTransactionManager(
        outerTx as unknown as Database,
        (name, database) => {
          if (name === "organizationManagement")
            return createOrganizationManagementRepository(database);
          if (name === "foundation")
            return createFoundationRepository(database);
          return undefined;
        },
      ),
      outerTx,
    ),
    fingerprintSecret: "x15-invitation-renewal-bus-fingerprint-secret",
    afterCommit: async (events) => {
      committed.push(...events);
    },
  });
}

function busContext(
  organizationId: string,
  userId: string,
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["members:manage"]),
    credentialId: `session_${randomUUID()}`,
    correlationId: randomUUID(),
  };
}

async function seed(outerTx: Tx) {
  const organizationId = randomUUID();
  const ownerId = `user_${randomUUID()}`;
  const adminId = `user_${randomUUID()}`;
  await outerTx.insert(organizations).values({
    id: organizationId,
    name: "Invitation renewal organization",
    slug: `renewal-${randomUUID()}`,
    status: "active",
  });
  await outerTx.insert(organizationMembers).values([
    { organizationId, userId: ownerId, role: "owner", status: "active" },
    { organizationId, userId: adminId, role: "admin", status: "active" },
  ]);
  const database = outerTx as unknown as Database;
  const hashes: string[] = [];
  // Each foundation transaction binds the organisation it authorises
  // (manifest-i2.md §2.3); the service's own transaction would end that
  // binding with it, so here it is ended when each one settles.
  const repository = createFoundationRepository(outerTx, async (run) => {
    try {
      return await outerTx.transaction(run);
    } finally {
      await endTenantBinding(outerTx);
    }
  });
  const service = new OrganizationService({
    repository,
    invitationTokenHash: () => {
      const hash = `sha256:${randomUUID()}`;
      hashes.push(hash);
      return hash;
    },
  });
  return {
    organizationId,
    ownerId,
    adminId,
    hashes,
    repository,
    service,
    management: endingEachMethodBinding(
      createOrganizationManagementRepository(database),
      outerTx,
    ),
    notifications: createNotificationRepository(database),
    email: `renewal-${randomUUID()}@example.invalid`,
  };
}

async function storedInvitation(outerTx: Tx, invitationId: string) {
  const [row] = await outerTx
    .select()
    .from(invitations)
    .where(eq(invitations.id, invitationId));
  if (!row) throw new Error("Missing invitation row");
  return row;
}

/**
 * Sorted by action: every row of one transaction shares `occurred_at`, and the
 * table has no other order. The events' aggregate versions carry the order.
 */
async function auditTrail(outerTx: Tx, invitationId: string) {
  return outerTx
    .select()
    .from(securityAuditRecords)
    .where(
      and(
        eq(securityAuditRecords.targetType, "invitation"),
        eq(securityAuditRecords.targetId, invitationId),
      ),
    )
    .orderBy(asc(securityAuditRecords.action));
}

async function eventTrail(outerTx: Tx, invitationId: string) {
  return outerTx
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.aggregateType, "invitation"),
        eq(domainEvents.aggregateId, invitationId),
      ),
    )
    .orderBy(asc(domainEvents.aggregateVersion));
}

/** Inserts the person's "user" row, which is what fires the signup trigger. */
async function signUp(outerTx: Tx, email: string) {
  const id = randomUUID();
  await outerTx.execute(
    sql`insert into "user" ("id", "name", "email") values (${id}, 'Invited person', ${email})`,
  );
  return id;
}

async function membershipOf(
  outerTx: Tx,
  organizationId: string,
  userId: string,
) {
  const [membership] = await outerTx
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
  return membership;
}

/**
 * The organisation's domain events. The foundation repository queues an outbox
 * row with each event it appends, so a count that does not move means nothing
 * was queued for the worker, the invitation email included.
 */
async function eventCount(outerTx: Tx, organizationId: string) {
  const [row] = await outerTx
    .select({ count: sql<number>`count(*)::int` })
    .from(domainEvents)
    .where(eq(domainEvents.organizationId, organizationId));
  return row?.count ?? 0;
}

async function intentsFor(outerTx: Tx, invitationId: string) {
  return outerTx
    .select()
    .from(notificationIntents)
    .where(eq(notificationIntents.invitationId, invitationId))
    .orderBy(asc(notificationIntents.createdAt), asc(notificationIntents.id));
}

/** The organisation's invitation rows and audit records, counted. */
async function organizationFootprint(outerTx: Tx, organizationId: string) {
  const [invitationRows] = await outerTx
    .select({ count: sql<number>`count(*)::int` })
    .from(invitations)
    .where(eq(invitations.organizationId, organizationId));
  const [auditRows] = await outerTx
    .select({ count: sql<number>`count(*)::int` })
    .from(securityAuditRecords)
    .where(eq(securityAuditRecords.organizationId, organizationId));
  return {
    invitations: invitationRows?.count ?? 0,
    audits: auditRows?.count ?? 0,
    events: await eventCount(outerTx, organizationId),
  };
}

async function databaseNow(outerTx: Tx) {
  const result = await outerTx.execute<{ now: string | Date }>(
    sql`select clock_timestamp() as now`,
  );
  return new Date(result.rows[0]?.now ?? Number.NaN).getTime();
}

describe.sequential("invitation renewal on the real database", () => {
  test("renews a revoked invitation: new token, expiry, role and inviter, version + 1, audited, evented, one email", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      const [creationEvent] = await eventTrail(outerTx, invitationId);
      if (!creationEvent) throw new Error("Missing creation event");
      // The first email, materialized as the worker would, and left pending:
      // an attempt that has not gone out yet when the invitation is revoked.
      const firstEmail =
        await scenario.notifications.materializeInvitationIntents(
          creationEvent.id,
          baseUrl,
        );
      expect(firstEmail).toHaveLength(1);

      await scenario.management.revokeInvitation(
        {
          organizationId: scenario.organizationId,
          userId: scenario.ownerId,
          correlationId: `corr_${randomUUID()}`,
          expectedVersion: 1,
          actor: { type: "user", id: scenario.ownerId },
        },
        invitationId,
      );
      const revoked = await storedInvitation(outerTx, invitationId);
      expect(revoked.revokedAt).not.toBeNull();
      expect(revoked.version).toBe(2);

      const before = await databaseNow(outerTx);
      const renewed = await scenario.service.inviteUser(
        userContext(scenario.adminId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email.toUpperCase(),
          role: "admin",
        },
      );
      const after = await databaseNow(outerTx);

      expect(renewed).toMatchObject({
        created: true,
        outcome: "renewed",
        renewedFrom: "revoked",
        invitation: { id: invitationId, role: "admin" },
      });
      expect(JSON.stringify(renewed)).not.toContain("sha256:");

      const row = await storedInvitation(outerTx, invitationId);
      expect(row).toMatchObject({
        role: "admin",
        acceptedAt: null,
        revokedAt: null,
        version: 3,
        createdByUserId: scenario.adminId,
        tokenHash: scenario.hashes[1],
      });
      expect(row.tokenHash).not.toBe(revoked.tokenHash);
      // A declared change: `created_at` becomes the renewal's issue time, so
      // the row no longer holds when the invitation was first created.
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(after);
      expect(row.createdAt.getTime()).toBeGreaterThan(
        revoked.createdAt.getTime(),
      );
      const week = 7 * 24 * 60 * 60 * 1_000;
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + week);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after + week);

      const audits = await auditTrail(outerTx, invitationId);
      expect(audits.map((audit) => audit.action)).toEqual([
        "organization.invitation_created",
        "organization.invitation_renewed",
        "organization.invitation_revoked",
      ]);
      expect(audits[1]).toMatchObject({
        organizationId: scenario.organizationId,
        actorType: "user",
        actorId: scenario.adminId,
        reason: "Organization invitation renewed after it was revoked",
      });

      const events = await eventTrail(outerTx, invitationId);
      expect(
        events.map((event) => [event.type, event.aggregateVersion]),
      ).toEqual([
        ["organization.invitation_created.v1", 1],
        ["organization.invitation_revoked.v1", 2],
        ["organization.invitation_created.v1", 3],
      ]);
      const renewalEvent = events[2];
      if (!renewalEvent) throw new Error("Missing renewal event");
      expect(renewalEvent.data).toEqual({
        invitationId,
        role: "admin",
        expiresAt: row.expiresAt.toISOString(),
        renewedFrom: "revoked",
      });
      expect(renewalEvent.actor).toEqual({
        type: "user",
        id: scenario.adminId,
      });
      const [queued] = await outerTx
        .select()
        .from(outbox)
        .where(eq(outbox.eventId, renewalEvent.id));
      expect(queued?.state).toBe("pending");

      // The renewal's email: one intent, to the address, carrying the new
      // role and expiry; materializing the same event again adds nothing.
      const renewalEmail =
        await scenario.notifications.materializeInvitationIntents(
          renewalEvent.id,
          baseUrl,
        );
      expect(renewalEmail).toHaveLength(1);
      expect(
        await scenario.notifications.materializeInvitationIntents(
          renewalEvent.id,
          baseUrl,
        ),
      ).toEqual([]);
      const intents = await outerTx
        .select()
        .from(notificationIntents)
        .where(eq(notificationIntents.invitationId, invitationId))
        .orderBy(
          asc(notificationIntents.createdAt),
          asc(notificationIntents.id),
        );
      const byEvent = new Map(
        intents.map((intent) => [intent.eventId, intent]),
      );
      expect(byEvent.get(renewalEvent.id)).toMatchObject({
        status: "pending",
        recipientRef: scenario.email,
        template: "organization_invitation_v1",
        viewModel: expect.objectContaining({
          role: "admin",
          expiresAt: row.expiresAt.toISOString(),
        }),
      });
      // The revoked invitation's undelivered email does not go out beside it.
      expect(byEvent.get(creationEvent.id)).toMatchObject({
        status: "suppressed",
        nextAttemptAt: null,
      });
      expect(intents.filter((intent) => intent.status === "pending")).toEqual([
        expect.objectContaining({ eventId: renewalEvent.id }),
      ]);
    });
  });

  test("renews an expired invitation, and an exact retry of the renewal changes nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
          expiresInSeconds: 60,
        },
      );
      const invitationId = first.invitation.id;
      await outerTx
        .update(invitations)
        .set({
          createdAt: sql`clock_timestamp() - interval '2 minutes'`,
          expiresAt: sql`clock_timestamp() - interval '1 minute'`,
        })
        .where(eq(invitations.id, invitationId));

      const renewed = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      expect(renewed).toMatchObject({
        created: true,
        outcome: "renewed",
        renewedFrom: "expired",
        invitation: { id: invitationId, role: "member" },
      });
      const row = await storedInvitation(outerTx, invitationId);
      expect(row.version).toBe(2);
      expect(row.expiresAt.getTime()).toBeGreaterThan(
        (await databaseNow(outerTx)) + 6 * 24 * 60 * 60 * 1_000,
      );

      const retry = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      expect(retry).toMatchObject({
        created: false,
        outcome: "unchanged",
        invitation: renewed.invitation,
      });
      expect((await storedInvitation(outerTx, invitationId)).version).toBe(2);

      const audits = await auditTrail(outerTx, invitationId);
      expect(audits.map((audit) => [audit.action, audit.reason])).toEqual([
        ["organization.invitation_created", "Organization invitation created"],
        [
          "organization.invitation_renewed",
          "Organization invitation renewed after it expired",
        ],
      ]);
      const events = await eventTrail(outerTx, invitationId);
      expect(
        events.map((event) => [event.type, event.aggregateVersion]),
      ).toEqual([
        ["organization.invitation_created.v1", 1],
        ["organization.invitation_created.v1", 2],
      ]);
      const renewalEvent = events[1];
      if (!renewalEvent) throw new Error("Missing renewal event");
      expect(renewalEvent.data).toMatchObject({ renewedFrom: "expired" });
      expect(
        await scenario.notifications.materializeInvitationIntents(
          renewalEvent.id,
          baseUrl,
        ),
      ).toHaveLength(1);
    });
  });

  test("refuses an active member as already_member, and a removed member as existing_account, changing nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      // Signing up is what accepts an invitation: the signup trigger makes the
      // membership and stamps `accepted_at`.
      const invitedUserId = await signUp(outerTx, scenario.email);
      const accepted = await storedInvitation(outerTx, invitationId);
      expect(accepted.acceptedAt).not.toBeNull();
      const membership = await membershipOf(
        outerTx,
        scenario.organizationId,
        invitedUserId,
      );
      expect(membership).toMatchObject({ status: "active", role: "member" });
      if (!membership) throw new Error("Missing accepted membership");

      await expect(
        scenario.service.inviteUser(userContext(scenario.ownerId), {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "already_member" },
      });
      expect(await storedInvitation(outerTx, invitationId)).toEqual(accepted);

      await scenario.management.setMember(
        {
          organizationId: scenario.organizationId,
          userId: scenario.ownerId,
          correlationId: `corr_${randomUUID()}`,
          expectedVersion: membership.version,
          actor: { type: "user", id: scenario.ownerId },
        },
        {
          userId: invitedUserId,
          role: "member",
          status: "revoked",
        },
      );
      const organizationEvents = await eventCount(
        outerTx,
        scenario.organizationId,
      );
      const intents = await intentsFor(outerTx, invitationId);

      // The person still has a "user" row, so a renewed invitation would never
      // be accepted: the trigger that accepts one runs only when that row is
      // inserted. Refused rather than reported as sent.
      await expect(
        scenario.service.inviteUser(userContext(scenario.adminId), {
          organizationId: scenario.organizationId,
          email: scenario.email.toUpperCase(),
          role: "admin",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "existing_account" },
      });
      expect(await storedInvitation(outerTx, invitationId)).toEqual(accepted);
      expect(
        (await auditTrail(outerTx, invitationId)).map((audit) => audit.action),
      ).toEqual(["organization.invitation_created"]);
      expect(await eventCount(outerTx, scenario.organizationId)).toBe(
        organizationEvents,
      );
      expect(await intentsFor(outerTx, invitationId)).toEqual(intents);
      expect(
        await membershipOf(outerTx, scenario.organizationId, invitedUserId),
      ).toMatchObject({ status: "revoked" });
    });
  });

  test("refuses as existing_account a revoked invitation whose person has since signed up through another organisation", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const elsewhere = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      await scenario.management.revokeInvitation(
        {
          organizationId: scenario.organizationId,
          userId: scenario.ownerId,
          correlationId: `corr_${randomUUID()}`,
          expectedVersion: 1,
          actor: { type: "user", id: scenario.ownerId },
        },
        invitationId,
      );
      await elsewhere.service.inviteUser(userContext(elsewhere.ownerId), {
        organizationId: elsewhere.organizationId,
        email: scenario.email,
        role: "member",
      });
      const personId = await signUp(outerTx, scenario.email);
      expect(
        await membershipOf(outerTx, elsewhere.organizationId, personId),
      ).toMatchObject({ status: "active" });
      expect(
        await membershipOf(outerTx, scenario.organizationId, personId),
      ).toBeUndefined();
      // The account's stored address differs in case from the one invited;
      // the check compares them case-insensitively.
      await outerTx
        .update(user)
        .set({ email: scenario.email.toUpperCase() })
        .where(eq(user.id, personId));

      const revoked = await storedInvitation(outerTx, invitationId);
      const organizationEvents = await eventCount(
        outerTx,
        scenario.organizationId,
      );
      const intents = await intentsFor(outerTx, invitationId);
      await expect(
        scenario.service.inviteUser(userContext(scenario.ownerId), {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "existing_account" },
      });
      expect(await storedInvitation(outerTx, invitationId)).toEqual(revoked);
      expect(
        (await auditTrail(outerTx, invitationId)).map((audit) => audit.action),
      ).toEqual([
        "organization.invitation_created",
        "organization.invitation_revoked",
      ]);
      expect(await eventCount(outerTx, scenario.organizationId)).toBe(
        organizationEvents,
      );
      expect(await intentsFor(outerTx, invitationId)).toEqual(intents);
    });
  });

  test("refuses a first invitation to an address that already has an account, as existing_account, creating nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const elsewhere = await seed(outerTx);
      await elsewhere.service.inviteUser(userContext(elsewhere.ownerId), {
        organizationId: elsewhere.organizationId,
        email: scenario.email,
        role: "member",
      });
      const personId = await signUp(outerTx, scenario.email);
      expect(
        await membershipOf(outerTx, elsewhere.organizationId, personId),
      ).toMatchObject({ status: "active" });
      // Stored in a different case from the address invited below.
      await outerTx
        .update(user)
        .set({ email: scenario.email.toUpperCase() })
        .where(eq(user.id, personId));

      const before = await organizationFootprint(
        outerTx,
        scenario.organizationId,
      );
      expect(before.invitations).toBe(0);
      await expect(
        scenario.service.inviteUser(userContext(scenario.ownerId), {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "existing_account" },
      });
      expect(
        await organizationFootprint(outerTx, scenario.organizationId),
      ).toEqual(before);
      expect(
        await membershipOf(outerTx, scenario.organizationId, personId),
      ).toBeUndefined();
    });
  });

  test("refuses a first invitation to an active member who has no invitation row, as already_member, creating nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const elsewhere = await seed(outerTx);
      await elsewhere.service.inviteUser(userContext(elsewhere.ownerId), {
        organizationId: elsewhere.organizationId,
        email: scenario.email,
        role: "member",
      });
      const personId = await signUp(outerTx, scenario.email);
      // A membership made without an invitation in this organisation, as an
      // owner's is at bootstrap.
      await outerTx.insert(organizationMembers).values({
        organizationId: scenario.organizationId,
        userId: personId,
        role: "member",
        status: "active",
      });

      const before = await organizationFootprint(
        outerTx,
        scenario.organizationId,
      );
      expect(before.invitations).toBe(0);
      await expect(
        scenario.service.inviteUser(userContext(scenario.ownerId), {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "admin",
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "already_member" },
      });
      expect(
        await organizationFootprint(outerTx, scenario.organizationId),
      ).toEqual(before);
    });
  });

  test("renews for an address with no account, and the signup that follows accepts it at the renewed role", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      await scenario.management.revokeInvitation(
        {
          organizationId: scenario.organizationId,
          userId: scenario.ownerId,
          correlationId: `corr_${randomUUID()}`,
          expectedVersion: 1,
          actor: { type: "user", id: scenario.ownerId },
        },
        invitationId,
      );

      await expect(
        scenario.service.inviteUser(userContext(scenario.ownerId), {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "admin",
        }),
      ).resolves.toMatchObject({ outcome: "renewed", renewedFrom: "revoked" });

      const personId = await signUp(outerTx, scenario.email);
      expect(
        (await storedInvitation(outerTx, invitationId)).acceptedAt,
      ).not.toBeNull();
      expect(
        await membershipOf(outerTx, scenario.organizationId, personId),
      ).toMatchObject({ status: "active", role: "admin" });
    });
  });

  test("renews a removed member's invitation once their account is gone, and signing up again re-admits them", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      const formerUserId = await signUp(outerTx, scenario.email);
      const membership = await membershipOf(
        outerTx,
        scenario.organizationId,
        formerUserId,
      );
      if (!membership) throw new Error("Missing accepted membership");
      await scenario.management.setMember(
        {
          organizationId: scenario.organizationId,
          userId: scenario.ownerId,
          correlationId: `corr_${randomUUID()}`,
          expectedVersion: membership.version,
          actor: { type: "user", id: scenario.ownerId },
        },
        {
          userId: formerUserId,
          role: "member",
          status: "revoked",
        },
      );
      await outerTx.delete(user).where(eq(user.id, formerUserId));

      const renewed = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      expect(renewed).toMatchObject({
        created: true,
        outcome: "renewed",
        renewedFrom: "accepted",
        invitation: { id: invitationId },
      });
      expect(await storedInvitation(outerTx, invitationId)).toMatchObject({
        acceptedAt: null,
        revokedAt: null,
        version: 2,
      });
      const audits = await auditTrail(outerTx, invitationId);
      expect(audits.map((audit) => [audit.action, audit.reason])).toEqual([
        ["organization.invitation_created", "Organization invitation created"],
        [
          "organization.invitation_renewed",
          "Organization invitation renewed after its member's access ended",
        ],
      ]);
      const renewalEvent = (await eventTrail(outerTx, invitationId)).at(-1);
      expect(renewalEvent).toMatchObject({
        type: "organization.invitation_created.v1",
        aggregateVersion: 2,
        data: expect.objectContaining({ renewedFrom: "accepted" }),
      });
      if (!renewalEvent) throw new Error("Missing renewal event");
      expect(
        await scenario.notifications.materializeInvitationIntents(
          renewalEvent.id,
          baseUrl,
        ),
      ).toHaveLength(1);

      const returningUserId = await signUp(outerTx, scenario.email);
      expect(
        (await storedInvitation(outerTx, invitationId)).acceptedAt,
      ).not.toBeNull();
      expect(
        await membershipOf(outerTx, scenario.organizationId, returningUserId),
      ).toMatchObject({ status: "active", role: "member" });
    });
  });

  test("pins a declared change: a same-key revoke replayed after a renewal answers its stored success while the row is pending again", {
    timeout: timeoutMs,
  }, async () => {
    // Since F.2.7 the receipt is the bus's: it answers a same-key replay after
    // the command's authorize, which checks the actor's authority and that the
    // organisation holds the invitation, not whether it is still pending.
    // Before X15 a revoked row never became pending again, so a replay always
    // matched the row; after a renewal it does not. Declared in the X15 log as
    // a production change, not fixed here.
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      const bus = commandBus(outerTx);
      const context = busContext(scenario.organizationId, scenario.ownerId);
      const idempotencyKey = `revoke-${randomUUID()}`;
      const revoke = () =>
        bus.execute<unknown, JsonObject>({
          name: revokeOrganizationInvitationCommandName,
          context,
          input: { organizationId: scenario.organizationId, invitationId },
          meta: { idempotencyKey, expectedVersion: 1 },
        });
      const revoked = await revoke();
      expect(revoked).toEqual({ id: invitationId, version: 2 });

      await scenario.service.inviteUser(userContext(scenario.ownerId), {
        organizationId: scenario.organizationId,
        email: scenario.email,
        role: "member",
      });

      await expect(revoke()).resolves.toEqual(revoked);
      expect(await storedInvitation(outerTx, invitationId)).toMatchObject({
        version: 3,
        revokedAt: null,
        acceptedAt: null,
      });
    });
  });

  test("renewInvitation refuses, with version_conflict, a pending row and a stale version, and changes nothing", {
    timeout: timeoutMs,
  }, async () => {
    // createOrganizationInvitation (behind inviteUser and the invite command)
    // only reaches renewInvitation for a row it has just read, under its
    // locks, as not pending. These call it directly, as a caller that read
    // earlier or wrongly would, so the guard in its update is what answers.
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      const renew = (expectedVersion: number) =>
        scenario.repository.transaction((tx) =>
          tx.renewInvitation({
            organizationId: scenario.organizationId,
            invitationId,
            expectedVersion,
            role: "admin",
            tokenHash: `sha256:direct:${randomUUID()}`,
            expiresInSeconds: 3_600,
            createdByUserId: scenario.adminId,
          }),
        );

      // Pending and unexpired, at its current version.
      const pending = await storedInvitation(outerTx, invitationId);
      expect(pending.version).toBe(1);
      await expect(renew(1)).rejects.toMatchObject({
        code: "version_conflict",
      });
      expect(await storedInvitation(outerTx, invitationId)).toEqual(pending);

      await scenario.management.revokeInvitation(
        {
          organizationId: scenario.organizationId,
          userId: scenario.ownerId,
          correlationId: `corr_${randomUUID()}`,
          expectedVersion: 1,
          actor: { type: "user", id: scenario.ownerId },
        },
        invitationId,
      );
      const revoked = await storedInvitation(outerTx, invitationId);
      expect(revoked.version).toBe(2);

      // Renewable now, but not at the version read before the revoke.
      await expect(renew(1)).rejects.toMatchObject({
        code: "version_conflict",
      });
      expect(await storedInvitation(outerTx, invitationId)).toEqual(revoked);

      // The control: at its current version the same call renews it.
      await expect(renew(2)).resolves.toMatchObject({
        id: invitationId,
        version: 3,
        role: "admin",
      });
      expect(await storedInvitation(outerTx, invitationId)).toMatchObject({
        version: 3,
        revokedAt: null,
      });
    });
  });

  test("still refuses a pending invitation on email, and leaves it untouched", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      const invitationId = first.invitation.id;
      const pending = await storedInvitation(outerTx, invitationId);

      for (const input of [
        { role: "admin" as const },
        { role: "member" as const, expiresInSeconds: 3_600 },
      ]) {
        await expect(
          scenario.service.inviteUser(userContext(scenario.adminId), {
            organizationId: scenario.organizationId,
            email: scenario.email,
            ...input,
          }),
        ).rejects.toMatchObject({
          code: "conflict",
          details: { field: "email", reason: "already_invited" },
        });
      }
      const exact = await scenario.service.inviteUser(
        userContext(scenario.ownerId),
        {
          organizationId: scenario.organizationId,
          email: scenario.email,
          role: "member",
        },
      );
      expect(exact).toMatchObject({ created: false, outcome: "unchanged" });

      expect(await storedInvitation(outerTx, invitationId)).toEqual(pending);
      expect(
        (await auditTrail(outerTx, invitationId)).map((audit) => audit.action),
      ).toEqual(["organization.invitation_created"]);
      expect(await eventTrail(outerTx, invitationId)).toHaveLength(1);
    });
  });
});

/*
  The same rules on the path the members form runs since F.2.7: the
  `invite_organization_member` command on the tenant bus. There the bus, not
  the foundation repository, writes the event and its outbox row, and its
  after-commit dispatch is what sends the email; a refusal must leave no
  receipt either.
*/
describe.sequential("invite_organization_member on the real database: renewal and refusals", () => {
  async function invite(
    outerTx: Tx,
    scenario: Awaited<ReturnType<typeof seed>>,
    input: { role?: "owner" | "admin" | "member"; actorId?: string } = {},
    committed: DomainEvent[] = [],
  ) {
    return commandBus(outerTx, committed).execute<unknown, JsonObject>({
      name: inviteOrganizationMemberCommandName,
      context: busContext(
        scenario.organizationId,
        input.actorId ?? scenario.ownerId,
      ),
      input: {
        organizationId: scenario.organizationId,
        email: scenario.email,
        role: input.role ?? "member",
      },
      meta: { idempotencyKey: `invite-${randomUUID()}`, expectedVersion: 0 },
    });
  }

  async function revoke(
    outerTx: Tx,
    scenario: Awaited<ReturnType<typeof seed>>,
    invitationId: string,
    expectedVersion: number,
  ) {
    return commandBus(outerTx).execute<unknown, JsonObject>({
      name: revokeOrganizationInvitationCommandName,
      context: busContext(scenario.organizationId, scenario.ownerId),
      input: { organizationId: scenario.organizationId, invitationId },
      meta: { idempotencyKey: `revoke-${randomUUID()}`, expectedVersion },
    });
  }

  /** Every receipt the case's transaction has written, under any command. */
  async function receiptCount(outerTx: Tx) {
    const [row] = await outerTx
      .select({ count: sql<number>`count(*)::int` })
      .from(commandReceipts)
      .where(sql`${commandReceipts.createdAt} = now()`);
    return row?.count ?? 0;
  }

  /**
   * Everything a refusal must leave as it was: the organisation's invitation
   * rows, audit records and events, the outbox rows of those events, its
   * email intents, and the receipts.
   */
  async function everything(outerTx: Tx, organizationId: string) {
    const [outboxRows] = await outerTx
      .select({ count: sql<number>`count(*)::int` })
      .from(outbox)
      .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
      .where(eq(domainEvents.organizationId, organizationId));
    const [intentRows] = await outerTx
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationIntents)
      .where(eq(notificationIntents.organizationId, organizationId));
    return {
      ...(await organizationFootprint(outerTx, organizationId)),
      outbox: outboxRows?.count ?? 0,
      intents: intentRows?.count ?? 0,
      receipts: await receiptCount(outerTx),
    };
  }

  /** The person has an account: they signed up through another organisation. */
  async function accountElsewhere(
    outerTx: Tx,
    scenario: Awaited<ReturnType<typeof seed>>,
  ) {
    const elsewhere = await seed(outerTx);
    await elsewhere.service.inviteUser(userContext(elsewhere.ownerId), {
      organizationId: elsewhere.organizationId,
      email: scenario.email,
      role: "member",
    });
    const personId = await signUp(outerTx, scenario.email);
    expect(
      await membershipOf(outerTx, elsewhere.organizationId, personId),
    ).toMatchObject({ status: "active" });
    return personId;
  }

  test("renews a revoked invitation for an address with no account: one audit row, one event with its outbox row, dispatched after commit, the earlier email suppressed", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await invite(outerTx, scenario);
      const invitationId = String(first.id);
      const [creationEvent] = await eventTrail(outerTx, invitationId);
      if (!creationEvent) throw new Error("Missing creation event");
      const [firstEmail] =
        await scenario.notifications.materializeInvitationIntents(
          creationEvent.id,
          baseUrl,
        );
      if (!firstEmail) throw new Error("Missing first email intent");
      await revoke(outerTx, scenario, invitationId, 1);
      const revoked = await storedInvitation(outerTx, invitationId);
      expect(revoked).toMatchObject({ version: 2 });
      const before = await organizationFootprint(
        outerTx,
        scenario.organizationId,
      );

      const committed: DomainEvent[] = [];
      const renewed = await invite(
        outerTx,
        scenario,
        { role: "admin", actorId: scenario.adminId },
        committed,
      );

      expect(renewed).toEqual({
        id: invitationId,
        role: "admin",
        expiresAt: expect.any(String),
        created: true,
      });
      const row = await storedInvitation(outerTx, invitationId);
      expect(row).toMatchObject({
        version: 3,
        role: "admin",
        revokedAt: null,
        acceptedAt: null,
        createdByUserId: scenario.adminId,
      });
      expect(row.tokenHash).not.toBe(revoked.tokenHash);
      expect(row.expiresAt.toISOString()).toBe(renewed.expiresAt);
      expect(
        await organizationFootprint(outerTx, scenario.organizationId),
      ).toEqual({
        invitations: before.invitations,
        audits: before.audits + 1,
        events: before.events + 1,
      });
      const renewals = (await auditTrail(outerTx, invitationId)).filter(
        (audit) => audit.action === "organization.invitation_renewed",
      );
      expect(renewals).toEqual([
        expect.objectContaining({
          actorType: "user",
          actorId: scenario.adminId,
          reason: "Organization invitation renewed after it was revoked",
        }),
      ]);
      const renewalEvent = (await eventTrail(outerTx, invitationId)).at(-1);
      if (!renewalEvent) throw new Error("Missing renewal event");
      expect(renewalEvent).toMatchObject({
        type: "organization.invitation_created.v1",
        aggregateVersion: 3,
        actor: { type: "user", id: scenario.adminId },
        data: {
          invitationId,
          role: "admin",
          expiresAt: renewed.expiresAt,
          renewedFrom: "revoked",
        },
      });
      const outboxRows = await outerTx
        .select({ state: outbox.state })
        .from(outbox)
        .where(eq(outbox.eventId, renewalEvent.id));
      expect(outboxRows).toEqual([{ state: "pending" }]);
      expect(committed.map((event) => event.id)).toEqual([renewalEvent.id]);
      const [earlier] = (await intentsFor(outerTx, invitationId)).filter(
        (intent) => intent.id === firstEmail.id,
      );
      expect(earlier).toMatchObject({ status: "suppressed" });
      expect(
        await scenario.notifications.materializeInvitationIntents(
          renewalEvent.id,
          baseUrl,
        ),
      ).toHaveLength(1);
    });
  });

  test("renews an expired invitation, from expired, at version 2", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await invite(outerTx, scenario);
      const invitationId = String(first.id);
      await outerTx
        .update(invitations)
        .set({
          createdAt: sql`clock_timestamp() - interval '8 days'`,
          expiresAt: sql`clock_timestamp() - interval '1 day'`,
        })
        .where(eq(invitations.id, invitationId));

      const committed: DomainEvent[] = [];
      const renewed = await invite(outerTx, scenario, {}, committed);

      expect(renewed).toMatchObject({ id: invitationId, created: true });
      expect(await storedInvitation(outerTx, invitationId)).toMatchObject({
        version: 2,
      });
      expect(
        (await auditTrail(outerTx, invitationId)).map((audit) => [
          audit.action,
          audit.reason,
        ]),
      ).toEqual([
        ["organization.invitation_created", "Organization invitation created"],
        [
          "organization.invitation_renewed",
          "Organization invitation renewed after it expired",
        ],
      ]);
      const events = await eventTrail(outerTx, invitationId);
      expect(
        events.map((event) => [event.aggregateVersion, event.data]),
      ).toEqual([
        [1, expect.not.objectContaining({ renewedFrom: expect.anything() })],
        [2, expect.objectContaining({ renewedFrom: "expired" })],
      ]);
      expect(committed.map((event) => event.id)).toEqual([events[1]?.id]);
    });
  });

  test("renews an accepted invitation from accepted once its member is removed and their account is gone", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await invite(outerTx, scenario);
      const invitationId = String(first.id);
      const formerUserId = await signUp(outerTx, scenario.email);
      const membership = await membershipOf(
        outerTx,
        scenario.organizationId,
        formerUserId,
      );
      if (!membership) throw new Error("Missing accepted membership");
      await commandBus(outerTx).execute({
        name: setOrganizationMemberCommandName,
        context: busContext(scenario.organizationId, scenario.ownerId),
        input: {
          organizationId: scenario.organizationId,
          userId: formerUserId,
          role: "member",
          status: "revoked",
        },
        meta: {
          idempotencyKey: `remove-${randomUUID()}`,
          expectedVersion: membership.version,
        },
      });
      await outerTx.delete(user).where(eq(user.id, formerUserId));

      const renewed = await invite(outerTx, scenario);
      expect(renewed).toMatchObject({ id: invitationId, created: true });
      expect(await storedInvitation(outerTx, invitationId)).toMatchObject({
        version: 2,
        acceptedAt: null,
        revokedAt: null,
      });
      expect((await eventTrail(outerTx, invitationId)).at(-1)).toMatchObject({
        aggregateVersion: 2,
        data: expect.objectContaining({ renewedFrom: "accepted" }),
      });
      const returningUserId = await signUp(outerTx, scenario.email);
      expect(
        await membershipOf(outerTx, scenario.organizationId, returningUserId),
      ).toMatchObject({ status: "active", role: "member" });
    });
  });

  test("refuses a first invitation to an address that already has an account, as existing_account, writing nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      await accountElsewhere(outerTx, scenario);
      const before = await everything(outerTx, scenario.organizationId);
      expect(before.invitations).toBe(0);

      const committed: DomainEvent[] = [];
      await expect(
        invite(outerTx, scenario, {}, committed),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "existing_account" },
      });
      expect(await everything(outerTx, scenario.organizationId)).toEqual(
        before,
      );
      expect(committed).toEqual([]);
    });
  });

  test("refuses to renew a revoked invitation whose person has since made an account, as existing_account, writing nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      const scenario = await seed(outerTx);
      const first = await invite(outerTx, scenario);
      const invitationId = String(first.id);
      await revoke(outerTx, scenario, invitationId, 1);
      await accountElsewhere(outerTx, scenario);
      const row = await storedInvitation(outerTx, invitationId);
      const before = await everything(outerTx, scenario.organizationId);

      const committed: DomainEvent[] = [];
      await expect(
        invite(outerTx, scenario, {}, committed),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "existing_account" },
      });
      expect(await storedInvitation(outerTx, invitationId)).toEqual(row);
      expect(await everything(outerTx, scenario.organizationId)).toEqual(
        before,
      );
      expect(committed).toEqual([]);
    });
  });

  test("refuses an active member as already_member, with or without an invitation row here, writing nothing", {
    timeout: timeoutMs,
  }, async () => {
    await inRollbackTransaction(async (outerTx) => {
      // Accepted through an invitation here: the row is on file, not pending.
      const scenario = await seed(outerTx);
      const first = await invite(outerTx, scenario);
      const personId = await signUp(outerTx, scenario.email);
      expect(
        await membershipOf(outerTx, scenario.organizationId, personId),
      ).toMatchObject({ status: "active" });
      const row = await storedInvitation(outerTx, String(first.id));
      const before = await everything(outerTx, scenario.organizationId);
      await expect(
        invite(outerTx, scenario, { role: "admin" }),
      ).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "already_member" },
      });
      expect(await storedInvitation(outerTx, String(first.id))).toEqual(row);
      expect(await everything(outerTx, scenario.organizationId)).toEqual(
        before,
      );

      // A member made without an invitation here, as an owner is at
      // bootstrap: no row at all.
      const other = await seed(outerTx);
      const otherPerson = await accountElsewhere(outerTx, other);
      await outerTx.insert(organizationMembers).values({
        organizationId: other.organizationId,
        userId: otherPerson,
        role: "member",
        status: "active",
      });
      const otherBefore = await everything(outerTx, other.organizationId);
      expect(otherBefore.invitations).toBe(0);
      await expect(invite(outerTx, other)).rejects.toMatchObject({
        code: "conflict",
        details: { field: "email", reason: "already_member" },
      });
      expect(await everything(outerTx, other.organizationId)).toEqual(
        otherBefore,
      );
    });
  });
});

afterAll(async () => {
  await suiteStorage.close();
});
