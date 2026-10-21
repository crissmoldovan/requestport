import {
  type AuthorizedCommandContext,
  DomainError,
  evaluateRouteForMember,
  isOperatorContext,
  memberAuthority,
  type RouteDecision,
  type routeEvaluationScopes,
} from "@requestport/domain";
import { asc, eq } from "drizzle-orm";

import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { createFoundationQueryRepository } from "../../repositories/foundation-query.js";
import { createRoutingRepository } from "../../repositories/routing-repository.js";
import { routingRules } from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  `list_administration_routing_rules` (Plan 13, F.2.1; `manifest-f2.md`
  §4.1): what the rule update and disable take their identifiers and their
  expected version from, and the current value of every field update resends
  whole. Nothing else: no organisation, specificity, author or timestamp.
  Every field returned is an enum, an id, a version or a flag; a rule holds no
  free text.

  The query here carries the organisation's predicate, with the value the
  caller hands in, so the tenant-scope sweep needs no ledger line for this
  file (§4.1, rule 9).
*/

export interface RoutingRulesReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * The organisation's routing rules as the rule writes need them, in the
 * caller's transaction, ordered by id.
 *
 * Throws `forbidden`, before any query, for a credential bound to a project:
 * the rules are the organisation's (binding `organization`, §4.1 rule 7).
 * Throws `forbidden` unless the member is an active owner or admin of the
 * active organisation, the rule the three rule commands apply, checked by the
 * same `canManage`, which takes the membership and organisation rows
 * `FOR SHARE` as the commands do. A member id that is not a person's (an
 * operator's actor id) matches no membership row and is refused the same
 * way; the membership's user id is text, so nothing is raised.
 */
export async function listAdministrationRoutingRules(
  tx: Tx,
  input: RoutingRulesReadInput,
) {
  if (input.credentialProjectId !== null) {
    throw new DomainError(
      "forbidden",
      "Routing rules are read with a credential bound to no project",
    );
  }
  const manages = await createRoutingRepository(tx).canManage(
    input.organizationId,
    { type: "user", id: input.memberUserId },
  );
  if (!manages) {
    throw new DomainError(
      "forbidden",
      "Organization routing authority is required",
    );
  }
  const rows = await tx
    .select({
      id: routingRules.id,
      version: routingRules.version,
      enabled: routingRules.enabled,
      sourceKind: routingRules.sourceKind,
      sourceProjectId: routingRules.sourceProjectId,
      targetProjectId: routingRules.targetProjectId,
      decision: routingRules.decision,
      requestTypes: routingRules.requestTypes,
      priorities: routingRules.priorities,
      humanRoles: routingRules.humanRoles,
      laneIds: routingRules.laneIds,
      agentPrincipalIds: routingRules.agentPrincipalIds,
    })
    .from(routingRules)
    .where(eq(routingRules.organizationId, input.organizationId))
    .orderBy(asc(routingRules.id));
  return rows;
}

/** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
type OperatorCredentialsSwitch = "enabled" | "disabled" | undefined;

/**
 * The operator behind `context`, re-checked in the caller's transaction as
 * the bus re-checks it (`manifest-f2.md` §4.1, rules 2 and 4): a context that
 * is not an operator's is refused `forbidden` before anything is read; then
 * the bus's own `assertCurrent` runs — the deployment's operator switch, then
 * F.3's `lockActiveOperatorAuthorization` under share locks and the scopes'
 * subset check — so nothing is read for a switched-off deployment, a revoked
 * or expired credential or key, a member no longer active or a suspended
 * organisation. Answers the member `memberAuthority` names, never
 * `context.actor.id`, which is `operator:<lineage>`.
 */
async function currentOperatorMember(
  tx: Tx,
  context: AuthorizedCommandContext,
  operatorCredentials: OperatorCredentialsSwitch,
) {
  const member = memberAuthority(context);
  if (!isOperatorContext(context) || member?.via !== "operator") {
    throw new DomainError(
      "forbidden",
      "This read admits an operator credential only",
    );
  }
  await createCommandAuthorizationRepository(tx, {
    operatorCredentials,
  }).assertCurrent(context);
  return member.userId;
}

/**
 * `list_administration_routing_rules` as `/api/v1` answers it for an
 * operator credential, in the caller's one transaction: the operator
 * re-checked (`currentOperatorMember`), then `listAdministrationRoutingRules`
 * for its member, in the context's organisation, refused for a credential
 * bound to a project.
 */
export async function readRoutingRulesForOperator(
  tx: Tx,
  input: {
    context: AuthorizedCommandContext;
    operatorCredentials: OperatorCredentialsSwitch;
  },
) {
  const memberUserId = await currentOperatorMember(
    tx,
    input.context,
    input.operatorCredentials,
  );
  return listAdministrationRoutingRules(tx, {
    memberUserId,
    organizationId: input.context.organizationId,
    credentialProjectId: input.context.projectId ?? null,
  });
}

/**
 * Route evaluation as `/api/v1` answers it for an operator credential
 * (`test_administration_route`, `preview_administration_route`), in the
 * caller's one transaction: the operator re-checked
 * (`currentOperatorMember`), then the one evaluation entry the routing tester
 * and the request form's preview reach, `evaluateRouteForMember`, on
 * repositories built from this transaction. It writes nothing.
 *
 * Throws `forbidden` for a credential bound to a project once the operator is
 * re-checked and before the query string is parsed, as the rules read
 * refuses one before it reads: a route's evaluation is the organisation's
 * (binding `organization`, §4.1 rule 7), so a bound credential is answered
 * 403 whatever it sends, never 422 for a malformed route.
 *
 * The route comes from the query string: each parameter's first value; the
 * purpose is the entry's, and the organisation the credential's, written over
 * any the caller names. The entry's schema is strict, so a parameter the
 * purpose does not take (a lane on a preview, or any unknown name) is refused
 * as invalid input rather than ignored. The entry takes the member's role
 * from the organisation's record.
 */
export async function evaluateRouteForOperator(
  tx: Tx,
  input: {
    context: AuthorizedCommandContext;
    purpose: keyof typeof routeEvaluationScopes;
    searchParams: URLSearchParams;
    operatorCredentials: OperatorCredentialsSwitch;
  },
): Promise<RouteDecision> {
  await currentOperatorMember(tx, input.context, input.operatorCredentials);
  if (input.context.projectId) {
    throw new DomainError(
      "forbidden",
      "Routes are evaluated with a credential bound to no project",
    );
  }
  const route: Record<string, string> = {};
  for (const name of new Set(input.searchParams.keys()))
    route[name] = input.searchParams.get(name) ?? "";
  return evaluateRouteForMember(
    {
      rules: createRoutingRepository(tx),
      members: createFoundationQueryRepository(tx),
    },
    input.context,
    {
      ...route,
      purpose: input.purpose,
      organizationId: input.context.organizationId,
    },
  );
}
