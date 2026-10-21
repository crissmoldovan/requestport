import {
  type AuthorizedCommandContext,
  DomainError,
  isOperatorContext,
  memberAuthority,
} from "@requestport/domain";
import { desc, eq } from "drizzle-orm";

import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { requireOperationsOperator } from "../../repositories/operations-repository.js";
import { requireOperator } from "../../repositories/retention-hold-repository.js";
import {
  domainEvents,
  importTaskDispatches,
  notificationIntents,
  outbox,
  retentionHolds,
  slackDeliveryOperations,
  slackInstallations,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  `list_administration_operations` and `list_administration_retention_holds`
  (Plan 13, F.2.4; `manifest-f2.md` §4.1): what the four requeues and the
  hold release take their identifiers and expected versions from. A requeue's
  version is its row's attempt count; a release's is the hold's version. The
  requeues' lists also carry the state each requeue checks, and the
  notification's channel and the Slack operation's type, which the forms use
  to start the task after the commit. Nothing else: no event type, request
  id, error code, provider field, run id, timestamp, reason, name or email.

  Both are bound to the organisation: each list function refuses a
  credential bound to a project before any query of its own. The operator
  entry points at the end, which `/api/v1` dispatches, re-check the
  credential first and then call those functions. Every query here carries
  the organisation's predicate, with the value the caller hands in, so the
  tenant-scope sweep needs no ledger line for this file (§4.1, rule 9).
*/

/** Each list is capped as the operations page caps it. */
const listLimit = 200;

export interface OperationsReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

function requireOrganizationWide(input: OperationsReadInput) {
  if (input.credentialProjectId !== null)
    throw new DomainError(
      "forbidden",
      "Operations reads require an organisation-wide credential",
    );
}

/**
 * The rows the four requeues act on, newest first, at most 200 of each kind,
 * in the caller's transaction.
 *
 * Throws `forbidden` before any query for a credential bound to a project.
 * Then locks the member's organisation membership row, joined to the
 * organisation row, `FOR SHARE` — the requeues' own check — and throws
 * `forbidden` unless the member is an active owner or admin of the active
 * organisation. The four lists are read one after another, not at once: they
 * share the transaction's one client.
 */
export async function listAdministrationOperations(
  tx: Tx,
  input: OperationsReadInput,
) {
  requireOrganizationWide(input);
  await requireOperationsOperator(tx, {
    userId: input.memberUserId,
    organizationId: input.organizationId,
  });
  const outboxRows = await tx
    .select({
      id: outbox.id,
      state: outbox.state,
      attemptCount: outbox.attemptCount,
    })
    .from(outbox)
    .innerJoin(domainEvents, eq(domainEvents.id, outbox.eventId))
    .where(eq(domainEvents.organizationId, input.organizationId))
    .orderBy(desc(outbox.createdAt), desc(outbox.id))
    .limit(listLimit);
  const notificationRows = await tx
    .select({
      id: notificationIntents.id,
      channel: notificationIntents.channel,
      status: notificationIntents.status,
      attemptCount: notificationIntents.attemptCount,
    })
    .from(notificationIntents)
    .where(eq(notificationIntents.organizationId, input.organizationId))
    .orderBy(desc(notificationIntents.createdAt), desc(notificationIntents.id))
    .limit(listLimit);
  const slackRows = await tx
    .select({
      id: slackDeliveryOperations.id,
      operationType: slackDeliveryOperations.operationType,
      status: slackDeliveryOperations.status,
      attemptCount: slackDeliveryOperations.attemptCount,
    })
    .from(slackDeliveryOperations)
    .innerJoin(
      slackInstallations,
      eq(slackInstallations.id, slackDeliveryOperations.installationId),
    )
    .where(eq(slackInstallations.organizationId, input.organizationId))
    .orderBy(
      desc(slackDeliveryOperations.updatedAt),
      desc(slackDeliveryOperations.id),
    )
    .limit(listLimit);
  const importRows = await tx
    .select({
      id: importTaskDispatches.id,
      state: importTaskDispatches.state,
      attemptCount: importTaskDispatches.attemptCount,
    })
    .from(importTaskDispatches)
    .where(eq(importTaskDispatches.organizationId, input.organizationId))
    .orderBy(
      desc(importTaskDispatches.updatedAt),
      desc(importTaskDispatches.id),
    )
    .limit(listLimit);
  return {
    outbox: outboxRows,
    notificationIntents: notificationRows,
    slackOperations: slackRows,
    importDispatches: importRows,
  };
}

/**
 * The organisation's retention holds, newest first, in the caller's
 * transaction: each hold's id, category, status and version.
 *
 * Throws `forbidden` before any query for a credential bound to a project.
 * Then locks the organisation row and the member's organisation membership
 * row `FOR SHARE` — the hold writes' own check — and throws `forbidden`
 * unless the member is an active owner or admin of the active organisation.
 */
export async function listAdministrationRetentionHolds(
  tx: Tx,
  input: OperationsReadInput,
) {
  requireOrganizationWide(input);
  await requireOperator(tx, {
    userId: input.memberUserId,
    organizationId: input.organizationId,
  });
  return tx
    .select({
      id: retentionHolds.id,
      category: retentionHolds.category,
      status: retentionHolds.status,
      version: retentionHolds.version,
    })
    .from(retentionHolds)
    .where(eq(retentionHolds.organizationId, input.organizationId))
    .orderBy(desc(retentionHolds.createdAt), desc(retentionHolds.id));
}

/** What `/api/v1` hands an operations read for an operator credential. */
export interface OperationsOperatorReadInput {
  context: AuthorizedCommandContext;
  /** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
  operatorCredentials: "enabled" | "disabled" | undefined;
}

/**
 * The read's input for the operator behind `context`, in the caller's one
 * transaction (`manifest-f2.md` §4.1, rules 4 and 5): first the bus's own
 * `assertCurrent` on the context — the deployment's operator switch, then
 * F.3's `lockActiveOperatorAuthorization` under share locks and the scopes'
 * subset check — so nothing is read for a switched-off deployment, a revoked
 * or expired credential or key, a member no longer active or a suspended
 * organisation. Then the member `memberAuthority` names (never
 * `context.actor.id`, which is `operator:<lineage>`), the context's
 * organisation, and the context's project, which the read refuses when there
 * is one.
 *
 * A context that is not an operator's is refused `forbidden` before anything
 * is read: these reads admit operators only (§4.1, rule 2).
 */
async function operatorReadInput(
  tx: Tx,
  input: OperationsOperatorReadInput,
): Promise<OperationsReadInput> {
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
  return {
    memberUserId: member.userId,
    organizationId: context.organizationId,
    credentialProjectId: context.projectId ?? null,
  };
}

/**
 * `list_administration_operations` as `/api/v1` answers it for an operator
 * credential, in the caller's one transaction: the operator re-checked as
 * `operatorReadInput` says, then `listAdministrationOperations` for its
 * member.
 */
export async function readOperationsForOperator(
  tx: Tx,
  input: OperationsOperatorReadInput,
) {
  return listAdministrationOperations(tx, await operatorReadInput(tx, input));
}

/**
 * `list_administration_retention_holds` as `/api/v1` answers it for an
 * operator credential, in the caller's one transaction: the operator
 * re-checked as `operatorReadInput` says, then
 * `listAdministrationRetentionHolds` for its member.
 */
export async function readRetentionHoldsForOperator(
  tx: Tx,
  input: OperationsOperatorReadInput,
) {
  return listAdministrationRetentionHolds(
    tx,
    await operatorReadInput(tx, input),
  );
}
