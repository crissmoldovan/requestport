import {
  auditActor,
  DomainError,
  type OperationsMutation,
  type OperationsOperator,
  type RetentionHoldCategory,
  type RetentionHoldPort,
  retentionHoldCategories,
  sanitizeEventActor,
} from "@requestport/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import {
  domainEvents,
  organizationMembers,
  organizations,
  outbox,
  retentionHolds,
  securityAuditRecords,
} from "../schema/index.js";
import { inTenantTransaction, withTenant } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

/**
 * Locks the organisation row and the operator's organisation membership row
 * `FOR SHARE`, in that order, and throws `forbidden` unless the organisation
 * is active and `context.userId` is an active owner or admin of it. The page
 * read, both hold writes, the port's `authorize` and the administration read
 * (`administration/operations-reads.ts`) all run it.
 */
export async function requireOperator(
  database: Database | Tx,
  context: OperationsOperator,
) {
  const [organization] = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, context.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!organization)
    throw new DomainError("forbidden", "Retention hold access is denied");
  const [membership] = await database
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, context.organizationId),
        eq(organizationMembers.userId, context.userId),
        eq(organizationMembers.status, "active"),
        inArray(organizationMembers.role, ["owner", "admin"]),
      ),
    )
    .for("share")
    .limit(1);
  if (!membership)
    throw new DomainError("forbidden", "Retention hold access is denied");
}

/**
 * A hold's audit row, its `retention.hold_changed.v1` event and the event's
 * outbox row. The audit row names the mutation's actor as `auditActor`
 * records it — a person as `user` and their id, an operator as `service` and
 * `operator:<lineage>` (Plan 13, F.3, F3-2), never as its member. The event's
 * actor is the mutation's, through the sanitiser the event factory applies to
 * every other event: a person as they are, an operator as its `service`
 * actor with the member as origin (F3-2: "domain events carry the actor
 * unchanged").
 */
async function appendHoldChange(
  tx: Tx,
  input: {
    context: OperationsMutation;
    holdId: string;
    category: RetentionHoldCategory;
    status: "active" | "released";
    version: number;
  },
) {
  const { actorType, actorId } = auditActor(input.context);
  await tx.insert(securityAuditRecords).values({
    organizationId: input.context.organizationId,
    actorType,
    actorId,
    action:
      input.status === "active"
        ? "retention.hold_created"
        : "retention.hold_released",
    targetType: "retention_hold",
    targetId: input.holdId,
    reason:
      input.status === "active"
        ? "Operator created a retention hold"
        : "Operator released a retention hold",
    fieldNames: ["category", "status", "version"],
    correlationId: input.context.correlationId,
  });
  const eventId = uuidv7();
  await tx.insert(domainEvents).values({
    id: eventId,
    organizationId: input.context.organizationId,
    aggregateType: "retention_hold",
    aggregateId: input.holdId,
    aggregateVersion: input.version,
    type: "retention.hold_changed.v1",
    schemaVersion: 1,
    actor: sanitizeEventActor(input.context.actor),
    correlationId: input.context.correlationId,
    causationId: input.context.correlationId,
    data: { category: input.category, status: input.status },
    links: {},
  });
  await tx.insert(outbox).values({ eventId, state: "pending" });
}

function isHoldCategory(value: string): value is RetentionHoldCategory {
  return (retentionHoldCategories as readonly string[]).includes(value);
}

export function createRetentionHoldRepository(database: Database) {
  return {
    async list(organizationId: string, userId: string) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        await requireOperator(tx, { organizationId, userId });
        return tx
          .select({
            id: retentionHolds.id,
            category: retentionHolds.category,
            reason: retentionHolds.reason,
            status: retentionHolds.status,
            version: retentionHolds.version,
            createdAt: retentionHolds.createdAt,
            releasedAt: retentionHolds.releasedAt,
          })
          .from(retentionHolds)
          .where(eq(retentionHolds.organizationId, organizationId))
          .orderBy(desc(retentionHolds.createdAt), desc(retentionHolds.id));
      });
    },
  };
}

/**
 * Creating and releasing a hold, as the command bus reaches them through its
 * unit of work (the `retentionHoldCommands` port; the commands are
 * `@requestport/domain`'s `operations-commands.ts`). Handed the bus's
 * transaction, each write runs in a savepoint inside it.
 *
 * Neither keeps a receipt. The command bus holds the one receipt a write has,
 * and answers a replay from it before the write runs (`manifest-f2.md` §2.4).
 */
export function createRetentionHoldCommandRepository(
  database: Database,
): RetentionHoldPort {
  return {
    async authorize(operator: OperationsOperator) {
      await withTenant(
        operator.organizationId,
        (database) => requireOperator(database, operator),
        { database },
      );
    },

    async create(
      context: OperationsMutation,
      input: { category: RetentionHoldCategory; reason: string },
    ) {
      const reason = input.reason.trim();
      if (
        !isHoldCategory(input.category) ||
        reason.length < 8 ||
        reason.length > 500
      )
        throw new DomainError(
          "validation_failed",
          "Retention hold details are invalid",
        );
      if (context.expectedVersion !== 0)
        throw new DomainError(
          "version_conflict",
          "A new hold must use expected version zero",
        );
      return inTenantTransaction(
        database,
        context.organizationId,
        async (tx) => {
          await requireOperator(tx, context);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`requestport:retention-hold:${context.organizationId}:${input.category}`}, 0))`,
          );
          const [active] = await tx
            .select({ id: retentionHolds.id })
            .from(retentionHolds)
            .where(
              and(
                eq(retentionHolds.organizationId, context.organizationId),
                eq(retentionHolds.category, input.category),
                eq(retentionHolds.status, "active"),
              ),
            )
            .for("update")
            .limit(1);
          if (active)
            throw new DomainError(
              "version_conflict",
              "An active hold already exists for this category",
            );
          const [created] = await tx
            .insert(retentionHolds)
            .values({
              organizationId: context.organizationId,
              category: input.category,
              reason,
              createdByUserId: context.userId,
            })
            .returning({
              id: retentionHolds.id,
              version: retentionHolds.version,
            });
          if (!created) throw new Error("Retention hold persistence failed");
          await appendHoldChange(tx, {
            context,
            holdId: created.id,
            category: input.category,
            status: "active",
            version: created.version,
          });
          return created;
        },
      );
    },

    async release(context: OperationsMutation, holdId: string) {
      return inTenantTransaction(
        database,
        context.organizationId,
        async (tx) => {
          await requireOperator(tx, context);
          const [current] = await tx
            .select({
              id: retentionHolds.id,
              category: retentionHolds.category,
              status: retentionHolds.status,
              version: retentionHolds.version,
            })
            .from(retentionHolds)
            .where(
              and(
                eq(retentionHolds.id, holdId),
                eq(retentionHolds.organizationId, context.organizationId),
              ),
            )
            .for("update")
            .limit(1);
          if (!current || !isHoldCategory(current.category))
            throw new DomainError("not_found", "Retention hold was not found");
          if (
            current.version !== context.expectedVersion ||
            current.status !== "active"
          )
            throw new DomainError(
              "version_conflict",
              "Retention hold changed concurrently",
            );
          const [updated] = await tx
            .update(retentionHolds)
            .set({
              status: "released",
              version: context.expectedVersion + 1,
              releasedAt: new Date(),
              releasedByUserId: context.userId,
            })
            .where(
              and(
                eq(retentionHolds.id, current.id),
                eq(retentionHolds.organizationId, context.organizationId),
                eq(retentionHolds.version, context.expectedVersion),
                eq(retentionHolds.status, "active"),
              ),
            )
            .returning({
              id: retentionHolds.id,
              version: retentionHolds.version,
            });
          if (!updated)
            throw new DomainError(
              "version_conflict",
              "Retention hold changed concurrently",
            );
          await appendHoldChange(tx, {
            context,
            holdId: updated.id,
            category: current.category,
            status: "released",
            version: updated.version,
          });
          return updated;
        },
      );
    },
  };
}
