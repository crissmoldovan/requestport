import {
  DomainError,
  deserializeEncryptedEnvelope,
  type EncryptedEnvelope,
  serializeEncryptedEnvelope,
} from "@requestport/domain";
import type {
  WebhookAuditContext,
  WebhookManagementRepository,
  WebhookSubscriptionRecord,
} from "@requestport/webhooks";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  domainEvents,
  lanes,
  organizationMembers,
  organizations,
  outbox,
  projects,
  securityAuditRecords,
  webhookSubscriptions,
} from "../schema/index.js";
import { inTenantTransaction, withTenantRead } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";
import {
  lockMutationReceipt,
  saveMutationReceipt,
} from "./mutation-receipt.js";

type WebhookDatabase = Database | Tx;

function encodeEnvelope(envelope: EncryptedEnvelope) {
  return serializeEncryptedEnvelope(envelope);
}

function decodeEnvelope(value: Record<string, unknown>): EncryptedEnvelope {
  return deserializeEncryptedEnvelope(value);
}

function record(
  row: typeof webhookSubscriptions.$inferSelect,
): WebhookSubscriptionRecord {
  return {
    ...row,
    projectId: row.projectId,
    status: row.status as WebhookSubscriptionRecord["status"],
    currentSecretCiphertext: decodeEnvelope(row.currentSecretCiphertext),
    nextSecretCiphertext: row.nextSecretCiphertext
      ? decodeEnvelope(row.nextSecretCiphertext)
      : null,
  };
}

function receiptObject(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Webhook command receipt is invalid");
  }
  return value as Record<string, unknown>;
}

function receiptVersion(value: unknown) {
  const result = receiptObject(value);
  if (typeof result.version !== "number" || !Number.isInteger(result.version)) {
    throw new Error("Webhook command receipt is invalid");
  }
  return result.version;
}

async function canManage(
  database: WebhookDatabase,
  organizationId: string,
  userId: string,
  lock = false,
) {
  let organizationQuery = database
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);
  if (lock)
    organizationQuery = organizationQuery.for(
      "share",
    ) as typeof organizationQuery;
  const [organization] = await organizationQuery;
  if (!organization) return false;
  let memberQuery = database
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .limit(1);
  if (lock) memberQuery = memberQuery.for("share") as typeof memberQuery;
  const [member] = await memberQuery;
  return member?.role === "owner" || member?.role === "admin";
}

async function authorizeMutation(
  database: WebhookDatabase,
  organizationId: string,
  projectId: string | null,
  laneIds: readonly string[],
  context: WebhookAuditContext,
) {
  if (context.actorType === "system") return { laneIds: [] as string[] };
  if (context.actorType === "user") {
    if (await canManage(database, organizationId, context.actorId, true)) {
      return { laneIds: [] as string[] };
    }
  } else if (context.actorType === "agent") {
    if (
      !context.authorizedProjectId ||
      projectId !== context.authorizedProjectId ||
      !context.authorizationId ||
      (context.authorizedLaneIds?.length &&
        (laneIds.length === 0 ||
          laneIds.some(
            (laneId) => !context.authorizedLaneIds?.includes(laneId),
          )))
    ) {
      throw new DomainError("forbidden", "Webhook management access is denied");
    }
    const [principal] = await database
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
          eq(projects.id, context.authorizedProjectId),
          eq(projects.status, "active"),
        ),
      )
      .where(
        and(
          eq(agentPrincipals.organizationId, organizationId),
          eq(agentPrincipals.id, context.actorId),
          eq(agentPrincipals.status, "active"),
          or(
            isNull(agentPrincipals.projectId),
            eq(agentPrincipals.projectId, context.authorizedProjectId),
          ),
        ),
      )
      .for("share")
      .limit(1);
    if (!principal) {
      throw new DomainError("forbidden", "Webhook management access is denied");
    }
    const credential = !context.delegatedByUserId
      ? await lockActiveApiKeyAuthorization(database, {
          organizationId,
          agentPrincipalId: context.actorId,
          authorizationId: context.authorizationId,
          projectId: context.authorizedProjectId,
        })
      : null;
    const grant = context.delegatedByUserId
      ? await lockActiveOAuthAuthorization(database, {
          organizationId,
          agentPrincipalId: context.actorId,
          authorizationId: context.authorizationId,
          delegatedByUserId: context.delegatedByUserId,
          projectId: context.authorizedProjectId,
        })
      : null;
    const authorization = credential ?? grant;
    const freshLaneIds = authorization?.laneIds ?? [];
    const contextLaneIds = context.authorizedLaneIds ?? [];
    const sameLaneGrant =
      freshLaneIds.length === contextLaneIds.length &&
      freshLaneIds.every((laneId) => contextLaneIds.includes(laneId));
    if (
      authorization?.scopes.includes("webhook:manage") &&
      sameLaneGrant &&
      (freshLaneIds.length === 0 ||
        (laneIds.length > 0 &&
          laneIds.every((laneId) => freshLaneIds.includes(laneId))))
    ) {
      return { laneIds: [...freshLaneIds] };
    }
  }
  throw new DomainError("forbidden", "Webhook management access is denied");
}

async function validateScope(
  database: WebhookDatabase,
  input: {
    organizationId: string;
    projectId: string | null;
    projectIds: string[];
    laneIds: string[];
  },
) {
  const projectIds = [
    ...new Set([
      ...(input.projectId ? [input.projectId] : []),
      ...input.projectIds,
    ]),
  ];
  if (projectIds.length) {
    const rows = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, input.organizationId),
          eq(projects.status, "active"),
          inArray(projects.id, projectIds),
        ),
      );
    if (rows.length !== projectIds.length) return false;
  }
  if (input.laneIds.length) {
    const laneIds = [...new Set(input.laneIds)];
    const rows = await database
      .select({ id: lanes.id, projectId: lanes.projectId })
      .from(lanes)
      .where(
        and(
          eq(lanes.organizationId, input.organizationId),
          eq(lanes.status, "active"),
          inArray(lanes.id, laneIds),
        ),
      );
    if (rows.length !== laneIds.length) return false;
    if (
      projectIds.length &&
      rows.some((row) => !projectIds.includes(row.projectId))
    )
      return false;
  }
  return true;
}

async function audit(
  database: WebhookDatabase,
  organizationId: string,
  subscriptionId: string,
  action: string,
  fields: string[],
  context: WebhookAuditContext,
) {
  await database.insert(securityAuditRecords).values({
    organizationId,
    actorType: context.actorType,
    actorId: context.actorId,
    action,
    targetType: "webhook_subscription",
    targetId: subscriptionId,
    reason: "Webhook administration change",
    fieldNames: fields,
    correlationId: context.correlationId,
  });
}

async function appendConfigurationEvent(
  database: WebhookDatabase,
  record: {
    id: string;
    organizationId: string;
    projectId: string | null;
    version: number;
    status: string;
  },
  changeType: string,
  context: WebhookAuditContext,
) {
  const eventId = uuidv7();
  await database.insert(domainEvents).values({
    id: eventId,
    organizationId: record.organizationId,
    aggregateType: "webhook_subscription",
    aggregateId: record.id,
    aggregateVersion: record.version,
    type: "integration.webhook_changed.v1",
    schemaVersion: 1,
    projectId: record.projectId,
    actor: {
      type: context.actorType === "system" ? "service" : context.actorType,
      id: context.actorId,
    },
    correlationId: context.correlationId,
    causationId: context.correlationId,
    data: {
      subscriptionId: record.id,
      changeType,
      status: record.status,
    },
    links: {},
  });
  await database.insert(outbox).values({ eventId, state: "pending" });
}

export function createWebhookRepository(
  database: Database,
): WebhookManagementRepository {
  /**
   * The two checks the web makes on the pool are wrapped as manifest-i2.md
   * §2.3 item 3 says; every method here that opens its own transaction binds
   * it to its organisation at its start (item 2).
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: Database) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    async canManage(organizationId, userId) {
      return forOrganization(
        organizationId,
        async (database) => {
          return canManage(database, organizationId, userId);
        },
        true,
      );
    },
    async validateScope(input) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          return validateScope(database, input);
        },
        true,
      );
    },
    async create(input, context, receipt) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const existingReceipt = await lockMutationReceipt(tx, receipt);
        if (existingReceipt) {
          if (!existingReceipt.aggregateId) {
            throw new Error("Webhook command receipt aggregate is missing");
          }
          const [existing] = await tx
            .select()
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, input.organizationId),
                eq(webhookSubscriptions.id, existingReceipt.aggregateId),
              ),
            )
            .for("share")
            .limit(1);
          if (!existing) {
            throw new Error("Webhook command receipt aggregate is missing");
          }
          await authorizeMutation(
            tx,
            input.organizationId,
            existing.projectId,
            existing.laneIds,
            context,
          );
          throw new DomainError(
            "conflict",
            "Webhook creation already completed; plaintext secrets are revealed only once",
          );
        }
        await authorizeMutation(
          tx,
          input.organizationId,
          input.projectId,
          input.laneIds,
          context,
        );
        if (!(await validateScope(tx, input))) {
          throw new DomainError(
            "validation_failed",
            "Webhook project or lane scope is invalid",
          );
        }
        const [created] = await tx
          .insert(webhookSubscriptions)
          .values({
            ...input,
            currentSecretCiphertext: encodeEnvelope(
              input.currentSecretCiphertext,
            ),
            nextSecretCiphertext: input.nextSecretCiphertext
              ? encodeEnvelope(input.nextSecretCiphertext)
              : null,
          })
          .returning();
        if (!created)
          throw new Error("Webhook subscription persistence failed");
        await audit(
          tx,
          input.organizationId,
          created.id,
          "webhook.subscription_created",
          [
            "projectId",
            "endpointUrl",
            "eventTypes",
            "projectIds",
            "laneIds",
            "requestTypes",
          ],
          context,
        );
        await appendConfigurationEvent(tx, created, "created", context);
        await saveMutationReceipt(tx, receipt, {
          aggregateId: created.id,
          result: {
            subscriptionId: created.id,
            keyId: created.currentSecretKeyId,
            overlapEndsAt: null,
          },
        });
        return {
          record: record(created),
          secretCiphertext: input.currentSecretCiphertext,
          keyId: created.currentSecretKeyId,
          overlapEndsAt: null,
          replayed: false,
        };
      });
    },
    async find(organizationId, id, context) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.id, id),
            ),
          )
          .for("share")
          .limit(1);
        if (!row) return null;
        await authorizeMutation(
          tx,
          organizationId,
          row.projectId,
          row.laneIds,
          context,
        );
        return record(row);
      });
    },
    async list(organizationId, userId) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        if (!(await canManage(tx, organizationId, userId, true))) return [];
        const rows = await tx
          .select()
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.organizationId, organizationId))
          .orderBy(desc(webhookSubscriptions.createdAt));
        return rows.map((row) => {
          const {
            currentSecretCiphertext: _current,
            nextSecretCiphertext: _next,
            ...safe
          } = record(row);
          return safe;
        });
      });
    },
    async listForProject(organizationId, projectId, context) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        // Listing is authorized against the agent's grant, then the service
        // narrows the returned subscriptions to the granted lanes. Passing an
        // empty lane set here would incorrectly deny every lane-scoped agent.
        const authorization = await authorizeMutation(
          tx,
          organizationId,
          projectId,
          context.authorizedLaneIds ?? [],
          context,
        );
        const rows = await tx
          .select()
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.projectId, projectId),
            ),
          )
          .orderBy(desc(webhookSubscriptions.createdAt));
        return rows
          .filter(
            (row) =>
              authorization.laneIds.length === 0 ||
              (row.laneIds.length > 0 &&
                row.laneIds.every((laneId) =>
                  authorization.laneIds.includes(laneId),
                )),
          )
          .map((row) => {
            const {
              currentSecretCiphertext: _current,
              nextSecretCiphertext: _next,
              ...safe
            } = record(row);
            return safe;
          });
      });
    },
    async markVerified(organizationId, id, expectedVersion, context, receipt) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        const existingReceipt = await lockMutationReceipt(tx, receipt);
        if (existingReceipt) {
          const [existing] = await tx
            .select({
              id: webhookSubscriptions.id,
              projectId: webhookSubscriptions.projectId,
              laneIds: webhookSubscriptions.laneIds,
            })
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, organizationId),
                eq(webhookSubscriptions.id, id),
              ),
            )
            .for("share")
            .limit(1);
          if (!existing) {
            throw new DomainError(
              "not_found",
              "Webhook subscription was not found",
            );
          }
          await authorizeMutation(
            tx,
            organizationId,
            existing.projectId,
            existing.laneIds,
            context,
          );
          return {
            version: receiptVersion(existingReceipt.result),
            replayed: true,
          };
        }
        const [current] = await tx
          .select({
            projectId: webhookSubscriptions.projectId,
            laneIds: webhookSubscriptions.laneIds,
            status: webhookSubscriptions.status,
            version: webhookSubscriptions.version,
          })
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.id, id),
            ),
          )
          .for("update")
          .limit(1);
        if (!current)
          throw new DomainError(
            "not_found",
            "Webhook subscription was not found",
          );
        if (current.version !== expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Webhook subscription changed concurrently",
          );
        if (current.status === "revoked")
          throw new DomainError(
            "conflict",
            "A revoked webhook cannot be verified",
          );
        await authorizeMutation(
          tx,
          organizationId,
          current.projectId,
          current.laneIds,
          context,
        );
        const [updated] = await tx
          .update(webhookSubscriptions)
          .set({
            status: "active",
            verifiedAt: sql`clock_timestamp()`,
            version: expectedVersion + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.id, id),
              eq(webhookSubscriptions.version, expectedVersion),
            ),
          )
          .returning();
        if (!updated)
          throw new Error("Webhook subscription persistence failed");
        await audit(
          tx,
          organizationId,
          id,
          "webhook.subscription_verified",
          ["status", "verifiedAt"],
          context,
        );
        await appendConfigurationEvent(tx, updated, "verified", context);
        await saveMutationReceipt(tx, receipt, {
          aggregateId: id,
          result: { subscriptionId: id, version: updated.version },
        });
        return { version: updated.version, replayed: false };
      });
    },
    async setStatus(
      organizationId,
      id,
      expectedVersion,
      status,
      context,
      receipt,
    ) {
      return inTenantTransaction(database, organizationId, async (tx) => {
        const existingReceipt = await lockMutationReceipt(tx, receipt);
        if (existingReceipt) {
          const [existing] = await tx
            .select({
              id: webhookSubscriptions.id,
              projectId: webhookSubscriptions.projectId,
              laneIds: webhookSubscriptions.laneIds,
            })
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, organizationId),
                eq(webhookSubscriptions.id, id),
              ),
            )
            .for("share")
            .limit(1);
          if (!existing) {
            throw new DomainError(
              "not_found",
              "Webhook subscription was not found",
            );
          }
          await authorizeMutation(
            tx,
            organizationId,
            existing.projectId,
            existing.laneIds,
            context,
          );
          return {
            version: receiptVersion(existingReceipt.result),
            replayed: true,
          };
        }
        const [current] = await tx
          .select({
            projectId: webhookSubscriptions.projectId,
            laneIds: webhookSubscriptions.laneIds,
            status: webhookSubscriptions.status,
            version: webhookSubscriptions.version,
          })
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.id, id),
            ),
          )
          .for("update")
          .limit(1);
        if (!current)
          throw new DomainError(
            "not_found",
            "Webhook subscription was not found",
          );
        if (current.version !== expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Webhook subscription changed concurrently",
          );
        if (current.status === "revoked")
          throw new DomainError(
            "conflict",
            "A revoked webhook cannot change status",
          );
        await authorizeMutation(
          tx,
          organizationId,
          current.projectId,
          current.laneIds,
          context,
        );
        const [updated] = await tx
          .update(webhookSubscriptions)
          .set({
            status,
            ...(status === "revoked"
              ? {
                  nextSecretCiphertext: null,
                  nextSecretKeyId: null,
                  overlapEndsAt: null,
                }
              : {}),
            version: expectedVersion + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(webhookSubscriptions.organizationId, organizationId),
              eq(webhookSubscriptions.id, id),
              eq(webhookSubscriptions.version, expectedVersion),
            ),
          )
          .returning();
        if (!updated)
          throw new Error("Webhook subscription persistence failed");
        await audit(
          tx,
          organizationId,
          id,
          "webhook.subscription_status_changed",
          ["status"],
          context,
        );
        await appendConfigurationEvent(tx, updated, "status_changed", context);
        await saveMutationReceipt(tx, receipt, {
          aggregateId: id,
          result: {
            subscriptionId: id,
            status,
            version: updated.version,
          },
        });
        return { version: updated.version, replayed: false };
      });
    },
    async setNextSecret(input, context, receipt) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const existingReceipt = await lockMutationReceipt(tx, receipt);
        if (existingReceipt) {
          const [existing] = await tx
            .select()
            .from(webhookSubscriptions)
            .where(
              and(
                eq(webhookSubscriptions.organizationId, input.organizationId),
                eq(webhookSubscriptions.id, input.id),
              ),
            )
            .for("share")
            .limit(1);
          if (!existing) {
            throw new DomainError(
              "not_found",
              "Webhook subscription was not found",
            );
          }
          await authorizeMutation(
            tx,
            input.organizationId,
            existing.projectId,
            existing.laneIds,
            context,
          );
          throw new DomainError(
            "conflict",
            "Webhook rotation already completed; plaintext secrets are revealed only once",
          );
        }
        const [current] = await tx
          .select({
            projectId: webhookSubscriptions.projectId,
            laneIds: webhookSubscriptions.laneIds,
            nextSecretKeyId: webhookSubscriptions.nextSecretKeyId,
            status: webhookSubscriptions.status,
            version: webhookSubscriptions.version,
          })
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, input.organizationId),
              eq(webhookSubscriptions.id, input.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!current)
          throw new DomainError(
            "not_found",
            "Webhook subscription was not found",
          );
        if (current.version !== input.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Webhook subscription changed concurrently",
          );
        if (current.status === "revoked")
          throw new DomainError(
            "conflict",
            "A revoked webhook cannot rotate secrets",
          );
        await authorizeMutation(
          tx,
          input.organizationId,
          current.projectId,
          current.laneIds,
          context,
        );
        const [updated] = await tx
          .update(webhookSubscriptions)
          .set({
            nextSecretCiphertext: encodeEnvelope(input.envelope),
            nextSecretKeyId: input.signingKeyId,
            overlapEndsAt: input.overlapEndsAt,
            version: input.expectedVersion + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(webhookSubscriptions.organizationId, input.organizationId),
              eq(webhookSubscriptions.id, input.id),
              eq(webhookSubscriptions.version, input.expectedVersion),
            ),
          )
          .returning();
        if (!updated)
          throw new Error("Webhook subscription persistence failed");
        await audit(
          tx,
          input.organizationId,
          input.id,
          "webhook.secret_rotation_started",
          ["nextSecretKeyId", "overlapEndsAt"],
          context,
        );
        await appendConfigurationEvent(
          tx,
          updated,
          "secret_rotation_started",
          context,
        );
        await saveMutationReceipt(tx, receipt, {
          aggregateId: input.id,
          result: {
            subscriptionId: input.id,
            keyId: input.signingKeyId,
            overlapEndsAt: input.overlapEndsAt.toISOString(),
          },
        });
        return {
          record: record(updated),
          secretCiphertext: input.envelope,
          keyId: input.signingKeyId,
          overlapEndsAt: input.overlapEndsAt,
          replayed: false,
        };
      });
    },
    /**
     * Function 12: subscriptions whose secret promotion is due, as ids and
     * organisations only (1-500, default 100). The ciphertexts are read
     * bound, per subscription, by `loadDueSecretPromotion`.
     */
    async listDueSecretPromotions(limit = 100) {
      const bound =
        limit === undefined || !Number.isFinite(limit)
          ? null
          : Math.max(
              -2_147_483_648,
              Math.min(2_147_483_647, Math.trunc(limit)),
            );
      const result = await database.execute<{
        subscription_id: string;
        organization_id: string;
      }>(
        sql`select subscription_id, organization_id from requestport_private.due_webhook_secret_promotions(${bound}::integer)`,
      );
      return result.rows.map((row) => ({
        id: row.subscription_id,
        organizationId: row.organization_id,
      }));
    },
    /**
     * The rotation's bound read of one due subscription's next secret and its
     * key id (§5.1: the listing no longer returns them), under the same
     * conditions the listing applied; null when it is no longer due.
     */
    async loadDueSecretPromotion(organizationId: string, id: string) {
      const [row] = await database
        .select({
          id: webhookSubscriptions.id,
          organizationId: webhookSubscriptions.organizationId,
          nextSecretCiphertext: webhookSubscriptions.nextSecretCiphertext,
          nextSecretKeyId: webhookSubscriptions.nextSecretKeyId,
        })
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.organizationId, organizationId),
            eq(webhookSubscriptions.id, id),
            isNotNull(webhookSubscriptions.nextSecretCiphertext),
            isNotNull(webhookSubscriptions.overlapEndsAt),
            lte(
              webhookSubscriptions.overlapEndsAt,
              sql<Date>`clock_timestamp()`,
            ),
          ),
        )
        .limit(1);
      if (!row?.nextSecretCiphertext || !row.nextSecretKeyId) return null;
      return {
        id: row.id,
        organizationId: row.organizationId,
        nextSecretCiphertext: decodeEnvelope(row.nextSecretCiphertext),
        nextSecretKeyId: row.nextSecretKeyId,
      };
    },
    async promoteSecret(
      input: {
        organizationId: string;
        id: string;
        envelope: EncryptedEnvelope;
        expectedNextSecretKeyId: string;
      },
      context,
    ) {
      await inTenantTransaction(database, input.organizationId, async (tx) => {
        const [current] = await tx
          .select({
            projectId: webhookSubscriptions.projectId,
            laneIds: webhookSubscriptions.laneIds,
            nextSecretKeyId: webhookSubscriptions.nextSecretKeyId,
            status: webhookSubscriptions.status,
          })
          .from(webhookSubscriptions)
          .where(
            and(
              eq(webhookSubscriptions.organizationId, input.organizationId),
              eq(webhookSubscriptions.id, input.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) return;
        if (current.status === "revoked") return;
        if (!current.nextSecretKeyId) return;
        if (current.nextSecretKeyId !== input.expectedNextSecretKeyId) return;
        await authorizeMutation(
          tx,
          input.organizationId,
          current.projectId,
          current.laneIds,
          context,
        );
        const [updated] = await tx
          .update(webhookSubscriptions)
          .set({
            currentSecretCiphertext: encodeEnvelope(input.envelope),
            currentSecretKeyId: current.nextSecretKeyId,
            nextSecretCiphertext: null,
            nextSecretKeyId: null,
            overlapEndsAt: null,
            version: sql`${webhookSubscriptions.version} + 1`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(webhookSubscriptions.organizationId, input.organizationId),
              eq(webhookSubscriptions.id, input.id),
              eq(
                webhookSubscriptions.nextSecretKeyId,
                input.expectedNextSecretKeyId,
              ),
              isNotNull(webhookSubscriptions.nextSecretCiphertext),
            ),
          )
          .returning();
        if (!updated) return;
        await audit(
          tx,
          input.organizationId,
          input.id,
          "webhook.secret_rotation_promoted",
          ["currentSecretKeyId", "nextSecretKeyId", "overlapEndsAt"],
          context,
        );
        await appendConfigurationEvent(
          tx,
          updated,
          "secret_rotation_completed",
          context,
        );
      });
    },
  };
}
