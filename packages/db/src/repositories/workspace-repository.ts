import type {
  PrivateTelemetryField,
  WorkspaceRecord,
  WorkspaceRepository,
} from "@requestport/domain";
import {
  actorFingerprint,
  DomainError,
  keyedFingerprint,
  normalizedInputHash,
  validateCommandMeta,
} from "@requestport/domain";
import { and, eq, isNull, or } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentInstallations,
  agentPrincipals,
  machineWorkspaces,
  organizationMembers,
  organizations,
  projectMembers,
  projectRepositories,
  projects,
  securityAuditRecords,
} from "../schema/index.js";
import { inTenantTransaction } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";
import {
  lockMutationReceipt,
  saveMutationReceipt,
} from "./mutation-receipt.js";

type WorkspaceDatabase = Database | Tx;

type RevealWorkspaceInput = {
  organizationId: string;
  userId: string;
  workspaceId: string;
  fields: PrivateTelemetryField[];
  reason: string;
  correlationId: string;
  expectedVersion: number;
  idempotencyKey: string;
  fingerprintSecret: string;
};

function record(row: typeof machineWorkspaces.$inferSelect): WorkspaceRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    installationId: row.installationId,
    safeCapabilities: row.safeCapabilities,
    envelope: {
      ciphertext: row.privateCiphertext,
      nonce: row.privateNonce,
      wrappedDek: row.wrappedDek,
      kekVersion: row.kekVersion,
    },
    telemetrySchemaVersion: row.telemetrySchemaVersion,
    status: row.status as WorkspaceRecord["status"],
    lastSeenAt: row.lastSeenAt,
  };
}

export function createWorkspaceRepository(
  database: WorkspaceDatabase,
): WorkspaceRepository {
  return {
    async validateRegistration(input) {
      const [binding] = await database
        .select({
          installationId: agentInstallations.id,
          credentialId: agentInstallations.credentialId,
          oauthGrantId: agentInstallations.oauthGrantId,
          requiredWorkspaceFields: projects.requiredWorkspaceFields,
        })
        .from(agentInstallations)
        .innerJoin(
          organizations,
          and(
            eq(organizations.id, agentInstallations.organizationId),
            eq(organizations.status, "active"),
          ),
        )
        .innerJoin(
          agentPrincipals,
          and(
            eq(
              agentPrincipals.organizationId,
              agentInstallations.organizationId,
            ),
            eq(agentPrincipals.id, agentInstallations.agentPrincipalId),
            eq(agentPrincipals.status, "active"),
          ),
        )
        .innerJoin(
          projects,
          and(
            eq(projects.organizationId, input.organizationId),
            eq(projects.id, input.projectId),
            eq(projects.status, "active"),
          ),
        )
        .innerJoin(
          projectRepositories,
          and(
            eq(projectRepositories.organizationId, input.organizationId),
            eq(projectRepositories.projectId, input.projectId),
            eq(projectRepositories.id, input.repositoryId),
            eq(projectRepositories.status, "active"),
          ),
        )
        .where(
          and(
            eq(agentInstallations.organizationId, input.organizationId),
            eq(agentInstallations.id, input.installationId),
            eq(agentInstallations.agentPrincipalId, input.agentPrincipalId),
            eq(agentInstallations.status, "active"),
            or(
              isNull(agentPrincipals.projectId),
              eq(agentPrincipals.projectId, input.projectId),
            ),
          ),
        )
        .for("share")
        .limit(1);
      if (!binding) {
        return { allowed: false, requiredPrivateTelemetryFields: [] };
      }
      if (
        binding.credentialId !== input.authorizationId &&
        binding.oauthGrantId !== input.authorizationId
      ) {
        return { allowed: false, requiredPrivateTelemetryFields: [] };
      }
      const credential = !input.delegatedByUserId
        ? await lockActiveApiKeyAuthorization(database, {
            organizationId: input.organizationId,
            agentPrincipalId: input.agentPrincipalId,
            authorizationId: input.authorizationId,
            projectId: input.projectId,
          })
        : null;
      const grant = input.delegatedByUserId
        ? await lockActiveOAuthAuthorization(database, {
            organizationId: input.organizationId,
            agentPrincipalId: input.agentPrincipalId,
            authorizationId: input.authorizationId,
            delegatedByUserId: input.delegatedByUserId,
            projectId: input.projectId,
          })
        : null;
      return {
        allowed: Boolean(credential || grant),
        requiredPrivateTelemetryFields:
          credential || grant
            ? (binding.requiredWorkspaceFields as PrivateTelemetryField[])
            : [],
      };
    },

    async upsert(input) {
      const [saved] = await database
        .insert(machineWorkspaces)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          installationId: input.installationId,
          safeCapabilities: input.safeCapabilities,
          privateCiphertext: Buffer.from(input.envelope.ciphertext),
          privateNonce: Buffer.from(input.envelope.nonce),
          wrappedDek: Buffer.from(input.envelope.wrappedDek),
          kekVersion: input.envelope.kekVersion,
          telemetrySchemaVersion: input.telemetrySchemaVersion,
          status: input.status,
          lastSeenAt: input.lastSeenAt,
        })
        .returning();
      if (!saved) throw new Error("Workspace persistence failed");
      return record(saved);
    },

    async findById(organizationId, workspaceId) {
      const [found] = await database
        .select()
        .from(machineWorkspaces)
        .where(
          and(
            eq(machineWorkspaces.organizationId, organizationId),
            eq(machineWorkspaces.id, workspaceId),
          ),
        )
        .limit(1);
      return found ? record(found) : null;
    },

    async revealAuthorized<T>(
      input: RevealWorkspaceInput,
      reveal: (record: WorkspaceRecord) => Promise<T>,
    ) {
      validateCommandMeta(input);
      if (input.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "Workspace reveal requires expected version zero",
        );
      }
      const key = {
        actorFingerprint: actorFingerprint({ type: "user", id: input.userId }),
        commandName: "reveal_workspace_telemetry",
        idempotencyFingerprint: keyedFingerprint(
          input.fingerprintSecret,
          input.idempotencyKey,
        ),
        normalizedInputHash: normalizedInputHash({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          fields: [...input.fields].sort(),
          reason: input.reason,
        }),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      };
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const replay = await lockMutationReceipt(tx, key);
        const [candidate] = await tx
          .select({ projectId: machineWorkspaces.projectId })
          .from(machineWorkspaces)
          .where(
            and(
              eq(machineWorkspaces.organizationId, input.organizationId),
              eq(machineWorkspaces.id, input.workspaceId),
            ),
          )
          .limit(1);
        if (!candidate) {
          throw new DomainError("not_found", "Workspace was not found");
        }
        const [membership] = await tx
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
              eq(organizationMembers.userId, input.userId),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!membership) {
          throw new DomainError(
            "forbidden",
            "Workspace telemetry access is denied",
          );
        }
        if (membership.role !== "owner" && membership.role !== "admin") {
          const [projectAccess] = await tx
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.organizationId, input.organizationId),
                eq(projectMembers.projectId, candidate.projectId),
                eq(projectMembers.userId, input.userId),
                eq(projectMembers.status, "active"),
                eq(projectMembers.role, "maintainer"),
              ),
            )
            .for("share")
            .limit(1);
          if (!projectAccess) {
            throw new DomainError(
              "forbidden",
              "Workspace telemetry access is denied",
            );
          }
        }
        const [workspace] = await tx
          .select()
          .from(machineWorkspaces)
          .where(
            and(
              eq(machineWorkspaces.organizationId, input.organizationId),
              eq(machineWorkspaces.id, input.workspaceId),
              eq(machineWorkspaces.projectId, candidate.projectId),
            ),
          )
          .for("share")
          .limit(1);
        if (!workspace) {
          throw new DomainError("not_found", "Workspace was not found");
        }
        const value = await reveal(record(workspace));
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.userId,
          action: "workspace.telemetry_revealed.v1",
          targetType: "machine_workspace",
          targetId: input.workspaceId,
          reason: input.reason,
          fieldNames: input.fields,
          correlationId: input.correlationId,
        });
        if (!replay) {
          await saveMutationReceipt(tx, key, {
            aggregateId: input.workspaceId,
            result: { revealed: true },
          });
        }
        return { value, replayed: Boolean(replay) };
      });
    },
  };
}
