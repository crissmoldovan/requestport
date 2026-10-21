import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

import type { EnvelopeEncryption } from "../security/envelope-encryption.js";
import type { AuthorizedCommandContext } from "../shared/authorization.js";
import {
  requireAgentProject,
  requireOrganization,
  requireScope,
} from "../shared/authorization.js";
import { DomainError } from "../shared/errors.js";
import {
  type PrivateTelemetryField,
  type PrivateWorkspaceTelemetry,
  privateTelemetryFields,
  rejectProhibitedTelemetry,
  type SafeWorkspaceProjection,
  type WorkspaceRecord,
  type WorkspaceRepository,
  workspaceRegistrationSchema,
} from "./workspace-types.js";

export function workspaceAad(input: {
  organizationId: string;
  workspaceId: string;
  telemetrySchemaVersion: number;
}) {
  return new TextEncoder().encode(
    `requestport:workspace:${input.organizationId}:${input.workspaceId}:v${input.telemetrySchemaVersion}`,
  );
}

function safeProjection(record: WorkspaceRecord): SafeWorkspaceProjection {
  const { envelope: _privateEnvelope, ...safe } = record;
  return safe;
}

export class WorkspaceService {
  constructor(
    private readonly dependencies: {
      repository: WorkspaceRepository;
      encryption: EnvelopeEncryption;
      createId?: () => string;
      now?: () => Date;
      fingerprintSecret?: string;
    },
  ) {}

  async register(context: AuthorizedCommandContext, rawInput: unknown) {
    requireScope(context, "agent:register");
    const input = workspaceRegistrationSchema.parse(rawInput);
    requireOrganization(context, input.organizationId);
    if (context.actor.type !== "agent") {
      throw new DomainError("forbidden", "An agent identity is required");
    }
    requireAgentProject(context, input.projectId);
    rejectProhibitedTelemetry(rawInput);
    const registration =
      await this.dependencies.repository.validateRegistration({
        organizationId: input.organizationId,
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        installationId: input.installationId,
        agentPrincipalId: context.actor.id,
        authorizationId: context.credentialId,
        delegatedByUserId: context.actor.delegatedBy?.id ?? null,
      });
    if (!registration.allowed) {
      throw new DomainError("forbidden", "Workspace binding is not allowed");
    }
    const missingRequired = registration.requiredPrivateTelemetryFields.filter(
      (field) => input.privateTelemetry[field] === undefined,
    );
    if (missingRequired.length > 0) {
      throw new DomainError(
        "validation_failed",
        "Project policy requires additional workspace telemetry",
        { fields: missingRequired },
      );
    }
    const id = this.dependencies.createId?.() ?? uuidv7();
    const envelope = await this.dependencies.encryption.encrypt(
      input.privateTelemetry,
      workspaceAad({
        organizationId: input.organizationId,
        workspaceId: id,
        telemetrySchemaVersion: input.telemetrySchemaVersion,
      }),
    );
    const now = this.dependencies.now?.() ?? new Date();
    const record = await this.dependencies.repository.upsert({
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      installationId: input.installationId,
      safeCapabilities: input.safeCapabilities,
      envelope,
      telemetrySchemaVersion: input.telemetrySchemaVersion,
      status: "active",
      lastSeenAt: now,
    });
    return safeProjection(record);
  }

  async getSafeProjection(organizationId: string, workspaceId: string) {
    const record = await this.dependencies.repository.findById(
      organizationId,
      workspaceId,
    );
    return record ? safeProjection(record) : null;
  }

  async revealPrivateProjection(
    context: AuthorizedCommandContext,
    rawInput: unknown,
  ) {
    const input = z
      .object({
        organizationId: z.uuid(),
        workspaceId: z.uuid(),
        fields: z.array(z.enum(privateTelemetryFields)).min(1).max(9),
        reason: z.string().trim().min(10).max(500),
        expectedVersion: z.number().int().nonnegative(),
        idempotencyKey: z.string().trim().min(16).max(200),
      })
      .parse(rawInput);
    requireOrganization(context, input.organizationId);
    requireScope(context, "workspace:telemetry:reveal");
    if (context.actor.type !== "user") {
      throw new DomainError("forbidden", "A human maintainer is required");
    }
    if (!this.dependencies.fingerprintSecret) {
      throw new DomainError(
        "configuration_error",
        "Workspace reveal receipt signing is unavailable",
      );
    }
    const fields = [...new Set(input.fields)].sort() as PrivateTelemetryField[];
    const revealed = await this.dependencies.repository.revealAuthorized(
      {
        organizationId: input.organizationId,
        userId: context.actor.id,
        workspaceId: input.workspaceId,
        fields,
        reason: input.reason,
        correlationId: context.correlationId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: this.dependencies.fingerprintSecret,
      },
      async (record) => {
        const privateData =
          await this.dependencies.encryption.decrypt<PrivateWorkspaceTelemetry>(
            record.envelope,
            workspaceAad({
              organizationId: record.organizationId,
              workspaceId: record.id,
              telemetrySchemaVersion: record.telemetrySchemaVersion,
            }),
          );
        return Object.fromEntries(
          fields
            .filter((field) => privateData[field] !== undefined)
            .map((field) => [field, privateData[field]]),
        );
      },
    );
    return { data: revealed.value, cacheControl: "no-store" as const };
  }
}
