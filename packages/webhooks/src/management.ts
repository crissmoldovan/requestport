import { randomBytes } from "node:crypto";

import {
  type AuthorizedCommandContext,
  actorFingerprint,
  type CommandMeta,
  containsSensitiveContent,
  DomainError,
  type EncryptedEnvelope,
  type EnvelopeEncryption,
  keyedFingerprint,
  normalizedInputHash,
  requireOrganization,
  requireScope,
  validateCommandMeta,
} from "@requestport/domain";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import { z } from "zod";

import { deliverWebhook } from "./deliver.js";
import { resolveWebhookEndpoint } from "./endpoint-policy.js";

export type WebhookSubscriptionRecord = {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  endpointUrl: string;
  eventTypes: string[];
  projectIds: string[];
  laneIds: string[];
  requestTypes: string[];
  status: "pending_verification" | "active" | "disabled" | "revoked";
  version: number;
  currentSecretCiphertext: EncryptedEnvelope;
  currentSecretKeyId: string;
  nextSecretCiphertext: EncryptedEnvelope | null;
  nextSecretKeyId: string | null;
  overlapEndsAt: Date | null;
  verifiedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type WebhookAuditContext = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  correlationId: string;
  authorizedProjectId?: string | null;
  authorizedLaneIds?: string[];
  authorizationId?: string;
  delegatedByUserId?: string | null;
};

export type WebhookMutationReceipt = {
  actorFingerprint: string;
  commandName: string;
  idempotencyFingerprint: string;
  normalizedInputHash: string;
  expiresAt: Date;
};

export type WebhookSecretMutationResult = {
  record: WebhookSubscriptionRecord;
  secretCiphertext: EncryptedEnvelope;
  keyId: string;
  overlapEndsAt: Date | null;
  replayed: boolean;
};

export interface WebhookManagementRepository {
  canManage(organizationId: string, userId: string): Promise<boolean>;
  validateScope(input: {
    organizationId: string;
    projectId: string | null;
    projectIds: string[];
    laneIds: string[];
  }): Promise<boolean>;
  create(
    input: WebhookSubscriptionRecord,
    audit: WebhookAuditContext,
    receipt: WebhookMutationReceipt,
  ): Promise<WebhookSecretMutationResult>;
  find(
    organizationId: string,
    id: string,
    audit: WebhookAuditContext,
  ): Promise<WebhookSubscriptionRecord | null>;
  list(
    organizationId: string,
    userId: string,
  ): Promise<
    Array<
      Omit<
        WebhookSubscriptionRecord,
        "currentSecretCiphertext" | "nextSecretCiphertext"
      >
    >
  >;
  listForProject(
    organizationId: string,
    projectId: string,
    audit: WebhookAuditContext,
  ): Promise<
    Array<
      Omit<
        WebhookSubscriptionRecord,
        "currentSecretCiphertext" | "nextSecretCiphertext"
      >
    >
  >;
  markVerified(
    organizationId: string,
    id: string,
    expectedVersion: number,
    audit: WebhookAuditContext,
    receipt: WebhookMutationReceipt,
  ): Promise<{ version: number; replayed: boolean }>;
  setStatus(
    organizationId: string,
    id: string,
    expectedVersion: number,
    status: "active" | "disabled" | "revoked",
    audit: WebhookAuditContext,
    receipt: WebhookMutationReceipt,
  ): Promise<{ version: number; replayed: boolean }>;
  setNextSecret(
    input: {
      organizationId: string;
      id: string;
      expectedVersion: number;
      envelope: EncryptedEnvelope;
      signingKeyId: string;
      overlapEndsAt: Date;
    },
    audit: WebhookAuditContext,
    receipt: WebhookMutationReceipt,
  ): Promise<WebhookSecretMutationResult>;
  /**
   * Subscriptions whose secret promotion is due, across organisations: ids
   * and organisations only (Plan 13, I.2b, the dispatcher's function 12).
   */
  listDueSecretPromotions(
    limit?: number,
  ): Promise<Array<{ id: string; organizationId: string }>>;
  /**
   * One due subscription's next secret and its key id, read bound to its
   * organisation; null when it is no longer due.
   */
  loadDueSecretPromotion(
    organizationId: string,
    id: string,
  ): Promise<{
    id: string;
    organizationId: string;
    nextSecretCiphertext: EncryptedEnvelope;
    nextSecretKeyId: string;
  } | null>;
  promoteSecret(
    input: {
      organizationId: string;
      id: string;
      envelope: EncryptedEnvelope;
      expectedNextSecretKeyId: string;
    },
    audit: WebhookAuditContext,
  ): Promise<void>;
}

const createInput = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid().nullable().default(null),
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (value) => !containsSensitiveContent(value),
      "Webhook name contains private or secret material",
    ),
  endpointUrl: z.url().max(2_048),
  eventTypes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9_.-]{0,159}$/u),
    )
    .max(100)
    .default([]),
  projectIds: z.array(z.uuid()).max(100).default([]),
  laneIds: z.array(z.uuid()).max(100).default([]),
  requestTypes: z
    .array(z.enum(["feature", "bug", "question", "chore", "investigation"]))
    .max(5)
    .default([]),
});

const WEBHOOK_VERIFICATION_NAMESPACE = "eecc4cca-5a4e-4cdf-9af2-51c352dc41ee";

function aad(
  organizationId: string,
  subscriptionId: string,
  slot: "current" | "next",
) {
  return new TextEncoder().encode(
    `requestport:webhook:${organizationId}:${subscriptionId}:${slot}`,
  );
}

export function createWebhookManagementService(dependencies: {
  repository: WebhookManagementRepository;
  encryption: EnvelopeEncryption;
  fingerprintSecret: string;
  production?: boolean;
  /**
   * The operator's opt-in for private and loopback receivers
   * (`EndpointPolicyOptions`), applied where an endpoint is registered and
   * where it is verified. Off when absent.
   */
  privateReceivers?: boolean;
  createId?: () => string;
}) {
  function mutationReceipt(
    context: AuthorizedCommandContext,
    commandName: string,
    input: unknown,
    meta: CommandMeta,
  ): WebhookMutationReceipt {
    validateCommandMeta(meta);
    return {
      actorFingerprint: actorFingerprint(context.actor),
      commandName,
      idempotencyFingerprint: keyedFingerprint(
        dependencies.fingerprintSecret,
        meta.idempotencyKey,
      ),
      normalizedInputHash: normalizedInputHash(input),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    };
  }
  async function manager(
    context: AuthorizedCommandContext,
    organizationId: string,
  ) {
    requireOrganization(context, organizationId);
    requireScope(context, "webhook:manage");
    if (context.actor.type === "agent") {
      const projectId = (
        context as AuthorizedCommandContext & { projectId?: string }
      ).projectId;
      if (!projectId)
        throw new DomainError(
          "forbidden",
          "A project-bound agent grant is required",
        );
      return {
        actorType: "agent" as const,
        actorId: context.actor.id,
        projectId,
        laneIds: [...(context.laneIds ?? [])],
      };
    }
    if (
      context.actor.type !== "user" ||
      !(await dependencies.repository.canManage(
        organizationId,
        context.actor.id,
      ))
    ) {
      throw new DomainError("forbidden", "Webhook management access is denied");
    }
    return {
      actorType: "user" as const,
      actorId: context.actor.id,
      projectId: null,
      laneIds: [] as string[],
    };
  }
  function auditContext(
    access: Awaited<ReturnType<typeof manager>>,
    context: AuthorizedCommandContext,
  ): WebhookAuditContext {
    return {
      actorType: access.actorType,
      actorId: access.actorId,
      correlationId: context.correlationId,
      authorizedProjectId: access.projectId,
      authorizedLaneIds: access.laneIds,
      ...(access.actorType === "agent"
        ? {
            authorizationId: context.credentialId,
            delegatedByUserId:
              context.actor.type === "agent"
                ? (context.actor.delegatedBy?.id ?? null)
                : null,
          }
        : {}),
    };
  }
  return {
    async list(context: AuthorizedCommandContext, organizationId: string) {
      const access = await manager(context, organizationId);
      if (!access.projectId) {
        return dependencies.repository.list(organizationId, access.actorId);
      }
      const records = await dependencies.repository.listForProject(
        organizationId,
        access.projectId,
        auditContext(access, context),
      );
      if (!access.laneIds.length) return records;
      const granted = new Set(access.laneIds);
      return records.filter(
        (record) =>
          record.laneIds.length > 0 &&
          record.laneIds.every((laneId) => granted.has(laneId)),
      );
    },
    async create(
      context: AuthorizedCommandContext,
      rawInput: unknown,
      meta: CommandMeta,
    ) {
      const input = createInput.parse(rawInput);
      const receipt = mutationReceipt(
        context,
        "create_event_subscription",
        input,
        meta,
      );
      if (meta.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "A new webhook must use expected version zero",
        );
      }
      const access = await manager(context, input.organizationId);
      if (access.projectId && input.projectId !== access.projectId)
        throw new DomainError(
          "forbidden",
          "Agent webhooks must use the granted project",
        );
      const grantedLanes = new Set(access.laneIds);
      if (
        access.projectId &&
        (input.projectIds.some((id) => id !== access.projectId) ||
          (grantedLanes.size > 0 &&
            (input.laneIds.length === 0 ||
              input.laneIds.some((laneId) => !grantedLanes.has(laneId)))))
      ) {
        throw new DomainError(
          "forbidden",
          "Agent webhook filters exceed the project grant",
        );
      }
      if (!(await dependencies.repository.validateScope(input))) {
        throw new DomainError(
          "validation_failed",
          "Webhook project or lane scope is invalid",
        );
      }
      await resolveWebhookEndpoint(input.endpointUrl, {
        production: dependencies.production,
        privateReceivers: dependencies.privateReceivers,
      });
      const id = dependencies.createId?.() ?? uuidv7();
      const secret = randomBytes(32).toString("base64url");
      const signingKeyId = `whk_${randomBytes(12).toString("base64url")}`;
      const envelope = await dependencies.encryption.encrypt(
        { secret },
        aad(input.organizationId, id, "current"),
      );
      const now = new Date();
      const created = await dependencies.repository.create(
        {
          id,
          ...input,
          eventTypes: [...new Set(input.eventTypes)],
          projectIds: [...new Set(input.projectIds)],
          laneIds: [...new Set(input.laneIds)],
          requestTypes: [...new Set(input.requestTypes)],
          status: "pending_verification",
          version: 1,
          currentSecretCiphertext: envelope,
          currentSecretKeyId: signingKeyId,
          nextSecretCiphertext: null,
          nextSecretKeyId: null,
          overlapEndsAt: null,
          verifiedAt: null,
          createdBy: access.actorId,
          createdAt: now,
          updatedAt: now,
        },
        auditContext(access, context),
        receipt,
      );
      const revealed = await dependencies.encryption.decrypt<{
        secret: string;
      }>(
        created.secretCiphertext,
        aad(input.organizationId, created.record.id, "current"),
      );
      return {
        subscription: {
          ...created.record,
          currentSecretCiphertext: undefined,
          nextSecretCiphertext: undefined,
        },
        plaintextSecret: revealed.secret,
        replayed: created.replayed,
      };
    },
    async verify(
      context: AuthorizedCommandContext,
      input: { organizationId: string; id: string },
      meta: CommandMeta,
    ) {
      const receipt = mutationReceipt(
        context,
        "verify_event_subscription",
        input,
        meta,
      );
      const access = await manager(context, input.organizationId);
      const record = await dependencies.repository.find(
        input.organizationId,
        input.id,
        auditContext(access, context),
      );
      if (!record)
        throw new DomainError(
          "not_found",
          "Webhook subscription was not found",
        );
      if (access.projectId && record.projectId !== access.projectId)
        throw new DomainError("forbidden", "Webhook access is denied");
      const data = await dependencies.encryption.decrypt<{ secret: string }>(
        record.currentSecretCiphertext,
        aad(record.organizationId, record.id, "current"),
      );
      const response = await deliverWebhook({
        endpointUrl: record.endpointUrl,
        eventId: uuidv5(
          `event:${receipt.idempotencyFingerprint}`,
          WEBHOOK_VERIFICATION_NAMESPACE,
        ),
        deliveryId: uuidv5(
          `delivery:${receipt.idempotencyFingerprint}`,
          WEBHOOK_VERIFICATION_NAMESPACE,
        ),
        attempt: 1,
        schemaVersion: 1,
        keyId: record.currentSecretKeyId,
        secret: data.secret,
        payload: { type: "webhook.verification.v1", subscriptionId: record.id },
        production: dependencies.production,
        privateReceivers: dependencies.privateReceivers,
      });
      if (response.status < 200 || response.status >= 300)
        throw new DomainError(
          "validation_failed",
          "Webhook endpoint did not accept verification",
        );
      const persisted = await dependencies.repository.markVerified(
        record.organizationId,
        record.id,
        meta.expectedVersion,
        auditContext(access, context),
        receipt,
      );
      return { verified: true, ...persisted };
    },
    async rotate(
      context: AuthorizedCommandContext,
      input: { organizationId: string; id: string; overlapMinutes: number },
      meta: CommandMeta,
    ) {
      const receipt = mutationReceipt(
        context,
        "rotate_event_subscription_secret",
        input,
        meta,
      );
      const access = await manager(context, input.organizationId);
      const record = await dependencies.repository.find(
        input.organizationId,
        input.id,
        auditContext(access, context),
      );
      if (!record)
        throw new DomainError(
          "not_found",
          "Webhook subscription was not found",
        );
      if (access.projectId && record.projectId !== access.projectId)
        throw new DomainError("forbidden", "Webhook access is denied");
      const secret = randomBytes(32).toString("base64url");
      const signingKeyId = `whk_${randomBytes(12).toString("base64url")}`;
      const envelope = await dependencies.encryption.encrypt(
        { secret },
        aad(record.organizationId, record.id, "next"),
      );
      const overlapEndsAt = new Date(
        Date.now() +
          Math.min(1_440, Math.max(5, input.overlapMinutes)) * 60_000,
      );
      const persisted = await dependencies.repository.setNextSecret(
        {
          organizationId: record.organizationId,
          id: record.id,
          expectedVersion: meta.expectedVersion,
          envelope,
          signingKeyId,
          overlapEndsAt,
        },
        auditContext(access, context),
        receipt,
      );
      const revealed = await dependencies.encryption.decrypt<{
        secret: string;
      }>(
        persisted.secretCiphertext,
        aad(record.organizationId, record.id, "next"),
      );
      return {
        plaintextSecret: revealed.secret,
        keyId: persisted.keyId,
        overlapEndsAt: persisted.overlapEndsAt ?? overlapEndsAt,
        replayed: persisted.replayed,
      };
    },
    async setStatus(
      context: AuthorizedCommandContext,
      input: {
        organizationId: string;
        id: string;
        status: "active" | "disabled" | "revoked";
      },
      meta: CommandMeta,
    ) {
      const receipt = mutationReceipt(
        context,
        "set_event_subscription_status",
        input,
        meta,
      );
      const access = await manager(context, input.organizationId);
      const record = await dependencies.repository.find(
        input.organizationId,
        input.id,
        auditContext(access, context),
      );
      if (!record)
        throw new DomainError(
          "not_found",
          "Webhook subscription was not found",
        );
      if (access.projectId && record.projectId !== access.projectId)
        throw new DomainError("forbidden", "Webhook access is denied");
      if (input.status === "active" && !record.verifiedAt) {
        throw new DomainError(
          "validation_failed",
          "Verify the endpoint before enabling delivery",
        );
      }
      const persisted = await dependencies.repository.setStatus(
        input.organizationId,
        input.id,
        meta.expectedVersion,
        input.status,
        auditContext(access, context),
        receipt,
      );
      return { updated: true, ...persisted };
    },
  };
}
