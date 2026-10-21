import {
  type ActorRef,
  actorFingerprint,
  auditActor,
  DomainError,
  deserializeEncryptedEnvelope,
  type EncryptedEnvelope,
  type JsonValue,
  keyedFingerprint,
  type SlackAdministrationMutation,
  type SlackAdministrationPort,
  type SlackAdministrationTarget,
  sanitizeEventActor,
  serializeEncryptedEnvelope,
  validateCommandMeta,
} from "@requestport/domain";
import { parseNotificationViewModel } from "@requestport/notifications/view-model";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import { inTurn } from "../in-turn.js";
import {
  domainEvents,
  notificationIntents,
  organizationMembers,
  organizations,
  outbox,
  projectMembers,
  projects,
  questions,
  requests,
  securityAuditRecords,
  slackActionTokens,
  slackDeliveries,
  slackDeliveryOperations,
  slackInstallations,
  slackOauthStates,
  slackRoutes,
  slackUserMappings,
  user,
} from "../schema/index.js";
import {
  bindTenant,
  inTenantTransaction,
  withTenant,
} from "../tenant-context.js";
import type { Tx } from "../transaction.js";

type SlackDatabase = Database | Tx;

/**
 * Records `integration.slack_changed.v1` and its outbox row, with `actor` as
 * given. The installation flow hands it the person, `{ type: "user", id }`.
 * The administration writes (Plan 13, F.2.5) hand it the mutation's actor
 * through `sanitizeEventActor`, the sanitiser the event factory applies to
 * every other event, so an operator is recorded as its `service` actor with
 * the member as origin (F3-2: "domain events carry the actor unchanged").
 */
async function appendSlackConfigurationEvent(
  database: SlackDatabase,
  input: {
    organizationId: string;
    projectId?: string | null;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    changeType: string;
    status: string;
    actor: ActorRef;
    correlationId: string;
  },
) {
  const eventId = uuidv7();
  await database.insert(domainEvents).values({
    id: eventId,
    organizationId: input.organizationId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    type: "integration.slack_changed.v1",
    schemaVersion: 1,
    projectId: input.projectId ?? null,
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.correlationId,
    data: {
      integration: "slack",
      changeType: input.changeType,
      status: input.status,
    },
    links: {},
  });
  await database.insert(outbox).values({ eventId, state: "pending" });
}

function withSlackTransaction<T>(
  database: SlackDatabase,
  operation: (transaction: SlackDatabase) => Promise<T>,
) {
  const candidate = database as SlackDatabase & {
    transaction?: <TResult>(
      callback: (transaction: Tx) => Promise<TResult>,
    ) => Promise<TResult>;
  };
  return candidate.transaction
    ? candidate.transaction(operation)
    : operation(database);
}

function installationAad(organizationId: string, installationId: string) {
  return new TextEncoder().encode(
    `requestport:slack:${organizationId}:${installationId}:bot-token`,
  );
}

export function slackInstallationAad(
  organizationId: string,
  installationId: string,
) {
  return installationAad(organizationId, installationId);
}

async function manager(
  database: SlackDatabase,
  organizationId: string,
  userId: string,
) {
  const [organization] = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!organization) return false;
  const [membership] = await database
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
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
  return Boolean(membership);
}

export type LockedSlackAction = {
  id: string;
  organizationId: string;
  questionId: string;
  installationId: string;
  tokenType: "answer" | "modal_launch" | "modal_submit";
  actionPayload: Record<string, JsonValue>;
  answerId: string | null;
  consumedAt: Date | null;
  consumedByUserId: string | null;
  slackUserId: string | null;
  userId: string;
  questionVersion: number;
};

export function createSlackRepository(database: SlackDatabase) {
  /**
   * The web opens its own transactions for the Slack OAuth callback and the
   * interaction handlers and hands them here (manifest-i2.md §2.3 item 5).
   * Of the six methods they call, `lockInstallationIdForWorkspace`,
   * `upsertInstallation` and `createActionToken` bind the transaction they
   * are handed to the organisation their input names, through this,
   * idempotently; `consumeOauthState` and `lockActionToken` bind the one
   * they find (D11); and `consumeActionToken`, which names none, runs in the
   * transaction `lockActionToken` bound. Handed the pool, this wraps as
   * every pool read does (`withTenant`).
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: SlackDatabase) => Promise<T>,
    readOnly = false,
  ) => withTenant(organizationId, work, { database, readOnly });

  return {
    canManage(organizationId: string, userId: string) {
      return manager(database, organizationId, userId);
    },

    async createOauthState(input: {
      id: string;
      organizationId: string;
      userId: string;
      stateHash: string;
      redirectUri: string;
      expiresAt: Date;
      correlationId: string;
    }) {
      await inTenantTransaction(
        database,
        input.organizationId,
        async (transaction) => {
          if (
            !(await manager(transaction, input.organizationId, input.userId))
          ) {
            throw new DomainError(
              "forbidden",
              "Slack installation access is denied",
            );
          }
          await transaction.insert(slackOauthStates).values({
            id: input.id,
            organizationId: input.organizationId,
            userId: input.userId,
            stateHash: input.stateHash,
            redirectUri: input.redirectUri,
            expiresAt: input.expiresAt,
          });
        },
      );
    },

    /**
     * Consume a live OAuth state, and bind the transaction to the
     * organisation it names (D11). The state is found before any
     * organisation is known, so a definer function locks, consumes and
     * returns it (manifest-i2.md §2.5.0); it writes, so it runs in a
     * transaction (§2.5.0 item 7) — handed one, a savepoint whose binding
     * the enclosing transaction keeps. The user must still manage Slack in
     * that organisation, read under the binding; if not, this throws and the
     * consumption rolls back with it.
     */
    async consumeOauthState(stateHash: string) {
      return withSlackTransaction(database, async (transaction) => {
        const { rows } = await transaction.execute(
          sql`select * from requestport_private.consume_slack_oauth_state(${stateHash})`,
        );
        const record = rows[0] as
          | { organization_id: string; user_id: string; redirect_uri: string }
          | undefined;
        if (!record) {
          throw new DomainError(
            "forbidden",
            "Slack OAuth state is invalid or expired",
          );
        }
        await bindTenant(transaction as Tx, record.organization_id);
        if (
          !(await manager(transaction, record.organization_id, record.user_id))
        ) {
          throw new DomainError(
            "forbidden",
            "Slack OAuth state is invalid or expired",
          );
        }
        return {
          organizationId: record.organization_id,
          userId: record.user_id,
          redirectUri: record.redirect_uri,
        };
      });
    },

    async installationIdForWorkspace(
      organizationId: string,
      workspaceId: string,
    ) {
      const [record] = await database
        .select({ id: slackInstallations.id })
        .from(slackInstallations)
        .where(
          and(
            eq(slackInstallations.organizationId, organizationId),
            eq(slackInstallations.workspaceId, workspaceId),
          ),
        )
        .orderBy(desc(slackInstallations.createdAt))
        .limit(1);
      return record?.id ?? null;
    },

    async lockInstallationIdForWorkspace(
      organizationId: string,
      workspaceId: string,
      proposedId: string,
    ) {
      return forOrganization(organizationId, async (database) => {
        await database.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('requestport:slack-installation:' || ${organizationId} || ':' || ${workspaceId}, 0))`,
        );
        const [record] = await database
          .select({ id: slackInstallations.id })
          .from(slackInstallations)
          .where(
            and(
              eq(slackInstallations.organizationId, organizationId),
              eq(slackInstallations.workspaceId, workspaceId),
            ),
          )
          .orderBy(desc(slackInstallations.createdAt))
          .limit(1);
        return record?.id ?? proposedId;
      });
    },

    async upsertInstallation(input: {
      id: string;
      organizationId: string;
      workspaceId: string;
      workspaceName: string;
      botToken: EncryptedEnvelope;
      botUserId: string;
      scopes: string[];
      userId: string;
      correlationId: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        if (!(await manager(database, input.organizationId, input.userId))) {
          throw new DomainError(
            "forbidden",
            "Slack installation access is denied",
          );
        }
        const existing = await database
          .select({ id: slackInstallations.id })
          .from(slackInstallations)
          .where(
            and(
              eq(slackInstallations.organizationId, input.organizationId),
              eq(slackInstallations.workspaceId, input.workspaceId),
            ),
          )
          .orderBy(desc(slackInstallations.createdAt))
          .limit(1);
        const installationId = existing[0]?.id ?? input.id;
        if (installationId !== input.id) {
          throw new DomainError(
            "conflict",
            "Slack installation identity changed during OAuth",
          );
        }
        if (existing[0]) {
          const [updated] = await database
            .update(slackInstallations)
            .set({
              workspaceName: input.workspaceName,
              botTokenCiphertext: serializeEncryptedEnvelope(input.botToken),
              botUserId: input.botUserId,
              scopes: input.scopes,
              status: "active",
              version: sql`${slackInstallations.version} + 1`,
              installedByUserId: input.userId,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(slackInstallations.id, installationId))
            .returning({ version: slackInstallations.version });
          if (!updated)
            throw new Error("Slack installation persistence failed");
        } else {
          await database.insert(slackInstallations).values({
            id: installationId,
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            workspaceName: input.workspaceName,
            botTokenCiphertext: serializeEncryptedEnvelope(input.botToken),
            botUserId: input.botUserId,
            scopes: input.scopes,
            installedByUserId: input.userId,
          });
        }
        await database.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.userId,
          action: existing[0]
            ? "slack.installation_refreshed"
            : "slack.installation_created",
          targetType: "slack_installation",
          targetId: installationId,
          reason: "Slack OAuth installation completed",
          fieldNames: ["workspaceId", "botUserId", "scopes", "status"],
          correlationId: input.correlationId,
        });
        const [current] = await database
          .select({
            version: slackInstallations.version,
            status: slackInstallations.status,
          })
          .from(slackInstallations)
          .where(eq(slackInstallations.id, installationId))
          .limit(1);
        if (!current) throw new Error("Slack installation persistence failed");
        await appendSlackConfigurationEvent(database, {
          organizationId: input.organizationId,
          aggregateType: "slack_installation",
          aggregateId: installationId,
          aggregateVersion: current.version,
          changeType: existing[0] ? "refreshed" : "installed",
          status: current.status,
          actor: { type: "user", id: input.userId },
          correlationId: input.correlationId,
        });
        return installationId;
      });
    },

    async list(organizationId: string, userId: string) {
      return inTenantTransaction(
        database,
        organizationId,
        async (transaction) => {
          if (!(await manager(transaction, organizationId, userId)))
            return null;
          const [installations, mappings, routes] = await inTurn([
            () =>
              transaction
                .select({
                  id: slackInstallations.id,
                  workspaceId: slackInstallations.workspaceId,
                  workspaceName: slackInstallations.workspaceName,
                  botUserId: slackInstallations.botUserId,
                  scopes: slackInstallations.scopes,
                  status: slackInstallations.status,
                  version: slackInstallations.version,
                  updatedAt: slackInstallations.updatedAt,
                })
                .from(slackInstallations)
                .where(eq(slackInstallations.organizationId, organizationId))
                .orderBy(desc(slackInstallations.updatedAt)),
            () =>
              transaction
                .select({
                  id: slackUserMappings.id,
                  installationId: slackUserMappings.installationId,
                  slackUserId: slackUserMappings.slackUserId,
                  userId: slackUserMappings.userId,
                  userName: user.name,
                  status: slackUserMappings.status,
                  version: slackUserMappings.version,
                })
                .from(slackUserMappings)
                .innerJoin(user, eq(user.id, slackUserMappings.userId))
                .where(eq(slackUserMappings.organizationId, organizationId)),
            () =>
              transaction
                .select({
                  id: slackRoutes.id,
                  projectId: slackRoutes.projectId,
                  projectName: projects.name,
                  mode: slackRoutes.mode,
                  channelId: slackRoutes.channelId,
                  fallback: slackRoutes.fallback,
                  status: slackRoutes.status,
                  version: slackRoutes.version,
                })
                .from(slackRoutes)
                .leftJoin(projects, eq(projects.id, slackRoutes.projectId))
                .where(eq(slackRoutes.organizationId, organizationId)),
          ]);
          const operations = installations.length
            ? await transaction
                .select({
                  id: slackDeliveryOperations.id,
                  installationId: slackDeliveryOperations.installationId,
                  operationType: slackDeliveryOperations.operationType,
                  status: slackDeliveryOperations.status,
                  createdAt: slackDeliveryOperations.createdAt,
                  updatedAt: slackDeliveryOperations.updatedAt,
                })
                .from(slackDeliveryOperations)
                .where(
                  inArray(
                    slackDeliveryOperations.installationId,
                    installations.map((installation) => installation.id),
                  ),
                )
                .orderBy(desc(slackDeliveryOperations.updatedAt))
                .limit(100)
            : [];
          return { installations, mappings, routes, operations };
        },
      );
    },

    async loadPendingSlackIntent(intentId: string, leaseOwner: string) {
      const [row] = await database
        .select({
          intent: notificationIntents,
          questionState: questions.state,
          audienceType: questions.audienceType,
          audienceId: questions.audienceId,
          projectId: requests.targetProjectId,
          reporterType: requests.reporterType,
          reporterId: requests.reporterId,
        })
        .from(notificationIntents)
        .innerJoin(
          questions,
          and(
            eq(questions.id, notificationIntents.questionId),
            eq(questions.organizationId, notificationIntents.organizationId),
          ),
        )
        .innerJoin(
          requests,
          and(
            eq(requests.id, questions.parentRequestId),
            eq(requests.organizationId, notificationIntents.organizationId),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.id, requests.targetProjectId),
            eq(projects.organizationId, notificationIntents.organizationId),
            eq(projects.status, "active"),
          ),
        )
        .where(
          and(
            eq(notificationIntents.id, intentId),
            eq(notificationIntents.channel, "slack"),
            eq(notificationIntents.status, "delivering"),
            eq(notificationIntents.leaseOwner, leaseOwner),
            sql`${notificationIntents.leaseExpiresAt} > clock_timestamp()`,
            eq(questions.state, "open"),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (!row.intent.recipientUserId) return null;
      const [mapping] = await database
        .select({
          installationId: slackUserMappings.installationId,
          slackUserId: slackUserMappings.slackUserId,
          installation: slackInstallations,
          userId: slackUserMappings.userId,
          organizationRole: organizationMembers.role,
          projectRole: projectMembers.role,
        })
        .from(slackUserMappings)
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, slackUserMappings.installationId),
        )
        .innerJoin(
          organizationMembers,
          and(
            eq(
              organizationMembers.organizationId,
              slackUserMappings.organizationId,
            ),
            eq(organizationMembers.userId, slackUserMappings.userId),
            eq(organizationMembers.status, "active"),
          ),
        )
        .leftJoin(
          projectMembers,
          and(
            eq(projectMembers.organizationId, slackUserMappings.organizationId),
            eq(projectMembers.projectId, row.projectId),
            eq(projectMembers.userId, slackUserMappings.userId),
            eq(projectMembers.status, "active"),
          ),
        )
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, slackUserMappings.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .where(
          and(
            eq(slackUserMappings.organizationId, row.intent.organizationId),
            eq(slackUserMappings.userId, row.intent.recipientUserId),
            eq(slackUserMappings.slackUserId, row.intent.recipientRef),
            eq(slackUserMappings.status, "active"),
            eq(slackInstallations.status, "active"),
          ),
        )
        .limit(1);
      if (!mapping) return null;
      const parsedModel = parseNotificationViewModel(row.intent.viewModel);
      const escalationAudience =
        parsedModel.kind === "question"
          ? parsedModel.escalationAudience
          : undefined;
      const stillEligible =
        row.intent.template === "question_escalation_v1"
          ? mapping.organizationRole === "owner" ||
            mapping.organizationRole === "admin" ||
            (escalationAudience === "project_maintainers" &&
              mapping.projectRole === "maintainer")
          : (row.audienceType === "user" &&
              row.audienceId === mapping.userId) ||
            (row.audienceType === "role" &&
              row.audienceId === mapping.organizationRole) ||
            (row.audienceType === "requester" &&
              row.reporterType === "user" &&
              row.reporterId === mapping.userId) ||
            (row.audienceType === "project_maintainers" &&
              (mapping.organizationRole === "owner" ||
                mapping.organizationRole === "admin" ||
                mapping.projectRole === "maintainer"));
      if (!stillEligible) return null;
      const routes = await database
        .select()
        .from(slackRoutes)
        .where(
          and(
            eq(slackRoutes.organizationId, row.intent.organizationId),
            eq(slackRoutes.status, "active"),
            or(
              eq(slackRoutes.projectId, row.projectId),
              isNull(slackRoutes.projectId),
            ),
          ),
        );
      const route =
        routes.find((item) => item.projectId === row.projectId) ??
        routes.find((item) => item.projectId === null) ??
        null;
      return {
        intent: row.intent,
        projectId: row.projectId,
        installation: {
          ...mapping.installation,
          botTokenCiphertext: deserializeEncryptedEnvelope(
            mapping.installation.botTokenCiphertext,
          ),
        },
        slackUserId: mapping.slackUserId,
        route,
      };
    },

    async ensureSlackDelivery(input: {
      organizationId: string;
      intentId: string;
      installationId: string;
      channelId: string;
    }) {
      const [created] = await database
        .insert(slackDeliveries)
        .values({
          organizationId: input.organizationId,
          notificationIntentId: input.intentId,
          installationId: input.installationId,
          channelId: input.channelId,
        })
        .onConflictDoNothing()
        .returning({ id: slackDeliveries.id });
      if (created)
        return { id: created.id, status: "pending" as const, messageTs: null };
      const [existing] = await database
        .select({
          id: slackDeliveries.id,
          status: slackDeliveries.status,
          messageTs: slackDeliveries.messageTs,
        })
        .from(slackDeliveries)
        .where(
          and(
            eq(slackDeliveries.notificationIntentId, input.intentId),
            eq(slackDeliveries.installationId, input.installationId),
            eq(slackDeliveries.channelId, input.channelId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Slack delivery allocation failed");
      return existing;
    },

    async finishSlackDelivery(input: {
      intentId: string;
      deliveryId: string;
      leaseOwner: string;
      status: "delivered" | "failed";
      messageTs?: string;
    }) {
      const [updated] = await database
        .update(slackDeliveries)
        .set({
          status: input.status,
          messageTs: input.messageTs,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(slackDeliveries.id, input.deliveryId),
            eq(slackDeliveries.notificationIntentId, input.intentId),
            sql`exists (
              select 1
              from ${notificationIntents} active_intent
              where active_intent.id = ${input.intentId}
                and active_intent.channel = 'slack'
                and active_intent.status = 'delivering'
                and active_intent.lease_owner = ${input.leaseOwner}
                and active_intent.lease_expires_at > clock_timestamp()
            )`,
            input.status === "failed"
              ? ne(slackDeliveries.status, "delivered")
              : sql`true`,
          ),
        )
        .returning({ id: slackDeliveries.id });
      return Boolean(updated);
    },

    async createActionToken(input: {
      id: string;
      organizationId: string;
      questionId: string;
      installationId: string;
      slackUserId: string | null;
      tokenType: "answer" | "modal_launch" | "modal_submit";
      tokenHash: string;
      actionPayload?: Record<string, JsonValue>;
      expiresAt: Date;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        await database
          .insert(slackActionTokens)
          .values({ ...input, actionPayload: input.actionPayload ?? {} });
      });
    },

    /**
     * Lock a live action token and everything it answers for, and bind the
     * transaction to the token's organisation (D11). Found before any
     * organisation is known, so through a definer function
     * (manifest-i2.md §2.5.0), which locks the rows of all six joined tables
     * `FOR UPDATE` as this method's own query did; it takes locks, so it runs
     * in a transaction (§2.5.0 item 7) — handed one, a savepoint whose
     * binding the enclosing transaction keeps.
     */
    async lockActionToken(input: {
      tokenHash: string;
      tokenType: "answer" | "modal_launch" | "modal_submit";
      workspaceId: string;
      slackUserId: string;
    }): Promise<LockedSlackAction> {
      return withSlackTransaction(database, async (transaction) => {
        const { rows } = await transaction.execute(
          sql`select * from requestport_private.lock_slack_action_token(${input.tokenHash}, ${input.tokenType}, ${input.workspaceId}, ${input.slackUserId})`,
        );
        const row = rows[0] as
          | {
              token_id: string;
              organization_id: string;
              question_id: string;
              installation_id: string;
              action_payload: Record<string, JsonValue>;
              answer_id: string | null;
              consumed_at: string | Date | null;
              consumed_by_user_id: string | null;
              slack_user_id: string | null;
              user_id: string;
              question_version: number;
            }
          | undefined;
        if (!row)
          throw new DomainError(
            "forbidden",
            "Slack action is invalid or expired",
          );
        await bindTenant(transaction as Tx, row.organization_id);
        return {
          id: row.token_id,
          organizationId: row.organization_id,
          questionId: row.question_id,
          installationId: row.installation_id,
          // The function matches this type exactly, so it does not return it.
          tokenType: input.tokenType,
          actionPayload: row.action_payload,
          answerId: row.answer_id,
          // Text from `execute`, which Drizzle's column mappers would parse.
          consumedAt:
            row.consumed_at === null ? null : new Date(row.consumed_at),
          consumedByUserId: row.consumed_by_user_id,
          slackUserId: row.slack_user_id,
          userId: row.user_id,
          questionVersion: row.question_version,
        };
      });
    },

    async consumeActionToken(input: {
      id: string;
      userId: string;
      slackUserId: string;
      answerId?: string | null;
    }) {
      await database
        .update(slackActionTokens)
        .set({
          consumedAt: new Date(),
          consumedByUserId: input.userId,
          slackUserId: sql`coalesce(${slackActionTokens.slackUserId}, ${input.slackUserId})`,
          answerId: input.answerId ?? null,
        })
        .where(eq(slackActionTokens.id, input.id));
    },

    async ensureMessageUpdateOperation(input: {
      installationId: string;
      operationKey: string;
      channelId: string;
      messageTs: string;
      answerId: string;
    }) {
      const [created] = await database
        .insert(slackDeliveryOperations)
        .values({
          installationId: input.installationId,
          operationKey: input.operationKey,
          operationType: "message_update",
          providerMessageTs: input.messageTs,
          operationPayload: {
            channelId: input.channelId,
            messageTs: input.messageTs,
            answerId: input.answerId,
          },
        })
        .onConflictDoNothing()
        .returning({ id: slackDeliveryOperations.id });
      if (created) return created.id;
      const [existing] = await database
        .select({ id: slackDeliveryOperations.id })
        .from(slackDeliveryOperations)
        .where(eq(slackDeliveryOperations.operationKey, input.operationKey))
        .limit(1);
      if (!existing) throw new Error("Slack message update allocation failed");
      return existing.id;
    },

    async claimSlackDeliveryOperation(input: {
      operationId: string;
      operationType: "message_update" | "connection_test";
      leaseOwner: string;
    }) {
      return withSlackTransaction(database, async (transaction) => {
        const [operation] = await transaction
          .update(slackDeliveryOperations)
          .set({
            status: "delivering",
            attemptCount: sql`${slackDeliveryOperations.attemptCount} + 1`,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: sql`clock_timestamp() + interval '10 minutes'`,
            lastErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(slackDeliveryOperations.id, input.operationId),
              eq(slackDeliveryOperations.operationType, input.operationType),
              sql`(
                (${slackDeliveryOperations.status} in ('pending', 'retry')
                  and ${slackDeliveryOperations.nextAttemptAt} <= clock_timestamp())
                or (${slackDeliveryOperations.status} = 'delivering'
                  and ${slackDeliveryOperations.leaseExpiresAt} < clock_timestamp())
              )`,
              sql`exists (
                select 1 from ${slackInstallations} active_installation
                where active_installation.id = ${slackDeliveryOperations.installationId}
                  and active_installation.status = 'active'
              )`,
            ),
          )
          .returning();
        if (!operation) return null;
        const [installation] = await transaction
          .select()
          .from(slackInstallations)
          .where(
            and(
              eq(slackInstallations.id, operation.installationId),
              eq(slackInstallations.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!installation) {
          throw new Error("Slack operation installation disappeared");
        }
        return {
          operation,
          installation: {
            ...installation,
            botTokenCiphertext: deserializeEncryptedEnvelope(
              installation.botTokenCiphertext,
            ),
          },
        };
      });
    },

    async finishSlackDeliveryOperation(input: {
      operationId: string;
      operationType: "message_update" | "connection_test";
      leaseOwner: string;
      delivered: boolean;
      providerMessageTs?: string;
      errorCode?: string;
    }) {
      const [operation] = await database
        .update(slackDeliveryOperations)
        .set({
          status: input.delivered
            ? "delivered"
            : sql`case when ${slackDeliveryOperations.attemptCount} >= 8 then 'failed' else 'retry' end`,
          providerMessageTs: input.providerMessageTs,
          nextAttemptAt: input.delivered
            ? sql`clock_timestamp()`
            : sql`clock_timestamp() + (least(3600, 30 * power(2, greatest(0, ${slackDeliveryOperations.attemptCount} - 1))) * interval '1 second')`,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: input.delivered
            ? null
            : (input.errorCode ?? "provider_delivery_failed"),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(slackDeliveryOperations.id, input.operationId),
            eq(slackDeliveryOperations.operationType, input.operationType),
            eq(slackDeliveryOperations.status, "delivering"),
            eq(slackDeliveryOperations.leaseOwner, input.leaseOwner),
          ),
        )
        .returning({ status: slackDeliveryOperations.status });
      return operation?.status ?? null;
    },

    /**
     * Functions 8 and 9: due Slack operations' ids and their installations'
     * organisations (1-500, default 100), one function per type, chosen here
     * by a fixed branch: no function takes a type name (§5.1).
     */
    async dueSlackDeliveryOperations(
      operationType: "message_update" | "connection_test",
      limit = 100,
    ) {
      const bound =
        limit === undefined || !Number.isFinite(limit)
          ? null
          : Math.max(
              -2_147_483_648,
              Math.min(2_147_483_647, Math.trunc(limit)),
            );
      const result = await database.execute<{
        operation_id: string;
        organization_id: string;
      }>(
        operationType === "message_update"
          ? sql`select operation_id, organization_id from requestport_private.due_slack_message_updates(${bound}::integer)`
          : sql`select operation_id, organization_id from requestport_private.due_slack_connection_tests(${bound}::integer)`,
      );
      return result.rows.map((row) => ({
        id: row.operation_id,
        organizationId: row.organization_id,
      }));
    },

    /**
     * Queues a connection test on an active installation of the organisation
     * (Plan 13, F.2.5), for `userId`, who must be an active owner or admin of
     * it: the signed-in person, or an operator's issuing member. `actor` is
     * who acts — that person, or the operator's own `service` actor — and is
     * what the operation's key is built from and what the audit row records
     * (`auditActor`), so an operator's retry and its member's never share an
     * operation, and an operator is never recorded as its member.
     */
    async queueConnectionTest(input: {
      organizationId: string;
      installationId: string;
      channelId: string;
      userId: string;
      actor: ActorRef;
      idempotencyKey: string;
      expectedVersion: number;
      fingerprintSecret: string;
      correlationId: string;
    }) {
      validateCommandMeta(input);
      if (input.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "New Slack tests require expected version zero",
        );
      }
      return inTenantTransaction(
        database,
        input.organizationId,
        async (transaction) => {
          if (
            !(await manager(transaction, input.organizationId, input.userId))
          ) {
            throw new DomainError("forbidden", "Slack test access is denied");
          }
          const [installation] = await transaction
            .select({ id: slackInstallations.id })
            .from(slackInstallations)
            .where(
              and(
                eq(slackInstallations.id, input.installationId),
                eq(slackInstallations.organizationId, input.organizationId),
                eq(slackInstallations.status, "active"),
              ),
            )
            .limit(1);
          if (!installation) {
            throw new DomainError(
              "not_found",
              "Active Slack installation was not found",
            );
          }
          const operationKey = `connection-test:${keyedFingerprint(
            input.fingerprintSecret,
            `${actorFingerprint(input.actor)}:${input.idempotencyKey}`,
          )}`;
          const [created] = await transaction
            .insert(slackDeliveryOperations)
            .values({
              installationId: input.installationId,
              operationKey,
              operationType: "connection_test",
              operationPayload: { channelId: input.channelId },
            })
            .onConflictDoNothing()
            .returning({ id: slackDeliveryOperations.id });
          const [operation] = created
            ? [
                {
                  ...created,
                  installationId: input.installationId,
                  operationPayload: { channelId: input.channelId },
                },
              ]
            : await transaction
                .select({
                  id: slackDeliveryOperations.id,
                  installationId: slackDeliveryOperations.installationId,
                  operationPayload: slackDeliveryOperations.operationPayload,
                })
                .from(slackDeliveryOperations)
                .where(eq(slackDeliveryOperations.operationKey, operationKey))
                .limit(1);
          if (!operation) {
            throw new Error("Slack connection test allocation failed");
          }
          if (
            operation.installationId !== input.installationId ||
            operation.operationPayload.channelId !== input.channelId
          ) {
            throw new DomainError(
              "idempotency_conflict",
              "Slack connection test idempotency key was already used",
            );
          }
          if (created) {
            await transaction.insert(securityAuditRecords).values({
              organizationId: input.organizationId,
              ...auditActor(input),
              action: "slack.connection_test_queued",
              targetType: "slack_delivery_operation",
              targetId: operation.id,
              reason: "Operator requested a Slack connection test",
              fieldNames: ["installationId", "channelId"],
              correlationId: input.correlationId,
            });
          }
          return operation;
        },
      );
    },

    /**
     * The installation the interaction route opens a modal with, a pool read
     * the web makes for the organisation `prepareSlackAnswerModal` found
     * (manifest-i2.md §2.3 item 3): bound to it, read-only, through the
     * wrapping every pool read has.
     */
    async loadInstallation(organizationId: string, installationId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          const [row] = await database
            .select()
            .from(slackInstallations)
            .where(
              and(
                eq(slackInstallations.organizationId, organizationId),
                eq(slackInstallations.id, installationId),
                eq(slackInstallations.status, "active"),
              ),
            )
            .limit(1);
          return row
            ? {
                ...row,
                botTokenCiphertext: deserializeEncryptedEnvelope(
                  row.botTokenCiphertext,
                ),
              }
            : null;
        },
        true,
      );
    },
  };
}

/**
 * The Slack administration writes, as the command bus opens them on its
 * transaction (Plan 13, F.2.5): the port `slack-administration-commands.ts`
 * names. Each write runs in its own transaction, a savepoint inside the
 * bus's, and checks the acting member's role (`actorUserId`) and its row's
 * version again there. Each records the mutation's `actor`: its audit row
 * through `auditActor` — a person as `user` and their id, an operator as
 * `service` and `operator:<lineage>` (F3-2), never as its member — and its
 * events with that actor as it is. None keeps a receipt: the bus's receipt,
 * keyed by its own secret, is the only one (`manifest-f2.md` §2.4).
 *
 * Each method binds the transaction it runs in to the organisation it names
 * (manifest-i2.md §2.3 items 2 and 5): `authorize` the one it is handed, and
 * each write its savepoint, whose binding the bus's transaction then keeps.
 * The bus binds its transaction to the context's organisation before these
 * run (`commandTransactionBinding`), so on the bus each binding repeats that
 * one, which is idempotent, and one for another organisation is refused.
 */
export function createSlackAdministrationCommandRepository(
  database: SlackDatabase,
) {
  const forOrganization = <T>(
    organizationId: string,
    work: (database: SlackDatabase) => Promise<T>,
  ) => withTenant(organizationId, work, { database });

  const repository = {
    async authorize(target: SlackAdministrationTarget) {
      return forOrganization(target.organizationId, async (database) => {
        if (
          !(await manager(database, target.organizationId, target.actorUserId))
        )
          throw new DomainError(
            "forbidden",
            "Slack administration access is denied",
          );
      });
    },

    async setInstallationStatus(
      mutation: SlackAdministrationMutation,
      input: {
        installationId: string;
        status: "active" | "disabled" | "revoked";
      },
    ) {
      return inTenantTransaction(
        database,
        mutation.organizationId,
        async (transaction) => {
          if (
            !(await manager(
              transaction,
              mutation.organizationId,
              mutation.actorUserId,
            ))
          )
            throw new DomainError(
              "forbidden",
              "Slack installation access is denied",
            );
          const [current] = await transaction
            .select({
              status: slackInstallations.status,
              version: slackInstallations.version,
            })
            .from(slackInstallations)
            .where(
              and(
                eq(slackInstallations.id, input.installationId),
                eq(slackInstallations.organizationId, mutation.organizationId),
              ),
            )
            .for("update")
            .limit(1);
          if (!current)
            throw new DomainError(
              "not_found",
              "Slack installation was not found",
            );
          if (current.status === "revoked") {
            throw new DomainError(
              "conflict",
              "A revoked Slack installation must be reinstalled through OAuth",
            );
          }
          if (current.version !== mutation.expectedVersion)
            throw new DomainError(
              "version_conflict",
              "Slack installation changed concurrently",
            );
          const [updated] = await transaction
            .update(slackInstallations)
            .set({
              status: input.status,
              version: mutation.expectedVersion + 1,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(slackInstallations.id, input.installationId),
                eq(slackInstallations.organizationId, mutation.organizationId),
                eq(slackInstallations.version, mutation.expectedVersion),
              ),
            )
            .returning({
              id: slackInstallations.id,
              version: slackInstallations.version,
              status: slackInstallations.status,
            });
          if (!updated)
            throw new DomainError(
              "version_conflict",
              "Slack installation changed concurrently",
            );
          await transaction.insert(securityAuditRecords).values({
            organizationId: mutation.organizationId,
            ...auditActor(mutation),
            action: `slack.installation_${input.status}`,
            targetType: "slack_installation",
            targetId: input.installationId,
            reason: "Slack installation status changed",
            fieldNames: ["status"],
            correlationId: mutation.correlationId,
          });
          await appendSlackConfigurationEvent(transaction, {
            organizationId: mutation.organizationId,
            aggregateType: "slack_installation",
            aggregateId: updated.id,
            aggregateVersion: updated.version,
            changeType: "status_changed",
            status: updated.status,
            actor: sanitizeEventActor(mutation.actor),
            correlationId: mutation.correlationId,
          });
          return updated;
        },
      );
    },

    async upsertMapping(
      mutation: SlackAdministrationMutation,
      input: { installationId: string; userId: string; slackUserId: string },
    ) {
      return inTenantTransaction(
        database,
        mutation.organizationId,
        async (transaction) => {
          if (
            !(await manager(
              transaction,
              mutation.organizationId,
              mutation.actorUserId,
            ))
          )
            throw new DomainError(
              "forbidden",
              "Slack mapping access is denied",
            );
          const mappingLocks = [
            `requestport:slack-mapping-user:${input.installationId}:${input.userId}`,
            `requestport:slack-mapping-slack:${input.installationId}:${input.slackUserId}`,
          ].sort((left, right) => left.localeCompare(right, "en"));
          for (const lock of mappingLocks) {
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`,
            );
          }
          const [valid] = await transaction
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, mutation.organizationId),
                eq(organizationMembers.userId, input.userId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .limit(1);
          const [installation] = await transaction
            .select({ id: slackInstallations.id })
            .from(slackInstallations)
            .where(
              and(
                eq(slackInstallations.id, input.installationId),
                eq(slackInstallations.organizationId, mutation.organizationId),
                eq(slackInstallations.status, "active"),
              ),
            )
            .limit(1);
          if (!valid || !installation)
            throw new DomainError(
              "validation_failed",
              "Select an active member and Slack installation",
            );
          const [conflictingSlackUser] = await transaction
            .select({ id: slackUserMappings.id })
            .from(slackUserMappings)
            .where(
              and(
                eq(slackUserMappings.installationId, input.installationId),
                eq(slackUserMappings.slackUserId, input.slackUserId),
                ne(slackUserMappings.userId, input.userId),
              ),
            )
            .for("share")
            .limit(1);
          if (conflictingSlackUser) {
            throw new DomainError(
              "validation_failed",
              "That Slack user is already mapped to another organization member",
            );
          }
          const [current] = await transaction
            .select({
              id: slackUserMappings.id,
              version: slackUserMappings.version,
            })
            .from(slackUserMappings)
            .where(
              and(
                eq(slackUserMappings.organizationId, mutation.organizationId),
                eq(slackUserMappings.installationId, input.installationId),
                eq(slackUserMappings.userId, input.userId),
              ),
            )
            .for("update")
            .limit(1);
          if ((current?.version ?? 0) !== mutation.expectedVersion)
            throw new DomainError(
              "version_conflict",
              "Slack mapping changed concurrently",
            );
          const [mapping] = current
            ? await transaction
                .update(slackUserMappings)
                .set({
                  slackUserId: input.slackUserId,
                  status: "active",
                  version: mutation.expectedVersion + 1,
                  verifiedAt: sql`clock_timestamp()`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(
                  and(
                    eq(slackUserMappings.id, current.id),
                    eq(
                      slackUserMappings.organizationId,
                      mutation.organizationId,
                    ),
                    eq(slackUserMappings.version, mutation.expectedVersion),
                  ),
                )
                .returning({
                  id: slackUserMappings.id,
                  version: slackUserMappings.version,
                  status: slackUserMappings.status,
                })
            : await transaction
                .insert(slackUserMappings)
                .values({
                  organizationId: mutation.organizationId,
                  installationId: input.installationId,
                  slackUserId: input.slackUserId,
                  userId: input.userId,
                  verifiedAt: sql`clock_timestamp()`,
                })
                .returning({
                  id: slackUserMappings.id,
                  version: slackUserMappings.version,
                  status: slackUserMappings.status,
                });
          if (!mapping) throw new Error("Slack mapping persistence failed");
          await transaction.insert(securityAuditRecords).values({
            organizationId: mutation.organizationId,
            ...auditActor(mutation),
            action: "slack.user_mapping_updated",
            targetType: "user",
            targetId: input.userId,
            reason: "Slack user mapping changed",
            fieldNames: ["installationId", "slackUserId", "status"],
            correlationId: mutation.correlationId,
          });
          await appendSlackConfigurationEvent(transaction, {
            organizationId: mutation.organizationId,
            aggregateType: "slack_user_mapping",
            aggregateId: mapping.id,
            aggregateVersion: mapping.version,
            changeType: "user_mapping_changed",
            status: mapping.status,
            actor: sanitizeEventActor(mutation.actor),
            correlationId: mutation.correlationId,
          });
          return { id: mapping.id, version: mapping.version };
        },
      );
    },

    async setRoute(
      mutation: SlackAdministrationMutation,
      input: {
        projectId: string | null;
        mode: "dm" | "channel" | "both";
        channelId: string | null;
        fallback: "none" | "organization_channel" | "email";
      },
    ) {
      return inTenantTransaction(
        database,
        mutation.organizationId,
        async (transaction) => {
          if (
            !(await manager(
              transaction,
              mutation.organizationId,
              mutation.actorUserId,
            ))
          )
            throw new DomainError(
              "forbidden",
              "Slack routing access is denied",
            );
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('requestport:slack-route:' || ${mutation.organizationId} || ':' || coalesce(${input.projectId}, 'organization'), 0))`,
          );
          if (
            (input.mode === "channel" || input.mode === "both") &&
            !input.channelId
          )
            throw new DomainError(
              "validation_failed",
              "A Slack channel is required for this route",
            );
          if (input.projectId) {
            const [project] = await transaction
              .select({ id: projects.id })
              .from(projects)
              .where(
                and(
                  eq(projects.organizationId, mutation.organizationId),
                  eq(projects.id, input.projectId),
                  eq(projects.status, "active"),
                ),
              )
              .limit(1);
            if (!project)
              throw new DomainError(
                "validation_failed",
                "Slack route project is invalid",
              );
          }
          const [current] = await transaction
            .select({ id: slackRoutes.id, version: slackRoutes.version })
            .from(slackRoutes)
            .where(
              and(
                eq(slackRoutes.organizationId, mutation.organizationId),
                input.projectId
                  ? eq(slackRoutes.projectId, input.projectId)
                  : isNull(slackRoutes.projectId),
                eq(slackRoutes.status, "active"),
              ),
            )
            .for("update")
            .limit(1);
          if ((current?.version ?? 0) !== mutation.expectedVersion)
            throw new DomainError(
              "version_conflict",
              "Slack route changed concurrently",
            );
          const disabledRoutes = current
            ? await transaction
                .update(slackRoutes)
                .set({
                  status: "disabled",
                  version: sql`${slackRoutes.version} + 1`,
                  updatedAt: sql`clock_timestamp()`,
                })
                .where(
                  and(
                    eq(slackRoutes.id, current.id),
                    eq(slackRoutes.organizationId, mutation.organizationId),
                    eq(slackRoutes.version, mutation.expectedVersion),
                    eq(slackRoutes.status, "active"),
                  ),
                )
                .returning({
                  id: slackRoutes.id,
                  projectId: slackRoutes.projectId,
                  version: slackRoutes.version,
                  status: slackRoutes.status,
                })
            : [];
          for (const disabled of disabledRoutes) {
            await appendSlackConfigurationEvent(transaction, {
              organizationId: mutation.organizationId,
              projectId: disabled.projectId,
              aggregateType: "slack_route",
              aggregateId: disabled.id,
              aggregateVersion: disabled.version,
              changeType: "route_disabled",
              status: disabled.status,
              actor: sanitizeEventActor(mutation.actor),
              correlationId: mutation.correlationId,
            });
          }
          // A change replaces the active row rather than updating it, so the
          // successor carries the next version of the scope's route. Starting it
          // at 1 would hand every later writer the version 1 it already holds,
          // and the check above would never refuse a stale one.
          const [created] = await transaction
            .insert(slackRoutes)
            .values({
              organizationId: mutation.organizationId,
              projectId: input.projectId,
              mode: input.mode,
              channelId: input.channelId,
              fallback: input.fallback,
              version: mutation.expectedVersion + 1,
            })
            .returning({
              id: slackRoutes.id,
              version: slackRoutes.version,
              status: slackRoutes.status,
            });
          if (!created) throw new Error("Slack route persistence failed");
          await transaction.insert(securityAuditRecords).values({
            organizationId: mutation.organizationId,
            ...auditActor(mutation),
            action: "slack.route_changed",
            targetType: "slack_route",
            targetId: created.id,
            reason: "Slack delivery route changed",
            fieldNames: ["projectId", "mode", "channelId", "fallback"],
            correlationId: mutation.correlationId,
          });
          await appendSlackConfigurationEvent(transaction, {
            organizationId: mutation.organizationId,
            projectId: input.projectId,
            aggregateType: "slack_route",
            aggregateId: created.id,
            aggregateVersion: created.version,
            changeType: "route_changed",
            status: created.status,
            actor: sanitizeEventActor(mutation.actor),
            correlationId: mutation.correlationId,
          });
          return { id: created.id, version: created.version };
        },
      );
    },
  };
  return repository satisfies SlackAdministrationPort;
}
