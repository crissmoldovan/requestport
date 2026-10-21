import {
  actorFingerprint,
  DomainError,
  keyedFingerprint,
  normalizedInputHash,
  validateCommandMeta,
} from "@requestport/domain";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  domainEvents,
  organizationMembers,
  organizations,
  outbox,
  projects,
  requests,
  securityAuditRecords,
  webhookAttempts,
  webhookDeliveries,
  webhookSubscriptions,
} from "../schema/index.js";
import { inTenantTransaction, withTenant } from "../tenant-context.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";
import {
  lockMutationReceipt,
  saveMutationReceipt,
} from "./mutation-receipt.js";

export type ClaimedOutbox = {
  id: string;
  eventId: string;
  organizationId: string;
  attemptCount: number;
};

/*
 * Leases and settlement (Plan 13, Track I.2b, step b2; manifest-i2.md §5.1,
 * "Leases are database-generated ids" and "Settlement"; ruling 57).
 */

/**
 * What a claim granted: the claimed row's organisation, the lease id the
 * claim function generated (never a caller's string), and the lease's end as
 * the claim wrote it.
 */
export type ClaimLease = {
  organizationId: string;
  leaseId: string;
  leaseExpiresAt: Date;
};

/**
 * The claim a completion or failure settles, handed to a settling body by
 * whatever started it, never read from its payload: in process, the claim's
 * lease id; on Trigger.dev, the executing run's `ctx.run.id`, which the
 * dispatcher recorded at acceptance.
 */
export type ClaimSettlement =
  | { kind: "lease"; leaseId: string }
  | { kind: "trigger_run"; runId: string };

/**
 * A settling body's standing, read before any effect: `held` proceeds;
 * `pending_acceptance` (a Trigger run whose row is still leased, its
 * acceptance not yet recorded) is retried; `superseded` does nothing.
 */
export type ClaimStanding = "held" | "pending_acceptance" | "superseded";

const LEASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Whether `value` can be a lease or row id: the functions take uuids, so a
 * string that is not one names no claim, and is answered false without a
 * call rather than raising 22P02.
 */
export function isClaimUuid(value: unknown): value is string {
  return typeof value === "string" && LEASE_ID.test(value);
}

function knownSettlement(settlement: ClaimSettlement): ClaimSettlement {
  if (
    (settlement?.kind === "lease" && typeof settlement.leaseId === "string") ||
    (settlement?.kind === "trigger_run" && typeof settlement.runId === "string")
  ) {
    return settlement;
  }
  throw new Error("A claim settlement names a lease or a Trigger run.");
}

/** The columns of a leased table the settlement predicate reads. */
type LeaseColumns = {
  state: AnyPgColumn;
  leaseOwner: AnyPgColumn;
  leaseExpiresAt: AnyPgColumn;
  triggerRunId: AnyPgColumn;
};

/**
 * §5.1's two predicates, in the settling `UPDATE … WHERE`. A lease holds
 * while the row is `leased` under it and `lease_expires_at` is after
 * `clock_timestamp()` — the claim's clock, not the transaction's start, so a
 * body that outlived its lease settles nothing. A run holds only an
 * `accepted` row carrying its id: a claim does not clear `trigger_run_id`, so
 * equality alone would let an old run settle a re-claimed row.
 */
export function settlementHolds(
  columns: LeaseColumns,
  settlement: ClaimSettlement,
): SQL {
  const known = knownSettlement(settlement);

  return known.kind === "lease"
    ? (and(
        sql`${columns.state} = 'leased'`,
        sql`${columns.leaseOwner} = ${known.leaseId}`,
        sql`${columns.leaseExpiresAt} > clock_timestamp()`,
      ) as SQL)
    : (and(
        sql`${columns.state} = 'accepted'`,
        sql`${columns.triggerRunId} = ${known.runId}`,
      ) as SQL);
}

/** `claimStanding`'s answer from the row as read; no row is superseded. */
export function standingOf(
  row:
    | {
        state: string;
        leaseOwner: string | null;
        leaseLive: boolean | null;
        triggerRunId: string | null;
      }
    | undefined,
  settlement: ClaimSettlement,
): ClaimStanding {
  const known = knownSettlement(settlement);

  if (!row) return "superseded";
  if (known.kind === "lease") {
    return row.state === "leased" &&
      row.leaseOwner === known.leaseId &&
      row.leaseLive === true
      ? "held"
      : "superseded";
  }
  if (row.state === "accepted") {
    return row.triggerRunId === known.runId ? "held" : "superseded";
  }
  return row.state === "leased" ? "pending_acceptance" : "superseded";
}

/**
 * A bound for a claim or release function's integer argument: undefined or
 * not finite passes NULL (the function's default), anything else an integer
 * within PostgreSQL's range. The function clamps it to its own bounds.
 */
export function claimBound(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? null
    : Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(value)));
}

export function createOutboxRepository(database: Database) {
  return {
    /** Function 16: the pending backlog Trigger's outbox-repair reports. */
    async pendingBacklog() {
      const result = await database.execute<{
        pending_count: number;
        oldest_age_seconds: number;
      }>(
        sql`select pending_count, oldest_age_seconds from requestport_private.outbox_pending_backlog()`,
      );
      const row = result.rows[0];
      return {
        count: Number(row?.pending_count ?? 0),
        oldestAgeSeconds: Number(row?.oldest_age_seconds ?? 0),
      };
    },

    /**
     * Function 1: leases up to `limit` rows (1-200, default 50) for
     * `leaseSeconds` (10-600, default 60), each under a lease id the
     * function generates, and returns what it granted. In a transaction on
     * this storage (§2.5.0 item 7): a bare call is a read the pool's read
     * retry would send again, leasing a second batch.
     */
    async claimBatch(
      limit?: number,
      leaseSeconds?: number,
    ): Promise<Array<ClaimedOutbox & ClaimLease>> {
      const result = await database.transaction((tx) =>
        tx.execute<{
          outbox_id: string;
          event_id: string;
          organization_id: string;
          attempt_count: number;
          lease_id: string;
          lease_expires_at: Date | string;
        }>(
          sql`select outbox_id, event_id, organization_id, attempt_count, lease_id, lease_expires_at
              from requestport_private.claim_outbox_batch(${claimBound(limit)}::integer, ${claimBound(leaseSeconds)}::integer)`,
        ),
      );
      return result.rows.map((row) => ({
        id: row.outbox_id,
        eventId: row.event_id,
        organizationId: row.organization_id,
        attemptCount: row.attempt_count,
        leaseId: row.lease_id,
        leaseExpiresAt: new Date(row.lease_expires_at),
      }));
    },

    /**
     * Function 2, the dispatcher's acceptance: records `runId`, the id
     * `trigger()` returned, only while the row is leased under `leaseId` and
     * the lease is unexpired. False, and nothing changed, otherwise.
     */
    async acceptClaim(
      id: string,
      leaseId: string,
      runId: string,
    ): Promise<boolean> {
      if (!isClaimUuid(id) || !isClaimUuid(leaseId)) return false;
      const result = await database.transaction((tx) =>
        tx.execute<{ accepted: boolean }>(
          sql`select requestport_private.accept_outbox_claim(${id}::uuid, ${leaseId}::uuid, ${runId}) as accepted`,
        ),
      );
      return result.rows[0]?.accepted === true;
    },

    /**
     * Function 3, the poller's release: under a live lease, dead-letters the
     * row, or puts it back to pending after `delayMs` (clamped to 1 s-1 h).
     * After the lease has run out it changes nothing, and the row is claimed
     * again when due.
     */
    async releaseClaim(
      id: string,
      leaseId: string,
      deadLetter: boolean,
      delayMs: number,
    ): Promise<boolean> {
      if (!isClaimUuid(id) || !isClaimUuid(leaseId)) return false;
      const result = await database.transaction((tx) =>
        tx.execute<{ released: boolean }>(
          sql`select requestport_private.release_outbox_claim(${id}::uuid, ${leaseId}::uuid, ${deadLetter}, ${claimBound(delayMs)}::integer) as released`,
        ),
      );
      return result.rows[0]?.released === true;
    },

    /**
     * The web's claim, and outbox-dispatcher.ts's: one row by id, under the
     * caller's owner string. §5.1 keeps it a repository method rather than a
     * definer function because both callers run it bound to the row's
     * organisation once their surface's variables are set: the web through
     * `boundOutboxRepository`, and `trigger/src/outbox-dispatcher.ts` in the
     * processor's unit (`inUnit`). With the application variable unset, the
     * web runs it on its root's storage's handle, unbound; the worker's unit
     * is that handle only on one of `createWorkerStorages`' two exceptions,
     * on the storage its caller gave.
     */
    async claimOne(
      id: string,
      owner: string,
      leaseMs = 60_000,
    ): Promise<ClaimedOutbox | null> {
      const result = await database.execute<{
        id: string;
        event_id: string;
        organization_id: string;
        attempt_count: number;
      }>(sql`
        update ${outbox}
        set state = 'leased', lease_owner = ${owner}, lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'), attempt_count = attempt_count + 1, updated_at = clock_timestamp()
        where id = ${id}
          and (
            ${outbox.state} = 'pending'
            or (${outbox.state} = 'leased' and ${outbox.leaseExpiresAt} < clock_timestamp())
            or (${outbox.state} = 'accepted' and ${outbox.updatedAt} < clock_timestamp() - interval '10 minutes')
          )
          and ${outbox.nextAttemptAt} <= clock_timestamp()
        returning id, event_id, attempt_count,
          (select ${domainEvents.organizationId} from ${domainEvents} where ${domainEvents.id} = ${outbox.eventId}) as organization_id
      `);
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            eventId: row.event_id,
            organizationId: row.organization_id,
            attemptCount: row.attempt_count,
          }
        : null;
    },

    /**
     * `claimOne`'s acceptance, by id and owner, and only while the lease is
     * unexpired (§5.1, since round 3). True when it recorded `triggerRunId`.
     */
    async markAccepted(id: string, owner: string, triggerRunId: string) {
      const [accepted] = await database
        .update(outbox)
        .set({
          state: "accepted",
          triggerRunId,
          acceptedAt: sql`clock_timestamp()`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(outbox.id, id),
            eq(outbox.state, "leased"),
            eq(outbox.leaseOwner, owner),
            sql`${outbox.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: outbox.id });
      return Boolean(accepted);
    },

    /** Completes the row only while `settlement` holds it (§5.1). */
    async markCompleted(id: string, settlement: ClaimSettlement) {
      const [completed] = await database
        .update(outbox)
        .set({
          state: "completed",
          acceptedAt: sql`coalesce(${outbox.acceptedAt}, clock_timestamp())`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(outbox.id, id), settlementHolds(outbox, settlement)))
        .returning({ id: outbox.id });
      return Boolean(completed);
    },

    /** The body's dead letter, only while `settlement` holds the row. */
    async deadLetter(id: string, settlement: ClaimSettlement) {
      const [dead] = await database
        .update(outbox)
        .set({
          state: "dead_letter",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(outbox.id, id), settlementHolds(outbox, settlement)))
        .returning({ id: outbox.id });
      return Boolean(dead);
    },

    /**
     * The standing a settling body reads before any effect (§5.1). A row
     * this handle cannot see — another organisation's under the binding, or
     * none — is `superseded`, as an absent one is.
     */
    async claimStanding(
      id: string,
      settlement: ClaimSettlement,
    ): Promise<ClaimStanding> {
      knownSettlement(settlement);
      const [row] = await database
        .select({
          state: outbox.state,
          leaseOwner: outbox.leaseOwner,
          leaseLive: sql<
            boolean | null
          >`${outbox.leaseExpiresAt} > clock_timestamp()`,
          triggerRunId: outbox.triggerRunId,
        })
        .from(outbox)
        .where(eq(outbox.id, id))
        .limit(1);
      return standingOf(row, settlement);
    },

    async loadEvent(outboxId: string) {
      const [event] = await database
        .select({ outboxId: outbox.id, event: domainEvents })
        .from(outbox)
        .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
        .where(eq(outbox.id, outboxId))
        .limit(1);
      return event ?? null;
    },

    async idsForEvents(eventIds: string[]) {
      if (!eventIds.length) return [];
      return database
        .select({ id: outbox.id })
        .from(outbox)
        .where(inArray(outbox.eventId, eventIds))
        .orderBy(asc(outbox.createdAt));
    },

    async idsForCorrelation(correlationId: string) {
      return database
        .select({ id: outbox.id })
        .from(outbox)
        .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
        .where(eq(domainEvents.correlationId, correlationId))
        .orderBy(asc(outbox.createdAt));
    },

    async matchingWebhookSubscriptions(
      event: typeof domainEvents.$inferSelect,
    ) {
      const [request] = event.requestId
        ? await database
            .select({
              sourceProjectId: requests.sourceProjectId,
              targetProjectId: requests.targetProjectId,
              laneId: requests.laneId,
              type: requests.type,
            })
            .from(requests)
            .where(
              and(
                eq(requests.organizationId, event.organizationId),
                eq(requests.id, event.requestId),
              ),
            )
            .limit(1)
        : [];
      const eventProjectIds = new Set(
        [
          event.projectId,
          request?.sourceProjectId,
          request?.targetProjectId,
        ].filter((value): value is string => Boolean(value)),
      );
      const rows = await database
        .select()
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.organizationId, event.organizationId),
            eq(webhookSubscriptions.status, "active"),
          ),
        );
      return rows.filter((subscription) => {
        if (
          subscription.eventTypes.length &&
          !subscription.eventTypes.includes(event.type)
        )
          return false;
        if (
          subscription.projectIds.length &&
          !subscription.projectIds.some((projectId) =>
            eventProjectIds.has(projectId),
          )
        )
          return false;
        const laneId =
          request?.laneId ??
          (typeof event.data.laneId === "string" ? event.data.laneId : null);
        if (
          subscription.laneIds.length &&
          (!laneId || !subscription.laneIds.includes(laneId))
        )
          return false;
        const requestType =
          request?.type ??
          (typeof event.data.requestType === "string"
            ? event.data.requestType
            : null);
        return !(
          subscription.requestTypes.length &&
          (!requestType || !subscription.requestTypes.includes(requestType))
        );
      });
    },

    async ensureWebhookDelivery(input: {
      organizationId: string;
      subscriptionId: string;
      eventId: string;
      replayNumber?: number;
    }) {
      const [created] = await database
        .insert(webhookDeliveries)
        .values({ ...input, replayNumber: input.replayNumber ?? 0 })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });
      if (created) return created.id;
      const [existing] = await database
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.subscriptionId, input.subscriptionId),
            eq(webhookDeliveries.eventId, input.eventId),
            eq(webhookDeliveries.replayNumber, input.replayNumber ?? 0),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Webhook delivery allocation failed");
      return existing.id;
    },

    async loadWebhookDelivery(deliveryId: string) {
      const [row] = await database
        .select({
          delivery: webhookDeliveries,
          subscription: webhookSubscriptions,
          event: domainEvents,
          requestSensitivity: requests.sensitivity,
        })
        .from(webhookDeliveries)
        .innerJoin(
          webhookSubscriptions,
          and(
            eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
            eq(
              webhookSubscriptions.organizationId,
              webhookDeliveries.organizationId,
            ),
          ),
        )
        .innerJoin(domainEvents, eq(domainEvents.id, webhookDeliveries.eventId))
        .leftJoin(
          requests,
          and(
            eq(requests.organizationId, domainEvents.organizationId),
            eq(requests.id, domainEvents.requestId),
          ),
        )
        .where(eq(webhookDeliveries.id, deliveryId))
        .limit(1);
      return row ?? null;
    },

    /** Function 7: due deliveries' ids and organisations (1-500, default 100). */
    async pendingWebhookDeliveries(limit = 100) {
      const result = await database.execute<{
        delivery_id: string;
        organization_id: string;
      }>(
        sql`select delivery_id, organization_id from requestport_private.pending_webhook_deliveries(${claimBound(limit)}::integer)`,
      );
      return result.rows.map((row) => ({
        id: row.delivery_id,
        organizationId: row.organization_id,
      }));
    },

    async claimWebhookDelivery(input: {
      deliveryId: string;
      timestamp: number;
    }) {
      return database.transaction(async (tx) => {
        const eligible = await tx.execute<{
          id: string;
          organization_id: string;
          subscription_id: string;
          signing_key_id: string;
          secret_ciphertext: Record<string, unknown>;
        }>(sql`
          select d.id, d.organization_id, d.subscription_id,
            s.current_secret_key_id as signing_key_id,
            s.current_secret_ciphertext as secret_ciphertext
          from ${webhookDeliveries} d
          inner join ${webhookSubscriptions} s
            on s.id = d.subscription_id
            and s.organization_id = d.organization_id
            and s.status = 'active'
          where d.id = ${input.deliveryId}
            and (
              d.status = 'pending'
              or (
                d.status = 'retry'
                and exists (
                  select 1 from ${webhookAttempts} retry_attempt
                  where retry_attempt.delivery_id = d.id
                    and retry_attempt.next_attempt_at <= clock_timestamp()
                    and not exists (
                      select 1 from ${webhookAttempts} newer
                      where newer.delivery_id = d.id
                        and newer.attempt_number > retry_attempt.attempt_number
                    )
                )
              )
              or (
                d.status = 'delivering'
                and exists (
                  select 1 from ${webhookAttempts} stale_attempt
                  where stale_attempt.delivery_id = d.id
                    and stale_attempt.finished_at is null
                    and stale_attempt.started_at < clock_timestamp() - interval '10 minutes'
                    and not exists (
                      select 1 from ${webhookAttempts} newer
                      where newer.delivery_id = d.id
                        and newer.attempt_number > stale_attempt.attempt_number
                    )
                )
              )
            )
          for update of d, s
        `);
        const delivery = eligible.rows[0];
        if (!delivery) return null;
        const [counter] = await tx
          .select({
            next: sql<number>`coalesce(max(${webhookAttempts.attemptNumber}), 0)::integer + 1`,
          })
          .from(webhookAttempts)
          .where(eq(webhookAttempts.deliveryId, input.deliveryId));
        const attemptNumber = counter?.next ?? 1;
        if (attemptNumber > 6) {
          await tx
            .update(webhookDeliveries)
            .set({ status: "dead_letter", completedAt: sql`clock_timestamp()` })
            .where(eq(webhookDeliveries.id, input.deliveryId));
          return null;
        }
        const [attempt] = await tx
          .insert(webhookAttempts)
          .values({
            deliveryId: input.deliveryId,
            attemptNumber,
            resolvedIps: [],
            requestTimestamp: new Date(input.timestamp * 1_000),
            signingKeyId: delivery.signing_key_id,
          })
          .returning({ id: webhookAttempts.id });
        if (!attempt) throw new Error("Webhook attempt persistence failed");
        await tx
          .update(webhookDeliveries)
          .set({ status: "delivering", completedAt: null })
          .where(eq(webhookDeliveries.id, input.deliveryId));
        return {
          attemptId: attempt.id,
          attemptNumber,
          organizationId: delivery.organization_id,
          subscriptionId: delivery.subscription_id,
          signingKeyId: delivery.signing_key_id,
          secretCiphertext: delivery.secret_ciphertext,
        };
      });
    },

    async addWebhookResolvedIps(attemptId: string, addresses: string[]) {
      const [current] = await database
        .select({ resolvedIps: webhookAttempts.resolvedIps })
        .from(webhookAttempts)
        .where(eq(webhookAttempts.id, attemptId))
        .limit(1);
      if (!current) return;
      await database
        .update(webhookAttempts)
        .set({
          resolvedIps: [...new Set([...current.resolvedIps, ...addresses])],
        })
        .where(eq(webhookAttempts.id, attemptId));
    },

    async finishWebhookAttempt(input: {
      attemptId: string;
      deliveryId: string;
      status: "delivered" | "retry" | "dead_letter";
      responseStatus?: number;
      responseExcerpt?: string;
      errorCode?: string;
      retryDelaySeconds?: number;
    }) {
      await database.transaction(async (tx) => {
        const [finished] = await tx
          .update(webhookAttempts)
          .set({
            finishedAt: sql`clock_timestamp()`,
            responseStatus: input.responseStatus,
            responseExcerpt: input.responseExcerpt,
            errorCode: input.errorCode,
            nextAttemptAt:
              input.status === "retry"
                ? sql`clock_timestamp() + (${Math.max(1, Math.min(input.retryDelaySeconds ?? 1, 3_600))} * interval '1 second')`
                : null,
          })
          .where(
            and(
              eq(webhookAttempts.id, input.attemptId),
              eq(webhookAttempts.deliveryId, input.deliveryId),
              isNull(webhookAttempts.finishedAt),
            ),
          )
          .returning({ attemptNumber: webhookAttempts.attemptNumber });
        if (!finished) return;
        const terminal = input.status === "delivered";
        await tx
          .update(webhookDeliveries)
          .set({
            status: input.status,
            completedAt:
              input.status === "delivered" || input.status === "dead_letter"
                ? sql`clock_timestamp()`
                : null,
          })
          .where(
            and(
              eq(webhookDeliveries.id, input.deliveryId),
              sql`${webhookDeliveries.status} <> 'delivered'`,
              terminal
                ? sql`true`
                : sql`not exists (
                    select 1 from ${webhookAttempts} newer_attempt
                    where newer_attempt.delivery_id = ${input.deliveryId}
                      and newer_attempt.attempt_number > ${finished.attemptNumber}
                  )`,
            ),
          );
      });
    },

    async listWebhookOperations(
      organizationId: string,
      subscriptionId: string,
      userId: string,
    ) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        const [access] = await tx
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .innerJoin(
            organizations,
            and(
              eq(organizations.id, organizationMembers.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, userId),
              eq(organizationMembers.status, "active"),
              inArray(organizationMembers.role, ["owner", "admin"]),
            ),
          )
          .for("share")
          .limit(1);
        if (!access) return { deliveries: [], attempts: [] };
        const deliveries = await tx
          .select()
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.organizationId, organizationId),
              eq(webhookDeliveries.subscriptionId, subscriptionId),
            ),
          )
          .orderBy(desc(webhookDeliveries.createdAt))
          .limit(200);
        const attempts = deliveries.length
          ? await tx
              .select()
              .from(webhookAttempts)
              .where(
                inArray(
                  webhookAttempts.deliveryId,
                  deliveries.map((item) => item.id),
                ),
              )
              .orderBy(desc(webhookAttempts.startedAt))
              .limit(500)
          : [];
        return { deliveries, attempts };
      });
    },

    async createWebhookReplay(input: {
      organizationId: string;
      deliveryId: string;
      actorType: "user" | "agent";
      actorId: string;
      correlationId: string;
      expectedVersion: number;
      fingerprintSecret: string;
      idempotencyKey: string;
      authorization?: {
        projectId: string;
        laneIds: string[];
        authorizationId: string;
        delegatedByUserId: string | null;
      };
    }) {
      validateCommandMeta({
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      });
      if (input.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "A webhook replay must use expected version zero",
        );
      }
      const receipt = {
        actorFingerprint: actorFingerprint(
          input.actorType === "user"
            ? { type: "user" as const, id: input.actorId }
            : {
                type: "agent" as const,
                id: input.actorId,
                ...(input.authorization?.delegatedByUserId
                  ? {
                      delegatedBy: {
                        type: "user" as const,
                        id: input.authorization.delegatedByUserId,
                      },
                    }
                  : {}),
              },
        ),
        commandName: "replay_event_delivery",
        idempotencyFingerprint: keyedFingerprint(
          input.fingerprintSecret,
          input.idempotencyKey,
        ),
        normalizedInputHash: normalizedInputHash({
          organizationId: input.organizationId,
          deliveryId: input.deliveryId,
        }),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      };
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const existingReceipt = await lockMutationReceipt(tx, receipt);
        const [source] = await tx
          .select()
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.organizationId, input.organizationId),
              eq(webhookDeliveries.id, input.deliveryId),
            ),
          )
          .for("update")
          .limit(1);
        if (!source) return null;
        const [subscription] = await tx
          .select({
            projectId: webhookSubscriptions.projectId,
            laneIds: webhookSubscriptions.laneIds,
            status: webhookSubscriptions.status,
          })
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, input.organizationId),
              eq(webhookSubscriptions.id, source.subscriptionId),
            ),
          )
          .for("share")
          .limit(1);
        if (subscription?.status !== "active") {
          throw new DomainError(
            "conflict",
            "Webhook subscription is not active",
          );
        }
        if (input.actorType === "user") {
          const [manager] = await tx
            .select({ role: organizationMembers.role })
            .from(organizationMembers)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, organizationMembers.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .where(
              and(
                eq(organizationMembers.organizationId, input.organizationId),
                eq(organizationMembers.userId, input.actorId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          if (!manager || !["owner", "admin"].includes(manager.role)) {
            throw new DomainError(
              "forbidden",
              "Webhook replay access is denied",
            );
          }
        } else {
          const authorization = input.authorization;
          if (
            !authorization ||
            subscription.projectId !== authorization.projectId ||
            (authorization.laneIds.length > 0 &&
              (subscription.laneIds.length === 0 ||
                subscription.laneIds.some(
                  (laneId) => !authorization.laneIds.includes(laneId),
                )))
          ) {
            throw new DomainError(
              "forbidden",
              "Webhook replay access is denied",
            );
          }
          const [principal] = await tx
            .select({ id: agentPrincipals.id })
            .from(agentPrincipals)
            .innerJoin(
              organizations,
              and(
                eq(organizations.id, agentPrincipals.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .innerJoin(
              projects,
              and(
                eq(projects.organizationId, agentPrincipals.organizationId),
                eq(projects.id, authorization.projectId),
                eq(projects.status, "active"),
              ),
            )
            .where(
              and(
                eq(agentPrincipals.organizationId, input.organizationId),
                eq(agentPrincipals.id, input.actorId),
                eq(agentPrincipals.status, "active"),
                or(
                  isNull(agentPrincipals.projectId),
                  eq(agentPrincipals.projectId, authorization.projectId),
                ),
              ),
            )
            .for("share")
            .limit(1);
          const credential = !authorization.delegatedByUserId
            ? await lockActiveApiKeyAuthorization(tx, {
                organizationId: input.organizationId,
                agentPrincipalId: input.actorId,
                authorizationId: authorization.authorizationId,
                projectId: authorization.projectId,
              })
            : null;
          const grant = authorization.delegatedByUserId
            ? await lockActiveOAuthAuthorization(tx, {
                organizationId: input.organizationId,
                agentPrincipalId: input.actorId,
                authorizationId: authorization.authorizationId,
                delegatedByUserId: authorization.delegatedByUserId,
                projectId: authorization.projectId,
              })
            : null;
          if (!principal || (!credential && !grant)) {
            throw new DomainError(
              "forbidden",
              "Webhook replay access is denied",
            );
          }
        }
        if (existingReceipt) {
          if (!existingReceipt.aggregateId) {
            throw new Error("Webhook replay receipt aggregate is missing");
          }
          const [existing] = await tx
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(
              and(
                eq(webhookDeliveries.organizationId, input.organizationId),
                eq(webhookDeliveries.id, existingReceipt.aggregateId),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new Error("Webhook replay receipt aggregate is missing");
          }
          return existing;
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('requestport:webhook-replay:' || ${source.subscriptionId} || ':' || ${source.eventId}, 0))`,
        );
        const [maximum] = await tx
          .select({
            replayNumber: sql<number>`coalesce(max(${webhookDeliveries.replayNumber}), 0)::integer`,
          })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.subscriptionId, source.subscriptionId),
              eq(webhookDeliveries.eventId, source.eventId),
            ),
          );
        const [created] = await tx
          .insert(webhookDeliveries)
          .values({
            organizationId: source.organizationId,
            subscriptionId: source.subscriptionId,
            eventId: source.eventId,
            replayNumber: (maximum?.replayNumber ?? 0) + 1,
          })
          .returning({ id: webhookDeliveries.id });
        if (created) {
          await tx.insert(securityAuditRecords).values({
            organizationId: input.organizationId,
            actorType: input.actorType,
            actorId: input.actorId,
            action: "webhook.delivery_replayed",
            targetType: "webhook_delivery",
            targetId: created.id,
            reason: "Operator requested a retained webhook delivery replay",
            fieldNames: ["sourceDeliveryId", "eventId", "replayNumber"],
            correlationId: input.correlationId,
          });
          await saveMutationReceipt(tx, receipt, {
            aggregateId: created.id,
            result: { deliveryId: created.id },
          });
        }
        return created ?? null;
      });
    },
  };
}

/**
 * The outbox methods the web calls after a command commits, each bound to
 * the command's organisation (manifest-i2.md §2.4; track-i2.md D5). Every
 * call is its own short transaction through `withTenant`, as the web's
 * claim, Trigger.dev start and acceptance already are three steps: bound
 * when the application variable is set, and on the pool exactly as before
 * when it is not. The shared methods keep their signatures: the worker
 * calls them, not these, on the storages `createWorkerStorages` gives it
 * (I.2b).
 */
export function boundOutboxRepository(
  organizationId: string,
  database: Database,
) {
  const bound = <T>(
    readOnly: boolean,
    work: (repository: ReturnType<typeof createOutboxRepository>) => Promise<T>,
  ) =>
    withTenant(
      organizationId,
      (tenant) => work(createOutboxRepository(tenant as Database)),
      { database, readOnly },
    );

  return {
    idsForEvents: (eventIds: string[]) =>
      bound(true, (repository) => repository.idsForEvents(eventIds)),
    idsForCorrelation: (correlationId: string) =>
      bound(true, (repository) => repository.idsForCorrelation(correlationId)),
    loadWebhookDelivery: (deliveryId: string) =>
      bound(true, (repository) => repository.loadWebhookDelivery(deliveryId)),
    claimOne: (id: string, owner: string, leaseMs?: number) =>
      bound(false, (repository) => repository.claimOne(id, owner, leaseMs)),
    markAccepted: (id: string, owner: string, triggerRunId: string) =>
      bound(false, (repository) =>
        repository.markAccepted(id, owner, triggerRunId),
      ),
  };
}
