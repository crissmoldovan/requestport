import {
  type AuthorizedCommandContext,
  DomainError,
  isOperatorContext,
  memberAuthority,
} from "@requestport/domain";
import { asc, eq } from "drizzle-orm";

import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { createSlackRepository } from "../../repositories/slack-repository.js";
import {
  slackInstallations,
  slackRoutes,
  slackUserMappings,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  `get_administration_slack_configuration` (Plan 13, F.2.5; `manifest-f2.md`
  §4.1): what the four Slack administration writes take their identifiers and
  their expected version from, and the current value of the three route
  fields the route write resends whole (mode, channel and fallback). Nothing
  else: no workspace name, bot user, scopes, token, person's or project's
  name, timestamp or delivery operation (F.2.4's read carries those).

  Every route row is returned, disabled ones included, each with its status:
  a route change disables the active row and inserts its successor, so the
  version a route write expects is the *active* row's for its scope.

  Every query here carries the organisation's predicate, with the value the
  caller hands in, so the tenant-scope sweep needs no ledger line for this
  file (§4.1, rule 9).
*/

export interface SlackConfigurationReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * The organisation's Slack configuration as the writes need it, in the
 * caller's transaction: its installations, its user mappings and its routes,
 * each list ordered by id.
 *
 * Throws `forbidden`, before any query, for a credential bound to a project:
 * Slack configuration is the organisation's (binding `organization`, §4.1
 * rule 7). Throws `forbidden` unless the member is an active owner or admin of
 * the active organisation, the rule every Slack write applies, checked by the
 * repository's own `canManage`, which takes the organisation and membership
 * rows `FOR SHARE` as the writes do. A member id that is not a person's (an
 * operator's actor id) matches no membership row and is refused the same
 * way; the membership's user id is text, so nothing is raised.
 *
 * The three lists are read one after another: they share the transaction's
 * one client.
 */
export async function getAdministrationSlackConfiguration(
  tx: Tx,
  input: SlackConfigurationReadInput,
) {
  if (input.credentialProjectId !== null) {
    throw new DomainError(
      "forbidden",
      "Slack configuration is read with a credential bound to no project",
    );
  }
  const manages = await createSlackRepository(tx).canManage(
    input.organizationId,
    input.memberUserId,
  );
  if (!manages) {
    throw new DomainError("forbidden", "Slack administration access is denied");
  }
  const installations = await tx
    .select({
      id: slackInstallations.id,
      status: slackInstallations.status,
      version: slackInstallations.version,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.organizationId, input.organizationId))
    .orderBy(asc(slackInstallations.id));
  const mappings = await tx
    .select({
      id: slackUserMappings.id,
      installationId: slackUserMappings.installationId,
      userId: slackUserMappings.userId,
      slackUserId: slackUserMappings.slackUserId,
      status: slackUserMappings.status,
      version: slackUserMappings.version,
    })
    .from(slackUserMappings)
    .where(eq(slackUserMappings.organizationId, input.organizationId))
    .orderBy(asc(slackUserMappings.id));
  const routes = await tx
    .select({
      id: slackRoutes.id,
      projectId: slackRoutes.projectId,
      status: slackRoutes.status,
      version: slackRoutes.version,
      mode: slackRoutes.mode,
      channelId: slackRoutes.channelId,
      fallback: slackRoutes.fallback,
    })
    .from(slackRoutes)
    .where(eq(slackRoutes.organizationId, input.organizationId))
    .orderBy(asc(slackRoutes.id));
  return { installations, mappings, routes };
}

/**
 * `get_administration_slack_configuration` as `/api/v1` answers it for an
 * operator credential, in the caller's one transaction (`manifest-f2.md`
 * §4.1, rules 4 and 5): first the bus's own `assertCurrent` on the context —
 * the deployment's operator switch, then F.3's
 * `lockActiveOperatorAuthorization` under share locks and the scopes'
 * subset check — so nothing is read for a switched-off deployment, a revoked
 * or expired credential or key, a member no longer active or a suspended
 * organisation. Then the projection above, for the member `memberAuthority`
 * names (never `context.actor.id`, which is `operator:<lineage>`), in the
 * context's organisation, with the context's project as the credential's
 * binding, which the projection refuses when there is one.
 *
 * A context that is not an operator's is refused `forbidden` before anything
 * is read: this read admits operators only (§4.1, rule 2).
 */
export async function readSlackConfigurationForOperator(
  tx: Tx,
  input: {
    context: AuthorizedCommandContext;
    /** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
    operatorCredentials: "enabled" | "disabled" | undefined;
  },
) {
  const { context } = input;
  const member = memberAuthority(context);
  if (!isOperatorContext(context) || member?.via !== "operator") {
    throw new DomainError(
      "forbidden",
      "This read admits an operator credential only",
    );
  }
  await createCommandAuthorizationRepository(tx, {
    operatorCredentials: input.operatorCredentials,
  }).assertCurrent(context);
  return getAdministrationSlackConfiguration(tx, {
    memberUserId: member.userId,
    organizationId: context.organizationId,
    credentialProjectId: context.projectId ?? null,
  });
}
