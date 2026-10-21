import {
  auditActor,
  DomainError,
  type OperationsMutation,
  type OperationsOperator,
  type OperationsPort,
} from "@requestport/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  domainEvents,
  importRuns,
  importTaskDispatches,
  notificationIntents,
  organizationMembers,
  organizations,
  outbox,
  securityAuditRecords,
  slackDeliveryOperations,
  slackInstallations,
} from "../schema/index.js";
import { inTenantTransaction, withTenant } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

/**
 * Locks the operator's standing `FOR SHARE` — the organisation membership
 * row joined to the organisation row — and throws `forbidden` unless
 * `operator.userId` is an active owner or admin of the active organisation.
 * Every requeue and the port's `authorize` run it; the administration read
 * runs it too (`administration/operations-reads.ts`).
 */
export async function requireOperationsOperator(
  database: Database | Tx,
  operator: OperationsOperator,
) {
  const [access] = await database
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMembers.organizationId),
    )
    .where(
      and(
        eq(organizationMembers.organizationId, operator.organizationId),
        eq(organizationMembers.userId, operator.userId),
        eq(organizationMembers.status, "active"),
        eq(organizations.status, "active"),
        inArray(organizationMembers.role, ["owner", "admin"]),
      ),
    )
    .for("share")
    .limit(1);
  if (!access) {
    throw new DomainError("forbidden", "Operations access is denied");
  }
}

/**
 * The four requeues, as the command bus reaches them through its unit of work
 * (the `operationsCommands` port; the commands are `@requestport/domain`'s
 * `operations-commands.ts`). Handed the bus's transaction, each requeue runs
 * in a savepoint inside it.
 *
 * None keeps a receipt. The command bus holds the one receipt a requeue has,
 * and answers a replay from it before the requeue runs (`manifest-f2.md`
 * §2.4).
 *
 * Each audit row names the mutation's actor as `auditActor` records it: a
 * person as `user` and their id, an operator as `service` and
 * `operator:<lineage>` (Plan 13, F.3, F3-2), never as its member.
 */
export function createOperationsCommandRepository(
  database: Database,
): OperationsPort {
  return {
    async authorize(operator: OperationsOperator) {
      await withTenant(
        operator.organizationId,
        (database) => requireOperationsOperator(database, operator),
        { database },
      );
    },

    async requeueOutbox(input: OperationsMutation, outboxId: string) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        await requireOperationsOperator(tx, input);
        const [record] = await tx
          .select({
            id: outbox.id,
            eventId: outbox.eventId,
            state: outbox.state,
            attemptCount: outbox.attemptCount,
          })
          .from(outbox)
          .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
          .where(
            and(
              eq(outbox.id, outboxId),
              eq(domainEvents.organizationId, input.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!record)
          throw new DomainError("not_found", "Outbox record was not found");
        if (record.attemptCount !== input.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Outbox record changed concurrently",
          );
        if (record.state !== "dead_letter") {
          throw new DomainError(
            "invalid_state",
            "Only dead-lettered outbox records can be requeued",
          );
        }
        await tx
          .update(outbox)
          .set({
            state: "pending",
            leaseOwner: null,
            leaseExpiresAt: null,
            triggerRunId: null,
            acceptedAt: null,
            nextAttemptAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(outbox.id, record.id));
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          ...auditActor(input),
          action: "outbox.requeued",
          targetType: "outbox",
          targetId: record.id,
          reason: "Operator requeued a domain event delivery attempt",
          fieldNames: ["eventId", "previousState"],
          correlationId: input.correlationId,
        });
        return { outboxId: record.id, eventId: record.eventId };
      });
    },

    async requeueNotification(
      input: OperationsMutation,
      notificationIntentId: string,
    ) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        await requireOperationsOperator(tx, input);
        const [record] = await tx
          .select({
            id: notificationIntents.id,
            status: notificationIntents.status,
            attemptCount: notificationIntents.attemptCount,
          })
          .from(notificationIntents)
          .where(
            and(
              eq(notificationIntents.id, notificationIntentId),
              eq(notificationIntents.organizationId, input.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!record) {
          throw new DomainError(
            "not_found",
            "Notification intent was not found",
          );
        }
        if (record.attemptCount !== input.expectedVersion) {
          throw new DomainError(
            "version_conflict",
            "Notification intent changed concurrently",
          );
        }
        if (record.status !== "failed") {
          throw new DomainError(
            "invalid_state",
            "Only failed notifications can be requeued",
          );
        }
        await tx
          .update(notificationIntents)
          .set({
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: sql`clock_timestamp()`,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(notificationIntents.id, record.id));
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          ...auditActor(input),
          action: "notification.requeued",
          targetType: "notification_intent",
          targetId: record.id,
          reason: "Operator requeued a failed notification intent",
          fieldNames: ["status", "attemptCount"],
          correlationId: input.correlationId,
        });
        return { notificationIntentId: record.id };
      });
    },

    async requeueSlackOperation(
      input: OperationsMutation,
      operationId: string,
    ) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        await requireOperationsOperator(tx, input);
        const [record] = await tx
          .select({
            id: slackDeliveryOperations.id,
            operationType: slackDeliveryOperations.operationType,
            status: slackDeliveryOperations.status,
            attemptCount: slackDeliveryOperations.attemptCount,
          })
          .from(slackDeliveryOperations)
          .innerJoin(
            slackInstallations,
            eq(slackInstallations.id, slackDeliveryOperations.installationId),
          )
          .where(
            and(
              eq(slackDeliveryOperations.id, operationId),
              eq(slackInstallations.organizationId, input.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!record) {
          throw new DomainError("not_found", "Slack operation was not found");
        }
        if (record.attemptCount !== input.expectedVersion) {
          throw new DomainError(
            "version_conflict",
            "Slack operation changed concurrently",
          );
        }
        if (record.status !== "failed") {
          throw new DomainError(
            "invalid_state",
            "Only failed Slack operations can be requeued",
          );
        }
        if (
          record.operationType !== "message_update" &&
          record.operationType !== "connection_test"
        ) {
          throw new Error("Slack operation type is invalid");
        }
        await tx
          .update(slackDeliveryOperations)
          .set({
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: sql`clock_timestamp()`,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(slackDeliveryOperations.id, record.id));
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          ...auditActor(input),
          action: "slack.operation_requeued",
          targetType: "slack_delivery_operation",
          targetId: record.id,
          reason: "Operator requeued a failed Slack operation",
          fieldNames: ["status", "attemptCount"],
          correlationId: input.correlationId,
        });
        return {
          operationId: record.id,
          operationType: record.operationType,
        };
      });
    },

    async requeueImportDispatch(input: OperationsMutation, dispatchId: string) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        await requireOperationsOperator(tx, input);
        const [record] = await tx
          .select({
            id: importTaskDispatches.id,
            state: importTaskDispatches.state,
            attemptCount: importTaskDispatches.attemptCount,
          })
          .from(importTaskDispatches)
          .innerJoin(
            importRuns,
            and(
              eq(
                importRuns.organizationId,
                importTaskDispatches.organizationId,
              ),
              eq(importRuns.id, importTaskDispatches.importRunId),
            ),
          )
          .where(
            and(
              eq(importTaskDispatches.id, dispatchId),
              eq(importRuns.organizationId, input.organizationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!record) {
          throw new DomainError("not_found", "Import dispatch was not found");
        }
        if (record.attemptCount !== input.expectedVersion) {
          throw new DomainError(
            "version_conflict",
            "Import dispatch changed concurrently",
          );
        }
        if (record.state !== "dead_letter") {
          throw new DomainError(
            "invalid_state",
            "Only dead-lettered import dispatches can be requeued",
          );
        }
        await tx
          .update(importTaskDispatches)
          .set({
            state: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            triggerRunId: null,
            acceptedAt: null,
            completedAt: null,
            lastErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(importTaskDispatches.id, record.id));
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          ...auditActor(input),
          action: "import.dispatch_requeued",
          targetType: "import_task_dispatch",
          targetId: record.id,
          reason: "Operator requeued a dead-lettered import task dispatch",
          fieldNames: ["state", "attemptCount"],
          correlationId: input.correlationId,
        });
        return { dispatchId: record.id };
      });
    },
  };
}

/**
 * The same four requeues on the database it is handed, under the name the
 * package's public surface has always carried (`index.test.ts` holds it).
 * Nothing in the application calls it: the operations forms reach the
 * requeues through the command bus, which opens
 * `createOperationsCommandRepository` on its own transaction.
 */
export function createOperationsRepository(database: Database): OperationsPort {
  return createOperationsCommandRepository(database);
}
