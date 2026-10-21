import { createHash, randomUUID } from "node:crypto";

import {
  type ActorRef,
  actorFingerprint,
  auditActor,
  DomainError,
  keyedFingerprint,
  normalizedInputHash,
  redactSensitiveText,
  validateCommandMeta,
} from "@requestport/domain";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "../client.js";
import {
  agentCredentials,
  agentOauthGrants,
  agentPrincipals,
  apiKeys,
  commandReceipts,
  domainEvents,
  lanes,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  organizationMembers,
  organizations,
  outbox,
  projectMembers,
  projects,
  securityAuditRecords,
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

type AgentAuthDatabase = Database | Tx;

function withAgentAuthTransaction<T>(
  database: AgentAuthDatabase,
  operation: (transaction: AgentAuthDatabase) => Promise<T>,
) {
  const candidate = database as AgentAuthDatabase & {
    transaction?: <TResult>(
      callback: (transaction: Tx) => Promise<TResult>,
    ) => Promise<TResult>;
  };
  return candidate.transaction
    ? candidate.transaction(operation)
    : operation(database);
}

export type ResolvedAgentAuthorization = {
  authorizationId: string;
  organizationId: string;
  agentPrincipalId: string;
  delegatedByUserId: string | null;
  audience: "mcp" | "api";
  /**
   * Null only for an exclusively-provisioning grant, whose capability is
   * organization-wide and which therefore names no project.
   *
   * Consumers must not treat null as "any project". `requireAgentProject`
   * already refuses an agent context with no project, and that refusal is what
   * keeps a provisioning grant out of every project-scoped command — so the
   * null is safe precisely because nothing downstream accepts it.
   */
  projectId: string | null;
  laneIds: string[];
  scopes: string[];
  /**
   * Never set since the lookups moved to definer functions (Plan 13, I.2;
   * manifest-i2.md §2.5.0), which return only what a caller reads, and no
   * caller reads this. Optional so callers' fixtures that still carry it
   * type-check; it goes when they drop it.
   */
  expiresAt?: Date;
  credentialFingerprint: string;
  oauthTokenBindingFingerprint?: string;
};

/*
 * The rows the definer lookups return (0019_row_security_expand.sql), as the
 * driver hands them over: snake_case, uuids as text, jsonb parsed.
 */
type ResolvedGrantRow = {
  authorization_id: string;
  organization_id: string;
  agent_principal_id: string;
  delegated_by_user_id: string;
  audience: string;
  project_id: string | null;
  lane_ids: string[];
  scopes: string[];
  refresh_family_id: string;
};

type ResolvedCredentialRow = {
  authorization_id: string;
  organization_id: string;
  agent_principal_id: string;
  audience: string;
  project_id: string;
  lane_ids: string[];
  scopes: string[];
  credential_fingerprint: string;
};

async function lockCredentialManager(
  database: AgentAuthDatabase,
  input: {
    organizationId: string;
    credentialId: string;
    actorUserId: string;
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
        eq(organizationMembers.userId, input.actorUserId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!membership) {
    throw new DomainError("forbidden", "Agent credential management is denied");
  }
  const [credential] = await database
    .select({
      id: agentCredentials.id,
      betterAuthApiKeyId: agentCredentials.betterAuthApiKeyId,
      projectId: agentCredentials.projectId,
      revokedAt: agentCredentials.revokedAt,
      version: agentCredentials.version,
    })
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.organizationId, input.organizationId),
        eq(agentCredentials.id, input.credentialId),
      ),
    )
    .for("update")
    .limit(1);
  if (!credential) return null;
  if (membership.role !== "owner" && membership.role !== "admin") {
    const [projectManager] = await database
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.organizationId, input.organizationId),
          eq(projectMembers.projectId, credential.projectId),
          eq(projectMembers.userId, input.actorUserId),
          eq(projectMembers.status, "active"),
          eq(projectMembers.role, "maintainer"),
        ),
      )
      .for("share")
      .limit(1);
    if (!projectManager) {
      throw new DomainError(
        "forbidden",
        "Agent credential management is denied",
      );
    }
  }
  return credential;
}

function oauthTokenBindingFingerprint(
  clientId: string,
  refreshFamilyId: string,
) {
  return createHash("sha256")
    .update(clientId)
    .update("\0")
    .update(refreshFamilyId)
    .digest("base64url");
}

/**
 * How many grant fingerprints the family claim may carry.
 *
 * It is capped because the claim rides inside every access token this provider
 * mints, and a token is not a place to keep an unbounded list.
 *
 * This number used to be justified by a matching refusal in
 * `authenticate-bearer.ts`, which rejected any claim holding more than a
 * hundred entries. That refusal is gone: it could never fire, because this cap
 * is what built the claim in the first place, and an untested branch defending
 * against something it makes impossible is worse than no branch at all. So the
 * number is now load-bearing here and nowhere else, which is why the ordering
 * below matters — a truncated claim must at least be the same hundred every
 * time, and must hold the grant a person has just approved.
 */
const grantFamilyClaimLimit = 100;

export type AgentGrantFamilyFingerprints = {
  fingerprints: string[];
  /**
   * True when the person holds more usable grants than the claim can carry.
   *
   * The dropped grants still exist and still authorize their agents; they just
   * cannot prove it, and the refusal they get says only that a grant is
   * unavailable. Returning the fact lets the caller say so somewhere a person
   * can read it.
   */
  truncated: boolean;
};

export type AgentCredentialSummary = {
  id: string;
  /**
   * Carried so a rotation can preserve it.
   *
   * Without it `rotate` re-issued through `issue` with no lineage and the
   * replacement was written as though a human had made it — outliving the
   * revocation of the grant that authorized the original. One rotation
   * laundered a minted credential into an unrevokable one, which is the same
   * hole the foreign key opened by another route.
   */
  issuedByGrantId: string | null;
  agentPrincipalId: string;
  name: string;
  prefix: string;
  fingerprint: string;
  audience: "mcp" | "api";
  projectId: string;
  laneIds: string[];
  scopes: string[];
  version: number;
  expiresAt: Date;
  revokedAt: Date | null;
  overlapExpiresAt: Date | null;
  lastUsedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
};

export type CredentialIssuanceReceipt = {
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

async function invalidateOAuthProviderTokens(
  database: AgentAuthDatabase,
  input: { userId: string; clientId: string },
) {
  await database
    .delete(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.userId, input.userId),
        eq(oauthAccessTokens.clientId, input.clientId),
      ),
    );
  await database
    .delete(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.userId, input.userId),
        eq(oauthRefreshTokens.clientId, input.clientId),
      ),
    );
}

/**
 * The receipt key of a credential mutation. It is named for the actor who
 * acts: `actor` when given (Plan 13, F.2.2: an operator's own `service`
 * actor, so an operator's retry never meets its member's receipt), and
 * otherwise the person `actorUserId`, as every caller before F.2.2 named it.
 */
function credentialMutationKey(input: {
  actorUserId: string;
  actor?: ActorRef;
  commandName: string;
  idempotencyKey: string;
  fingerprintSecret: string;
  normalizedInput: unknown;
}) {
  return {
    actorFingerprint: actorFingerprint(
      input.actor ?? { type: "user", id: input.actorUserId },
    ),
    commandName: input.commandName,
    idempotencyFingerprint: keyedFingerprint(
      input.fingerprintSecret,
      input.idempotencyKey,
    ),
    normalizedInputHash: normalizedInputHash(input.normalizedInput),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  } satisfies MutationReceiptKey;
}

/**
 * The `actor_type` and `actor_id` of a revocation's audit row: the acting
 * `actor` as `auditActor` records it when given (an operator as `service` and
 * `operator:<lineage>`, never as its member), and otherwise the person
 * `actorUserId` as `user`.
 */
function revocationAuditActor(input: {
  actorUserId: string;
  actor?: ActorRef;
}) {
  return auditActor({
    actor: input.actor ?? { type: "user", id: input.actorUserId },
  });
}

export function createAgentAuthRepository(database: AgentAuthDatabase) {
  /** For the pool reads the application makes (manifest-i2.md §2.3 item 3). */
  const withTenantReadOn = <T>(
    organizationId: string,
    work: (database: AgentAuthDatabase) => Promise<T>,
    readOnly = false,
  ) => withTenantRead(organizationId, work, { database, readOnly });

  return {
    async reserveCredentialIssuance(input: {
      actorUserId: string;
      organizationId: string;
      projectId: string;
      idempotencyKey: string;
      expectedVersion: number;
      fingerprintSecret: string;
      normalizedInput: unknown;
    }): Promise<CredentialIssuanceReceipt> {
      validateCommandMeta(input);
      if (input.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "New credentials require expected version zero",
        );
      }
      const key = credentialMutationKey({
        ...input,
        commandName: "issue_agent_credential",
      });
      return inTenantTransaction(
        database,
        input.organizationId,
        async (candidate) => {
          const tx = candidate as Tx;
          const existing = await lockMutationReceipt(tx, key);
          const [organization] = await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(
              and(
                eq(organizations.id, input.organizationId),
                eq(organizations.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          const [membership] = await tx
            .select({ role: organizationMembers.role })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, input.organizationId),
                eq(organizationMembers.userId, input.actorUserId),
                eq(organizationMembers.status, "active"),
              ),
            )
            .for("share")
            .limit(1);
          const [project] = await tx
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
          if (!organization || !membership || !project) {
            throw new DomainError(
              "forbidden",
              "Agent credential issuance is denied",
            );
          }
          if (membership.role !== "owner" && membership.role !== "admin") {
            const [projectManager] = await tx
              .select({ id: projectMembers.id })
              .from(projectMembers)
              .where(
                and(
                  eq(projectMembers.organizationId, input.organizationId),
                  eq(projectMembers.projectId, input.projectId),
                  eq(projectMembers.userId, input.actorUserId),
                  eq(projectMembers.status, "active"),
                  eq(projectMembers.role, "maintainer"),
                ),
              )
              .for("share")
              .limit(1);
            if (!projectManager) {
              throw new DomainError(
                "forbidden",
                "Agent credential issuance is denied",
              );
            }
          }
          const organizationId = input.organizationId;
          if (existing)
            return {
              key,
              organizationId,
              result: existing.result,
              reserved: false,
            };
          const result = { status: "pending" };
          await saveMutationReceipt(tx, key, { result });
          return { key, organizationId, result, reserved: true };
        },
      );
    },

    async cancelCredentialIssuance(receipt: CredentialIssuanceReceipt) {
      // Bound to the reservation's organisation: the pending receipt is
      // visible only there (manifest-i2.md §2.1, §3 step 8).
      return inTenantTransaction(
        database,
        receipt.organizationId,
        async (candidate) => {
          const tx = candidate as Tx;
          const existing = await lockMutationReceipt(tx, receipt.key);
          if (
            existing &&
            typeof existing.result === "object" &&
            existing.result !== null &&
            !Array.isArray(existing.result) &&
            existing.result.status === "pending"
          ) {
            await tx
              .delete(commandReceipts)
              .where(
                and(
                  eq(
                    commandReceipts.actorFingerprint,
                    receipt.key.actorFingerprint,
                  ),
                  eq(commandReceipts.commandName, receipt.key.commandName),
                  eq(
                    commandReceipts.idempotencyFingerprint,
                    receipt.key.idempotencyFingerprint,
                  ),
                  eq(
                    commandReceipts.normalizedInputHash,
                    receipt.key.normalizedInputHash,
                  ),
                ),
              );
          }
        },
      );
    },

    /**
     * The grant an agent's OAuth token presents, found before any
     * organisation is known, so through a definer function
     * (manifest-i2.md §2.5.0): the same joins and predicates this method
     * ran, the organisation's membership and project standing included.
     */
    async resolveOAuthGrant(input: {
      userId: string;
      clientId: string;
      audience: "mcp" | "api";
    }): Promise<ResolvedAgentAuthorization | null> {
      const { rows } = await database.execute(
        sql`select * from requestport_private.resolve_oauth_grant(${input.userId}, ${input.clientId}, ${input.audience})`,
      );
      const grant = rows[0] as ResolvedGrantRow | undefined;
      return grant
        ? {
            authorizationId: grant.authorization_id,
            organizationId: grant.organization_id,
            agentPrincipalId: grant.agent_principal_id,
            delegatedByUserId: grant.delegated_by_user_id,
            audience: grant.audience as "mcp" | "api",
            projectId: grant.project_id,
            laneIds: grant.lane_ids,
            scopes: grant.scopes,
            credentialFingerprint: `oauth:${grant.authorization_id}:${grant.refresh_family_id}`,
            oauthTokenBindingFingerprint: oauthTokenBindingFingerprint(
              input.clientId,
              grant.refresh_family_id,
            ),
          }
        : null;
    },

    /**
     * The person's usable grant families, through a definer function
     * (manifest-i2.md §2.5.0), because they span organisations.
     *
     * Newest first, and the tie broken so the order is total (`created_at
     * desc, id desc`, in the function). Capped and unordered, the hundred
     * were whichever hundred the plan happened to produce, and a different
     * hundred next mint. The grant a person has just consented to is the one
     * that suffers: consent writes it, the token is minted moments later, and
     * if that arbitrary hundred left it out then every request the new
     * connection makes is refused with "OAuth agent grant is unavailable" —
     * a bare 401, for a connection they just authorized, that no amount of
     * retrying fixes.
     *
     * Nothing here can choose the right hundred, because nothing here knows
     * which client is asking: the provider hands `customAccessTokenClaims`
     * the person and the resource, never the client. Recency is therefore the
     * best available order, and it is the one that matters — it puts the
     * grant consent just wrote at the front, so the connection a person
     * completes always works, and what the cap sheds is their oldest
     * connections, each recoverable by consenting to it again.
     *
     * The function returns at most `grantFamilyClaimLimit + 1` rows — one
     * past the cap, a constant in its body — so a dropped grant can be
     * reported rather than inferred. Asking for exactly the cap cannot tell
     * "a hundred grants and all of them claimed" from "a hundred and one and
     * one silently missing", which are the two cases a person needs told
     * apart.
     */
    async listOAuthGrantBindingFingerprints(input: {
      userId: string;
      audience: "mcp" | "api";
    }): Promise<AgentGrantFamilyFingerprints> {
      const { rows } = await database.execute(
        sql`select * from requestport_private.list_oauth_grant_binding_fingerprints(${input.userId}, ${input.audience})`,
      );
      const families = rows as {
        client_id: string;
        refresh_family_id: string;
      }[];
      const claimed = families.slice(0, grantFamilyClaimLimit);
      return {
        fingerprints: claimed.map((row) =>
          oauthTokenBindingFingerprint(row.client_id, row.refresh_family_id),
        ),
        truncated: families.length > claimed.length,
      };
    },

    async invalidateUnboundOAuthProviderAuthorization(input: {
      userId: string;
      clientId: string;
    }) {
      await withAgentAuthTransaction(database, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('requestport:oauth-grant:' || ${input.userId} || ':' || ${input.clientId}, 0))`,
        );
        /**
         * Usable, not merely unrevoked: active, unrevoked and unexpired. A
         * lapsed grant used to look active here, the repair declined, and the
         * pair stayed exactly as stranded as if no grant had ever existed.
         * The consent screen is skipped in that state, which is the state the
         * screen would have fixed.
         *
         * Across organisations, so through a definer function
         * (manifest-i2.md §2.5.0). It checks less than `resolveOAuthGrant`
         * does — no principal, organisation, membership or project — which
         * is this method's behaviour before the move, kept and recorded
         * there rather than changed here.
         */
        const { rows } = await tx.execute(
          sql`select requestport_private.has_usable_oauth_grant(${input.userId}, ${input.clientId}) as usable`,
        );
        if ((rows[0] as { usable: boolean } | undefined)?.usable) return;
        await tx
          .update(oauthConsents)
          .set({ scopes: [], updatedAt: new Date() })
          .where(
            and(
              eq(oauthConsents.userId, input.userId),
              eq(oauthConsents.clientId, input.clientId),
            ),
          );
        await invalidateOAuthProviderTokens(tx, input);
      });
    },

    /**
     * The credential an agent's API key presents, found before any
     * organisation is known, so through a definer function
     * (manifest-i2.md §2.5.0): the same joins and predicates this method
     * ran. A credential a human issued records no grant and is unaffected;
     * one a provisioning grant minted resolves only while that grant, in the
     * credential's own organisation, is still usable — which is what makes
     * revoking a compromised provisioning grant revoke its children in one
     * act.
     */
    async resolveApiKeyCredential(input: {
      apiKeyId: string;
      audience: "mcp" | "api";
    }): Promise<ResolvedAgentAuthorization | null> {
      const { rows } = await database.execute(
        sql`select * from requestport_private.resolve_api_key_credential(${input.apiKeyId}, ${input.audience})`,
      );
      const credential = rows[0] as ResolvedCredentialRow | undefined;
      return credential
        ? {
            authorizationId: credential.authorization_id,
            organizationId: credential.organization_id,
            agentPrincipalId: credential.agent_principal_id,
            delegatedByUserId: null,
            audience: credential.audience as "mcp" | "api",
            projectId: credential.project_id,
            laneIds: credential.lane_ids,
            scopes: credential.scopes,
            credentialFingerprint: credential.credential_fingerprint,
          }
        : null;
    },

    async bindOAuthConsent(input: {
      organizationId: string;
      agentPrincipalId: string;
      userId: string;
      clientId: string;
      audience: "mcp" | "api";
      /**
       * Null for an exclusively-provisioning grant, whose capability is
       * organization-wide and which therefore names no project.
       */
      projectId: string | null;
      laneIds: string[];
      scopes: string[];
      expiresAt: Date;
      correlationId: string;
      expectedVersion: 0;
      idempotencyKey: string;
      fingerprintSecret: string;
      newPrincipal?: {
        id: string;
        displayName: string;
        slug: string;
        softwareName: string;
      };
    }) {
      validateCommandMeta(input);
      if (input.expectedVersion !== 0) {
        throw new DomainError(
          "version_conflict",
          "New OAuth grant bindings require expected version zero",
        );
      }
      const receipt = credentialMutationKey({
        actorUserId: input.userId,
        commandName: "bind_agent_oauth_grant",
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: input.fingerprintSecret,
        normalizedInput: {
          organizationId: input.organizationId,
          agentPrincipalId: input.agentPrincipalId,
          clientId: input.clientId,
          audience: input.audience,
          projectId: input.projectId,
          laneIds: [...input.laneIds].sort(),
          scopes: [...input.scopes].sort(),
          // `?? null` because the canonical hash refuses `undefined`, and
          // consenting as an existing agent principal leaves this absent — the
          // exact case that never reached the database at all.
          newPrincipal: input.newPrincipal ?? null,
        },
      });
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('requestport:oauth-grant:' || ${input.userId} || ':' || ${input.clientId}, 0))`,
        );
        const [organization] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.id, input.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!organization) {
          throw new DomainError("forbidden", "OAuth agent consent is denied");
        }
        const [membership] = await tx
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
        if (!membership) {
          throw new DomainError("forbidden", "OAuth agent consent is denied");
        }
        const [client] = await tx
          .select({ id: oauthClients.clientId })
          .from(oauthClients)
          .where(
            and(
              eq(oauthClients.clientId, input.clientId),
              eq(oauthClients.disabled, false),
              // Public is read off the token endpoint method, not the
              // `public` column: Better Auth 1.6.29 wrote `public` as exactly
              // "the method is `none`", 1.7 has no field for it, and 0022
              // (K.4) drops the column.
              eq(oauthClients.tokenEndpointAuthMethod, "none"),
              // Null, not false, is what dynamic client registration writes:
              // the public register endpoint strips `require_pkce`, and Better
              // Auth reads the absence as "required" and enforces PKCE anyway.
              // Demanding a literal true here refused every client an agent can
              // register for itself.
              or(
                isNull(oauthClients.requirePKCE),
                eq(oauthClients.requirePKCE, true),
              ),
            ),
          )
          .for("share")
          .limit(1);
        if (!client) {
          throw new DomainError("forbidden", "OAuth agent consent is denied");
        }
        /**
         * Looked up only when the grant names one.
         *
         * A provisioning grant is organization-wide and names no project, so an
         * unconditional lookup matched no row and refused the consent — the
         * refusal rules all worked while the happy path could never run. The
         * check is skipped rather than loosened: a grant that DOES name a
         * project is still held to an active one in this organization.
         */
        if (input.projectId !== null) {
          const [project] = await tx
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
          if (!project) {
            throw new DomainError("forbidden", "OAuth agent consent is denied");
          }
        }
        if (input.laneIds.length > 0) {
          /**
           * A lane belongs to a project, so a grant naming no project cannot
           * name a lane either. Refused rather than ignored: silently dropping
           * a restriction the caller asked for would hand back a grant broader
           * than the one they consented to.
           */
          if (input.projectId === null) {
            throw new DomainError("forbidden", "OAuth agent consent is denied");
          }
          const projectId = input.projectId;
          const distinctLaneIds = [...new Set(input.laneIds)];
          const selectedLanes = await tx
            .select({ id: lanes.id })
            .from(lanes)
            .where(
              and(
                eq(lanes.organizationId, input.organizationId),
                eq(lanes.projectId, projectId),
                eq(lanes.status, "active"),
                inArray(lanes.id, distinctLaneIds),
              ),
            )
            .for("share");
          if (selectedLanes.length !== distinctLaneIds.length) {
            throw new DomainError(
              "validation_failed",
              "OAuth agent lane binding is invalid",
            );
          }
        }
        const organizationManager = ["owner", "admin"].includes(
          membership.role,
        );
        if (!organizationManager) {
          /**
           * Maintainer standing is standing *in a project*. A grant that names
           * none leaves organization standing as the only thing that could
           * authorize it — which is what the provisioning rules demand anyway,
           * and is stricter than falling through to a lookup that would match
           * nothing.
           */
          if (input.projectId === null) {
            throw new DomainError("forbidden", "OAuth agent consent is denied");
          }
          const scopedProjectId = input.projectId;
          const [projectManager] = await tx
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.organizationId, input.organizationId),
                eq(projectMembers.projectId, scopedProjectId),
                eq(projectMembers.userId, input.userId),
                eq(projectMembers.status, "active"),
                eq(projectMembers.role, "maintainer"),
              ),
            )
            .for("share")
            .limit(1);
          if (!projectManager) {
            throw new DomainError("forbidden", "OAuth agent consent is denied");
          }
        }
        const [consent] = await tx
          .select({ id: oauthConsents.id })
          .from(oauthConsents)
          .where(
            and(
              eq(oauthConsents.clientId, input.clientId),
              eq(oauthConsents.userId, input.userId),
            ),
          )
          .orderBy(
            sql`${oauthConsents.updatedAt} desc nulls last, ${oauthConsents.createdAt} desc nulls last`,
          )
          .limit(1);
        if (!consent) throw new Error("OAuth consent was not persisted");
        const replay = await lockMutationReceipt(tx as Tx, receipt);
        if (replay) return replay.result as { id: string };
        let principal:
          | {
              id: string;
              projectId: string | null;
              displayName: string;
              slug: string;
              status: string;
              version: number;
            }
          | undefined;
        if (input.newPrincipal) {
          if (input.newPrincipal.id !== input.agentPrincipalId) {
            throw new DomainError(
              "validation_failed",
              "New agent principal binding is invalid",
            );
          }
          [principal] = await tx
            .insert(agentPrincipals)
            .values({
              id: input.newPrincipal.id,
              organizationId: input.organizationId,
              projectId: input.projectId,
              displayName: input.newPrincipal.displayName,
              slug: input.newPrincipal.slug,
              softwareName: input.newPrincipal.softwareName,
              status: "active",
              createdByUserId: input.userId,
            })
            .onConflictDoNothing()
            .returning({
              id: agentPrincipals.id,
              projectId: agentPrincipals.projectId,
              displayName: agentPrincipals.displayName,
              slug: agentPrincipals.slug,
              status: agentPrincipals.status,
              version: agentPrincipals.version,
            });
        }
        if (!principal) {
          [principal] = await tx
            .select({
              id: agentPrincipals.id,
              projectId: agentPrincipals.projectId,
              displayName: agentPrincipals.displayName,
              slug: agentPrincipals.slug,
              status: agentPrincipals.status,
              version: agentPrincipals.version,
            })
            .from(agentPrincipals)
            .where(
              and(
                eq(agentPrincipals.organizationId, input.organizationId),
                eq(agentPrincipals.id, input.agentPrincipalId),
                eq(agentPrincipals.status, "active"),
                /**
                 * A principal serves this grant if it is organization-scoped,
                 * or if it belongs to the very project the grant names. A
                 * provisioning grant names none, so only the first can apply —
                 * a principal belonging to some project could otherwise be
                 * lent organization-wide authority it was never given.
                 */
                input.projectId === null
                  ? isNull(agentPrincipals.projectId)
                  : or(
                      isNull(agentPrincipals.projectId),
                      eq(agentPrincipals.projectId, input.projectId),
                    ),
              ),
            )
            .for("share")
            .limit(1);
        }
        if (!principal) {
          /*
            A name already taken is not a permission problem.

            `agent_principals` is unique on (organization, lower(slug)), and
            the insert above declines a conflict rather than failing. The
            lookup that follows is keyed on the proposed id — which is derived
            from the request, so connecting the same agent again derives a new
            one while its name, and therefore its slug, does not change. The
            insert wrote nothing, the id was never there to find, and
            reconnecting any agent answered "you do not have permission to
            authorize this connection" for as long as the first principal
            existed. Saying which of the two it is makes it something a person
            can act on: the principal is already on the screen to be chosen.
          */
          if (input.newPrincipal) {
            const [taken] = await tx
              .select({ id: agentPrincipals.id })
              .from(agentPrincipals)
              .where(
                and(
                  eq(agentPrincipals.organizationId, input.organizationId),
                  sql`lower(${agentPrincipals.slug}) = lower(${input.newPrincipal.slug})`,
                ),
              )
              .limit(1);
            if (taken) {
              throw new DomainError(
                "conflict",
                "An agent principal with that stable slug already exists in this organization",
                // Named so the screen can put it on the control it is about,
                // where the person can change it, rather than in a banner that
                // tells them to reload something that will fail again.
                { field: "slug" },
              );
            }
          }

          throw new DomainError("forbidden", "Agent principal is unavailable");
        }
        if (input.newPrincipal && principal.id === input.newPrincipal.id) {
          const [existingEvent] = await tx
            .select({ id: domainEvents.id })
            .from(domainEvents)
            .where(
              and(
                eq(domainEvents.aggregateType, "agent_principal"),
                eq(domainEvents.aggregateId, principal.id),
                eq(domainEvents.aggregateVersion, principal.version),
              ),
            )
            .limit(1);
          if (!existingEvent) {
            const eventId = uuidv7();
            await tx.insert(domainEvents).values({
              id: eventId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              aggregateType: "agent_principal",
              aggregateId: principal.id,
              aggregateVersion: principal.version,
              type: "agent.registered.v1",
              schemaVersion: 1,
              actor: { type: "user", id: input.userId },
              correlationId: input.correlationId,
              causationId: input.correlationId,
              data: {
                agentPrincipalId: principal.id,
                projectId: principal.projectId,
                displayName: redactSensitiveText(principal.displayName),
                slug: principal.slug,
                status: "active",
              },
              links: {},
            });
            await tx.insert(outbox).values({ eventId, state: "pending" });
          }
        }
        await invalidateOAuthProviderTokens(tx, {
          userId: input.userId,
          clientId: input.clientId,
        });
        // The person's live grants for this client, in every organisation:
        // the unique index allows one per (user, client). Across
        // organisations, so through a definer function, inside this
        // transaction because it writes (manifest-i2.md §2.5.0 item 7).
        await tx.execute(
          sql`select requestport_private.revoke_user_client_oauth_grants(${input.userId}, ${input.clientId})`,
        );
        const [created] = await tx
          .insert(agentOauthGrants)
          .values({
            id: randomUUID(),
            organizationId: input.organizationId,
            agentPrincipalId: input.agentPrincipalId,
            userId: input.userId,
            oauthClientId: input.clientId,
            providerGrantId: consent.id,
            refreshFamilyId: randomUUID(),
            audience: input.audience,
            projectId: input.projectId,
            laneIds: input.laneIds,
            scopes: input.scopes,
            status: "active",
            expiresAt: input.expiresAt,
          })
          .returning({ id: agentOauthGrants.id });
        if (!created) throw new Error("OAuth agent grant persistence failed");
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.userId,
          action: "agent.oauth_grant_bound",
          targetType: "agent_oauth_grant",
          targetId: created.id,
          reason: "Human approved an OAuth agent connection",
          fieldNames: [
            "agentPrincipalId",
            "projectId",
            "audience",
            "scopes",
            "expiresAt",
          ],
          correlationId: input.correlationId,
        });
        await saveMutationReceipt(tx as Tx, receipt, {
          aggregateId: created.id,
          result: created,
        });
        return created;
      });
    },

    async createCredential(input: {
      organizationId: string;
      agentPrincipalId: string;
      betterAuthApiKeyId: string;
      name: string;
      prefix: string;
      fingerprint: string;
      audience: "mcp" | "api";
      projectId: string;
      laneIds: string[];
      scopes: string[];
      expiresAt: Date;
      overlapExpiresAt?: Date;
      createdByUserId: string;
      correlationId: string;
      /**
       * The provisioning grant minting this credential, when a grant is doing
       * the minting. Omitted when a signed-in human issues one in the UI, which
       * is what leaves the lineage null and the credential unaffected by any
       * grant revocation.
       */
      issuedByGrantId?: string;
      issuanceReceipt?: CredentialIssuanceReceipt;
    }) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        if (input.issuanceReceipt) {
          const receipt = await lockMutationReceipt(
            tx as Tx,
            input.issuanceReceipt.key,
          );
          if (
            !receipt ||
            typeof receipt.result !== "object" ||
            receipt.result === null ||
            Array.isArray(receipt.result) ||
            receipt.result.status !== "pending"
          ) {
            throw new DomainError(
              "idempotency_conflict",
              "Credential issuance is already settled",
            );
          }
        }
        const [organization] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.id, input.organizationId),
              eq(organizations.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!organization) {
          throw new DomainError(
            "forbidden",
            "Agent credential binding is denied",
          );
        }
        const [membership] = await tx
          .select({ role: organizationMembers.role })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.organizationId, input.organizationId),
              eq(organizationMembers.userId, input.createdByUserId),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!membership) {
          throw new DomainError(
            "forbidden",
            "Agent credential binding is denied",
          );
        }
        const [project] = await tx
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
        if (!project) {
          throw new DomainError(
            "forbidden",
            "Agent credential binding is denied",
          );
        }
        const organizationManager = ["owner", "admin"].includes(
          membership.role,
        );
        if (!organizationManager) {
          const [projectManager] = await tx
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.organizationId, input.organizationId),
                eq(projectMembers.projectId, input.projectId),
                eq(projectMembers.userId, input.createdByUserId),
                eq(projectMembers.status, "active"),
                eq(projectMembers.role, "maintainer"),
              ),
            )
            .for("share")
            .limit(1);
          if (!projectManager) {
            throw new DomainError(
              "forbidden",
              "Agent credential binding is denied",
            );
          }
        }
        const [principal] = await tx
          .select({ id: agentPrincipals.id })
          .from(agentPrincipals)
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
          throw new DomainError(
            "forbidden",
            "Agent project binding is invalid",
          );
        }
        if (input.issuedByGrantId) {
          /**
           * A grant may only mint while it is itself usable, and the share lock
           * holds that true until this transaction commits — without it a
           * revocation landing between this check and the insert below would
           * leave behind a credential whose parent is already dead.
           *
           * The organization must match for the same reason it does at
           * resolution: the foreign key names the grant's primary key alone, so
           * nothing else stops a credential citing another tenant's grant.
           */
          const [issuingGrant] = await tx
            .select({ id: agentOauthGrants.id })
            .from(agentOauthGrants)
            .where(
              and(
                eq(agentOauthGrants.id, input.issuedByGrantId),
                eq(agentOauthGrants.organizationId, input.organizationId),
                eq(agentOauthGrants.status, "active"),
                isNull(agentOauthGrants.revokedAt),
                sql`${agentOauthGrants.expiresAt} > clock_timestamp()`,
              ),
            )
            .for("share")
            .limit(1);
          if (!issuingGrant) {
            throw new DomainError(
              "forbidden",
              "Agent credential binding is denied",
            );
          }
        }
        if (input.laneIds.length > 0) {
          const allowedLanes = await tx
            .select({ id: lanes.id })
            .from(lanes)
            .where(
              and(
                eq(lanes.organizationId, input.organizationId),
                eq(lanes.projectId, input.projectId),
                eq(lanes.status, "active"),
                inArray(lanes.id, [...new Set(input.laneIds)]),
              ),
            )
            .for("share");
          if (allowedLanes.length !== new Set(input.laneIds).size) {
            throw new DomainError(
              "validation_failed",
              "Agent lane binding is invalid",
            );
          }
        }
        const [created] = await tx
          .insert(agentCredentials)
          .values({
            id: randomUUID(),
            organizationId: input.organizationId,
            agentPrincipalId: input.agentPrincipalId,
            betterAuthApiKeyId: input.betterAuthApiKeyId,
            name: input.name,
            prefix: input.prefix,
            fingerprint: input.fingerprint,
            audience: input.audience,
            projectId: input.projectId,
            laneIds: input.laneIds,
            scopes: input.scopes,
            expiresAt: input.expiresAt,
            overlapExpiresAt: input.overlapExpiresAt,
            issuedByGrantId: input.issuedByGrantId,
            createdByUserId: input.createdByUserId,
          })
          .returning();
        if (!created) throw new Error("Agent credential persistence failed");
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.createdByUserId,
          action: "agent.credential_issued",
          targetType: "agent_credential",
          targetId: created.id,
          reason: "Human issued a scoped agent credential",
          fieldNames: [
            "agentPrincipalId",
            "projectId",
            "laneIds",
            "scopes",
            "audience",
            "expiresAt",
          ],
          correlationId: input.correlationId,
        });
        if (input.issuanceReceipt) {
          await updateMutationReceipt(tx as Tx, input.issuanceReceipt.key, {
            aggregateId: created.id,
            result: {
              status: "complete",
              credential: {
                id: created.id,
                agentPrincipalId: created.agentPrincipalId,
                name: created.name,
                prefix: created.prefix,
                fingerprint: created.fingerprint,
                audience: created.audience,
                projectId: created.projectId,
                laneIds: created.laneIds,
                scopes: created.scopes,
                version: created.version,
                expiresAt: created.expiresAt.toISOString(),
                revokedAt: created.revokedAt?.toISOString() ?? null,
                overlapExpiresAt:
                  created.overlapExpiresAt?.toISOString() ?? null,
                lastUsedAt: created.lastUsedAt?.toISOString() ?? null,
                createdByUserId: created.createdByUserId,
                createdAt: created.createdAt.toISOString(),
              },
            },
          });
        }
        return created;
      });
    },

    /**
     * Revokes one of a principal's OAuth grants, for `actorUserId`: an active
     * owner or admin of the active organisation, the member who delegated the
     * grant, or an active maintainer of the grant's project.
     *
     * Plan 13, F.2.2: `actor` is who acts, when that is not the member
     * themselves — an operator credential's `service` actor. The audit row
     * records it through `auditActor` and the receipt is named for it; absent,
     * both name the person `actorUserId`, as before. `requireGrantProject` is
     * called with the grant's project (null for a provisioning grant) once the
     * grant is locked, before the role check and any replay, and refuses by
     * throwing; the operator path passes the domain's `requireAgentProject`,
     * which holds a project-bound operator to its project.
     */
    async revokeOAuthGrant(input: {
      organizationId: string;
      agentPrincipalId: string;
      grantId: string;
      actorUserId: string;
      actor?: ActorRef;
      requireGrantProject?: (projectId: string | null) => void;
      correlationId: string;
      reason: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      validateCommandMeta(input);
      const receiptKey = credentialMutationKey({
        actorUserId: input.actorUserId,
        actor: input.actor,
        commandName: "revoke_agent_oauth_grant",
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: input.fingerprintSecret,
        normalizedInput: {
          organizationId: input.organizationId,
          agentPrincipalId: input.agentPrincipalId,
          grantId: input.grantId,
          reason: input.reason,
        },
      });
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const replay = await lockMutationReceipt(tx as Tx, receiptKey);
        const [grant] = await tx
          .select({
            id: agentOauthGrants.id,
            projectId: agentOauthGrants.projectId,
            userId: agentOauthGrants.userId,
            status: agentOauthGrants.status,
            revokedAt: agentOauthGrants.revokedAt,
            version: agentOauthGrants.version,
            oauthClientId: agentOauthGrants.oauthClientId,
            providerGrantId: agentOauthGrants.providerGrantId,
          })
          .from(agentOauthGrants)
          .where(
            and(
              eq(agentOauthGrants.organizationId, input.organizationId),
              eq(agentOauthGrants.agentPrincipalId, input.agentPrincipalId),
              eq(agentOauthGrants.id, input.grantId),
            ),
          )
          .for("update")
          .limit(1);
        if (!grant) {
          throw new DomainError("not_found", "OAuth agent grant was not found");
        }
        input.requireGrantProject?.(grant.projectId);
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
              eq(organizationMembers.userId, input.actorUserId),
              eq(organizationMembers.status, "active"),
            ),
          )
          .for("share")
          .limit(1);
        if (!membership) {
          throw new DomainError(
            "forbidden",
            "OAuth agent grant revocation is denied",
          );
        }
        const organizationManager =
          membership.role === "owner" || membership.role === "admin";
        const ownsDelegation = grant.userId === input.actorUserId;
        // A provisioning grant names no project, so there is no project
        // membership that could stand in for organization authority. Only an
        // organization manager or the delegating human may revoke one.
        const [projectManager] =
          organizationManager || ownsDelegation || grant.projectId === null
            ? []
            : await tx
                .select({ id: projectMembers.id })
                .from(projectMembers)
                .where(
                  and(
                    eq(projectMembers.organizationId, input.organizationId),
                    eq(projectMembers.projectId, grant.projectId),
                    eq(projectMembers.userId, input.actorUserId),
                    eq(projectMembers.status, "active"),
                    eq(projectMembers.role, "maintainer"),
                  ),
                )
                .for("share")
                .limit(1);
        if (!organizationManager && !ownsDelegation && !projectManager) {
          throw new DomainError(
            "forbidden",
            "OAuth agent grant revocation is denied",
          );
        }
        if (replay) {
          return replay.result as {
            id: string;
            revoked: boolean;
            version: number;
          };
        }
        if (grant.version !== input.expectedVersion) {
          throw new DomainError(
            "version_conflict",
            "OAuth agent grant changed",
          );
        }
        if (grant.status === "revoked" || grant.revokedAt) {
          throw new DomainError(
            "version_conflict",
            "OAuth agent grant changed",
          );
        }
        const now = new Date();
        const [revoked] = await tx
          .update(agentOauthGrants)
          .set({
            status: "revoked",
            revokedAt: now,
            updatedAt: now,
            version: sql`${agentOauthGrants.version} + 1`,
          })
          .where(
            and(
              eq(agentOauthGrants.organizationId, input.organizationId),
              eq(agentOauthGrants.id, input.grantId),
              eq(agentOauthGrants.status, "active"),
              isNull(agentOauthGrants.revokedAt),
              eq(agentOauthGrants.version, input.expectedVersion),
            ),
          )
          .returning({
            id: agentOauthGrants.id,
            version: agentOauthGrants.version,
          });
        if (!revoked) {
          throw new DomainError(
            "version_conflict",
            "OAuth agent grant changed",
          );
        }
        await tx
          .update(oauthConsents)
          .set({ scopes: [], updatedAt: now })
          .where(
            and(
              eq(oauthConsents.id, grant.providerGrantId),
              eq(oauthConsents.userId, grant.userId),
              eq(oauthConsents.clientId, grant.oauthClientId),
            ),
          );
        await invalidateOAuthProviderTokens(tx, {
          userId: grant.userId,
          clientId: grant.oauthClientId,
        });
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          ...revocationAuditActor(input),
          action: "agent.oauth_grant_revoked",
          targetType: "agent_oauth_grant",
          targetId: input.grantId,
          reason: input.reason,
          fieldNames: ["status", "revokedAt"],
          correlationId: input.correlationId,
        });
        const result = {
          id: revoked.id,
          revoked: true,
          version: revoked.version,
        };
        await saveMutationReceipt(tx as Tx, receiptKey, {
          aggregateId: revoked.id,
          result,
        });
        return result;
      });
    },

    /**
     * Revokes an agent credential, for `actorUserId`, whose role
     * `lockCredentialManager` checks on the credential's project.
     *
     * Plan 13, F.2.2: `actor` is who acts, when that is not the member
     * themselves — an operator credential's `service` actor. The audit row
     * records it through `auditActor` and the receipt is named for it; absent,
     * both name the person `actorUserId`, as before.
     */
    async revokeCredential(input: {
      organizationId: string;
      credentialId: string;
      actorUserId: string;
      actor?: ActorRef;
      correlationId: string;
      reason?: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      validateCommandMeta(input);
      const reason = input.reason ?? "Human revoked an agent credential";
      const receiptKey = credentialMutationKey({
        actorUserId: input.actorUserId,
        actor: input.actor,
        commandName: "revoke_agent_credential",
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: input.fingerprintSecret,
        normalizedInput: {
          organizationId: input.organizationId,
          credentialId: input.credentialId,
          reason,
        },
      });
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const replay = await lockMutationReceipt(tx as Tx, receiptKey);
        const credential = await lockCredentialManager(tx, input);
        if (!credential) return null;
        if (replay) {
          return replay.result as {
            id: string;
            revoked: boolean;
            version: number;
          };
        }
        if (
          credential.revokedAt ||
          credential.version !== input.expectedVersion
        ) {
          throw new DomainError("version_conflict", "Agent credential changed");
        }
        const [updated] = await tx
          .update(agentCredentials)
          .set({
            revokedAt: new Date(),
            version: sql`${agentCredentials.version} + 1`,
          })
          .where(
            and(
              eq(agentCredentials.organizationId, input.organizationId),
              eq(agentCredentials.id, input.credentialId),
              isNull(agentCredentials.revokedAt),
              eq(agentCredentials.version, input.expectedVersion),
            ),
          )
          .returning({
            id: agentCredentials.id,
            betterAuthApiKeyId: agentCredentials.betterAuthApiKeyId,
            version: agentCredentials.version,
          });
        if (updated) {
          await tx
            .update(apiKeys)
            .set({ enabled: false, updatedAt: new Date() })
            .where(eq(apiKeys.id, updated.betterAuthApiKeyId));
          await tx.insert(securityAuditRecords).values({
            organizationId: input.organizationId,
            ...revocationAuditActor(input),
            action: "agent.credential_revoked",
            targetType: "agent_credential",
            targetId: input.credentialId,
            reason,
            fieldNames: ["revokedAt", "betterAuthApiKey.enabled"],
            correlationId: input.correlationId,
          });
          const result = {
            id: updated.id,
            revoked: true,
            version: updated.version,
          };
          await saveMutationReceipt(tx as Tx, receiptKey, {
            aggregateId: updated.id,
            result,
          });
          return result;
        }
        throw new DomainError("version_conflict", "Agent credential changed");
      });
    },

    async setCredentialOverlap(input: {
      organizationId: string;
      credentialId: string;
      overlapExpiresAt: Date;
      overlapMinutes: number;
      actorUserId: string;
      correlationId: string;
      expectedVersion: number;
      idempotencyKey: string;
      fingerprintSecret: string;
    }) {
      validateCommandMeta(input);
      const receiptKey = credentialMutationKey({
        actorUserId: input.actorUserId,
        commandName: "rotate_agent_credential",
        idempotencyKey: input.idempotencyKey,
        fingerprintSecret: input.fingerprintSecret,
        normalizedInput: {
          organizationId: input.organizationId,
          credentialId: input.credentialId,
          overlapMinutes: input.overlapMinutes,
        },
      });
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const replay = await lockMutationReceipt(tx as Tx, receiptKey);
        const credential = await lockCredentialManager(tx, input);
        if (!credential) return null;
        if (replay) return replay.result as { id: string; version: number };
        if (
          credential.revokedAt ||
          credential.version !== input.expectedVersion
        ) {
          throw new DomainError("version_conflict", "Agent credential changed");
        }
        const [updated] = await tx
          .update(agentCredentials)
          .set({
            overlapExpiresAt: input.overlapExpiresAt,
            expiresAt: input.overlapExpiresAt,
            version: sql`${agentCredentials.version} + 1`,
          })
          .where(
            and(
              eq(agentCredentials.organizationId, input.organizationId),
              eq(agentCredentials.id, input.credentialId),
              isNull(agentCredentials.revokedAt),
              eq(agentCredentials.version, input.expectedVersion),
            ),
          )
          .returning({
            id: agentCredentials.id,
            version: agentCredentials.version,
          });
        if (updated) {
          await tx.insert(securityAuditRecords).values({
            organizationId: input.organizationId,
            actorType: "user",
            actorId: input.actorUserId,
            action: "agent.credential_rotation_started",
            targetType: "agent_credential",
            targetId: input.credentialId,
            reason: "Human rotated an agent credential with bounded overlap",
            fieldNames: ["overlapExpiresAt", "expiresAt"],
            correlationId: input.correlationId,
          });
          await saveMutationReceipt(tx as Tx, receiptKey, {
            aggregateId: updated.id,
            result: updated,
          });
          return updated;
        }
        throw new DomainError("version_conflict", "Agent credential changed");
      });
    },

    async revokeCredentialForCompensation(input: {
      organizationId: string;
      credentialId: string;
      actorUserId: string;
      correlationId: string;
      reason: string;
    }) {
      return inTenantTransaction(database, input.organizationId, async (tx) => {
        const [updated] = await tx
          .update(agentCredentials)
          .set({
            revokedAt: new Date(),
            version: sql`${agentCredentials.version} + 1`,
          })
          .where(
            and(
              eq(agentCredentials.organizationId, input.organizationId),
              eq(agentCredentials.id, input.credentialId),
              isNull(agentCredentials.revokedAt),
            ),
          )
          .returning({
            id: agentCredentials.id,
            betterAuthApiKeyId: agentCredentials.betterAuthApiKeyId,
          });
        if (!updated) return null;
        await tx
          .update(apiKeys)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(apiKeys.id, updated.betterAuthApiKeyId));
        await tx.insert(securityAuditRecords).values({
          organizationId: input.organizationId,
          actorType: "user",
          actorId: input.actorUserId,
          action: "agent.credential_revoked",
          targetType: "agent_credential",
          targetId: input.credentialId,
          reason: input.reason,
          fieldNames: ["revokedAt", "betterAuthApiKey.enabled"],
          correlationId: input.correlationId,
        });
        return updated;
      });
    },

    async deleteOrphanApiKey(apiKeyId: string) {
      await database.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));
    },

    /**
     * Stamps a credential `resolveApiKeyCredential` has just resolved, bound
     * to the organisation that lookup found (D15), which the caller hands
     * on: on the pool it wraps as every pool read does (`withTenant`), and
     * the update names the organisation too, so a credential outside it is
     * not stamped.
     */
    async touchCredential(credentialId: string, organizationId: string) {
      await withTenant(
        organizationId,
        (database) =>
          database
            .update(agentCredentials)
            .set({ lastUsedAt: new Date() })
            .where(
              and(
                eq(agentCredentials.id, credentialId),
                eq(agentCredentials.organizationId, organizationId),
              ),
            ),
        { database },
      );
    },

    async listCredentials(
      organizationId: string,
      agentPrincipalId: string,
    ): Promise<AgentCredentialSummary[]> {
      return withTenantReadOn(
        organizationId,
        async (database) => {
          const rows = await database
            .select()
            .from(agentCredentials)
            .where(
              and(
                eq(agentCredentials.organizationId, organizationId),
                eq(agentCredentials.agentPrincipalId, agentPrincipalId),
              ),
            )
            .orderBy(sql`${agentCredentials.createdAt} desc`);
          return rows.map((row) => ({
            id: row.id,
            issuedByGrantId: row.issuedByGrantId,
            agentPrincipalId: row.agentPrincipalId,
            name: row.name,
            prefix: row.prefix,
            fingerprint: row.fingerprint,
            audience: row.audience as "mcp" | "api",
            projectId: row.projectId,
            laneIds: row.laneIds,
            scopes: row.scopes,
            version: row.version,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            overlapExpiresAt: row.overlapExpiresAt,
            lastUsedAt: row.lastUsedAt,
            createdByUserId: row.createdByUserId,
            createdAt: row.createdAt,
          }));
        },
        true,
      );
    },
  };
}
