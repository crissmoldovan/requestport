import { operatorApiKeyConfigId } from "@requestport/domain";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  agentCredentials,
  agentOauthGrants,
  agentPrincipals,
  apiKeys,
  oauthClients,
  operatorCredentials,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
} from "../schema/index.js";
import { isTransaction } from "../tenant-context.js";
import type { Tx } from "../transaction.js";

type AuthorizationDatabase = Database | Tx;

/**
 * Whether the Better Auth row behind an agent authorization is live, locked
 * `FOR SHARE` to the end of `tx` (migration 0021; the driver's ruling of
 * 2026-09-30; manifest-i2.md §5.1 rows 18 and 19). Each definer function
 * applies exactly the predicate the helpers below used to join on — a key
 * `enabled` and unexpired against `clock_timestamp()`, a client not
 * `disabled` — so the tenant processor, which may read neither table,
 * authorises an agent's import application as the application does. The
 * lock is the transaction's, as the join's was: a concurrent revocation waits
 * for it. The kind is a static choice between two functions, never a name.
 */
async function lockLiveBetterAuthRow(
  tx: Tx,
  kind: "api_key" | "oauth_client",
  id: string,
): Promise<boolean> {
  const { rows } = await tx.execute<{ live: boolean }>(
    kind === "api_key"
      ? sql`select requestport_private.lock_live_api_key(${id}) as live`
      : sql`select requestport_private.lock_live_oauth_client(${id}) as live`,
  );
  return rows[0]?.live === true;
}

/**
 * Runs `work` in the caller's transaction, or in one of its own when handed
 * the pool: 0021's functions take a row lock, and §2.5.0 item 7 calls such a
 * function only inside a transaction (a bare `select` of one is a read the
 * pool's read retry would send again). On the pool the locks end with that
 * transaction, as the join's ended with its statement.
 */
function inTransaction<T>(
  database: AuthorizationDatabase,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return isTransaction(database) ? work(database) : database.transaction(work);
}

/**
 * Revalidates the complete authorization chain for a headless agent key while
 * holding share locks for the surrounding command transaction. A verified
 * Better Auth key is not sufficient by itself: its principal, project,
 * organization, and issuing maintainer must all still be active.
 *
 * The tenant rows are read and locked as the caller; the Better Auth key is
 * checked and locked through `lock_live_api_key` (0021) after them, in the
 * order a revocation takes them (the credential, then its key).
 */
export function lockActiveApiKeyAuthorization(
  database: AuthorizationDatabase,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    projectId: string;
  },
) {
  return inTransaction(database, (tx) =>
    lockActiveApiKeyAuthorizationIn(tx, input),
  );
}

async function lockActiveApiKeyAuthorizationIn(
  database: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    projectId: string;
  },
) {
  const [locked] = await database
    .select({
      id: agentCredentials.id,
      laneIds: agentCredentials.laneIds,
      scopes: agentCredentials.scopes,
      organizationRole: organizationMembers.role,
      issuingUserId: agentCredentials.createdByUserId,
      betterAuthApiKeyId: agentCredentials.betterAuthApiKeyId,
    })
    .from(agentCredentials)
    .innerJoin(
      agentPrincipals,
      and(
        eq(agentPrincipals.organizationId, agentCredentials.organizationId),
        eq(agentPrincipals.id, agentCredentials.agentPrincipalId),
        eq(agentPrincipals.status, "active"),
        or(
          isNull(agentPrincipals.projectId),
          eq(agentPrincipals.projectId, agentCredentials.projectId),
        ),
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, agentCredentials.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      projects,
      and(
        eq(projects.organizationId, agentCredentials.organizationId),
        eq(projects.id, agentCredentials.projectId),
        eq(projects.status, "active"),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, agentCredentials.organizationId),
        eq(organizationMembers.userId, agentCredentials.createdByUserId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentCredentials.id, input.authorizationId),
        eq(agentCredentials.organizationId, input.organizationId),
        eq(agentCredentials.agentPrincipalId, input.agentPrincipalId),
        eq(agentCredentials.projectId, input.projectId),
        isNull(agentCredentials.revokedAt),
        sql`${agentCredentials.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share")
    .limit(1);
  if (!locked) return null;
  const { betterAuthApiKeyId, ...authorization } = locked;
  if (!(await lockLiveBetterAuthRow(database, "api_key", betterAuthApiKeyId)))
    return null;
  if (
    authorization.organizationRole === "owner" ||
    authorization.organizationRole === "admin"
  ) {
    return authorization;
  }
  const [projectManager] = await database
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, input.organizationId),
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, authorization.issuingUserId),
        eq(projectMembers.status, "active"),
        eq(projectMembers.role, "maintainer"),
      ),
    )
    .for("share")
    .limit(1);
  return projectManager ? authorization : null;
}

/**
 * Revalidates an OAuth-delegated agent grant against the same live human
 * authority required to create it. Remaining an ordinary organization member
 * is not enough: the delegating user must still be an owner/admin or an active
 * maintainer of the bound project.
 *
 * The tenant rows are read and locked as the caller; the grant's OAuth client
 * is checked and locked through `lock_live_oauth_client` (0021) after them.
 */
export function lockActiveOAuthAuthorization(
  database: AuthorizationDatabase,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId: string;
    projectId: string;
  },
) {
  return inTransaction(database, (tx) =>
    lockActiveOAuthAuthorizationIn(tx, input),
  );
}

async function lockActiveOAuthAuthorizationIn(
  database: Tx,
  input: {
    organizationId: string;
    agentPrincipalId: string;
    authorizationId: string;
    delegatedByUserId: string;
    projectId: string;
  },
) {
  const [authorization] = await database
    .select({
      id: agentOauthGrants.id,
      laneIds: agentOauthGrants.laneIds,
      scopes: agentOauthGrants.scopes,
      organizationRole: organizationMembers.role,
      clientId: agentOauthGrants.oauthClientId,
      refreshFamilyId: agentOauthGrants.refreshFamilyId,
      audience: agentOauthGrants.audience,
      expiresAt: agentOauthGrants.expiresAt,
    })
    .from(agentOauthGrants)
    .innerJoin(
      agentPrincipals,
      and(
        eq(agentPrincipals.organizationId, agentOauthGrants.organizationId),
        eq(agentPrincipals.id, agentOauthGrants.agentPrincipalId),
        eq(agentPrincipals.status, "active"),
        or(
          isNull(agentPrincipals.projectId),
          eq(agentPrincipals.projectId, agentOauthGrants.projectId),
        ),
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, agentOauthGrants.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      projects,
      and(
        eq(projects.organizationId, agentOauthGrants.organizationId),
        eq(projects.id, agentOauthGrants.projectId),
        eq(projects.status, "active"),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, agentOauthGrants.organizationId),
        eq(organizationMembers.userId, agentOauthGrants.userId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentOauthGrants.id, input.authorizationId),
        eq(agentOauthGrants.organizationId, input.organizationId),
        eq(agentOauthGrants.agentPrincipalId, input.agentPrincipalId),
        eq(agentOauthGrants.userId, input.delegatedByUserId),
        eq(agentOauthGrants.projectId, input.projectId),
        eq(agentOauthGrants.status, "active"),
        isNull(agentOauthGrants.revokedAt),
        sql`${agentOauthGrants.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share")
    .limit(1);
  if (!authorization) return null;
  if (
    !(await lockLiveBetterAuthRow(
      database,
      "oauth_client",
      authorization.clientId,
    ))
  )
    return null;
  if (
    authorization.organizationRole === "owner" ||
    authorization.organizationRole === "admin"
  ) {
    return authorization;
  }
  const [projectManager] = await database
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, input.organizationId),
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.delegatedByUserId),
        eq(projectMembers.status, "active"),
        eq(projectMembers.role, "maintainer"),
      ),
    )
    .for("share")
    .limit(1);
  return projectManager ? authorization : null;
}

/**
 * Revalidates the organization-wide grant an agent holds between consent and
 * its first working credential, while holding share locks for the surrounding
 * command transaction.
 *
 * This is the provisioning grant, and it is a different shape from every other
 * authorization here: `project:provision` is organization-wide and exclusive,
 * so the grant names no project and neither does its principal. The database
 * states the same invariant — `agent_oauth_grants_provisioning_check` allows a
 * null project only when the scope set is exactly `["project:provision"]` —
 * which is why matching on a null project here cannot admit a working
 * credential that merely forgot its project.
 *
 * There is deliberately no project-maintainer fallback. The sibling lookups
 * accept a maintainer of the grant's project because a project-scoped grant
 * has one to be measured against; organization-wide authority has no project,
 * so nothing narrower than organization management can carry it.
 */
export async function lockActiveProvisioningAuthorization(
  database: AuthorizationDatabase,
  input: {
    organizationId: string;
    authorizationId: string;
    delegatedByUserId: string;
  },
) {
  const [authorization] = await database
    .select({
      id: agentOauthGrants.id,
      laneIds: agentOauthGrants.laneIds,
      scopes: agentOauthGrants.scopes,
      organizationRole: organizationMembers.role,
      clientId: agentOauthGrants.oauthClientId,
      refreshFamilyId: agentOauthGrants.refreshFamilyId,
      audience: agentOauthGrants.audience,
      expiresAt: agentOauthGrants.expiresAt,
    })
    .from(agentOauthGrants)
    .innerJoin(
      agentPrincipals,
      and(
        eq(agentPrincipals.organizationId, agentOauthGrants.organizationId),
        eq(agentPrincipals.id, agentOauthGrants.agentPrincipalId),
        eq(agentPrincipals.status, "active"),
        isNull(agentPrincipals.projectId),
      ),
    )
    .innerJoin(
      oauthClients,
      and(
        eq(oauthClients.clientId, agentOauthGrants.oauthClientId),
        eq(oauthClients.disabled, false),
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, agentOauthGrants.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, agentOauthGrants.organizationId),
        eq(organizationMembers.userId, agentOauthGrants.userId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .where(
      and(
        eq(agentOauthGrants.id, input.authorizationId),
        eq(agentOauthGrants.organizationId, input.organizationId),
        eq(agentOauthGrants.userId, input.delegatedByUserId),
        isNull(agentOauthGrants.projectId),
        eq(agentOauthGrants.status, "active"),
        isNull(agentOauthGrants.revokedAt),
        sql`${agentOauthGrants.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share")
    .limit(1);

  if (!authorization) return null;

  return authorization.organizationRole === "owner" ||
    authorization.organizationRole === "admin"
    ? authorization
    : null;
}

/**
 * Revalidates an operator credential's whole chain inside the command's
 * transaction, under share locks (Plan 13, F.3, F3-12): the binding must match
 * the context's credential, organisation, lineage and member and be neither
 * revoked nor expired; its plugin key must be enabled, unexpired (a null
 * expiry fails) and in the operator configuration; the organisation active;
 * the issuing member active, with F3-3's role rule — an owner or admin for an
 * organisation-wide credential, or for a project-bound one an owner, an admin
 * or an active maintainer of that project, which must itself be active. The
 * context's project must be the binding's, null for null.
 *
 * Answers the binding's scopes, or null. The caller checks the context's
 * scopes are a subset of them.
 */
export async function lockActiveOperatorAuthorization(
  database: AuthorizationDatabase,
  input: {
    organizationId: string;
    credentialId: string;
    lineageId: string;
    memberUserId: string;
    projectId: string | null;
  },
) {
  const [authorization] = await database
    .select({
      id: operatorCredentials.id,
      projectId: operatorCredentials.projectId,
      scopes: operatorCredentials.scopes,
      organizationRole: organizationMembers.role,
    })
    .from(operatorCredentials)
    .innerJoin(
      apiKeys,
      and(
        eq(apiKeys.id, operatorCredentials.betterAuthApiKeyId),
        eq(apiKeys.configId, operatorApiKeyConfigId),
        eq(apiKeys.enabled, true),
        sql`${apiKeys.expiresAt} > clock_timestamp()`,
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, operatorCredentials.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .innerJoin(
      organizationMembers,
      and(
        eq(
          organizationMembers.organizationId,
          operatorCredentials.organizationId,
        ),
        eq(organizationMembers.userId, operatorCredentials.memberUserId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .where(
      and(
        eq(operatorCredentials.id, input.credentialId),
        eq(operatorCredentials.organizationId, input.organizationId),
        eq(operatorCredentials.lineageId, input.lineageId),
        eq(operatorCredentials.memberUserId, input.memberUserId),
        isNull(operatorCredentials.revokedAt),
        sql`${operatorCredentials.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share")
    .limit(1);
  if (!authorization) return null;
  if ((authorization.projectId ?? null) !== (input.projectId ?? null)) {
    return null;
  }
  const organizationManager =
    authorization.organizationRole === "owner" ||
    authorization.organizationRole === "admin";
  if (!authorization.projectId) {
    return organizationManager ? authorization : null;
  }
  const [project] = await database
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, input.organizationId),
        eq(projects.id, authorization.projectId),
        eq(projects.status, "active"),
      ),
    )
    .for("share")
    .limit(1);
  if (!project) return null;
  if (organizationManager) return authorization;
  const [projectManager] = await database
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.organizationId, input.organizationId),
        eq(projectMembers.projectId, authorization.projectId),
        eq(projectMembers.userId, input.memberUserId),
        eq(projectMembers.status, "active"),
        eq(projectMembers.role, "maintainer"),
      ),
    )
    .for("share")
    .limit(1);
  return projectManager ? authorization : null;
}
