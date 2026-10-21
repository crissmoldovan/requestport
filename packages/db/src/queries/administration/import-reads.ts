import {
  type AuthorizedCommandContext,
  DomainError,
  isOperatorContext,
  memberAuthority,
} from "@requestport/domain";
import { and, asc, desc, eq } from "drizzle-orm";

import { createCommandAuthorizationRepository } from "../../repositories/command-authorization.js";
import { requireImportManager } from "../../repositories/import-repository.js";
import {
  importManifestEntries,
  importRuns,
  importSources,
} from "../../schema/index.js";
import type { Tx } from "../../transaction.js";

/*
  `list_administration_import_runs` and `get_administration_import_run` (Plan
  13, F.2.6; `manifest-f2.md` §4.1): what import review and split take their
  identifiers and their expected version from. Nothing else: no source or
  snapshot row, no artifact, no parsed legacy content, no conflict and no
  report. Every field returned is an id, a state or decision, or a version.

  Their rule is the review writes' own: an active owner or admin of the active
  organisation, by `requireImportManager`, which locks the membership and the
  organisation rows `FOR SHARE` as the writes do. Binding
  `organization-or-project`: a credential bound to a project sees only the
  runs whose source is that project.

  Every query here carries the organisation's predicate, with the value the
  caller hands in, so the tenant-scope sweep needs no ledger line for this
  file (§4.1, rule 9).

  `/api/v1` reaches them for an operator credential only, through
  `readImportRunsForOperator` and `readImportRunForOperator` at the end of
  this file (Plan 13, F.2.6's registry half).
*/

const uuidShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ImportRunsReadInput {
  /** The member whose standing the read runs under: a person's user id. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * The organisation's import runs, newest first and at most 200, as the page
 * lists them: per run its id, its source's project, its state and its
 * version.
 *
 * Throws `forbidden` unless the member is an active owner or admin of the
 * active organisation. A member id that is not a person's (an operator's
 * actor id) matches no membership row and is refused the same way; the
 * membership's user id is text, so nothing is raised. A credential bound to
 * a project that is not a UUID is bound to no run, and is answered with none
 * without the runs being queried.
 */
export async function listAdministrationImportRuns(
  tx: Tx,
  input: ImportRunsReadInput,
) {
  await requireImportManager(tx, input.organizationId, input.memberUserId);
  const bound = input.credentialProjectId;
  if (bound !== null && !uuidShape.test(bound)) return [];
  return tx
    .select({
      id: importRuns.id,
      projectId: importSources.projectId,
      state: importRuns.state,
      version: importRuns.version,
    })
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
        ...(bound === null ? [] : [eq(importSources.projectId, bound)]),
      ),
    )
    .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
    .limit(200);
}

/**
 * One import run, with its manifest entries: the run's id, state and
 * version, and per entry its id, decision, proposed canonical request and
 * version, ordered by artifact and record.
 *
 * Throws `not_found`, before any query, when the run id is not a UUID or the
 * credential is bound to a project that is not one. Throws `forbidden`
 * unless the member is an active owner or admin of the active organisation,
 * as `listAdministrationImportRuns` does. Throws `not_found` when the run is
 * not the organisation's, or its source is not the project a bound
 * credential names.
 */
export async function getAdministrationImportRun(
  tx: Tx,
  input: ImportRunsReadInput & {
    /** The run the path names. Not trusted to be a UUID. */
    runId: string;
  },
) {
  const bound = input.credentialProjectId;
  if (
    !uuidShape.test(input.runId) ||
    (bound !== null && !uuidShape.test(bound))
  )
    throw new DomainError("not_found", "Import run was not found");
  await requireImportManager(tx, input.organizationId, input.memberUserId);
  const [run] = await tx
    .select({
      id: importRuns.id,
      state: importRuns.state,
      version: importRuns.version,
      projectId: importSources.projectId,
    })
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
  if (!run || (bound !== null && run.projectId !== bound))
    throw new DomainError("not_found", "Import run was not found");
  const entries = await tx
    .select({
      id: importManifestEntries.id,
      decision: importManifestEntries.decision,
      proposedCanonicalId: importManifestEntries.proposedCanonicalId,
      version: importManifestEntries.version,
    })
    .from(importManifestEntries)
    .where(
      and(
        eq(importManifestEntries.organizationId, input.organizationId),
        eq(importManifestEntries.importRunId, run.id),
      ),
    )
    .orderBy(
      asc(importManifestEntries.sourceArtifactId),
      asc(importManifestEntries.recordIndex),
    );
  return { id: run.id, state: run.state, version: run.version, entries };
}

/** What `/api/v1` hands an import read for an operator credential. */
export interface ImportRunsOperatorReadInput {
  context: AuthorizedCommandContext;
  /** The deployment's `REQUESTPORT_OPERATOR_CREDENTIALS`. */
  operatorCredentials: "enabled" | "disabled" | undefined;
}

/**
 * The operator's standing for an import read, in the caller's one
 * transaction (`manifest-f2.md` §4.1, rules 4 and 5): first the bus's own
 * `assertCurrent` on the context — the deployment's operator switch, then
 * F.3's `lockActiveOperatorAuthorization` under share locks and the scopes'
 * subset check — so nothing is read for a switched-off deployment, a revoked
 * or expired credential or key, a member no longer active or a suspended
 * organisation. It answers the member `memberAuthority` names (never
 * `context.actor.id`, which is `operator:<lineage>`), the context's
 * organisation and its bound project, if any.
 *
 * A context that is not an operator's is refused `forbidden` before anything
 * is read: these reads admit operators only (§4.1, rule 2).
 */
async function operatorReader(
  tx: Tx,
  input: ImportRunsOperatorReadInput,
): Promise<ImportRunsReadInput> {
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
 * `list_administration_import_runs` as `/api/v1` answers it for an operator
 * credential: `operatorReader`'s re-check, then
 * `listAdministrationImportRuns` for its member, organisation and project.
 */
export async function readImportRunsForOperator(
  tx: Tx,
  input: ImportRunsOperatorReadInput,
) {
  return listAdministrationImportRuns(tx, await operatorReader(tx, input));
}

/**
 * `get_administration_import_run` as `/api/v1` answers it for an operator
 * credential: `operatorReader`'s re-check, then `getAdministrationImportRun`
 * for its member, organisation and project, and the path's run.
 */
export async function readImportRunForOperator(
  tx: Tx,
  input: ImportRunsOperatorReadInput & {
    /** The path's run. Not trusted to be a UUID. */
    runId: string;
  },
) {
  return getAdministrationImportRun(tx, {
    ...(await operatorReader(tx, input)),
    runId: input.runId,
  });
}
