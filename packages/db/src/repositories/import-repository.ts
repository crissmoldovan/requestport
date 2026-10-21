import { createHash, randomUUID } from "node:crypto";

import {
  type ActorRef,
  actorFingerprint,
  auditActor,
  canonicalJson,
  DomainError,
  hasControlCharacters,
  type ImportReviewMutation,
  type ImportReviewTarget,
  keyedFingerprint,
  normalizedInputHash,
  type ReviewImportEntryInput,
  validateCommandMeta,
} from "@requestport/domain";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentPrincipals,
  importApplyReports,
  importConflicts,
  importEntryApplications,
  importManifestEntries,
  importRuns,
  importSources,
  importTaskDispatches,
  legacyAliases,
  legacyMappings,
  organizationMembers,
  organizations,
  projectRepositories,
  projects,
  requests,
  securityAuditRecords,
  sourceArtifacts,
  sourceSnapshots,
} from "../schema/index.js";
import { withTenant } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
} from "./agent-authorization.js";
import {
  lockMutationReceipt,
  saveMutationReceipt,
} from "./mutation-receipt.js";
import {
  type ClaimLease,
  type ClaimSettlement,
  type ClaimStanding,
  claimBound,
  isClaimUuid,
  settlementHolds,
  standingOf,
} from "./outbox-repository.js";

type ImportDatabase = Database | Tx;

const MAX_IMPORT_ARTIFACTS = 5_000;
const MAX_IMPORT_BYTES = 100 * 1_024 * 1_024;

function assertArtifactBatchBounds(
  artifacts: Array<{
    relativePath: string;
    mediaType?: string;
    byteSize: number;
    sha256?: string;
    exactBytes?: Buffer;
  }>,
) {
  if (
    artifacts.length > MAX_IMPORT_ARTIFACTS ||
    new Set(artifacts.map((artifact) => artifact.relativePath)).size !==
      artifacts.length ||
    artifacts.reduce((total, artifact) => total + artifact.byteSize, 0) >
      MAX_IMPORT_BYTES
  ) {
    throw new DomainError(
      "validation_failed",
      "Import capture exceeds its artifact bounds",
    );
  }
  for (const artifact of artifacts) {
    if (
      !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/+ -]+$/u.test(
        artifact.relativePath,
      ) ||
      artifact.relativePath.length > 2_048 ||
      (artifact.mediaType !== undefined &&
        !["text/markdown", "text/plain"].includes(artifact.mediaType)) ||
      artifact.byteSize < 0 ||
      artifact.byteSize > 1_048_576
    ) {
      throw new DomainError(
        "validation_failed",
        "Import artifact metadata is invalid",
      );
    }
    if (artifact.exactBytes) {
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(
          artifact.exactBytes,
        );
      } catch {
        throw new DomainError(
          "validation_failed",
          "Import artifact must contain UTF-8 text",
        );
      }
      if (
        artifact.exactBytes.byteLength !== artifact.byteSize ||
        decoded.includes("\u0000") ||
        !artifact.sha256 ||
        createHash("sha256").update(artifact.exactBytes).digest("hex") !==
          artifact.sha256
      ) {
        throw new DomainError(
          "validation_failed",
          "Import artifact bytes do not match their metadata",
        );
      }
    }
  }
}

export type ImportTaskActor =
  | { type: "user"; id: string }
  | {
      type: "agent";
      id: string;
      authorizationId: string;
      delegatedByUserId: string | null;
      projectId: string;
    };

export type ImportTaskPayload =
  | { kind: "analyze"; runId: string }
  | {
      kind: "apply";
      organizationId: string;
      runId: string;
      manifestSha256: string;
      actor: ImportTaskActor;
    };

/** One record of a manual split, as the split's caller parsed it. */
export type ImportSplitSegment = {
  proposedKind: string;
  parsedJson: Record<string, unknown>;
  confidenceJson: Record<string, number>;
};

type ImportMutationMeta = {
  expectedVersion: number;
  idempotencyKey: string;
  fingerprintSecret: string;
};

type ImportMutationContext = ImportMutationMeta & {
  actorType: "user" | "agent";
  actorId: string;
};

function importMutationReceipt(
  context: ImportMutationContext,
  commandName: string,
  input: unknown,
) {
  return importActorReceipt(
    { type: context.actorType, id: context.actorId },
    context,
    commandName,
    input,
  );
}

/**
 * A receipt keyed by the whole `actor`. The split (Plan 13, F.2.6) is keyed
 * this way: an operator's receipt carries its own `service` actor and member
 * origin and never meets its member's, and a person's is keyed exactly as
 * `importMutationReceipt` keys a `user`.
 */
function importActorReceipt(
  actor: ActorRef,
  context: ImportMutationMeta,
  commandName: string,
  input: unknown,
) {
  validateCommandMeta(context);
  return {
    actorFingerprint: actorFingerprint(actor),
    commandName,
    idempotencyFingerprint: keyedFingerprint(
      context.fingerprintSecret,
      context.idempotencyKey,
    ),
    normalizedInputHash: normalizedInputHash(input),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  };
}

async function enqueueImportTask(
  database: ImportDatabase,
  input: {
    organizationId: string;
    runId: string;
    taskKind: "analyze" | "apply";
    taskPayload: ImportTaskPayload;
  },
) {
  const [dispatch] = await database
    .insert(importTaskDispatches)
    .values({
      organizationId: input.organizationId,
      importRunId: input.runId,
      taskKind: input.taskKind,
      taskPayload: input.taskPayload,
    })
    .onConflictDoNothing({
      target: [importTaskDispatches.importRunId, importTaskDispatches.taskKind],
    })
    .returning({ id: importTaskDispatches.id });
  if (dispatch) return dispatch.id;
  const [existing] = await database
    .select({ id: importTaskDispatches.id })
    .from(importTaskDispatches)
    .where(
      and(
        eq(importTaskDispatches.organizationId, input.organizationId),
        eq(importTaskDispatches.importRunId, input.runId),
        eq(importTaskDispatches.taskKind, input.taskKind),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Import task dispatch persistence failed");
  return existing.id;
}

function validateImportRepositoryUrl(value: string | null) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || hasControlCharacters(trimmed)) {
    throw new DomainError(
      "validation_failed",
      "Import repository URL is invalid",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DomainError(
      "validation_failed",
      "Import repository URL is invalid",
    );
  }
  const rawAuthority = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/iu.exec(trimmed)?.[1];
  if (
    !["https:", "http:", "ssh:", "git:"].includes(parsed.protocol) ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    rawAuthority?.includes("@") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new DomainError(
      "validation_failed",
      "Import repository URL must be credential-free",
    );
  }
  return trimmed;
}

async function requireImportProjectReference(
  database: ImportDatabase,
  input: {
    organizationId: string;
    projectId: string;
    repositoryId: string | null;
  },
) {
  const [project] = await database
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        eq(projects.id, input.projectId),
        eq(projects.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!project)
    throw new DomainError("not_found", "Import project was not found");
  if (!input.repositoryId) return;
  const [repository] = await database
    .select({ id: projectRepositories.id })
    .from(projectRepositories)
    .where(
      and(
        eq(projectRepositories.organizationId, input.organizationId),
        eq(projectRepositories.projectId, input.projectId),
        eq(projectRepositories.id, input.repositoryId),
        eq(projectRepositories.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!repository) {
    throw new DomainError(
      "validation_failed",
      "Import repository reference is unavailable",
    );
  }
}

export type AgentImportAuthorization = {
  organizationId: string;
  projectId: string;
  agentPrincipalId: string;
  authorizationId: string;
  delegatedByUserId: string | null;
};

async function requireAgentImportAuthorization(
  database: ImportDatabase,
  input: AgentImportAuthorization,
) {
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
        eq(projects.id, input.projectId),
        eq(projects.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentPrincipals.organizationId, input.organizationId),
        eq(agentPrincipals.id, input.agentPrincipalId),
        eq(agentPrincipals.status, "active"),
        or(
          isNull(agentPrincipals.projectId),
          eq(agentPrincipals.projectId, input.projectId),
        ),
      ),
    )
    .for("share")
    .limit(1);
  if (!principal) {
    throw new DomainError("forbidden", "Import authorization is inactive");
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
  const authorization = credential ?? grant;
  if (
    !authorization ||
    authorization.laneIds.length > 0 ||
    !authorization.scopes.includes("import:write")
  ) {
    throw new DomainError(
      "forbidden",
      "Imports require an active project-wide import authorization",
    );
  }
  return {
    laneIds: [...authorization.laneIds],
    scopes: [...authorization.scopes],
  };
}

async function loadImportDetail(
  database: ImportDatabase,
  organizationId: string,
  runId: string,
) {
  const [run] = await database
    .select({
      run: importRuns,
      source: importSources,
      snapshot: sourceSnapshots,
    })
    .from(importRuns)
    .innerJoin(importSources, eq(importSources.id, importRuns.importSourceId))
    .innerJoin(
      sourceSnapshots,
      eq(sourceSnapshots.id, importRuns.sourceSnapshotId),
    )
    .where(
      and(
        eq(importRuns.organizationId, organizationId),
        eq(importRuns.id, runId),
      ),
    )
    .limit(1);
  if (!run) return null;
  const entries = await database
    .select({ entry: importManifestEntries, artifact: sourceArtifacts })
    .from(importManifestEntries)
    .innerJoin(
      sourceArtifacts,
      eq(sourceArtifacts.id, importManifestEntries.sourceArtifactId),
    )
    .where(eq(importManifestEntries.importRunId, runId))
    .orderBy(
      asc(sourceArtifacts.relativePath),
      asc(importManifestEntries.recordIndex),
    );
  const conflicts = await database
    .select()
    .from(importConflicts)
    .where(eq(importConflicts.importRunId, runId))
    .orderBy(asc(importConflicts.severity), asc(importConflicts.kind));
  const [report] = await database
    .select()
    .from(importApplyReports)
    .where(eq(importApplyReports.importRunId, runId))
    .limit(1);
  return { ...run, entries, conflicts, report: report ?? null };
}

async function manager(
  database: ImportDatabase,
  organizationId: string,
  userId: string,
  lock = false,
) {
  let query = database
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMembers.organizationId),
    )
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);
  if (lock) query = query.for("share") as typeof query;
  const [row] = await query;
  return row?.role === "owner" || row?.role === "admin";
}

/**
 * Refuses anyone but an active owner or admin of the active organisation,
 * locking the membership and the organisation `FOR SHARE` until the
 * transaction ends.
 */
export async function requireImportManager(
  database: ImportDatabase,
  organizationId: string,
  userId: string,
) {
  if (!(await manager(database, organizationId, userId, true))) {
    throw new DomainError("forbidden", "Import management access is denied");
  }
}

export function createImportRepository(database: ImportDatabase) {
  /**
   * The web opens its own transactions and hands them here (manifest-i2.md
   * §2.3 item 5), so the fourteen methods here that those transactions call
   * each bind the transaction they are handed to the organisation their
   * input names, through this: the first call binds, and each later one
   * repeats the same binding, which is idempotent and refused for another
   * organisation. track-i2.md §6 counted sixteen; since F.2.6, `splitEntry`
   * and `reviewEntry` live in `createImportReviewCommandRepository` below
   * and bind there (ruling 14). Handed the pool, it wraps as every pool read
   * does (`withTenant`): off until the application variable is set. The
   * other methods here bind nothing; the worker's among them are I.2b's.
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: ImportDatabase) => Promise<T>,
    readOnly = false,
  ) => withTenant(organizationId, work, { database, readOnly });

  return {
    canManage(organizationId: string, userId: string) {
      return manager(database, organizationId, userId);
    },

    requireAgentAccess(input: AgentImportAuthorization) {
      return forOrganization(input.organizationId, async (database) => {
        return requireAgentImportAuthorization(database, input);
      });
    },

    requireManagerAccess(organizationId: string, userId: string) {
      return forOrganization(organizationId, async (database) => {
        return requireImportManager(database, organizationId, userId);
      });
    },

    async beginCapture(input: {
      organizationId: string;
      projectId: string;
      actorId: string;
      actorType: "user" | "agent";
      repositoryUrl: string | null;
      repositoryId: string | null;
      gitCommitSha: string | null;
      dirty: boolean;
      manifestSha256: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const receipt = importMutationReceipt(input, "begin_import_capture", {
          projectId: input.projectId,
          repositoryUrl: input.repositoryUrl,
          repositoryId: input.repositoryId,
          gitCommitSha: input.gitCommitSha,
          dirty: input.dirty,
          manifestSha256: input.manifestSha256,
        });
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const repositoryUrl = validateImportRepositoryUrl(input.repositoryUrl);
        await requireImportProjectReference(database, input);
        if (
          input.actorType === "user" &&
          !(await manager(database, input.organizationId, input.actorId))
        )
          throw new DomainError(
            "forbidden",
            "Import management access is denied",
          );
        if (replay)
          return replay.result as {
            sourceId: string;
            snapshotId: string;
            version: number;
          };
        if (input.expectedVersion !== 0)
          throw new DomainError(
            "version_conflict",
            "A new import capture must use expected version zero",
          );
        const [source] = await database
          .insert(importSources)
          .values({
            organizationId: input.organizationId,
            projectId: input.projectId,
            repositoryUrl,
            repositoryId: input.repositoryId,
            createdBy: `${input.actorType}:${input.actorId}`,
          })
          .returning();
        if (!source) throw new Error("Import source persistence failed");
        const [snapshot] = await database
          .insert(sourceSnapshots)
          .values({
            organizationId: input.organizationId,
            importSourceId: source.id,
            gitCommitSha: input.gitCommitSha,
            dirty: input.dirty,
            manifestSha256: input.manifestSha256,
            status: "capturing",
          })
          .returning();
        if (!snapshot) throw new Error("Import snapshot persistence failed");
        const result = {
          sourceId: source.id,
          snapshotId: snapshot.id,
          version: snapshot.version,
        };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: snapshot.id,
          result,
        });
        return result;
      });
    },

    async appendCaptureArtifacts(input: {
      organizationId: string;
      projectId: string;
      sourceId: string;
      snapshotId: string;
      artifacts: Array<{
        relativePath: string;
        mediaType: string;
        byteSize: number;
        sha256: string;
        exactBytes: Buffer;
        secretScanStatus: "clear" | "blocked";
      }>;
      actorId: string;
      actorType: "user" | "agent";
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        assertArtifactBatchBounds(input.artifacts);
        if (
          input.artifacts.some(
            (artifact) => artifact.secretScanStatus === "blocked",
          )
        ) {
          throw new DomainError(
            "validation_failed",
            "Import artifact contains a prohibited secret candidate",
          );
        }
        const receipt = importMutationReceipt(input, "append_import_capture", {
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          artifacts: input.artifacts.map(
            ({
              relativePath,
              mediaType,
              byteSize,
              sha256,
              secretScanStatus,
            }) => ({
              relativePath,
              mediaType,
              byteSize,
              sha256,
              secretScanStatus,
            }),
          ),
        });
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const [capture] = await database
          .select({ id: sourceSnapshots.id, version: sourceSnapshots.version })
          .from(sourceSnapshots)
          .innerJoin(
            importSources,
            and(
              eq(importSources.id, sourceSnapshots.importSourceId),
              eq(importSources.organizationId, sourceSnapshots.organizationId),
            ),
          )
          .where(
            and(
              eq(sourceSnapshots.organizationId, input.organizationId),
              eq(sourceSnapshots.id, input.snapshotId),
              eq(sourceSnapshots.importSourceId, input.sourceId),
              eq(sourceSnapshots.status, "capturing"),
              eq(importSources.projectId, input.projectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!capture)
          throw new DomainError(
            "not_found",
            "Open import capture was not found",
          );
        if (replay)
          return replay.result as { accepted: number; version: number };
        if (capture.version !== input.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Import capture changed concurrently",
          );
        const totals = await database.execute<{
          artifact_count: number;
          total_bytes: number;
        }>(sql`
        select count(*)::integer as artifact_count,
          coalesce(sum(byte_size), 0)::bigint as total_bytes
        from ${sourceArtifacts}
        where ${sourceArtifacts.importSourceId} = ${input.sourceId}
          and ${sourceArtifacts.sourceSnapshotId} = ${input.snapshotId}
      `);
        const current = totals.rows[0];
        if (
          Number(current?.artifact_count ?? 0) + input.artifacts.length >
            MAX_IMPORT_ARTIFACTS ||
          Number(current?.total_bytes ?? 0) +
            input.artifacts.reduce(
              (total, artifact) => total + artifact.byteSize,
              0,
            ) >
            MAX_IMPORT_BYTES
        ) {
          throw new DomainError(
            "validation_failed",
            "Import capture exceeds its cumulative artifact bounds",
          );
        }
        const rows = input.artifacts.length
          ? await database
              .insert(sourceArtifacts)
              .values(
                input.artifacts.map((artifact) => ({
                  ...artifact,
                  organizationId: input.organizationId,
                  importSourceId: input.sourceId,
                  sourceSnapshotId: input.snapshotId,
                })),
              )
              .onConflictDoNothing()
              .returning({
                id: sourceArtifacts.id,
                relativePath: sourceArtifacts.relativePath,
              })
          : [];
        const [updated] = await database
          .update(sourceSnapshots)
          .set({ version: input.expectedVersion + 1 })
          .where(
            and(
              eq(sourceSnapshots.id, input.snapshotId),
              eq(sourceSnapshots.version, input.expectedVersion),
            ),
          )
          .returning({ version: sourceSnapshots.version });
        if (!updated)
          throw new DomainError(
            "version_conflict",
            "Import capture changed concurrently",
          );
        const result = { accepted: rows.length, version: updated.version };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: input.snapshotId,
          result,
        });
        return result;
      });
    },

    async finalizeCapture(input: {
      organizationId: string;
      projectId: string;
      sourceId: string;
      snapshotId: string;
      actorId: string;
      actorType: "user" | "agent";
      correlationId: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const receipt = importMutationReceipt(
          input,
          "finalize_import_capture",
          {
            sourceId: input.sourceId,
            snapshotId: input.snapshotId,
          },
        );
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const [capture] = await database
          .select({ snapshot: sourceSnapshots, source: importSources })
          .from(sourceSnapshots)
          .innerJoin(
            importSources,
            eq(importSources.id, sourceSnapshots.importSourceId),
          )
          .where(
            and(
              eq(sourceSnapshots.organizationId, input.organizationId),
              eq(sourceSnapshots.id, input.snapshotId),
              eq(sourceSnapshots.importSourceId, input.sourceId),
              eq(importSources.projectId, input.projectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!capture)
          throw new DomainError(
            "not_found",
            "Open import capture was not found",
          );
        if (replay)
          return replay.result as {
            sourceId: string;
            snapshotId: string;
            status: string;
            artifacts: number;
            version: number;
          };
        if (
          capture.snapshot.status !== "capturing" ||
          capture.snapshot.version !== input.expectedVersion
        )
          throw new DomainError(
            "version_conflict",
            "Import capture changed concurrently",
          );
        const artifacts = await database
          .select({
            relativePath: sourceArtifacts.relativePath,
            mediaType: sourceArtifacts.mediaType,
            byteSize: sourceArtifacts.byteSize,
            sha256: sourceArtifacts.sha256,
            secretScanStatus: sourceArtifacts.secretScanStatus,
          })
          .from(sourceArtifacts)
          .where(
            and(
              eq(sourceArtifacts.importSourceId, input.sourceId),
              eq(sourceArtifacts.sourceSnapshotId, input.snapshotId),
            ),
          )
          .orderBy(asc(sourceArtifacts.relativePath));
        if (!artifacts.length)
          throw new DomainError(
            "validation_failed",
            "Import capture has no artifacts",
          );
        const actual = createHash("sha256")
          .update(
            canonicalJson({
              repositoryUrl: capture.source.repositoryUrl,
              repositoryId: capture.source.repositoryId,
              gitCommitSha: capture.snapshot.gitCommitSha,
              dirty: capture.snapshot.dirty,
              artifacts,
            }),
          )
          .digest("hex");
        if (actual !== capture.snapshot.manifestSha256)
          throw new DomainError(
            "validation_failed",
            "Import capture manifest hash does not match",
          );
        const status = artifacts.some(
          (artifact) => artifact.secretScanStatus === "blocked",
        )
          ? "blocked"
          : "captured";
        const [updated] = await database
          .update(sourceSnapshots)
          .set({ status, version: input.expectedVersion + 1 })
          .where(
            and(
              eq(sourceSnapshots.id, input.snapshotId),
              eq(sourceSnapshots.status, "capturing"),
              eq(sourceSnapshots.version, input.expectedVersion),
            ),
          )
          .returning({ version: sourceSnapshots.version });
        if (!updated)
          throw new DomainError(
            "version_conflict",
            "Import capture changed concurrently",
          );
        await database.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: input.actorType,
          actorId: input.actorId,
          action: "import.snapshot_captured",
          targetType: "source_snapshot",
          targetId: input.snapshotId,
          reason: "Legacy source bytes captured before parsing",
          fieldNames: [
            "projectId",
            "gitCommitSha",
            "dirty",
            "manifestSha256",
            "artifactCount",
          ],
          correlationId: input.correlationId,
        });
        const result = {
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          status,
          artifacts: artifacts.length,
          version: updated.version,
        };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: input.snapshotId,
          result,
        });
        return result;
      });
    },

    async capture(input: {
      organizationId: string;
      projectId: string;
      actorId: string;
      actorType: "user" | "agent";
      repositoryUrl: string | null;
      repositoryId: string | null;
      gitCommitSha: string | null;
      dirty: boolean;
      manifestSha256: string;
      artifacts: Array<{
        relativePath: string;
        mediaType: string;
        byteSize: number;
        sha256: string;
        exactBytes: Buffer;
        secretScanStatus: "clear" | "blocked";
      }>;
      correlationId: string;
    }) {
      assertArtifactBatchBounds(input.artifacts);
      if (!input.artifacts.length) {
        throw new DomainError(
          "validation_failed",
          "Import capture has no artifacts",
        );
      }
      if (
        input.artifacts.some(
          (artifact) => artifact.secretScanStatus === "blocked",
        )
      ) {
        throw new DomainError(
          "validation_failed",
          "Import artifact contains a prohibited secret candidate",
        );
      }
      const artifactManifest = input.artifacts
        .map(
          ({
            relativePath,
            mediaType,
            byteSize,
            sha256,
            secretScanStatus,
          }) => ({
            relativePath,
            mediaType,
            byteSize,
            sha256,
            secretScanStatus,
          }),
        )
        .sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath, "en"),
        );
      const actualManifestSha256 = createHash("sha256")
        .update(
          canonicalJson({
            repositoryUrl: input.repositoryUrl,
            repositoryId: input.repositoryId,
            gitCommitSha: input.gitCommitSha,
            dirty: input.dirty,
            artifacts: artifactManifest,
          }),
        )
        .digest("hex");
      if (actualManifestSha256 !== input.manifestSha256) {
        throw new DomainError(
          "validation_failed",
          "Import capture manifest hash does not match",
        );
      }
      const repositoryUrl = validateImportRepositoryUrl(input.repositoryUrl);
      await requireImportProjectReference(database, input);
      if (
        input.actorType === "user" &&
        !(await manager(database, input.organizationId, input.actorId))
      )
        throw new DomainError(
          "forbidden",
          "Import management access is denied",
        );
      const [source] = await database
        .insert(importSources)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          repositoryUrl,
          repositoryId: input.repositoryId,
          createdBy: `${input.actorType}:${input.actorId}`,
        })
        .returning();
      if (!source) throw new Error("Import source persistence failed");
      const [snapshot] = await database
        .insert(sourceSnapshots)
        .values({
          organizationId: input.organizationId,
          importSourceId: source.id,
          gitCommitSha: input.gitCommitSha,
          dirty: input.dirty,
          manifestSha256: input.manifestSha256,
          status: "captured",
        })
        .returning();
      if (!snapshot) throw new Error("Import snapshot persistence failed");
      const artifacts = input.artifacts.length
        ? await database
            .insert(sourceArtifacts)
            .values(
              input.artifacts.map((artifact) => ({
                ...artifact,
                organizationId: input.organizationId,
                importSourceId: source.id,
                sourceSnapshotId: snapshot.id,
              })),
            )
            .returning({
              id: sourceArtifacts.id,
              relativePath: sourceArtifacts.relativePath,
              secretScanStatus: sourceArtifacts.secretScanStatus,
            })
        : [];
      await database.insert(securityAuditRecords).values({
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "import.snapshot_captured",
        targetType: "source_snapshot",
        targetId: snapshot.id,
        reason: "Legacy source bytes captured before parsing",
        fieldNames: [
          "projectId",
          "gitCommitSha",
          "dirty",
          "manifestSha256",
          "artifactCount",
        ],
        correlationId: input.correlationId,
      });
      return { sourceId: source.id, snapshotId: snapshot.id, artifacts };
    },

    async createRun(input: {
      organizationId: string;
      sourceId: string;
      snapshotId: string;
      actorType: "user" | "agent";
      actorId: string;
      parserVersion: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const receipt = importMutationReceipt(input, "analyze_legacy_import", {
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          parserVersion: input.parserVersion,
        });
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const [snapshot] = await database
          .select({
            id: sourceSnapshots.id,
            sourceId: sourceSnapshots.importSourceId,
            status: sourceSnapshots.status,
          })
          .from(sourceSnapshots)
          .where(
            and(
              eq(sourceSnapshots.organizationId, input.organizationId),
              eq(sourceSnapshots.id, input.snapshotId),
              eq(sourceSnapshots.importSourceId, input.sourceId),
            ),
          )
          .for("share")
          .limit(1);
        if (!snapshot)
          throw new DomainError("not_found", "Import snapshot was not found");
        if (!["captured", "analyzed"].includes(snapshot.status))
          throw new DomainError(
            "forbidden",
            "Only a finalized import snapshot can be analyzed",
          );
        if (replay)
          return {
            ...(replay.result as {
              id: string;
              state: string;
              version: number;
              dispatchId: string;
            }),
            replayed: true as const,
          };
        if (input.expectedVersion !== 0)
          throw new DomainError(
            "version_conflict",
            "A new import run must use expected version zero",
          );
        const [run] = await database
          .insert(importRuns)
          .values({
            organizationId: input.organizationId,
            importSourceId: input.sourceId,
            sourceSnapshotId: input.snapshotId,
            requestedByType: input.actorType,
            requestedById: input.actorId,
            parserVersion: input.parserVersion,
          })
          .returning({
            id: importRuns.id,
            state: importRuns.state,
            version: importRuns.version,
          });
        if (!run) throw new Error("Import run persistence failed");
        const dispatchId = await enqueueImportTask(database, {
          organizationId: input.organizationId,
          runId: run.id,
          taskKind: "analyze",
          taskPayload: { kind: "analyze", runId: run.id },
        });
        const result = { ...run, dispatchId };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: run.id,
          result,
        });
        return { ...result, replayed: false as const };
      });
    },

    async createCorrectionRun(input: {
      organizationId: string;
      originalRunId: string;
      actorType: "user" | "agent";
      actorId: string;
      correlationId: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const receipt = importMutationReceipt(input, "correct_legacy_import", {
          originalRunId: input.originalRunId,
        });
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const detail = await loadImportDetail(
          database,
          input.organizationId,
          input.originalRunId,
        );
        if (detail?.run.state !== "applied") {
          throw new DomainError(
            "conflict",
            "Only an applied import can start a correction run",
          );
        }
        if (replay)
          return {
            ...(replay.result as {
              id: string;
              state: string;
              version: number;
            }),
            replayed: true as const,
          };
        if (detail.run.version !== input.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Import run changed concurrently",
          );
        const [run] = await database
          .insert(importRuns)
          .values({
            organizationId: input.organizationId,
            importSourceId: detail.run.importSourceId,
            sourceSnapshotId: detail.run.sourceSnapshotId,
            requestedByType: input.actorType,
            requestedById: input.actorId,
            parserVersion: `${detail.run.parserVersion}:correction`,
            state: "reviewing",
          })
          .returning({
            id: importRuns.id,
            state: importRuns.state,
            version: importRuns.version,
          });
        if (!run) throw new Error("Import correction persistence failed");
        for (const { entry } of detail.entries) {
          const [originalMapping] = await database
            .select({
              canonicalId: legacyMappings.canonicalId,
              canonicalType: legacyMappings.canonicalType,
            })
            .from(legacyMappings)
            .where(
              and(
                eq(legacyMappings.sourceArtifactId, entry.sourceArtifactId),
                eq(legacyMappings.recordIndex, entry.recordIndex),
              ),
            )
            .limit(1);
          const [copy] = await database
            .insert(importManifestEntries)
            .values({
              organizationId: input.organizationId,
              importRunId: run.id,
              sourceArtifactId: entry.sourceArtifactId,
              recordIndex: entry.recordIndex,
              proposedKind: entry.proposedKind,
              parsedJson: entry.parsedJson,
              confidenceJson: entry.confidenceJson,
              proposedCanonicalId:
                originalMapping?.canonicalType === "request"
                  ? originalMapping.canonicalId
                  : null,
              decision: "pending",
            })
            .returning({ id: importManifestEntries.id });
          if (!copy) throw new Error("Import correction persistence failed");
          const conflicts = detail.conflicts.filter(
            (conflict) => conflict.entryId === entry.id,
          );
          if (conflicts.length) {
            await database.insert(importConflicts).values(
              conflicts.map((conflict) => ({
                organizationId: input.organizationId,
                importRunId: run.id,
                entryId: copy.id,
                kind: conflict.kind,
                severity: conflict.severity,
                details: {
                  ...conflict.details,
                  correctionOfRunId: input.originalRunId,
                },
              })),
            );
          }
        }
        await database.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: input.actorType,
          actorId: input.actorId,
          action: "import.correction_started",
          targetType: "import_run",
          targetId: run.id,
          reason: "Compensating review started from an applied import",
          fieldNames: ["originalRunId", "sourceSnapshotId", "entries"],
          correlationId: input.correlationId,
        });
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: run.id,
          result: run,
        });
        return { ...run, replayed: false as const };
      });
    },

    listAnalyzableArtifacts(runId: string) {
      return database
        .select({ artifact: sourceArtifacts })
        .from(importRuns)
        .innerJoin(
          sourceArtifacts,
          and(
            eq(sourceArtifacts.sourceSnapshotId, importRuns.sourceSnapshotId),
            inArray(sourceArtifacts.secretScanStatus, ["clear", "reviewed"]),
          ),
        )
        .where(and(eq(importRuns.id, runId), eq(importRuns.state, "analyzing")))
        .orderBy(asc(sourceArtifacts.relativePath));
    },

    async saveAnalysis(input: {
      runId: string;
      entries: Array<{
        sourceArtifactId: string;
        recordIndex: number;
        proposedKind: string;
        parsedJson: Record<string, unknown>;
        confidenceJson: Record<string, number>;
        conflicts: Array<{
          kind: string;
          severity: "warning" | "blocking";
          details: Record<string, unknown>;
        }>;
      }>;
    }) {
      await database.transaction(async (tx) => {
        const [run] = await tx
          .select({
            id: importRuns.id,
            organizationId: importRuns.organizationId,
            sourceSnapshotId: importRuns.sourceSnapshotId,
          })
          .from(importRuns)
          .where(
            and(
              eq(importRuns.id, input.runId),
              eq(importRuns.state, "analyzing"),
            ),
          )
          .for("update")
          .limit(1);
        if (!run) {
          throw new DomainError(
            "conflict",
            "Only an analyzing import can persist analysis",
          );
        }
        const artifactIds = [
          ...new Set(input.entries.map((entry) => entry.sourceArtifactId)),
        ];
        if (artifactIds.length > 0) {
          const boundArtifacts = await tx
            .select({ id: sourceArtifacts.id })
            .from(sourceArtifacts)
            .where(
              and(
                eq(sourceArtifacts.organizationId, run.organizationId),
                eq(sourceArtifacts.sourceSnapshotId, run.sourceSnapshotId),
                inArray(sourceArtifacts.id, artifactIds),
                inArray(sourceArtifacts.secretScanStatus, [
                  "clear",
                  "reviewed",
                ]),
              ),
            )
            .for("share");
          if (boundArtifacts.length !== artifactIds.length) {
            throw new DomainError(
              "validation_failed",
              "Import analysis referenced an unavailable source artifact",
            );
          }
        }
        for (const entry of input.entries) {
          const [created] = await tx
            .insert(importManifestEntries)
            .values({
              organizationId: run.organizationId,
              importRunId: input.runId,
              sourceArtifactId: entry.sourceArtifactId,
              recordIndex: entry.recordIndex,
              proposedKind: entry.proposedKind,
              parsedJson: entry.parsedJson,
              confidenceJson: entry.confidenceJson,
            })
            .onConflictDoNothing()
            .returning({ id: importManifestEntries.id });
          const entryId =
            created?.id ??
            (
              await tx
                .select({ id: importManifestEntries.id })
                .from(importManifestEntries)
                .where(
                  and(
                    eq(importManifestEntries.importRunId, input.runId),
                    eq(
                      importManifestEntries.sourceArtifactId,
                      entry.sourceArtifactId,
                    ),
                    eq(importManifestEntries.recordIndex, entry.recordIndex),
                  ),
                )
                .limit(1)
            )[0]?.id;
          if (!entryId)
            throw new Error("Import analysis entry persistence failed");
          if (entry.conflicts.length)
            await tx
              .insert(importConflicts)
              .values(
                entry.conflicts.map((conflict) => ({
                  organizationId: run.organizationId,
                  importRunId: input.runId,
                  entryId,
                  ...conflict,
                })),
              )
              .onConflictDoNothing();
        }
        const [advanced] = await tx
          .update(importRuns)
          .set({ state: "reviewing", version: sql`${importRuns.version} + 1` })
          .where(
            and(
              eq(importRuns.id, input.runId),
              eq(importRuns.state, "analyzing"),
            ),
          )
          .returning({ id: importRuns.id });
        if (!advanced) {
          throw new DomainError("conflict", "Import analysis state changed");
        }
        await tx
          .update(sourceSnapshots)
          .set({
            status: "analyzed",
            version: sql`${sourceSnapshots.version} + 1`,
          })
          .where(
            and(
              eq(sourceSnapshots.id, run.sourceSnapshotId),
              eq(sourceSnapshots.status, "captured"),
            ),
          );
      });
    },

    async listCaptures(organizationId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          return database
            .select({ source: importSources, snapshot: sourceSnapshots })
            .from(sourceSnapshots)
            .innerJoin(
              importSources,
              eq(importSources.id, sourceSnapshots.importSourceId),
            )
            .where(eq(sourceSnapshots.organizationId, organizationId))
            .orderBy(desc(sourceSnapshots.capturedAt))
            .limit(200);
        },
        true,
      );
    },

    async findCaptureForProject(input: {
      organizationId: string;
      projectId: string;
      sourceId: string;
      snapshotId: string;
    }) {
      return forOrganization(
        input.organizationId,
        async (database) => {
          const [row] = await database
            .select({ source: importSources, snapshot: sourceSnapshots })
            .from(sourceSnapshots)
            .innerJoin(
              importSources,
              eq(importSources.id, sourceSnapshots.importSourceId),
            )
            .where(
              and(
                eq(sourceSnapshots.organizationId, input.organizationId),
                eq(sourceSnapshots.id, input.snapshotId),
                eq(sourceSnapshots.importSourceId, input.sourceId),
                eq(importSources.projectId, input.projectId),
              ),
            )
            .limit(1);
          return row ?? null;
        },
        true,
      );
    },

    async list(organizationId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          return database
            .select({
              run: importRuns,
              source: importSources,
              snapshot: sourceSnapshots,
            })
            .from(importRuns)
            .innerJoin(
              importSources,
              eq(importSources.id, importRuns.importSourceId),
            )
            .innerJoin(
              sourceSnapshots,
              eq(sourceSnapshots.id, importRuns.sourceSnapshotId),
            )
            .where(eq(importRuns.organizationId, organizationId))
            .orderBy(desc(importRuns.createdAt))
            .limit(200);
        },
        true,
      );
    },

    async listForProject(organizationId: string, projectId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          return database
            .select({
              run: importRuns,
              source: importSources,
              snapshot: sourceSnapshots,
            })
            .from(importRuns)
            .innerJoin(
              importSources,
              eq(importSources.id, importRuns.importSourceId),
            )
            .innerJoin(
              sourceSnapshots,
              eq(sourceSnapshots.id, importRuns.sourceSnapshotId),
            )
            .where(
              and(
                eq(importRuns.organizationId, organizationId),
                eq(importSources.projectId, projectId),
              ),
            )
            .orderBy(desc(importRuns.createdAt))
            .limit(200);
        },
        true,
      );
    },

    async detail(organizationId: string, runId: string) {
      return forOrganization(
        organizationId,
        async (database) => {
          return loadImportDetail(database, organizationId, runId);
        },
        true,
      );
    },

    async freeze(input: {
      organizationId: string;
      runId: string;
      reviewerId: string;
      correlationId: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const receipt = importMutationReceipt(
          { ...input, actorType: "user", actorId: input.reviewerId },
          "freeze_legacy_import",
          { runId: input.runId },
        );
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const [locked] = await database
          .select({ state: importRuns.state, version: importRuns.version })
          .from(importRuns)
          .where(
            and(
              eq(importRuns.organizationId, input.organizationId),
              eq(importRuns.id, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!locked) {
          throw new DomainError("conflict", "Import run is not reviewable");
        }
        if (replay)
          return replay.result as {
            manifestSha256: string;
            entries: number;
            version: number;
          };
        if (
          locked.state !== "reviewing" ||
          locked.version !== input.expectedVersion
        )
          throw new DomainError(
            "version_conflict",
            "Import run changed concurrently",
          );
        const detail = await loadImportDetail(
          database,
          input.organizationId,
          input.runId,
        );
        if (detail?.run.state !== "reviewing")
          throw new DomainError("conflict", "Import run is not reviewable");
        if (
          detail.entries.some(
            ({ entry }) =>
              entry.decision === "pending" || entry.decision === "blocked",
          )
        )
          throw new DomainError(
            "conflict",
            "Every import entry needs a non-blocking decision",
          );
        if (
          detail.conflicts.some(
            (conflict) =>
              conflict.severity === "blocking" && !conflict.resolvedAt,
          )
        )
          throw new DomainError(
            "conflict",
            "Resolve all blocking conflicts before approval",
          );
        const manifest = detail.entries
          .map(({ entry, artifact }) => ({
            entryId: entry.id,
            sourceArtifactId: entry.sourceArtifactId,
            relativePath: artifact.relativePath,
            recordIndex: entry.recordIndex,
            decision: entry.decision,
            proposedCanonicalId: entry.proposedCanonicalId,
            parsedJson: entry.parsedJson,
          }))
          .sort((left, right) =>
            `${left.relativePath}:${left.recordIndex}`.localeCompare(
              `${right.relativePath}:${right.recordIndex}`,
              "en",
            ),
          );
        const hash = createHash("sha256")
          .update(canonicalJson(manifest))
          .digest("hex");
        const [approved] = await database
          .update(importRuns)
          .set({
            state: "approved",
            manifestSha256: hash,
            version: input.expectedVersion + 1,
          })
          .where(
            and(
              eq(importRuns.id, input.runId),
              eq(importRuns.state, "reviewing"),
              eq(importRuns.version, input.expectedVersion),
            ),
          )
          .returning({ id: importRuns.id, version: importRuns.version });
        if (!approved)
          throw new DomainError(
            "conflict",
            "Import run changed during approval",
          );
        await database.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.reviewerId,
          action: "import.manifest_approved",
          targetType: "import_run",
          targetId: input.runId,
          reason: "Reviewed import manifest frozen",
          fieldNames: ["manifestSha256", "decisions"],
          correlationId: input.correlationId,
        });
        const result = {
          manifestSha256: hash,
          entries: manifest.length,
          version: approved.version,
        };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: input.runId,
          result,
        });
        return result;
      });
    },

    async queueApply(input: {
      organizationId: string;
      runId: string;
      manifestSha256: string;
      actorType: "user" | "agent";
      actorId: string;
      taskActor: ImportTaskActor;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const receipt = importMutationReceipt(input, "apply_legacy_import", {
          runId: input.runId,
          manifestSha256: input.manifestSha256,
        });
        const replay = await lockMutationReceipt(database as Tx, receipt);
        const [run] = await database
          .select({
            id: importRuns.id,
            state: importRuns.state,
            version: importRuns.version,
            manifestSha256: importRuns.manifestSha256,
          })
          .from(importRuns)
          .where(
            and(
              eq(importRuns.organizationId, input.organizationId),
              eq(importRuns.id, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!run)
          throw new DomainError("not_found", "Import run was not found");
        if (replay)
          return {
            ...(replay.result as {
              id: string;
              state: string;
              version: number;
              dispatchId: string;
            }),
            replayed: true as const,
          };
        if (
          run.state !== "approved" ||
          run.manifestSha256 !== input.manifestSha256
        )
          throw new DomainError(
            "validation_failed",
            "Approved import manifest hash does not match",
          );
        if (run.version !== input.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Import run changed concurrently",
          );
        const dispatchId = await enqueueImportTask(database, {
          organizationId: input.organizationId,
          runId: run.id,
          taskKind: "apply",
          taskPayload: {
            kind: "apply",
            organizationId: input.organizationId,
            runId: run.id,
            manifestSha256: input.manifestSha256,
            actor: input.taskActor,
          },
        });
        const result = {
          id: run.id,
          state: "queued",
          version: run.version,
          dispatchId,
        };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: run.id,
          result,
        });
        return { ...result, replayed: false as const };
      });
    },

    async lockForApply(input: {
      organizationId: string;
      runId: string;
      manifestSha256: string;
    }) {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('requestport:import-apply:' || ${input.runId}, 0))`,
      );
      const [row] = await database
        .select({
          run: importRuns,
          source: importSources,
          snapshot: sourceSnapshots,
        })
        .from(importRuns)
        .innerJoin(
          importSources,
          eq(importSources.id, importRuns.importSourceId),
        )
        .innerJoin(
          sourceSnapshots,
          eq(sourceSnapshots.id, importRuns.sourceSnapshotId),
        )
        .where(
          and(
            eq(importRuns.organizationId, input.organizationId),
            eq(importRuns.id, input.runId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) throw new DomainError("not_found", "Import run was not found");
      if (row.run.manifestSha256 !== input.manifestSha256)
        throw new DomainError(
          "validation_failed",
          "Approved import manifest hash does not match",
        );
      if (row.run.state === "applied")
        return { ...row, alreadyApplied: true as const };
      if (row.run.state !== "approved" && row.run.state !== "applying")
        throw new DomainError(
          "conflict",
          "Only an approved import can be applied",
        );
      if (row.run.requestedByType === "service")
        throw new DomainError(
          "forbidden",
          "A user or agent must own an import application",
        );
      if (row.run.state === "approved")
        await database
          .update(importRuns)
          .set({ state: "applying", version: sql`${importRuns.version} + 1` })
          .where(eq(importRuns.id, input.runId));
      return { ...row, alreadyApplied: false as const };
    },

    findMapping(sourceArtifactId: string, recordIndex: number) {
      return database
        .select()
        .from(legacyMappings)
        .where(
          and(
            eq(legacyMappings.sourceArtifactId, sourceArtifactId),
            eq(legacyMappings.recordIndex, recordIndex),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },
    findEntryApplication(runId: string, entryId: string) {
      return database
        .select()
        .from(importEntryApplications)
        .where(
          and(
            eq(importEntryApplications.importRunId, runId),
            eq(importEntryApplications.entryId, entryId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },
    listEntryApplications(runId: string) {
      return database
        .select()
        .from(importEntryApplications)
        .where(eq(importEntryApplications.importRunId, runId))
        .orderBy(
          asc(importEntryApplications.createdAt),
          asc(importEntryApplications.id),
        );
    },
    async recordEntryApplication(input: {
      organizationId: string;
      runId: string;
      entryId: string;
      outcome:
        | "created"
        | "mapped"
        | "message"
        | "skipped"
        | "existing"
        | "corrected_message";
      canonicalType?: string | null;
      canonicalId?: string | null;
      warnings?: Array<Record<string, unknown>>;
    }) {
      const [record] = await database
        .insert(importEntryApplications)
        .values({
          organizationId: input.organizationId,
          importRunId: input.runId,
          entryId: input.entryId,
          outcome: input.outcome,
          canonicalType: input.canonicalType ?? null,
          canonicalId: input.canonicalId ?? null,
          warnings: input.warnings ?? [],
        })
        .onConflictDoNothing()
        .returning();
      if (record) return record;
      const [existing] = await database
        .select()
        .from(importEntryApplications)
        .where(
          and(
            eq(importEntryApplications.importRunId, input.runId),
            eq(importEntryApplications.entryId, input.entryId),
          ),
        )
        .limit(1);
      return existing ?? null;
    },
    async insertMapping(input: {
      organizationId: string;
      sourceArtifactId: string;
      recordIndex: number;
      canonicalType: string;
      canonicalId: string;
      importRunId: string;
      sourceProjectId: string;
      legacyKey?: { namespace: string; normalizedKey: string };
    }) {
      await database.insert(legacyMappings).values({
        id: randomUUID(),
        organizationId: input.organizationId,
        sourceArtifactId: input.sourceArtifactId,
        recordIndex: input.recordIndex,
        canonicalType: input.canonicalType,
        canonicalId: input.canonicalId,
        importRunId: input.importRunId,
      });
      if (input.legacyKey && input.canonicalType === "request")
        await database.insert(legacyAliases).values({
          id: randomUUID(),
          organizationId: input.organizationId,
          sourceProjectId: input.sourceProjectId,
          namespace: input.legacyKey.namespace,
          normalizedKey: input.legacyKey.normalizedKey,
          sourceArtifactId: input.sourceArtifactId,
          recordIndex: input.recordIndex,
          canonicalRequestId: input.canonicalId,
        });
    },
    async setRunState(runId: string, from: string, to: string) {
      const [updated] = await database
        .update(importRuns)
        .set({
          state: to,
          version: sql`${importRuns.version} + 1`,
          completedAt: to === "applied" || to === "failed" ? new Date() : null,
        })
        .where(and(eq(importRuns.id, runId), eq(importRuns.state, from)))
        .returning({ id: importRuns.id });
      return Boolean(updated);
    },
    async createReport(input: {
      organizationId: string;
      runId: string;
      counts: Record<string, number>;
      warnings: Array<Record<string, unknown>>;
      manifestSha256: string;
    }) {
      const [report] = await database
        .insert(importApplyReports)
        .values({
          organizationId: input.organizationId,
          importRunId: input.runId,
          counts: input.counts,
          warnings: input.warnings,
          manifestSha256: input.manifestSha256,
        })
        .onConflictDoNothing()
        .returning({ id: importApplyReports.id });
      return (
        report?.id ??
        (
          await database
            .select({ id: importApplyReports.id })
            .from(importApplyReports)
            .where(eq(importApplyReports.importRunId, input.runId))
            .limit(1)
        )[0]?.id
      );
    },
    async completeApply(input: {
      organizationId: string;
      runId: string;
      actorType: "user" | "agent";
      actorId: string;
      reportId: string;
      correlationId: string;
    }) {
      const [updated] = await database
        .update(importRuns)
        .set({
          state: "applied",
          version: sql`${importRuns.version} + 1`,
          completedAt: sql<Date>`clock_timestamp()`,
        })
        .where(
          and(
            eq(importRuns.organizationId, input.organizationId),
            eq(importRuns.id, input.runId),
            eq(importRuns.state, "applying"),
          ),
        )
        .returning({ id: importRuns.id });
      if (!updated)
        throw new DomainError(
          "conflict",
          "Import application state changed concurrently",
        );
      await database.insert(securityAuditRecords).values({
        organizationId: input.organizationId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: "import.manifest_applied",
        targetType: "import_run",
        targetId: input.runId,
        reason: "Approved legacy import manifest applied",
        fieldNames: ["reportId", "mappings", "manifestSha256"],
        correlationId: input.correlationId,
      });
    },
  };
}

/**
 * For an operator bound to a project (`credentialProjectId` not null): the
 * run's source must be that project, or the run is not found, as it is for
 * the administration reads. Nothing is queried for anyone else. The project
 * is compared in code, never in SQL, so a malformed binding raises nothing.
 */
async function requireRunInBoundProject(
  database: ImportDatabase,
  input: {
    organizationId: string;
    runId: string;
    credentialProjectId: string | null;
  },
) {
  if (input.credentialProjectId === null) return;
  const [source] = await database
    .select({ projectId: importSources.projectId })
    .from(importRuns)
    .innerJoin(
      importSources,
      and(
        eq(importSources.organizationId, importRuns.organizationId),
        eq(importSources.id, importRuns.importSourceId),
      ),
    )
    .where(
      and(
        eq(importRuns.organizationId, input.organizationId),
        eq(importRuns.id, input.runId),
      ),
    )
    .limit(1);
  if (source?.projectId !== input.credentialProjectId)
    throw new DomainError("not_found", "Import run was not found");
}

/**
 * The import repository's review writes, as the command bus's
 * `importReviewCommands` port and the split handler reach them (Plan 13,
 * F.2.6), on the transaction they are handed. `authorize` and both writes
 * refuse anyone but an active owner or admin of the active organisation,
 * asked about the member (`userId`), never about the acting actor. Both
 * writes record who acted (`actor`: a person's id, or an operator's
 * `operator:<lineage>`, never its member) as the entry's reviewer and a
 * conflict's resolver, and hold an operator bound to a project
 * (`credentialProjectId`) to the runs whose source is that project.
 */
export function createImportReviewCommandRepository(database: ImportDatabase) {
  /**
   * Each method binds the transaction it is handed to the organisation it
   * names before its first read (manifest-i2.md §2.3 item 5), as the
   * repository above does: the web's split handler opens its own
   * transaction, and the bus's is bound to the context's organisation
   * already (`commandTransactionBinding`), so there the binding repeats it,
   * which is idempotent, and one for another organisation is refused.
   */
  const forOrganization = <T>(
    organizationId: string,
    work: (database: ImportDatabase) => Promise<T>,
  ) => withTenant(organizationId, work, { database });

  return {
    authorize(target: ImportReviewTarget) {
      return forOrganization(target.organizationId, async (database) => {
        return requireImportManager(
          database,
          target.organizationId,
          target.userId,
        );
      });
    },

    /**
     * Splits a pending or blocked entry into the segments `segment` cuts its
     * preserved record into, at the lines the caller asked for.
     *
     * The receipt is keyed by what the caller asked — the run, the entry and
     * the split lines — and `segment` runs only when no receipt answered the
     * request. The segments cannot be the key: once the split has run, the
     * entry holds only the first segment, so cutting it again at the same
     * lines can never reproduce them, and a retry with the same key could
     * never be answered from its receipt.
     *
     * The run and the entry are locked and checked before a replay is
     * answered, so a replay after the run left review is refused as
     * `conflict`, and one after the run or the entry was deleted as
     * `not_found`, writing nothing. A review's replay differs: the bus
     * answers it before `reviewEntry` reads the run.
     *
     * The split is off the command bus (its segments come from a parser the
     * domain cannot import), so this keeps its own receipt,
     * `split_legacy_import_entry`, under the acting actor — a person as the
     * `user` actor it has always been keyed by, an operator as its own
     * `service` actor — keyed with the fingerprint secret the caller passes.
     */
    async splitEntry(input: {
      organizationId: string;
      runId: string;
      entryId: string;
      splitLines: number[];
      segment: (bodyMarkdown: string) => ImportSplitSegment[];
      /** The member whose role authorises the split. */
      userId: string;
      /** Who acts, recorded as the resolver and the receipt's holder. */
      actor: ActorRef;
      /** An operator's bound project, or null. */
      credentialProjectId: string | null;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      return forOrganization(input.organizationId, async (database) => {
        const acting = auditActor(input);
        const receipt = importActorReceipt(
          input.actor,
          input,
          "split_legacy_import_entry",
          {
            runId: input.runId,
            entryId: input.entryId,
            splitLines: input.splitLines,
          },
        );
        const replay = await lockMutationReceipt(database as Tx, receipt);
        await requireImportManager(
          database,
          input.organizationId,
          input.userId,
        );
        const [run] = await database
          .select({ state: importRuns.state })
          .from(importRuns)
          .where(
            and(
              eq(importRuns.organizationId, input.organizationId),
              eq(importRuns.id, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!run)
          throw new DomainError("not_found", "Import run was not found");
        await requireRunInBoundProject(database, input);
        if (run.state !== "reviewing") {
          throw new DomainError(
            "conflict",
            "Only a reviewing import can split a bundle",
          );
        }
        const [entry] = await database
          .select()
          .from(importManifestEntries)
          .where(
            and(
              eq(importManifestEntries.importRunId, input.runId),
              eq(importManifestEntries.id, input.entryId),
            ),
          )
          .for("update")
          .limit(1);
        if (!entry)
          throw new DomainError("not_found", "Import entry was not found");
        if (replay) return replay.result as { entryIds: string[] };
        if (entry.version !== input.expectedVersion) {
          throw new DomainError(
            "version_conflict",
            "Import entry changed concurrently",
          );
        }
        if (entry.decision !== "pending" && entry.decision !== "blocked") {
          throw new DomainError(
            "conflict",
            "Only an unresolved import entry can be split",
          );
        }
        const [priorSplit] = await database
          .select({ id: importConflicts.id })
          .from(importConflicts)
          .where(
            and(
              eq(importConflicts.entryId, entry.id),
              eq(importConflicts.kind, "manual_split_requires_review"),
            ),
          )
          .limit(1);
        if (priorSplit) {
          throw new DomainError(
            "conflict",
            "A manually split entry cannot be split a second time",
          );
        }
        const originalBody = entry.parsedJson.bodyMarkdown;
        if (typeof originalBody !== "string") {
          throw new DomainError("not_found", "Import entry was not found");
        }
        const segments = input.segment(originalBody);
        if (segments.length < 2 || segments.length > 20) {
          throw new DomainError(
            "validation_failed",
            "A manual split requires between two and twenty segments",
          );
        }
        const firstSegment = segments[0];
        if (!firstSegment) {
          throw new DomainError(
            "validation_failed",
            "A manual split requires a first segment",
          );
        }
        const segmentBodies = segments.map(
          (segment) => segment.parsedJson.bodyMarkdown,
        );
        if (
          segmentBodies.some(
            (body) => typeof body !== "string" || body.trim().length === 0,
          ) ||
          segmentBodies.join("") !== originalBody
        ) {
          throw new DomainError(
            "validation_failed",
            "Manual split segments must preserve the source record exactly",
          );
        }
        const [maximum] = await database
          .select({
            value: sql<number>`coalesce(max(${importManifestEntries.recordIndex}), -1)::integer`,
          })
          .from(importManifestEntries)
          .where(
            and(
              eq(importManifestEntries.importRunId, input.runId),
              eq(
                importManifestEntries.sourceArtifactId,
                entry.sourceArtifactId,
              ),
            ),
          );
        let nextRecordIndex = Number(maximum?.value ?? entry.recordIndex) + 1;
        const [first] = await database
          .update(importManifestEntries)
          .set({
            proposedKind: firstSegment.proposedKind,
            parsedJson: firstSegment.parsedJson,
            confidenceJson: firstSegment.confidenceJson,
            decision: "pending",
            proposedCanonicalId: null,
            reviewerId: null,
            reviewedAt: null,
            version: input.expectedVersion + 1,
          })
          .where(
            and(
              eq(importManifestEntries.id, input.entryId),
              eq(importManifestEntries.version, input.expectedVersion),
            ),
          )
          .returning({ id: importManifestEntries.id });
        if (!first) {
          throw new DomainError(
            "version_conflict",
            "Import entry changed concurrently",
          );
        }
        const entryIds = [first.id];
        for (const segment of segments.slice(1)) {
          const [created] = await database
            .insert(importManifestEntries)
            .values({
              organizationId: input.organizationId,
              importRunId: input.runId,
              sourceArtifactId: entry.sourceArtifactId,
              recordIndex: nextRecordIndex,
              proposedKind: segment.proposedKind,
              parsedJson: segment.parsedJson,
              confidenceJson: segment.confidenceJson,
            })
            .returning({ id: importManifestEntries.id });
          if (!created)
            throw new Error("Import split entry persistence failed");
          entryIds.push(created.id);
          nextRecordIndex += 1;
        }
        await database
          .update(importConflicts)
          .set({
            resolution: { decision: "manual_split", entryIds },
            resolvedBy: acting.actorId,
            resolvedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(importConflicts.entryId, input.entryId),
              isNull(importConflicts.resolvedAt),
            ),
          );
        await database.insert(importConflicts).values(
          entryIds.map((entryId, index) => ({
            organizationId: input.organizationId,
            importRunId: input.runId,
            entryId,
            kind: "manual_split_requires_review",
            severity: "blocking" as const,
            details: {
              sourceEntryId: input.entryId,
              segment: index + 1,
              segmentCount: entryIds.length,
            },
          })),
        );
        const result = { entryIds };
        await saveMutationReceipt(database as Tx, receipt, {
          aggregateId: first.id,
          result,
        });
        return result;
      });
    },

    /**
     * Records a reviewer's decision on one entry of a reviewing run. It keeps
     * no receipt of its own: the command bus holds the one receipt for
     * `review_legacy_import_entry`, and answers a replay before this runs.
     *
     * An operator bound to a project may review only a run whose source is
     * that project: another project's run is refused `not_found` ("Import
     * run was not found") by `requireRunInBoundProject`, as another
     * organisation's run is. It may create only in that project, and may
     * name only that project's requests as the canonical request or a
     * relationship's target: any other target is refused
     * `validation_failed` with the same "… is unavailable" message another
     * organisation's target gets.
     */
    async reviewEntry(
      mutation: ImportReviewMutation,
      input: Omit<ReviewImportEntryInput, "organizationId">,
    ) {
      return forOrganization(mutation.organizationId, async (database) => {
        const relationshipIdentities = input.relationships.map(
          (relationship) =>
            `${relationship.type}:${relationship.targetRequestId}`,
        );
        if (
          input.relationships.length > 20 ||
          new Set(relationshipIdentities).size !== relationshipIdentities.length
        ) {
          throw new DomainError(
            "validation_failed",
            "Import relationships must be unique and may contain at most twenty links",
          );
        }
        await requireImportManager(
          database,
          mutation.organizationId,
          mutation.userId,
        );
        const [run] = await database
          .select({ state: importRuns.state })
          .from(importRuns)
          .where(
            and(
              eq(importRuns.organizationId, mutation.organizationId),
              eq(importRuns.id, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!run)
          throw new DomainError("not_found", "Import run was not found");
        await requireRunInBoundProject(database, {
          organizationId: mutation.organizationId,
          runId: input.runId,
          credentialProjectId: mutation.credentialProjectId,
        });
        if (run.state !== "reviewing")
          throw new DomainError(
            "conflict",
            "Only a reviewing import can change decisions",
          );
        const [entry] = await database
          .select()
          .from(importManifestEntries)
          .where(
            and(
              eq(importManifestEntries.id, input.entryId),
              eq(importManifestEntries.importRunId, input.runId),
            ),
          )
          .for("update")
          .limit(1);
        if (!entry)
          throw new DomainError("not_found", "Import entry was not found");
        if (entry.version !== mutation.expectedVersion)
          throw new DomainError(
            "version_conflict",
            "Import entry changed concurrently",
          );
        const bodyMarkdown = entry.parsedJson.bodyMarkdown;
        if (
          (input.decision === "create" || input.decision === "message") &&
          (typeof bodyMarkdown !== "string" ||
            bodyMarkdown.trim().length === 0 ||
            bodyMarkdown.length > 100_000 ||
            Buffer.byteLength(bodyMarkdown, "utf8") > 262_144)
        ) {
          throw new DomainError(
            "validation_failed",
            "Split or skip an import record that exceeds the canonical Markdown limit",
          );
        }
        const bound = mutation.credentialProjectId;
        if (input.decision === "create") {
          if (!input.targetProjectId) {
            throw new DomainError(
              "validation_failed",
              "A created import entry requires one target project",
            );
          }
          if (bound !== null && input.targetProjectId !== bound)
            throw new DomainError(
              "validation_failed",
              "Import target project is unavailable",
            );
          const [target] = await database
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.organizationId, mutation.organizationId),
                eq(projects.id, input.targetProjectId),
                eq(projects.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          if (!target)
            throw new DomainError(
              "validation_failed",
              "Import target project is unavailable",
            );
        } else if (
          input.decision === "map_existing" ||
          input.decision === "message"
        ) {
          if (!input.proposedCanonicalId) {
            throw new DomainError(
              "validation_failed",
              "This import decision requires a canonical request",
            );
          }
          const [canonical] = await database
            .select({ id: requests.id })
            .from(requests)
            .where(
              and(
                eq(requests.organizationId, mutation.organizationId),
                eq(requests.id, input.proposedCanonicalId),
                ...(bound === null
                  ? []
                  : [eq(requests.targetProjectId, bound)]),
              ),
            )
            .for("share")
            .limit(1);
          if (!canonical)
            throw new DomainError(
              "validation_failed",
              "Canonical import request is unavailable",
            );
        }
        if (
          input.relationships.length > 0 &&
          input.decision !== "create" &&
          input.decision !== "map_existing"
        ) {
          throw new DomainError(
            "validation_failed",
            "Only imported or mapped requests may define relationships",
          );
        }
        const relationshipTargets = [
          ...new Set(
            input.relationships.map(
              (relationship) => relationship.targetRequestId,
            ),
          ),
        ];
        if (relationshipTargets.length > 0) {
          const targets = await database
            .select({ id: requests.id })
            .from(requests)
            .where(
              and(
                eq(requests.organizationId, mutation.organizationId),
                inArray(requests.id, relationshipTargets),
                ...(bound === null
                  ? []
                  : [eq(requests.targetProjectId, bound)]),
              ),
            )
            .for("share");
          if (targets.length !== relationshipTargets.length) {
            throw new DomainError(
              "validation_failed",
              "An import relationship target is unavailable",
            );
          }
        }
        if (
          input.proposedCanonicalId &&
          input.relationships.some(
            (relationship) =>
              relationship.targetRequestId === input.proposedCanonicalId,
          )
        ) {
          throw new DomainError(
            "validation_failed",
            "An imported request cannot relate to itself",
          );
        }
        const proposedCanonicalId =
          input.decision === "map_existing" || input.decision === "message"
            ? input.proposedCanonicalId
            : null;
        const parsedJson = { ...entry.parsedJson };
        delete parsedJson.targetProjectId;
        delete parsedJson.reviewedRelationships;
        if (input.decision === "create")
          parsedJson.targetProjectId = input.targetProjectId;
        if (input.relationships.length > 0) {
          parsedJson.reviewedRelationships = input.relationships;
        }
        const [updated] = await database
          .update(importManifestEntries)
          .set({
            decision: input.decision,
            proposedCanonicalId,
            parsedJson,
            reviewerId: auditActor(mutation).actorId,
            reviewedAt: sql`clock_timestamp()`,
            version: mutation.expectedVersion + 1,
          })
          .where(
            and(
              eq(importManifestEntries.id, input.entryId),
              eq(importManifestEntries.version, mutation.expectedVersion),
            ),
          )
          .returning({
            id: importManifestEntries.id,
            version: importManifestEntries.version,
          });
        if (!updated)
          throw new DomainError(
            "version_conflict",
            "Import entry changed concurrently",
          );
        await database
          .update(importConflicts)
          .set({
            resolution: {
              decision: input.decision,
              proposedCanonicalId,
              targetProjectId:
                input.decision === "create" ? input.targetProjectId : null,
              relationships: input.relationships,
            },
            resolvedBy: auditActor(mutation).actorId,
            resolvedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(importConflicts.entryId, input.entryId),
              isNull(importConflicts.resolvedAt),
            ),
          );
        return updated;
      });
    },
  };
}

export type ClaimedImportTaskDispatch = {
  id: string;
  organizationId: string;
  taskKind: "analyze" | "apply";
  taskPayload: Record<string, unknown>;
  attemptCount: number;
};

const maxImportDispatchAttempts = 8;

export function createImportTaskDispatchRepository(database: Database) {
  return {
    /**
     * The web's claim of one dispatch, by id, under the caller's owner
     * string, through `boundImportTaskDispatchRepository`, which binds it to
     * the dispatch's organisation; so §5.1 keeps it a repository method, not
     * a definer function.
     */
    async claimOne(
      id: string,
      owner: string,
      leaseMs = 60_000,
      acceptedRetryMs = 15 * 60_000,
    ): Promise<ClaimedImportTaskDispatch | null> {
      await database.execute(sql`
        update ${importTaskDispatches}
        set state = 'dead_letter',
            lease_owner = null,
            lease_expires_at = null,
            last_error_code = 'dispatch_attempts_exhausted',
            updated_at = clock_timestamp()
        where id = ${id}
          and attempt_count >= ${maxImportDispatchAttempts}
          and (
            state = 'pending'
            or (state = 'leased' and lease_expires_at < clock_timestamp())
            or (state = 'accepted' and updated_at < clock_timestamp() - (${acceptedRetryMs} * interval '1 millisecond'))
          )
      `);
      const result = await database.execute<{
        id: string;
        organization_id: string;
        task_kind: "analyze" | "apply";
        task_payload: Record<string, unknown>;
        attempt_count: number;
      }>(sql`
        update ${importTaskDispatches}
        set state = 'leased',
            lease_owner = ${owner},
            lease_expires_at = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
            attempt_count = attempt_count + 1,
            updated_at = clock_timestamp()
        where id = ${id}
          and attempt_count < ${maxImportDispatchAttempts}
          and (
            state = 'pending'
            or (state = 'leased' and lease_expires_at < clock_timestamp())
            or (state = 'accepted' and updated_at < clock_timestamp() - (${acceptedRetryMs} * interval '1 millisecond'))
          )
        returning id, organization_id, task_kind, task_payload, attempt_count
      `);
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            organizationId: row.organization_id,
            taskKind: row.task_kind,
            taskPayload: row.task_payload,
            attemptCount: row.attempt_count,
          }
        : null;
    },

    /**
     * Function 4: dead-letters dispatches past eight attempts, then leases up
     * to `limit` (1-200, default 50) for `leaseSeconds` (60-1 800, default
     * 60), each under a lease id the function generates. No payload: the
     * bodies read it bound, through `load`. In a transaction on this storage
     * (§2.5.0 item 7).
     */
    async claimBatch(
      limit?: number,
      leaseSeconds?: number,
    ): Promise<
      Array<Omit<ClaimedImportTaskDispatch, "taskPayload"> & ClaimLease>
    > {
      const result = await database.transaction((tx) =>
        tx.execute<{
          dispatch_id: string;
          organization_id: string;
          task_kind: "analyze" | "apply";
          attempt_count: number;
          lease_id: string;
          lease_expires_at: Date | string;
        }>(
          sql`select dispatch_id, organization_id, task_kind, attempt_count, lease_id, lease_expires_at
              from requestport_private.claim_import_dispatch_batch(${claimBound(limit)}::integer, ${claimBound(leaseSeconds)}::integer)`,
        ),
      );
      return result.rows.map((row) => ({
        id: row.dispatch_id,
        organizationId: row.organization_id,
        taskKind: row.task_kind,
        attemptCount: row.attempt_count,
        leaseId: row.lease_id,
        leaseExpiresAt: new Date(row.lease_expires_at),
      }));
    },

    /**
     * Function 5, the dispatcher's acceptance by lease: as the outbox's, the
     * lease matched and unexpired, else false and nothing changed.
     */
    async acceptClaim(
      id: string,
      leaseId: string,
      runId: string,
    ): Promise<boolean> {
      if (!isClaimUuid(id) || !isClaimUuid(leaseId)) return false;
      const result = await database.transaction((tx) =>
        tx.execute<{ accepted: boolean }>(
          sql`select requestport_private.accept_import_dispatch_claim(${id}::uuid, ${leaseId}::uuid, ${runId}) as accepted`,
        ),
      );
      return result.rows[0]?.accepted === true;
    },

    /**
     * `claimOne`'s acceptance, by id and owner, only while the lease is
     * unexpired (§5.1). True when it recorded `triggerRunId`.
     */
    async markAccepted(id: string, owner: string, triggerRunId: string) {
      const [accepted] = await database
        .update(importTaskDispatches)
        .set({
          state: "accepted",
          triggerRunId,
          acceptedAt: sql<Date>`clock_timestamp()`,
          lastErrorCode: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql<Date>`clock_timestamp()`,
        })
        .where(
          and(
            eq(importTaskDispatches.id, id),
            eq(importTaskDispatches.state, "leased"),
            eq(importTaskDispatches.leaseOwner, owner),
            sql`${importTaskDispatches.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: importTaskDispatches.id });
      return Boolean(accepted);
    },

    async load(id: string) {
      const [row] = await database
        .select({
          dispatch: importTaskDispatches,
          runState: importRuns.state,
        })
        .from(importTaskDispatches)
        .innerJoin(
          importRuns,
          and(
            eq(importRuns.organizationId, importTaskDispatches.organizationId),
            eq(importRuns.id, importTaskDispatches.importRunId),
          ),
        )
        .where(eq(importTaskDispatches.id, id))
        .limit(1);
      return row ?? null;
    },

    /**
     * Completes the dispatch only for the attempt the body ran as, and only
     * while `settlement` holds it (§5.1): the attempt count fences a
     * re-claim, and the settlement an expired lease or a superseded run.
     */
    async markCompleted(
      id: string,
      expectedAttemptCount: number,
      settlement: ClaimSettlement,
    ) {
      const [completed] = await database
        .update(importTaskDispatches)
        .set({
          state: "completed",
          acceptedAt: sql<Date>`coalesce(${importTaskDispatches.acceptedAt}, clock_timestamp())`,
          completedAt: sql<Date>`clock_timestamp()`,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: sql<Date>`clock_timestamp()`,
        })
        .where(
          and(
            eq(importTaskDispatches.id, id),
            eq(importTaskDispatches.attemptCount, expectedAttemptCount),
            settlementHolds(importTaskDispatches, settlement),
          ),
        )
        .returning({ id: importTaskDispatches.id });
      return Boolean(completed);
    },

    /**
     * The standing a settling body reads before any effect (§5.1), for the
     * attempt it ran as: another attempt, or a row this handle cannot see,
     * is `superseded`.
     */
    async claimStanding(
      id: string,
      expectedAttemptCount: number,
      settlement: ClaimSettlement,
    ): Promise<ClaimStanding> {
      const [row] = await database
        .select({
          state: importTaskDispatches.state,
          leaseOwner: importTaskDispatches.leaseOwner,
          leaseLive: sql<
            boolean | null
          >`${importTaskDispatches.leaseExpiresAt} > clock_timestamp()`,
          triggerRunId: importTaskDispatches.triggerRunId,
          attemptCount: importTaskDispatches.attemptCount,
        })
        .from(importTaskDispatches)
        .where(eq(importTaskDispatches.id, id))
        .limit(1);
      return standingOf(
        row && row.attemptCount === expectedAttemptCount ? row : undefined,
        settlement,
      );
    },
  };
}

/**
 * The import dispatch methods the web calls after a command commits, each
 * bound to the command's organisation (manifest-i2.md §2.4; track-i2.md D5):
 * its own short transaction through `withTenant`, bound when the application
 * variable is set and on the pool exactly as before when it is not. The
 * worker calls the shared methods, not these, on the storages
 * `createWorkerStorages` gives it (I.2b).
 */
export function boundImportTaskDispatchRepository(
  organizationId: string,
  database: Database,
) {
  const bound = <T>(
    work: (
      repository: ReturnType<typeof createImportTaskDispatchRepository>,
    ) => Promise<T>,
  ) =>
    withTenant(
      organizationId,
      (tenant) => work(createImportTaskDispatchRepository(tenant as Database)),
      { database },
    );

  return {
    claimOne: (
      id: string,
      owner: string,
      leaseMs?: number,
      acceptedRetryMs?: number,
    ) =>
      bound((repository) =>
        repository.claimOne(id, owner, leaseMs, acceptedRetryMs),
      ),
    markAccepted: (id: string, owner: string, triggerRunId: string) =>
      bound((repository) => repository.markAccepted(id, owner, triggerRunId)),
  };
}
