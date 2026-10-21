import type { RewrapRepository } from "@requestport/domain";
import { and, asc, count, eq, gt, ne } from "drizzle-orm";

import type { Database } from "../client.js";
import { machineWorkspaces, securityAuditRecords } from "../schema/index.js";

export function createWorkspaceKeyRepository(database: Database) {
  return {
    async listBatch(fromVersion, afterId, limit) {
      const rows = await database
        .select()
        .from(machineWorkspaces)
        .where(
          and(
            eq(machineWorkspaces.kekVersion, fromVersion),
            ...(afterId ? [gt(machineWorkspaces.id, afterId)] : []),
          ),
        )
        .orderBy(asc(machineWorkspaces.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        telemetrySchemaVersion: row.telemetrySchemaVersion,
        envelope: {
          ciphertext: row.privateCiphertext,
          nonce: row.privateNonce,
          wrappedDek: row.wrappedDek,
          kekVersion: row.kekVersion,
        },
      }));
    },
    async replaceWrappedKey(input) {
      const [updated] = await database
        .update(machineWorkspaces)
        .set({
          wrappedDek: Buffer.from(input.envelope.wrappedDek),
          kekVersion: input.envelope.kekVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(machineWorkspaces.id, input.id),
            eq(machineWorkspaces.kekVersion, input.fromVersion),
          ),
        )
        .returning({ id: machineWorkspaces.id });
      return Boolean(updated);
    },
    async quarantine(input) {
      await database.transaction(async (tx) => {
        const [row] = await tx
          .update(machineWorkspaces)
          .set({ status: "inactive", updatedAt: new Date() })
          .where(eq(machineWorkspaces.id, input.id))
          .returning({ organizationId: machineWorkspaces.organizationId });
        if (row)
          await tx.insert(securityAuditRecords).values({
            organizationId: row.organizationId,
            actorType: "service",
            actorId: "cli:telemetry-rewrap",
            action: "workspace.telemetry_quarantined",
            targetType: "machine_workspace",
            targetId: input.id,
            reason: input.reason,
            fieldNames: ["status", "kekVersion"],
            correlationId: `rewrap:${input.id}`,
          });
      });
    },
    async countVersion(version) {
      const [row] = await database
        .select({ value: count() })
        .from(machineWorkspaces)
        .where(eq(machineWorkspaces.kekVersion, version));
      return row?.value ?? 0;
    },
    async countOtherVersions(version: string) {
      const [row] = await database
        .select({ value: count() })
        .from(machineWorkspaces)
        .where(ne(machineWorkspaces.kekVersion, version));
      return row?.value ?? 0;
    },
  } satisfies RewrapRepository & {
    countOtherVersions(version: string): Promise<number>;
  };
}
