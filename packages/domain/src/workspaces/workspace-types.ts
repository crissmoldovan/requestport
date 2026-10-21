import { z } from "zod";

import type { EncryptedEnvelope } from "../security/envelope-encryption.js";
import { containsSecretContent } from "../security/sensitive-content.js";
import { DomainError } from "../shared/errors.js";

const safeCapabilityName = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/u);

export const privateTelemetryFields = [
  "hostname",
  "fqdn",
  "osUser",
  "workingDirectory",
  "repositoryRoot",
  "branch",
  "commitSha",
  "operatingSystem",
  "toolVersions",
] as const;

export type PrivateTelemetryField = (typeof privateTelemetryFields)[number];

export const privateWorkspaceTelemetrySchema = z
  .object({
    hostname: z.string().trim().min(1).max(253).optional(),
    fqdn: z.string().trim().min(1).max(253).optional(),
    osUser: z.string().trim().min(1).max(256).optional(),
    workingDirectory: z.string().trim().min(1).max(4_096).optional(),
    repositoryRoot: z.string().trim().min(1).max(4_096).optional(),
    branch: z.string().trim().min(1).max(1_024).optional(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/u)
      .optional(),
    operatingSystem: z.string().trim().min(1).max(1_024).optional(),
    toolVersions: z
      .record(z.string().max(128), z.string().max(256))
      .refine((value) => Object.keys(value).length <= 128, {
        message: "At most 128 tool versions may be reported",
      })
      .optional(),
  })
  .strict();

export type PrivateWorkspaceTelemetry = z.infer<
  typeof privateWorkspaceTelemetrySchema
>;

export const workspaceRegistrationSchema = z
  .object({
    organizationId: z.uuid(),
    projectId: z.uuid(),
    repositoryId: z.uuid(),
    installationId: z.uuid(),
    safeCapabilities: z
      .record(safeCapabilityName, z.boolean())
      .refine((value) => Object.keys(value).length <= 128, {
        message: "At most 128 capabilities may be registered",
      })
      .default({}),
    privateTelemetry: privateWorkspaceTelemetrySchema,
    telemetrySchemaVersion: z.number().int().min(1).max(100).default(1),
  })
  .strict();

const prohibitedName =
  /(?:^|[_-])(authorization|cookie|environment|password|private[_-]?key|refresh[_-]?token|secret|ssh[_-]?key|token|api[_-]?key)(?:$|[_-])/iu;

export function rejectProhibitedTelemetry(value: unknown, path = "telemetry") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectProhibitedTelemetry(entry, `${path}.${index}`);
    });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (prohibitedName.test(key)) {
      throw new DomainError(
        "validation_failed",
        "Prohibited telemetry was rejected",
        {
          field: path,
        },
      );
    }
    if (
      typeof entry === "string" &&
      (/(?:https?|ssh):\/\/[^/\s]*:[^@/\s]+@/iu.test(entry) ||
        containsSecretContent(entry))
    ) {
      throw new DomainError(
        "validation_failed",
        "Credential-bearing URL was rejected",
        {
          field: path,
        },
      );
    }
    rejectProhibitedTelemetry(entry, `${path}.${key}`);
  }
}

export type WorkspaceRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  repositoryId: string;
  installationId: string;
  safeCapabilities: Record<string, boolean>;
  envelope: EncryptedEnvelope;
  telemetrySchemaVersion: number;
  status: "active" | "inactive" | "revoked";
  lastSeenAt: Date;
};

export type SafeWorkspaceProjection = Omit<WorkspaceRecord, "envelope">;

export interface WorkspaceRepository {
  validateRegistration(input: {
    organizationId: string;
    projectId: string;
    repositoryId: string;
    installationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId?: string | null;
  }): Promise<{
    allowed: boolean;
    requiredPrivateTelemetryFields: PrivateTelemetryField[];
  }>;
  upsert(input: WorkspaceRecord): Promise<WorkspaceRecord>;
  findById(
    organizationId: string,
    workspaceId: string,
  ): Promise<WorkspaceRecord | null>;
  revealAuthorized<T>(
    input: {
      organizationId: string;
      userId: string;
      workspaceId: string;
      fields: string[];
      reason: string;
      correlationId: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    },
    reveal: (record: WorkspaceRecord) => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }>;
}
