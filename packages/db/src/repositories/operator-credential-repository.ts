import {
  actorFingerprint,
  DomainError,
  keyedFingerprint,
  normalizedInputHash,
  type OperatorCredentialAvailability,
  type OperatorCredentialSwitch,
  operatorCredentialMaxLifetimeDays,
  operatorExcludedScopes,
  operatorScopes,
} from "@requestport/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import {
  apiKeys,
  operatorCredentials,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  securityAuditRecords,
  session,
} from "../schema/index.js";
import {
  inTenantTransaction,
  withTenant,
  withTenantRead,
} from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  lockMutationReceipt,
  type MutationReceiptKey,
  saveMutationReceipt,
  updateMutationReceipt,
} from "./mutation-receipt.js";

type OperatorDatabase = Database | Tx;

/**
 * The authority an operator key resolves to at authentication (F3-11): the
 * binding row, found by the Better Auth key id the plugin has just verified.
 * `credentialId` names this key's row; `lineageId` names the actor, and stays
 * the same across rotation.
 */
export type ResolvedOperatorAuthorization = {
  credentialId: string;
  lineageId: string;
  organizationId: string;
  memberUserId: string;
  projectId: string | null;
  scopes: string[];
  /**
   * Never set: `requestport_private.resolve_operator_credential` returns no
   * expiry (track-i2.md §3), and no caller reads one; the lookup already
   * refused an expired credential. Optional, as the agent resolution's is.
   */
  expiresAt?: Date;
  credentialFingerprint: string;
};

/*
 * The row `requestport_private.resolve_operator_credential` returns
 * (0019_row_security_expand.sql), as the driver hands it over: snake_case,
 * uuids as text, jsonb parsed.
 */
type ResolvedOperatorRow = {
  credential_id: string;
  lineage_id: string;
  organization_id: string;
  member_user_id: string;
  project_id: string | null;
  scopes: string[];
  credential_fingerprint: string;
};

export type OperatorCredentialRecord = {
  id: string;
  organizationId: string;
  memberUserId: string;
  projectId: string | null;
  betterAuthApiKeyId: string | null;
  lineageId: string;
  rotatedFromId: string | null;
  name: string;
  prefix: string;
  fingerprint: string;
  scopes: string[];
  version: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

/** A credential as the page lists it: the record, with its overlap and use. */
export type OperatorCredentialSummary = OperatorCredentialRecord & {
  overlapExpiresAt: Date | null;
  lastUsedAt: Date | null;
};

/**
 * An issuance's idempotency receipt, reserved before a plugin key exists and
 * settled when the binding is written, as for agent keys. It never holds the
 * plaintext key, so a replay after completion cannot reveal it again.
 */
export type OperatorIssuanceReceipt = {
  key: MutationReceiptKey;
  /**
   * The organisation the reservation was saved under, which the receipt row
   * records. Cancelling binds it: from step 8 (0024) the receipts policy
   * shows a transaction only its own organisation's receipts.
   */
  organizationId: string;
  result: unknown;
  reserved: boolean;
};

export type OperatorIssuanceCommandName =
  | "issue_operator_credential"
  | "rotate_operator_credential";

/** Who a revocation is recorded as, in `security_audit_records`. */
export type OperatorAuditActor = {
  actorType: "user" | "agent" | "service" | "system";
  actorId: string;
};

/**
 * Whether migration 0018 has created `operator_credentials` here. The code is
 * deployed before its migration is applied (R2 rule 2), so every path that
 * could run in that window asks this first rather than letting a statement
 * against a missing table abort its transaction.
 */
export async function operatorCredentialsTableExists(
  database: OperatorDatabase,
) {
  const result = await database.execute<{ present: boolean }>(
    sql`select to_regclass('public.operator_credentials') is not null as "present"`,
  );
  return result.rows[0]?.present === true;
}

function issuanceReceiptKey(input: {
  actorUserId: string;
  commandName: OperatorIssuanceCommandName;
  idempotencyKey: string;
  fingerprintSecret: string;
  normalizedInput: unknown;
}): MutationReceiptKey {
  return {
    actorFingerprint: actorFingerprint({ type: "user", id: input.actorUserId }),
    commandName: input.commandName,
    idempotencyFingerprint: keyedFingerprint(
      input.fingerprintSecret,
      input.idempotencyKey,
    ),
    normalizedInputHash: normalizedInputHash(input.normalizedInput),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  };
}

function isPending(result: unknown) {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { status?: unknown }).status === "pending"
  );
}

/**
 * Whether a member may issue a credential reaching `projectId` (null: the
 * whole organisation), locked for the rest of the transaction: an active
 * owner or admin of an active organisation for either, or an active
 * maintainer of an active project for a project-bound one. The rule agent
 * keys follow, and the one `resolveApiKeyCredential` re-checks on every use.
 */
async function lockIssuerAuthority(
  database: OperatorDatabase,
  input: {
    organizationId: string;
    memberUserId: string;
    projectId: string | null;
  },
) {
  const [membership] = await database
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
        eq(organizationMembers.userId, input.memberUserId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!membership) return false;
  const organizationManager =
    membership.role === "owner" || membership.role === "admin";
  if (!input.projectId) return organizationManager;
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
  if (!project) return false;
  if (organizationManager) return true;
  const [maintainer] = await database
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, input.organizationId),
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.memberUserId),
        eq(projectMembers.status, "active"),
        eq(projectMembers.role, "maintainer"),
      ),
    )
    .for("share")
    .limit(1);
  return Boolean(maintainer);
}

/**
 * Refuses a scope list that is not an operator's to hold: every scope must be
 * on the allow-list, and none may be excluded. The table's CHECK refuses the
 * excluded ones again on its own.
 */
function assertOperatorScopes(scopes: readonly string[]) {
  const excluded = new Set<string>(operatorExcludedScopes);
  if (
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) => excluded.has(scope) || !operatorScopes.includes(scope),
    )
  ) {
    throw new DomainError(
      "validation_failed",
      "Operator credential scopes are not admissible",
      { field: "scopes" },
    );
  }
}

/**
 * The rows a revocation changes, for one credential or many: the binding is
 * marked revoked and its version moved, its plugin key is disabled, and one
 * audit row is written in that credential's own organisation. Shared by
 * `revoke_operator_credential` and by F3-13's revocation of everything a
 * member issued, so both leave the same trail.
 */
async function revokeRows(
  database: OperatorDatabase,
  credentials: ReadonlyArray<{
    id: string;
    organizationId: string;
    betterAuthApiKeyId: string | null;
  }>,
  input: { actor: OperatorAuditActor; reason: string; correlationId: string },
) {
  if (credentials.length === 0) return;
  const apiKeyIds = credentials.flatMap((credential) =>
    credential.betterAuthApiKeyId ? [credential.betterAuthApiKeyId] : [],
  );
  if (apiKeyIds.length > 0) {
    await database
      .update(apiKeys)
      .set({ enabled: false, updatedAt: new Date() })
      .where(inArray(apiKeys.id, apiKeyIds));
  }
  await database.insert(securityAuditRecords).values(
    credentials.map((credential) => ({
      organizationId: credential.organizationId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      action: "operator.credential_revoked",
      targetType: "operator_credential",
      targetId: credential.id,
      reason: input.reason,
      fieldNames: ["revokedAt", "version", "betterAuthApiKey.enabled"],
      correlationId: input.correlationId,
    })),
  );
}

/**
 * F3-13: rotating or recovering a member's local credential revokes every
 * operator credential that member issued, in every organisation, in the
 * rotation's own transaction (ruling 11). Answers how many it revoked.
 *
 * Before migration 0018 is applied there is no table and nothing to revoke,
 * and a statement against it would abort the rotation — owner recovery must
 * keep working in that window — so it answers 0 without touching it.
 *
 * It runs across organisations by design and is called only by
 * `bootstrapOwner`, whose one caller, the CLI, runs as the database owner. If
 * row-level security applies to the caller, a revocation would silently reach
 * only the rows the caller's binding shows, so it refuses instead, and the
 * rotation rolls back (F3-15).
 */
export async function revokeOperatorCredentialsIssuedBy(
  database: OperatorDatabase,
  input: { userId: string; actor: OperatorAuditActor; correlationId: string },
) {
  if (!(await operatorCredentialsTableExists(database))) return 0;
  const guard = await database.execute<{ active: boolean }>(
    sql`select row_security_active('public.operator_credentials') as "active"`,
  );
  if (guard.rows[0]?.active !== false) {
    throw new DomainError(
      "configuration_error",
      "Operator credentials cannot be revoked by issuer under row-level security",
    );
  }
  const revoked = await database
    .update(operatorCredentials)
    .set({
      revokedAt: new Date(),
      version: sql`${operatorCredentials.version} + 1`,
    })
    .where(
      and(
        eq(operatorCredentials.memberUserId, input.userId),
        isNull(operatorCredentials.revokedAt),
      ),
    )
    .returning({
      id: operatorCredentials.id,
      organizationId: operatorCredentials.organizationId,
      betterAuthApiKeyId: operatorCredentials.betterAuthApiKeyId,
    });
  await revokeRows(database, revoked, {
    actor: input.actor,
    reason: "The issuer's local credential was rotated or recovered",
    correlationId: input.correlationId,
  });
  return revoked.length;
}

/**
 * The operator credential's repository (Plan 13, F.3). A factory only, with
 * no module-level instance: callers build it on the database or transaction
 * they hold.
 *
 * Tenant binding (manifest-i2.md §2.3). The issuing service's methods that
 * open a transaction of their own bind it to the credential's organisation at
 * its start (a savepoint when handed a transaction, whose binding the
 * enclosing one keeps), and the listing wraps as every pool read does. The
 * lookup by key is a definer call and binds nothing; `touchCredential` binds
 * the organisation that lookup found (D15). `lockCredential`,
 * `lockMemberRole` and `revokeCredential` are the bus's `operatorCredentials`
 * port and run on its transaction, which the bus binds before they run.
 * `cancelIssuance` binds the organisation its reservation carries, because
 * `command_receipts` is under a policy from step 8 (0024).
 * `deleteOrphanApiKey` touches only `apikey`, which no policy covers.
 */
export function createOperatorCredentialRepository(database: OperatorDatabase) {
  return {
    /**
     * F3-14's one answer. On only when the switch it is handed is on and the
     * table exists; otherwise off, with the reason the page shows.
     */
    async availability(
      operatorSwitch: OperatorCredentialSwitch,
    ): Promise<OperatorCredentialAvailability> {
      if (!operatorSwitch.enabled) {
        return { available: false, reason: operatorSwitch.reason };
      }
      return (await operatorCredentialsTableExists(database))
        ? { available: true }
        : { available: false, reason: "not-migrated" };
    },

    /**
     * Reserves an issuance (or a rotation's replacement) before any plugin key
     * exists, as agent keys do. Only a person with a live session row may
     * issue — the check `assertCurrentUser` makes — so the delegated
     * provisioning context, whose credential is a grant, cannot mint one
     * (F3-7) — and only one who may manage what the credential reaches. A
     * replay answers the stored receipt without reserving again.
     */
    async reserveIssuance(input: {
      actorUserId: string;
      sessionId: string;
      organizationId: string;
      projectId: string | null;
      commandName: OperatorIssuanceCommandName;
      idempotencyKey: string;
      fingerprintSecret: string;
      normalizedInput: unknown;
    }): Promise<OperatorIssuanceReceipt> {
      const key = issuanceReceiptKey(input);
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const existing = await lockMutationReceipt(tx, key);
        const [liveSession] = await tx
          .select({ id: session.id })
          .from(session)
          .where(
            and(
              eq(session.id, input.sessionId),
              eq(session.userId, input.actorUserId),
              sql`${session.expiresAt} > clock_timestamp()`,
            ),
          )
          .for("share")
          .limit(1);
        if (
          !liveSession ||
          !(await lockIssuerAuthority(tx, {
            organizationId: input.organizationId,
            memberUserId: input.actorUserId,
            projectId: input.projectId,
          }))
        ) {
          throw new DomainError(
            "forbidden",
            "Operator credential issuance is not permitted",
          );
        }
        const organizationId = input.organizationId;
        if (existing) {
          return {
            key,
            organizationId,
            result: existing.result,
            reserved: false,
          };
        }
        const result = { status: "pending" };
        await saveMutationReceipt(tx, key, { result });
        return { key, organizationId, result, reserved: true };
      });
    },

    /**
     * Removes a receipt that is still pending, so the issuance can be
     * retried, in a transaction bound to the reservation's organisation: the
     * pending receipt is visible only there (manifest-i2.md §2.1, §3 step 8).
     */
    async cancelIssuance(receipt: OperatorIssuanceReceipt) {
      await inTenantTransaction(
        database,
        receipt.organizationId,
        async (tx) => {
          const existing = await lockMutationReceipt(tx, receipt.key);
          if (!existing || !isPending(existing.result)) return;
          await tx.execute(sql`
          delete from "command_receipts"
          where "actor_fingerprint" = ${receipt.key.actorFingerprint}
            and "command_name" = ${receipt.key.commandName}
            and "idempotency_fingerprint" = ${receipt.key.idempotencyFingerprint}
            and "normalized_input_hash" = ${receipt.key.normalizedInputHash}
        `);
        },
      );
    },

    /**
     * Binds a verified Better Auth key to the authority it carries, once the
     * issuer is checked again under lock: an owner or admin for an
     * organisation-wide credential, or an active maintainer of an active
     * project for a project-bound one. With `issuanceReceipt`, the receipt
     * must still be pending, and is settled here with the binding (never the
     * key). The lifetime is `expiresInDays` from now, or, for a rotation's
     * replacement, the old credential's `expiresAt`; the table's CHECK bounds
     * either at 90 days. Session and availability are the issuing service's.
     */
    async createCredential(input: {
      organizationId: string;
      memberUserId: string;
      projectId: string | null;
      betterAuthApiKeyId: string;
      name: string;
      prefix: string;
      fingerprint: string;
      scopes: string[];
      expiresInDays?: number;
      expiresAt?: Date;
      correlationId: string;
      lineageId?: string;
      rotatedFromId?: string;
      issuanceReceipt?: OperatorIssuanceReceipt;
    }): Promise<OperatorCredentialRecord> {
      assertOperatorScopes(input.scopes);
      const expiresInDays = input.expiresInDays;
      if (
        input.expiresAt === undefined &&
        (expiresInDays === undefined ||
          !Number.isInteger(expiresInDays) ||
          expiresInDays < 1 ||
          expiresInDays > operatorCredentialMaxLifetimeDays)
      ) {
        throw new DomainError(
          "validation_failed",
          "Operator credential lifetime is out of range",
          { field: "expiresInDays" },
        );
      }
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        if (input.issuanceReceipt) {
          const receipt = await lockMutationReceipt(
            tx as Tx,
            input.issuanceReceipt.key,
          );
          if (!receipt || !isPending(receipt.result)) {
            throw new DomainError(
              "idempotency_conflict",
              "Operator credential issuance is already settled",
            );
          }
        }
        if (!(await lockIssuerAuthority(tx, input))) {
          throw new DomainError(
            "forbidden",
            "Operator credential issuance is not permitted",
          );
        }

        const id = uuidv7();
        const [created] = await tx
          .insert(operatorCredentials)
          .values({
            id,
            organizationId: input.organizationId,
            memberUserId: input.memberUserId,
            projectId: input.projectId,
            betterAuthApiKeyId: input.betterAuthApiKeyId,
            lineageId: input.lineageId ?? id,
            rotatedFromId: input.rotatedFromId ?? null,
            name: input.name,
            prefix: input.prefix,
            fingerprint: input.fingerprint,
            scopes: input.scopes,
            expiresAt:
              input.expiresAt ??
              sql`now() + make_interval(days => ${expiresInDays})`,
          })
          .returning();
        if (!created) {
          throw new DomainError(
            "conflict",
            "Operator credential was not saved",
          );
        }
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.memberUserId,
          action: "operator.credential_issued",
          targetType: "operator_credential",
          targetId: created.id,
          reason: input.rotatedFromId
            ? "A person rotated an operator credential"
            : "A person issued an operator credential",
          fieldNames: ["scopes", "projectId", "expiresAt"],
          correlationId: input.correlationId,
        });
        const record = {
          id: created.id,
          organizationId: created.organizationId,
          memberUserId: created.memberUserId,
          projectId: created.projectId,
          betterAuthApiKeyId: created.betterAuthApiKeyId,
          lineageId: created.lineageId,
          rotatedFromId: created.rotatedFromId,
          name: created.name,
          prefix: created.prefix,
          fingerprint: created.fingerprint,
          scopes: created.scopes,
          version: created.version,
          expiresAt: created.expiresAt,
          revokedAt: created.revokedAt,
          createdAt: created.createdAt,
        };
        if (input.issuanceReceipt) {
          await updateMutationReceipt(tx as Tx, input.issuanceReceipt.key, {
            aggregateId: created.id,
            result: {
              status: "complete",
              credential: {
                id: record.id,
                name: record.name,
                prefix: record.prefix,
                projectId: record.projectId,
                scopes: record.scopes,
                expiresAt: record.expiresAt.toISOString(),
              },
            },
          });
        }
        return record;
      });
    },

    /**
     * The first half of a rotation's hand-over (F3-8): the old credential
     * lives on only until `overlapExpiresAt`, at most 60 minutes, and never
     * longer than it already would. A stale version, or a credential already
     * revoked, is a `version_conflict`.
     */
    async setCredentialOverlap(input: {
      organizationId: string;
      credentialId: string;
      expectedVersion: number;
      overlapExpiresAt: Date;
      actorUserId: string;
      correlationId: string;
    }) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const [updated] = await tx
          .update(operatorCredentials)
          .set({
            overlapExpiresAt: input.overlapExpiresAt,
            expiresAt: sql`least(${operatorCredentials.expiresAt}, ${input.overlapExpiresAt.toISOString()}::timestamptz)`,
            version: sql`${operatorCredentials.version} + 1`,
          })
          .where(
            and(
              eq(operatorCredentials.organizationId, input.organizationId),
              eq(operatorCredentials.id, input.credentialId),
              isNull(operatorCredentials.revokedAt),
              eq(operatorCredentials.version, input.expectedVersion),
            ),
          )
          .returning({
            id: operatorCredentials.id,
            version: operatorCredentials.version,
          });
        if (!updated) {
          throw new DomainError(
            "version_conflict",
            "Operator credential changed",
          );
        }
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.actorUserId,
          action: "operator.credential_rotation_started",
          targetType: "operator_credential",
          targetId: input.credentialId,
          reason:
            "A person rotated an operator credential with bounded overlap",
          fieldNames: ["overlapExpiresAt", "expiresAt"],
          correlationId: input.correlationId,
        });
        return updated;
      });
    },

    /**
     * Revokes a rotation's replacement when the old credential's overlap
     * could not be set, so a failed rotation leaves one live credential, not
     * two (F3-8, as `api-key-service.ts` compensates for agent keys).
     */
    async revokeCredentialForCompensation(input: {
      organizationId: string;
      credentialId: string;
      actorUserId: string;
      correlationId: string;
      reason: string;
    }) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const [updated] = await tx
          .update(operatorCredentials)
          .set({
            revokedAt: new Date(),
            version: sql`${operatorCredentials.version} + 1`,
          })
          .where(
            and(
              eq(operatorCredentials.organizationId, input.organizationId),
              eq(operatorCredentials.id, input.credentialId),
              isNull(operatorCredentials.revokedAt),
            ),
          )
          .returning({
            id: operatorCredentials.id,
            organizationId: operatorCredentials.organizationId,
            betterAuthApiKeyId: operatorCredentials.betterAuthApiKeyId,
          });
        if (!updated) return null;
        await revokeRows(tx, [updated], {
          actor: { actorType: "user", actorId: input.actorUserId },
          reason: input.reason,
          correlationId: input.correlationId,
        });
        return updated;
      });
    },

    /** Deletes a plugin key whose binding was never written. */
    async deleteOrphanApiKey(apiKeyId: string) {
      await database.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));
    },

    /**
     * Every operator credential in one organisation, newest first. A pool
     * read the settings page makes, wrapped as manifest-i2.md §2.3 item 3
     * says (`withTenantRead`): bound once the application variable is set;
     * handed a transaction, it runs as its opener bound it.
     */
    async listCredentials(
      organizationId: string,
    ): Promise<OperatorCredentialSummary[]> {
      return withTenantRead(
        organizationId,
        async (database) => {
          const rows = await database
            .select()
            .from(operatorCredentials)
            .where(eq(operatorCredentials.organizationId, organizationId))
            .orderBy(
              sql`${operatorCredentials.createdAt} desc, ${operatorCredentials.id} desc`,
            );
          return rows.map((row) => ({
            id: row.id,
            organizationId: row.organizationId,
            memberUserId: row.memberUserId,
            projectId: row.projectId,
            betterAuthApiKeyId: row.betterAuthApiKeyId,
            lineageId: row.lineageId,
            rotatedFromId: row.rotatedFromId,
            name: row.name,
            prefix: row.prefix,
            fingerprint: row.fingerprint,
            scopes: row.scopes,
            version: row.version,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            overlapExpiresAt: row.overlapExpiresAt,
            lastUsedAt: row.lastUsedAt,
            createdAt: row.createdAt,
          }));
        },
        { database, readOnly: true },
      );
    },

    /**
     * Authenticates a key the plugin has verified under the operator
     * configuration: its binding, live, under a live member of a live
     * organisation who still holds the role the credential needs (F3-3). The
     * plugin row may only narrow: it must be enabled, unexpired — a null
     * expiry fails, under SQL's null rules — and still in the operator
     * configuration. A key with no binding resolves nothing.
     *
     * Found before any organisation is known, so through a definer function
     * (manifest-i2.md §2.1, §2.5.0; F3-15's first path): the same joins and
     * predicates this method's own query ran, with the configuration named
     * as the literal `operatorApiKeyConfigId` holds. It binds nothing; the
     * organisation it returns is what the request binds afterwards.
     */
    async resolveApiKeyCredential(input: {
      apiKeyId: string;
    }): Promise<ResolvedOperatorAuthorization | null> {
      const { rows } = await database.execute(
        sql`select * from requestport_private.resolve_operator_credential(${input.apiKeyId})`,
      );
      const credential = rows[0] as ResolvedOperatorRow | undefined;
      return credential
        ? {
            credentialId: credential.credential_id,
            lineageId: credential.lineage_id,
            organizationId: credential.organization_id,
            memberUserId: credential.member_user_id,
            projectId: credential.project_id,
            scopes: credential.scopes,
            credentialFingerprint: credential.credential_fingerprint,
          }
        : null;
    },

    /**
     * Stamps a credential `resolveApiKeyCredential` has just resolved, bound
     * to the organisation that lookup found (D15; F3-15's second path),
     * which the caller hands on: on the pool it wraps as every pool read does
     * (`withTenant`), and the update names the organisation too, so a
     * credential outside it is not stamped.
     */
    async touchCredential(credentialId: string, organizationId: string) {
      await withTenant(
        organizationId,
        (database) =>
          database
            .update(operatorCredentials)
            .set({ lastUsedAt: new Date() })
            .where(
              and(
                eq(operatorCredentials.id, credentialId),
                eq(operatorCredentials.organizationId, organizationId),
              ),
            ),
        { database },
      );
    },

    /** The credential, locked for update, when it is in this organisation. */
    async lockCredential(input: {
      organizationId: string;
      credentialId: string;
    }) {
      const [credential] = await database
        .select({
          id: operatorCredentials.id,
          organizationId: operatorCredentials.organizationId,
          memberUserId: operatorCredentials.memberUserId,
          projectId: operatorCredentials.projectId,
          lineageId: operatorCredentials.lineageId,
          version: operatorCredentials.version,
          revokedAt: operatorCredentials.revokedAt,
        })
        .from(operatorCredentials)
        .where(
          and(
            eq(operatorCredentials.organizationId, input.organizationId),
            eq(operatorCredentials.id, input.credentialId),
          ),
        )
        .for("update")
        .limit(1);
      return credential ?? null;
    },

    /** An active member's organisation role, locked, or null. */
    async lockMemberRole(input: { organizationId: string; userId: string }) {
      const [membership] = await database
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, input.organizationId),
            eq(organizationMembers.userId, input.userId),
            eq(organizationMembers.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      return membership
        ? { role: membership.role as "owner" | "admin" | "member" }
        : null;
    },

    /**
     * Revokes one credential at the version the caller read, recording the
     * actor it is handed. A stale version or a credential already revoked is
     * a `version_conflict`, as for agent keys.
     */
    async revokeCredential(input: {
      organizationId: string;
      credentialId: string;
      expectedVersion: number;
      actor: OperatorAuditActor;
      reason: string;
      correlationId: string;
    }) {
      const [updated] = await database
        .update(operatorCredentials)
        .set({
          revokedAt: new Date(),
          version: sql`${operatorCredentials.version} + 1`,
        })
        .where(
          and(
            eq(operatorCredentials.organizationId, input.organizationId),
            eq(operatorCredentials.id, input.credentialId),
            isNull(operatorCredentials.revokedAt),
            eq(operatorCredentials.version, input.expectedVersion),
          ),
        )
        .returning({
          id: operatorCredentials.id,
          organizationId: operatorCredentials.organizationId,
          betterAuthApiKeyId: operatorCredentials.betterAuthApiKeyId,
          version: operatorCredentials.version,
        });
      if (!updated) {
        throw new DomainError(
          "version_conflict",
          "Operator credential changed",
        );
      }
      await revokeRows(database, [updated], input);
      return {
        id: updated.id,
        revoked: true as const,
        version: updated.version,
      };
    },
  };
}

export type OperatorCredentialRepository = ReturnType<
  typeof createOperatorCredentialRepository
>;
