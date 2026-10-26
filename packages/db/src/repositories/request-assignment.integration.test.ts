import {
  AtomicCommandBus,
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import type { Database } from "../client.js";
import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  domainEvents,
  notificationIntents,
  outbox,
  projects,
  requests,
  securityAuditRecords,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createCommandAuthorizationRepository } from "./command-authorization.js";
import { createCommandTransactionManager } from "./command-repository.js";
import { createNotificationRepository } from "./notification-repository.js";
import { createRequestRepository } from "./request-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
  `assign_request` on a real database (ruling 262): through the command bus
  the web's form reaches, with the real request repository and the real
  `assertCurrent`, so the row, its event, its outbox row and its audit row are
  the ones production writes. Each case is rolled back.
*/

const busSecret = "request-assignment-live-bus-fingerprint-secret-0";

class TestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new TestRollback();
    }),
  ).rejects.toBeInstanceOf(TestRollback);
}

function portFactory(name: string, database: Database | Tx) {
  if (name === "requests") return createRequestRepository(database);
  if (name === "commandAuthorization")
    return createCommandAuthorizationRepository(database);
  return undefined;
}

function bus(tx: Tx) {
  return new AtomicCommandBus({
    registry: createCoreCommandRegistry(),
    transactions: createCommandTransactionManager(
      tx as unknown as Database,
      portFactory,
    ),
    fingerprintSecret: busSecret,
    authorizeContext: (context, uow) =>
      uow
        .port<ReturnType<typeof createCommandAuthorizationRepository>>(
          "commandAuthorization",
        )
        .assertCurrent(context),
  });
}

async function seedUser(tx: Tx, name: string) {
  const userId = `user_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await tx.execute(sql`
    insert into "signup_allowlist" ("normalized_email", "status")
    values (${email}, 'active')
  `);
  await tx.execute(sql`
    insert into "user" ("id", "name", "email", "updated_at")
    values (${userId}, ${name}, ${email}, now())
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
    values (${organizationId}, 'Assignment tenant',
      ${`assignment-live-${organizationId}`}, 'active')
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

/**
 * An organisation with a triaged request, an admin who may assign it, an
 * active member, a revoked member, a plain member who may not assign, and a
 * person who belongs to another organisation only.
 */
async function seed(tx: Tx) {
  const organizationId = await seedOrganization(tx);
  const elsewhere = await seedOrganization(tx);
  const admin = await seedUser(tx, "Assigning admin");
  const member = await seedUser(tx, "Assignable member");
  const revoked = await seedUser(tx, "Revoked member");
  const plain = await seedUser(tx, "Plain member");
  const outsider = await seedUser(tx, "Outsider");
  await seedMembership(tx, organizationId, admin.userId, "admin");
  await seedMembership(tx, organizationId, member.userId, "member");
  await seedMembership(tx, organizationId, revoked.userId, "member", "revoked");
  await seedMembership(tx, organizationId, plain.userId, "member");
  await seedMembership(tx, elsewhere, outsider.userId, "member");
  const suffix = crypto.randomUUID().slice(0, 8);
  const [project] = await tx
    .insert(projects)
    .values({
      organizationId,
      name: `Assignment ${suffix}`,
      slug: `assignment-${suffix}`,
      keyPrefix: `A${suffix.toUpperCase()}`,
      status: "active",
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("no project");
  const requestId = crypto.randomUUID();
  await tx.insert(requests).values({
    id: requestId,
    organizationId,
    sequenceNumber: 1,
    displayKey: `A${suffix.toUpperCase()}-1`,
    sourceKind: "human_direct",
    targetProjectId: project.id,
    type: "feature",
    title: "Assign this request",
    descriptionMd: "Body",
    state: "triage",
    reporterType: "user",
    reporterId: admin.userId,
    version: 1,
  });
  return {
    organizationId,
    projectId: project.id,
    requestId,
    admin,
    member,
    revoked,
    plain,
    outsider,
  };
}

function personContext(
  organizationId: string,
  person: { userId: string; sessionId: string },
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: person.userId },
    organizationId,
    scopes: new Set(["request:triage"]),
    credentialId: person.sessionId,
    correlationId: crypto.randomUUID(),
  };
}

async function requestRow(tx: Tx, requestId: string) {
  const [row] = await tx
    .select({
      assigneeType: requests.assigneeType,
      assigneeId: requests.assigneeId,
      version: requests.version,
    })
    .from(requests)
    .where(eq(requests.id, requestId));
  return row;
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live request assignment", () => {
  test("assigns and unassigns, each with its row, event, outbox row and audit row", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seed(tx);
      const assign = personContext(seeded.organizationId, seeded.admin);
      const result = await bus(tx).execute({
        name: "assign_request",
        context: assign,
        meta: { idempotencyKey: "assign-live-key-000001", expectedVersion: 1 },
        input: {
          organizationId: seeded.organizationId,
          requestId: seeded.requestId,
          assigneeUserId: seeded.member.userId,
        },
      });
      expect(result).toMatchObject({ id: seeded.requestId, version: 2 });
      expect(await requestRow(tx, seeded.requestId)).toEqual({
        assigneeType: "user",
        assigneeId: seeded.member.userId,
        version: 2,
      });

      const unassign = personContext(seeded.organizationId, seeded.admin);
      await bus(tx).execute({
        name: "assign_request",
        context: unassign,
        meta: { idempotencyKey: "assign-live-key-000002", expectedVersion: 2 },
        input: {
          organizationId: seeded.organizationId,
          requestId: seeded.requestId,
          assigneeUserId: null,
        },
      });
      expect(await requestRow(tx, seeded.requestId)).toEqual({
        assigneeType: null,
        assigneeId: null,
        version: 3,
      });

      const events = await tx
        .select({
          id: domainEvents.id,
          type: domainEvents.type,
          aggregateVersion: domainEvents.aggregateVersion,
          data: domainEvents.data,
          correlationId: domainEvents.correlationId,
        })
        .from(domainEvents)
        .where(eq(domainEvents.requestId, seeded.requestId))
        .orderBy(domainEvents.aggregateVersion);
      expect(events.map(({ id: _id, ...event }) => event)).toEqual([
        {
          type: "request.assigned.v1",
          aggregateVersion: 2,
          correlationId: assign.correlationId,
          data: expect.objectContaining({
            requestId: seeded.requestId,
            version: 2,
            assignee: { type: "user", id: seeded.member.userId },
            previousAssignee: null,
          }),
        },
        {
          type: "request.assigned.v1",
          aggregateVersion: 3,
          correlationId: unassign.correlationId,
          data: expect.objectContaining({
            version: 3,
            assignee: null,
            previousAssignee: { type: "user", id: seeded.member.userId },
          }),
        },
      ]);
      for (const event of events) {
        const queued = await tx
          .select({ id: outbox.id })
          .from(outbox)
          .where(eq(outbox.eventId, event.id));
        expect(queued, `an outbox row for ${event.id}`).toHaveLength(1);
      }

      const audit = await tx
        .select({
          organizationId: securityAuditRecords.organizationId,
          actorType: securityAuditRecords.actorType,
          actorId: securityAuditRecords.actorId,
          action: securityAuditRecords.action,
          targetType: securityAuditRecords.targetType,
          reason: securityAuditRecords.reason,
          fieldNames: securityAuditRecords.fieldNames,
          correlationId: securityAuditRecords.correlationId,
        })
        .from(securityAuditRecords)
        .where(
          and(
            eq(securityAuditRecords.targetType, "request"),
            eq(securityAuditRecords.targetId, seeded.requestId),
          ),
        );
      const expected = {
        organizationId: seeded.organizationId,
        actorType: "user",
        actorId: seeded.admin.userId,
        action: "request.assigned",
        targetType: "request",
        fieldNames: ["assigneeType", "assigneeId"],
      };
      expect(
        audit.sort((left, right) => left.reason.localeCompare(right.reason)),
      ).toEqual([
        {
          ...expected,
          reason: "Request assigned",
          correlationId: assign.correlationId,
        },
        {
          ...expected,
          reason: "Request unassigned",
          correlationId: unassign.correlationId,
        },
      ]);
    });
  });

  test("refuses a revoked member, another organisation's member and an assigner without triage authority, changing nothing", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seed(tx);
      const attempt = (
        actor: { userId: string; sessionId: string },
        assigneeUserId: string,
        key: string,
      ) =>
        bus(tx)
          .execute({
            name: "assign_request",
            context: personContext(seeded.organizationId, actor),
            meta: { idempotencyKey: key, expectedVersion: 1 },
            input: {
              organizationId: seeded.organizationId,
              requestId: seeded.requestId,
              assigneeUserId,
            },
          })
          .then(
            () => "accepted",
            (error: { code?: string }) => error.code,
          );
      expect(
        await attempt(
          seeded.admin,
          seeded.revoked.userId,
          "assign-refused-key-0001",
        ),
      ).toBe("validation_failed");
      expect(
        await attempt(
          seeded.admin,
          seeded.outsider.userId,
          "assign-refused-key-0002",
        ),
      ).toBe("validation_failed");
      expect(
        await attempt(
          seeded.plain,
          seeded.member.userId,
          "assign-refused-key-0003",
        ),
      ).toBe("forbidden");
      expect(await requestRow(tx, seeded.requestId)).toEqual({
        assigneeType: null,
        assigneeId: null,
        version: 1,
      });
      const audit = await tx
        .select({ id: securityAuditRecords.id })
        .from(securityAuditRecords)
        .where(eq(securityAuditRecords.targetId, seeded.requestId));
      expect(audit).toEqual([]);
    });
  });
  /*
    Ruling 264: the outbox worker's request intents email the person an
    assignment names, and nobody else: not the assigner, not for an
    unassignment, and not for an assignment the request has since moved on
    from.
  */
  test("emails the new assignee alone, through request_event_v1", {
    timeout: 30_000,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const seeded = await seed(tx);
      const notifications = createNotificationRepository(
        tx as unknown as Database,
      );
      const baseUrl = "https://requestport.example";
      let version = 1;
      const assignTo = async (
        actor: { userId: string; sessionId: string },
        assigneeUserId: string | null,
      ) => {
        await bus(tx).execute({
          name: "assign_request",
          context: personContext(seeded.organizationId, actor),
          meta: {
            idempotencyKey: `assign-notify-key-${version}`.padEnd(22, "0"),
            expectedVersion: version,
          },
          input: {
            organizationId: seeded.organizationId,
            requestId: seeded.requestId,
            assigneeUserId,
          },
        });
        version += 1;
        const [event] = await tx
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.requestId, seeded.requestId),
              eq(domainEvents.aggregateVersion, version),
            ),
          );
        if (!event) throw new Error("no assignment event");
        return event.id;
      };
      const intentsOf = async (eventId: string) =>
        tx
          .select({
            recipientUserId: notificationIntents.recipientUserId,
            recipientRef: notificationIntents.recipientRef,
            template: notificationIntents.template,
            channel: notificationIntents.channel,
            viewModel: notificationIntents.viewModel,
          })
          .from(notificationIntents)
          .where(eq(notificationIntents.eventId, eventId));

      const toMember = await assignTo(seeded.admin, seeded.member.userId);
      expect(
        await notifications.materializeRequestIntents(toMember, baseUrl),
      ).toHaveLength(1);
      expect(await intentsOf(toMember)).toEqual([
        {
          recipientUserId: seeded.member.userId,
          recipientRef: `${seeded.member.userId}@example.invalid`,
          template: "request_event_v1",
          channel: "email",
          viewModel: expect.objectContaining({
            kind: "request",
            requestId: seeded.requestId,
            recipientName: "Assignable member",
            reason: "This request was assigned to you.",
          }),
        },
      ]);

      // The admin takes it: nobody is told, the assigner least of all; and
      // the member's assignment, reached again, adds nothing.
      const toSelf = await assignTo(seeded.admin, seeded.admin.userId);
      expect(
        await notifications.materializeRequestIntents(toSelf, baseUrl),
      ).toEqual([]);
      expect(
        await notifications.materializeRequestIntents(toMember, baseUrl),
      ).toEqual([]);

      const unassigned = await assignTo(seeded.admin, null);
      expect(
        await notifications.materializeRequestIntents(unassigned, baseUrl),
      ).toEqual([]);

      // A reassignment the worker reaches after the request moved on sends
      // nothing to the person it named.
      const toPlain = await assignTo(seeded.admin, seeded.plain.userId);
      await assignTo(seeded.admin, seeded.member.userId);
      expect(
        await notifications.materializeRequestIntents(toPlain, baseUrl),
      ).toEqual([]);
      for (const eventId of [toSelf, unassigned, toPlain])
        expect(await intentsOf(eventId)).toEqual([]);
    });
  });
});
