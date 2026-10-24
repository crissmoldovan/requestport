import {
  type AuthenticatedUserCommandContext,
  type AuthorizedCommandContext,
  claimsOperator,
  DomainError,
  isOperatorContext,
  operatorLineageId,
} from "@requestport/domain";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  organizationMembers,
  organizations,
  session,
  user,
} from "../schema/index.js";
import { withTenant } from "../tenant-context.js";
import type { Tx } from "../transaction.js";
import {
  lockActiveApiKeyAuthorization,
  lockActiveOAuthAuthorization,
  lockActiveOperatorAuthorization,
  lockActiveProvisioningAuthorization,
} from "./agent-authorization.js";
import { operatorCredentialsTableExists } from "./operator-credential-repository.js";

type AuthorizationDatabase = Database | Tx;

function isSubset(values: ReadonlySet<string> | undefined, allowed: string[]) {
  return [...(values ?? [])].every((value) => allowed.includes(value));
}

/**
 * Whether a credential identifier could name an agent grant at all.
 *
 * `agent_oauth_grants.id` is a `uuid` column, and PostgreSQL *raises* on
 * malformed uuid input rather than matching no row — so handing it a Better
 * Auth session identifier, which is `session_<uuid>`, turns what should be a
 * plain refusal into a failed query. The delegated lookup below is therefore
 * attempted only for a value that could be a grant id in the first place.
 */
const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `operatorCredentials` is the deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`
 * (Plan 13, F.3, F3-14). Operator contexts pass `assertCurrent` only when it is
 * `enabled`; absent, as every caller that does not pass it leaves it, means
 * off.
 */
export function createCommandAuthorizationRepository(
  database: AuthorizationDatabase,
  options: { operatorCredentials?: "enabled" | "disabled" } = {},
) {
  /**
   * The context's organisation, bound to the transaction the re-check runs
   * in before its first read of a tenant table (manifest-i2.md §2.3 item 5,
   * Plan 13 I.2). On the bus the transaction is bound already, to the same
   * organisation (`commandTransactionBinding`), and binding it again is
   * idempotent; the handlers that stay off the bus, and the administration
   * reads, open a transaction of their own and run this first, so here it
   * is their first binding. A transaction bound to another organisation is
   * refused (`TenantBindingError`).
   */
  const forContext = <T>(
    context: AuthorizedCommandContext,
    work: (database: AuthorizationDatabase) => Promise<T>,
  ) => withTenant(context.organizationId, work, { database });

  return {
    /**
     * The session-only human recheck used by the authenticated-user command
     * bus. It deliberately never joins organizations or memberships: personal
     * appearance is global, so a signed-in user with no active organization —
     * or whose only organizations are suspended — must still be able to read,
     * write, and replay it.
     */
    async assertCurrentUser(context: AuthenticatedUserCommandContext) {
      const [authorized] = await database
        .select({ id: session.id })
        .from(session)
        .innerJoin(user, eq(user.id, session.userId))
        .where(
          and(
            eq(session.id, context.credentialId),
            eq(session.userId, context.actor.id),
            sql`${session.expiresAt} > clock_timestamp()`,
          ),
        )
        .for("share")
        .limit(1);
      if (!authorized) {
        throw new DomainError(
          "forbidden",
          "Current human authorization is no longer active",
        );
      }
    },

    async assertCurrent(context: AuthorizedCommandContext) {
      /*
        An operator credential (Plan 13, F.3, F3-12): a service actor whose
        origin is the member who issued it. Any context that claims to be one,
        by its kind or by its actor's name, is judged here and nowhere else —
        before the human branch, so a user actor that claims the operator kind
        never reaches a session lookup.

        It is refused, before anything is read, while the switch is off
        (F3-14) and when the claim is malformed; the ids it compares with uuid
        columns are shape-checked first, for the reason `uuidShape` records.
        It is refused before migration 0018 has created the table, so an
        absent table is a 403 and never a failed query. Otherwise the whole
        chain is locked and revalidated, and the context may carry no scope
        the binding does not, and no lanes.
      */
      if (claimsOperator(context)) {
        if (options.operatorCredentials !== "enabled") {
          throw new DomainError(
            "forbidden",
            "Operator credentials are not enabled",
          );
        }
        const lineageId = operatorLineageId(context.actor);
        if (
          !isOperatorContext(context) ||
          !lineageId ||
          !uuidShape.test(lineageId) ||
          !uuidShape.test(context.credentialId) ||
          context.laneIds?.size ||
          !(await operatorCredentialsTableExists(database))
        ) {
          throw new DomainError(
            "forbidden",
            "Current operator authorization is no longer active",
          );
        }
        const operator = await forContext(context, (database) =>
          lockActiveOperatorAuthorization(database, {
            organizationId: context.organizationId,
            credentialId: context.credentialId,
            lineageId,
            memberUserId: context.actor.originatingActor.id,
            projectId: context.projectId ?? null,
          }),
        );
        if (!operator || !isSubset(context.scopes, operator.scopes)) {
          throw new DomainError(
            "forbidden",
            "Current operator authorization is no longer active",
          );
        }
        return;
      }

      if (context.actor.type === "user") {
        return forContext(context, (database) =>
          assertCurrentPersonOn(database, {
            organizationId: context.organizationId,
            userId: context.actor.id,
            credentialId: context.credentialId,
          }),
        );
      }

      // Every other non-agent context — the worker's own service actor
      // included — is refused here: the tenant bus admits people, agents and
      // operators only.
      if (context.actor.type !== "agent" || !context.projectId) {
        throw new DomainError(
          "forbidden",
          "Current command authorization is unavailable",
        );
      }

      const agent = context.actor;
      const projectId = context.projectId;
      const authorization = await forContext(context, async (database) =>
        agent.delegatedBy
          ? await lockActiveOAuthAuthorization(database, {
              organizationId: context.organizationId,
              agentPrincipalId: agent.id,
              authorizationId: context.credentialId,
              delegatedByUserId: agent.delegatedBy.id,
              projectId,
            })
          : await lockActiveApiKeyAuthorization(database, {
              organizationId: context.organizationId,
              agentPrincipalId: agent.id,
              authorizationId: context.credentialId,
              projectId,
            }),
      );
      if (
        !authorization ||
        !isSubset(context.scopes, authorization.scopes) ||
        !isSubset(context.laneIds, authorization.laneIds) ||
        !isSubset(new Set(authorization.laneIds), [...(context.laneIds ?? [])])
      ) {
        throw new DomainError(
          "forbidden",
          "Current agent authorization is no longer active",
        );
      }
    },

    /**
     * Whether a person's context acts on a live provisioning grant (J.10's
     * F9, ruling 233 item 4), the read `provisionAgent` makes before either
     * of its writes: the context's `credentialId` must name an active,
     * unrevoked, unexpired, organisation-wide grant (no project, which the
     * database permits only for the exclusive `project:provision`) of an
     * active principal that names no project, through an enabled OAuth
     * client, that the context's person delegated, while that person is an
     * active owner or admin of the active organisation
     * (`lockActiveProvisioningAuthorization`). It is bound to the context's
     * organisation as `assertCurrent` binds it: on a transaction it is
     * handed, or in one of its own on the pool (on the pool itself with the
     * tenant binding off). Unlike `assertCurrent`, a session never passes,
     * whatever its id. Anything else is refused in the bus's words, "Current
     * human authorization is no longer active"; a context that is not a
     * person's, or whose credential is not a UUID, before anything is read.
     */
    async assertProvisioningGrant(context: AuthorizedCommandContext) {
      const refused = () =>
        new DomainError(
          "forbidden",
          "Current human authorization is no longer active",
        );
      if (
        context.actor.type !== "user" ||
        !uuidShape.test(context.credentialId)
      )
        throw refused();
      const userId = context.actor.id;
      const grant = await forContext(context, (database) =>
        lockActiveProvisioningAuthorization(database, {
          organizationId: context.organizationId,
          authorizationId: context.credentialId,
          delegatedByUserId: userId,
        }),
      );
      if (!grant) throw refused();
    },
  };
}

/**
 * The bus's re-check of a person, on `database`: a live session of the
 * person, while they are an active member of the active organisation
 * `person.organizationId`, or the delegated provisioning grant below;
 * otherwise refused as `forbidden`, "Current human authorization is no
 * longer active". Every row it reads is locked `FOR SHARE` to the end of the
 * transaction it runs in, so a revocation (Better Auth deletes the session
 * row) waits for that transaction to end.
 *
 * `assertCurrent` runs it for a person's context, bound to the context's
 * organisation (`forContext`): on the command's transaction, in one of its
 * own, or, with the tenant binding off, on the pool. The locked checks of
 * three writes run it in the write's own transaction, which
 * `inTenantTransaction` has bound, for the credential a person's call names
 * (ruling 234 (c)): the webhook repository's `canManage`, the agent auth
 * repository's `reserveCredentialIssuance` and its `bindOAuthConsent`.
 */
export async function assertCurrentPersonOn(
  database: AuthorizationDatabase,
  person: { organizationId: string; userId: string; credentialId: string },
): Promise<void> {
  const [authorized] = await database
    .select({ id: organizationMembers.id })
    .from(session)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, session.userId),
        eq(organizationMembers.organizationId, person.organizationId),
        eq(organizationMembers.status, "active"),
      ),
    )
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, organizationMembers.organizationId),
        eq(organizations.status, "active"),
      ),
    )
    .where(
      and(
        eq(session.id, person.credentialId),
        eq(session.userId, person.userId),
        sql`${session.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share")
    .limit(1);
  if (authorized) return;

  /*
    The delegated provisioning session, which carries no browser session.

    An agent that has completed consent acts as the human the consent
    screen named — `create_agent_principal` and credential issuance are
    human acts, and the audit trail should name that person — so the
    context presents a user actor. Its credential, though, is the agent
    authorization, not a session, and the lookup above can therefore
    never match one. Every command reachable from a provisioning grant
    was refused for that reason, which made `provision_agent` a
    registered tool that could not succeed on any input: an agent could
    create a project and then never obtain a credential to work with.

    The grant is revalidated here on its own terms instead. It admits
    only an organization-wide grant — null project, which the database
    permits only for the exclusive `project:provision` scope — held by an
    active owner or admin, so a working project-scoped credential cannot
    reach this path.

    Note what is deliberately NOT checked: `assertCurrent`'s agent branch
    requires the context's scopes to be a subset of the grant's, and this
    one does not. It cannot be, and the difference is by design. A
    delegated context carries the standing the human has in the UI, which
    is the whole human scope set, while the grant carries only
    `project:provision` — so a subset test would refuse every delegated
    call. Containment for this path is at the tool boundary rather than
    here: of the tools a provisioning grant registers, exactly two reach
    a command — `create_project` and `provision_agent`, the only two
    gated on `project:provision`. Every other command tool returns early
    for a scope the grant does not hold, the read tools are gated on
    `org:read`/`project:read`/`request:read`, and `agent_hello` needs a
    bound project this grant has none of; what remains is `whoami`,
    which only describes the caller. Widening that registration would
    widen this, which is the thing to watch when it changes.

    That boundary is MCP's, and it is not the only way in. An in-process
    embedder holding a RequestPort (`@requestport/core`) reaches this path
    too, through `RequestPort.mcpOnly`: `provisionAgent` runs
    `create_agent_principal` on the bus as the delegating user, with the
    grant as its credential, and no tool registration stands in between.
    There it is contained by ruling 63's in-process trust (code running in
    the process already holds the database credentials, so it is trusted as
    the web server is) and by the grant re-check below, which admits only an
    active, organization-wide provisioning grant delegated by that user.
  */
  const delegated = uuidShape.test(person.credentialId)
    ? await lockActiveProvisioningAuthorization(database, {
        organizationId: person.organizationId,
        authorizationId: person.credentialId,
        delegatedByUserId: person.userId,
      })
    : null;
  if (delegated) return;

  throw new DomainError(
    "forbidden",
    "Current human authorization is no longer active",
  );
}
