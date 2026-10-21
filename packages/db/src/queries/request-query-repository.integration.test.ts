import { eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import {
  domainEvents,
  organizationMembers,
  organizations,
  projects,
  requests,
  signupAllowlist,
  user,
  userRequestReadStates,
} from "../schema/index.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import { createRequestQueryRepository } from "./request-query-repository.js";

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
});
