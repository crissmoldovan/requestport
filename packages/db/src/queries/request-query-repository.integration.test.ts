import type { RequestFilters } from "@requestport/domain";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  agentPrincipals,
  answers,
  domainEvents,
  messages,
  organizationMembers,
  organizations,
  projects,
  questions,
  requests,
  signupAllowlist,
  user,
  userRequestReadStates,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createRequestQueryRepository } from "./request-query-repository.js";

/**
 * A seeded row's time: an hour after this run starts, plus `minutes`, so the
 * rows sort after anything the database stamps with the current time, on
 * any day the suite runs (a fixed date sorted before it once that date passed).
 */
function seededAt(minutes: number) {
  return new Date(Date.now() + (60 + minutes) * 60_000);
}

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

class RequestQueryTestRollback extends Error {}

async function inRollbackTransaction(run: (tx: Tx) => Promise<void>) {
  try {
    await suiteStorage.transaction(async (tx) => {
      await run(tx);
      throw new RequestQueryTestRollback();
    });
  } catch (error) {
    if (error instanceof RequestQueryTestRollback) return;
    throw error;
  }
  throw new Error("Expected the request query transaction to roll back");
}

afterAll(async () => {
  await suiteStorage.close();
});

describe.sequential("live request query adapter", () => {
  test("reads request detail inside an existing transaction and advances read state monotonically", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const userId = `user_${crypto.randomUUID()}`;
      const email = `${crypto.randomUUID()}@example.invalid`;
      const organizationId = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const olderEventId = crypto.randomUUID();
      const newerEventId = crypto.randomUUID();
      const olderOccurredAt = new Date("2026-08-18T08:00:00.000Z");
      const newerOccurredAt = new Date("2026-08-18T08:01:00.000Z");

      await tx
        .insert(signupAllowlist)
        .values({ normalizedEmail: email, status: "active" });
      await tx
        .insert(user)
        .values({ id: userId, name: "Request reader", email });
      await tx.insert(organizations).values({
        id: organizationId,
        name: "Request query tenant",
        slug: `request-query-${crypto.randomUUID()}`,
        status: "active",
      });
      await tx.insert(organizationMembers).values({
        organizationId,
        userId,
        role: "owner",
        status: "active",
      });
      await tx.insert(projects).values({
        id: projectId,
        organizationId,
        name: "Target project",
        slug: `target-${crypto.randomUUID()}`,
        keyPrefix: `RQ${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
        status: "active",
      });
      await tx.insert(requests).values({
        id: requestId,
        organizationId,
        sequenceNumber: 1,
        displayKey: "RQT-1",
        sourceKind: "human_direct",
        sourceProjectId: null,
        targetProjectId: projectId,
        type: "feature",
        title: "Prove request queries",
        descriptionMd: "Exercise the live transactional query path.",
        state: "submitted",
        reporterType: "user",
        reporterId: userId,
        visibility: "organization",
        sensitivity: "normal",
        version: 1,
        submittedAt: olderOccurredAt,
      });
      await tx.insert(domainEvents).values([
        {
          id: olderEventId,
          organizationId,
          aggregateType: "request",
          aggregateId: requestId,
          aggregateVersion: 1,
          type: "request.submitted",
          schemaVersion: 1,
          occurredAt: olderOccurredAt,
          projectId,
          requestId,
          actor: { type: "user", id: userId },
          correlationId: crypto.randomUUID(),
          causationId: crypto.randomUUID(),
          data: {},
          links: {},
        },
        {
          id: newerEventId,
          organizationId,
          aggregateType: "request",
          aggregateId: requestId,
          aggregateVersion: 2,
          type: "request.triage_started",
          schemaVersion: 1,
          occurredAt: newerOccurredAt,
          projectId,
          requestId,
          actor: { type: "user", id: userId },
          correlationId: crypto.randomUUID(),
          causationId: crypto.randomUUID(),
          data: {},
          links: {},
        },
      ]);

      const repository = createRequestQueryRepository(tx);
      const detail = await repository.getRequest({
        organizationId,
        userId,
        requestId,
      });
      expect(detail).toMatchObject({
        id: requestId,
        displayKey: "RQT-1",
        sourceKind: "human_direct",
        allowedActions: expect.arrayContaining([
          "begin_triage",
          "cancel_request",
          "withdraw_request",
        ]),
      });

      await repository.markRequestRead({
        organizationId,
        userId,
        requestId,
        lastSeenEventId: newerEventId,
      });
      await repository.markRequestRead({
        organizationId,
        userId,
        requestId,
        lastSeenEventId: olderEventId,
      });

      const [readState] = await tx
        .select()
        .from(userRequestReadStates)
        .where(eq(userRequestReadStates.requestId, requestId));
      expect(readState).toMatchObject({
        organizationId,
        userId,
        requestId,
        lastSeenEventId: newerEventId,
        lastSeenAt: newerOccurredAt,
      });
    });
  });

  /*
    Ruling 262: the reporter's and the assignee's names come from the
    request's own organisation's members, and each view's count is read under
    the conditions of its list.
  */
  test("names people from the request's organisation only, counts each view as its list reads, and offers assignment to a maintainer", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = crypto.randomUUID();
      const elsewhere = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const people = {
        reader: `user_${crypto.randomUUID()}`,
        blank: `user_${crypto.randomUUID()}`,
        outsider: `user_${crypto.randomUUID()}`,
      };
      const email = (id: string) => `${id}@example.invalid`;
      await tx.insert(signupAllowlist).values(
        Object.values(people).map((id) => ({
          normalizedEmail: email(id),
          status: "active",
        })),
      );
      await tx.insert(user).values([
        {
          id: people.reader,
          name: "Request reader",
          email: email(people.reader),
        },
        { id: people.blank, name: "  ", email: email(people.blank) },
        {
          id: people.outsider,
          name: "Outsider",
          email: email(people.outsider),
        },
      ]);
      await tx.insert(organizations).values([
        {
          id: organizationId,
          name: "Named tenant",
          slug: `named-${crypto.randomUUID()}`,
          status: "active",
        },
        {
          id: elsewhere,
          name: "Other tenant",
          slug: `other-${crypto.randomUUID()}`,
          status: "active",
        },
      ]);
      await tx.insert(organizationMembers).values([
        {
          organizationId,
          userId: people.reader,
          role: "owner",
          status: "active",
        },
        {
          organizationId,
          userId: people.blank,
          role: "member",
          status: "revoked",
        },
        {
          organizationId: elsewhere,
          userId: people.outsider,
          role: "member",
          status: "active",
        },
      ]);
      await tx.insert(projects).values({
        id: projectId,
        organizationId,
        name: "Target project",
        slug: `target-${crypto.randomUUID()}`,
        keyPrefix: `RN${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
        status: "active",
      });
      const base = {
        organizationId,
        sourceKind: "human_direct" as const,
        sourceProjectId: null,
        targetProjectId: projectId,
        type: "feature" as const,
        descriptionMd: "Body",
        visibility: "organization" as const,
        sensitivity: "normal" as const,
        version: 1,
      };
      const ids = {
        assigned: crypto.randomUUID(),
        outsiderReported: crypto.randomUUID(),
        cancelled: crypto.randomUUID(),
      };
      await tx.insert(requests).values([
        {
          ...base,
          id: ids.assigned,
          sequenceNumber: 1,
          displayKey: "RN-1",
          title: "Reported by the reader, assigned to a revoked member",
          state: "triage",
          reporterType: "user",
          reporterId: people.reader,
          assigneeType: "user",
          assigneeId: people.blank,
        },
        {
          ...base,
          id: ids.outsiderReported,
          sequenceNumber: 2,
          displayKey: "RN-2",
          title: "Reported by someone from another organisation",
          state: "submitted",
          reporterType: "user",
          reporterId: people.outsider,
          assigneeType: "agent",
          assigneeId: crypto.randomUUID(),
        },
        {
          ...base,
          id: ids.cancelled,
          sequenceNumber: 3,
          displayKey: "RN-3",
          title: "Cancelled",
          state: "cancelled",
          reporterType: "user",
          reporterId: people.reader,
        },
      ]);

      const repository = createRequestQueryRepository(tx);
      const reader = { organizationId, userId: people.reader };
      const page = await repository.listRequests(reader);
      const names = Object.fromEntries(
        page.items.map((item) => [
          item.id,
          [item.reporterDisplayName, item.assigneeDisplayName],
        ]),
      );
      expect(names).toEqual({
        // A revoked member is still named: they were a member.
        [ids.assigned]: ["Request reader", email(people.blank)],
        // A person of another organisation, and an agent, are not.
        [ids.outsiderReported]: [null, null],
        [ids.cancelled]: ["Request reader", null],
      });
      const detail = await repository.getRequest({
        ...reader,
        requestId: ids.assigned,
      });
      expect(detail).toMatchObject({
        reporterDisplayName: "Request reader",
        assigneeDisplayName: email(people.blank),
        permissions: { canAssign: true },
      });
      const cancelled = await repository.getRequest({
        ...reader,
        requestId: ids.cancelled,
      });
      expect(cancelled?.permissions.canAssign).toBe(false);

      const views: Record<string, RequestFilters> = {
        all: { mode: "all" },
        inbox: { mode: "inbox" },
        myWork: { mode: "my_work" },
        waiting: { mode: "all", unanswered: true },
        triage: { mode: "all", state: ["triage"] },
        assignedToRevoked: { mode: "all", assigneeId: people.blank },
      };
      const counts = await repository.countRequests({ ...reader, views });
      const listed: Record<string, number> = {};
      for (const [view, filters] of Object.entries(views)) {
        listed[view] = (
          await repository.listRequests({ ...reader, filters })
        ).items.length;
      }
      expect(counts).toEqual(listed);
      expect(counts).toEqual({
        all: 3,
        // No request has an event, a question or a mention, and none is
        // assigned to the reader.
        inbox: 0,
        myWork: 2,
        waiting: 0,
        triage: 1,
        assignedToRevoked: 1,
      });
    });
  });
  /*
    Ruling 264: an agent is named as a person is — reporter, assignee, the
    author of a message or an answer, and the actor of a timeline event — by
    its display name, and only by the request's own organisation's agent.
  */
  test("names the organisation's agents as reporter, assignee, author and actor, and no other organisation's", {
    timeout: lockChoreographyTimeoutMs,
  }, async () => {
    await inRollbackTransaction(async (tx) => {
      const organizationId = crypto.randomUUID();
      const elsewhere = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const reader = `user_${crypto.randomUUID()}`;
      const email = `${reader}@example.invalid`;
      const agent = crypto.randomUUID();
      const foreignAgent = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const questionId = crypto.randomUUID();
      await tx
        .insert(signupAllowlist)
        .values({ normalizedEmail: email, status: "active" });
      await tx.insert(user).values({ id: reader, name: "Agent reader", email });
      await tx.insert(organizations).values([
        {
          id: organizationId,
          name: "Agent tenant",
          slug: `agents-${crypto.randomUUID()}`,
          status: "active",
        },
        {
          id: elsewhere,
          name: "Other tenant",
          slug: `agents-other-${crypto.randomUUID()}`,
          status: "active",
        },
      ]);
      await tx.insert(organizationMembers).values({
        organizationId,
        userId: reader,
        role: "owner",
        status: "active",
      });
      await tx.insert(projects).values({
        id: projectId,
        organizationId,
        name: "Target project",
        slug: `target-${crypto.randomUUID()}`,
        keyPrefix: `RA${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
        status: "active",
      });
      await tx.insert(agentPrincipals).values([
        {
          id: agent,
          organizationId,
          displayName: "Triage bot",
          slug: `triage-bot-${crypto.randomUUID()}`,
          createdByUserId: reader,
        },
        {
          id: foreignAgent,
          organizationId: elsewhere,
          displayName: "Foreign bot",
          slug: `foreign-bot-${crypto.randomUUID()}`,
          createdByUserId: reader,
        },
      ]);
      await tx.insert(requests).values({
        id: requestId,
        organizationId,
        sequenceNumber: 1,
        displayKey: "RA-1",
        sourceKind: "human_direct",
        sourceProjectId: null,
        targetProjectId: projectId,
        type: "feature",
        title: "Reported by an agent, assigned to another organisation's",
        descriptionMd: "Body",
        state: "triage",
        reporterType: "agent",
        reporterId: agent,
        assigneeType: "agent",
        assigneeId: foreignAgent,
        visibility: "organization",
        sensitivity: "normal",
        version: 2,
      });
      await tx.insert(messages).values([
        {
          id: crypto.randomUUID(),
          organizationId,
          requestId,
          actorType: "agent",
          actorId: agent,
          bodyMd: "From the agent",
          createdAt: seededAt(0),
        },
        {
          id: crypto.randomUUID(),
          organizationId,
          requestId,
          actorType: "agent",
          actorId: foreignAgent,
          bodyMd: "From another organisation's agent",
          createdAt: seededAt(1),
        },
        {
          id: crypto.randomUUID(),
          organizationId,
          requestId,
          actorType: "user",
          actorId: reader,
          bodyMd: "From the reader",
          createdAt: seededAt(2),
        },
      ]);
      await tx.insert(questions).values({
        id: questionId,
        organizationId,
        subjectType: "request",
        subjectId: requestId,
        parentRequestId: requestId,
        audienceType: "requester",
        bodyMd: "Which one?",
        askedByType: "user",
        askedById: reader,
      });
      await tx.insert(answers).values({
        id: crypto.randomUUID(),
        organizationId,
        questionId,
        actorType: "agent",
        actorId: agent,
        sourceChannel: "mcp",
        bodyMd: "This one",
      });
      const eventData = {
        requestId,
        displayKey: "RA-1",
        state: "triage",
        assignee: { type: "user", id: reader },
        previousAssignee: null,
      };
      await tx.insert(domainEvents).values([
        {
          id: crypto.randomUUID(),
          organizationId,
          aggregateType: "request",
          aggregateId: requestId,
          aggregateVersion: 1,
          type: "request.assigned.v1",
          schemaVersion: 1,
          occurredAt: seededAt(0),
          projectId,
          requestId,
          actor: { type: "agent", id: agent },
          correlationId: crypto.randomUUID(),
          causationId: crypto.randomUUID(),
          data: { ...eventData, version: 1 },
          links: {},
        },
        {
          id: crypto.randomUUID(),
          organizationId,
          aggregateType: "request",
          aggregateId: requestId,
          aggregateVersion: 2,
          type: "request.assigned.v1",
          schemaVersion: 1,
          occurredAt: seededAt(1),
          projectId,
          requestId,
          actor: { type: "user", id: reader },
          correlationId: crypto.randomUUID(),
          causationId: crypto.randomUUID(),
          data: {
            ...eventData,
            version: 2,
            assignee: { type: "agent", id: foreignAgent },
            previousAssignee: { type: "user", id: reader },
          },
          links: {},
        },
      ]);

      const repository = createRequestQueryRepository(tx);
      const scope = { organizationId, userId: reader };
      const [listed] = (await repository.listRequests(scope)).items;
      expect([
        listed?.reporterDisplayName,
        listed?.assigneeDisplayName,
      ]).toEqual(["Triage bot", null]);
      const detail = await repository.getRequest({ ...scope, requestId });
      expect(detail).toMatchObject({
        reporterDisplayName: "Triage bot",
        assigneeDisplayName: null,
      });
      expect(
        detail?.messages.map((message) => message.actorDisplayName),
      ).toEqual(["Triage bot", null, "Agent reader"]);
      expect(
        detail?.questions[0]?.answers.map((answer) => answer.actorDisplayName),
      ).toEqual(["Triage bot"]);
      const timeline = await repository.listTimeline({ ...scope, requestId });
      expect(timeline.items.map((event) => event.actorDisplayName)).toEqual([
        "Agent reader",
        "Triage bot",
      ]);
      // The organisation's activity holds one event more: the appearance
      // defaults the owner's membership seeded, whose service actor nobody
      // names.
      const activity = await repository.listOrganizationActivity(scope);
      expect(
        activity.items.map((event) => [
          event.actor.type,
          event.actorDisplayName,
        ]),
      ).toEqual([
        ["user", "Agent reader"],
        ["agent", "Triage bot"],
        ["service", null],
      ]);
    });
  });
});
