import {
  createCommandAuthorizationRepository,
  type Database,
  evaluateRouteForOperator,
  listAdministrationLanes,
  listAdministrationMembers,
  listAdministrationProjects,
  readAgentPrincipalForOperator,
  readAgentPrincipalsForOperator,
  readImportRunForOperator,
  readImportRunsForOperator,
  readInvitationsForOperator,
  readOperationsForOperator,
  readOrganizationAppearanceForOperator,
  readProjectSettingsForOperator,
  readRetentionHoldsForOperator,
  readRoutingRulesForOperator,
  readSlackConfigurationForOperator,
  type Tx,
  withAdministrationReadTransaction,
} from "@requestport/db";
import {
  type AdministrationReadName,
  type AuthorizedCommandContext,
  administrationBasePath,
  admitsCredentialKind,
  type Capability,
  capabilityRegistry,
  DomainError,
  isOperatorContext,
  memberAuthority,
  type QueryCapability,
  restApiBasePath,
} from "@requestport/domain";

import type { RequestPortSecrets } from "./options.js";

/*
  The administration reads (Plan 13, F.2.0; `manifest-f2.md` §4.1), moved
  from `apps/web/src/lib/server-administration-reads.ts` into core in Plan
  13, G.6 (manifest-g.md §2.5's `administration-read` row). `query`
  (`query.ts`) runs one for its registry entry, after the admission below;
  the REST route's GET handler hands every path under
  `administrationBasePath`, the prefix itself included, to `query`, through
  `resolveRestQuery`, before it asks for a project, and never to the agent
  queries. Each read in `administrationReads` makes that admission again
  itself, for the registry entry that dispatches to it, before its
  transaction opens (`admitted`; ruling 230), for a caller of the published
  `./adapters` entry that calls the map without `query`.

  A read is added as a registry entry dispatched to `administration-read`,
  plus one line in `administrationReads` under the entry's `dispatch.method`.
  Neither the REST route nor `query` is edited for it. The map is an R4
  append point (ruling 28): keep both lines, never sort. It is one object for
  the process, which `apps/web/src/lib/server-administration-reads.ts`
  re-exports, and each read is handed the storage's handle and the switch it
  reads by the RequestPort that runs it (`reading`).
*/

/**
 * What a RequestPort hands each administration read it runs: the handle the
 * read's one transaction opens on (its storage's `db`), and the secrets whose
 * `operatorCredentials` switch the read's re-check reads as it runs.
 */
export interface AdministrationReading {
  database: Database;
  secrets: Pick<RequestPortSecrets, "operatorCredentials">;
}

/** What an administration read is handed. */
export interface AdministrationReadInput {
  context: AuthorizedCommandContext;
  /** The path's parameters, by the names in braces in the entry's path. */
  pathParameters: Readonly<Record<string, string>>;
  searchParams: URLSearchParams;
  reading: AdministrationReading;
}

export type AdministrationRead = (
  input: AdministrationReadInput,
) => Promise<unknown>;

/** What every administration read is bound to (`manifest-f2.md` §4.1, rule 5). */
export interface OperatorReadScope {
  /** The member the operator acts for, from `memberAuthority`. */
  memberUserId: string;
  /** The credential's organisation. */
  organizationId: string;
  /** The project the credential is bound to, or null when it is bound to none. */
  credentialProjectId: string | null;
}

/**
 * Runs `read` for the operator behind `context`, in one transaction (§4.1,
 * rule 4), bound to the credential's organisation before its first statement
 * (`withAdministrationReadTransaction`; manifest-i2.md §4 Owns, ruling 50),
 * on `reading.database`. First F.3's re-check of the operator's whole chain:
 * `assertCurrent`, whose operator branch refuses while `reading.secrets`'
 * `operatorCredentials` is not `enabled`, refuses a malformed context before
 * any query, and runs `lockActiveOperatorAuthorization` under share locks,
 * so nothing is read for a revoked or expired credential, a revoked or
 * demoted member or a suspended organisation. Then the read, handed the
 * member `memberAuthority` names, the credential's organisation and its
 * project (rule 5), and never `context.actor.id`, which for an operator is
 * `operator:<lineage>`. Any other context is refused before the transaction
 * opens.
 */
async function asOperator<T>(
  context: AuthorizedCommandContext,
  reading: AdministrationReading,
  read: (tx: Tx, scope: OperatorReadScope) => Promise<T>,
): Promise<T> {
  const member = memberAuthority(context);
  if (member?.via !== "operator") {
    throw new DomainError(
      "forbidden",
      "Only an operator credential reaches an administration read",
    );
  }

  return withAdministrationReadTransaction(
    context.organizationId,
    async (tx) => {
      await createCommandAuthorizationRepository(tx, {
        operatorCredentials: reading.secrets.operatorCredentials,
      }).assertCurrent(context);
      return read(tx, {
        memberUserId: member.userId,
        organizationId: context.organizationId,
        credentialProjectId: context.projectId ?? null,
      });
    },
    { database: reading.database },
  );
}

/**
 * Every administration read, by the name its entry dispatches it under. One
 * line per read, each in one transaction bound to the credential's
 * organisation before its first statement
 * (`withAdministrationReadTransaction`; manifest-i2.md §4 Owns, ruling 50),
 * opened on the handle the RequestPort hands it (`reading.database`), and
 * each re-checking the operator in that transaction before it reads, under
 * `reading.secrets`' `operatorCredentials`: F.2.0b's through `asOperator`,
 * F.2.3's inside `readProjectSettingsForOperator`, F.2.1's inside
 * `readRoutingRulesForOperator` and `evaluateRouteForOperator`, F.2.2's inside
 * `readAgentPrincipalsForOperator` and `readAgentPrincipalForOperator`, F.2.4's
 * inside `readOperationsForOperator` and `readRetentionHoldsForOperator`,
 * F.2.5's inside `readSlackConfigurationForOperator`, F.2.6's inside
 * `readImportRunsForOperator` and `readImportRunForOperator`, and F.2.7's
 * inside `readInvitationsForOperator` and
 * `readOrganizationAppearanceForOperator`. Before any of that, each read
 * admits its context by `readAdministrationEntry`'s rule for the registry
 * entry that dispatches to it (`admitted`, below; ruling 230), so a caller
 * that runs a read here directly is refused what `query` refuses.
 */
export const administrationReads: {
  readonly [name in AdministrationReadName]: AdministrationRead;
} = admitted({
  // F.2.0b: the three shared reads (`manifest-f2.md` §4.1).
  list_administration_projects: ({ context, reading }) =>
    asOperator(context, reading, (tx, scope) =>
      listAdministrationProjects(tx, scope),
    ),
  list_administration_lanes: ({ context, searchParams, reading }) =>
    asOperator(context, reading, (tx, scope) =>
      listAdministrationLanes(tx, {
        ...scope,
        projectId: searchParams.get("projectId"),
      }),
    ),
  list_administration_members: ({ context, reading }) =>
    asOperator(context, reading, (tx, scope) =>
      listAdministrationMembers(tx, scope),
    ),
  // Plan 13, F.2.3: one transaction, bound to the credential's organisation
  // (ruling 50), in which the operator's credential is re-checked as the bus
  // re-checks it, under the deployment's switch, before the projection is
  // read for its member (`project-settings-reads.ts`).
  get_administration_project_settings: ({ context, pathParameters, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readProjectSettingsForOperator(tx, {
          context,
          projectId: pathParameters.projectId ?? "",
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  // Plan 13, F.2.1: one transaction each, bound to the credential's
  // organisation (ruling 50), in which the operator's credential is
  // re-checked as the bus re-checks it, under the deployment's switch, before
  // the rules are read or the route is evaluated for its member
  // (`routing-reads.ts`). Route evaluation takes the route from the query
  // string, under the entry's own purpose.
  list_administration_routing_rules: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readRoutingRulesForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  test_administration_route: ({ context, searchParams, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        evaluateRouteForOperator(tx, {
          context,
          purpose: "test",
          searchParams,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  preview_administration_route: ({ context, searchParams, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        evaluateRouteForOperator(tx, {
          context,
          purpose: "preview",
          searchParams,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  // Plan 13, F.2.2: one transaction each, bound to the credential's
  // organisation (ruling 50), in which the operator's credential is
  // re-checked as the bus re-checks it, under the deployment's switch, before
  // the principals are read for its member (`agent-reads.ts`).
  list_administration_agent_principals: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readAgentPrincipalsForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  get_administration_agent_principal: ({ context, pathParameters, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readAgentPrincipalForOperator(tx, {
          context,
          agentPrincipalId: pathParameters.agentPrincipalId ?? "",
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  // Plan 13, F.2.4: one transaction each, bound to the credential's
  // organisation (ruling 50), in which the operator's credential is
  // re-checked as the bus re-checks it, under the deployment's switch, before
  // the organisation's rows are read for its member (`operations-reads.ts`).
  list_administration_operations: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readOperationsForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  list_administration_retention_holds: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readRetentionHoldsForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  // Plan 13, F.2.5: as F.2.3's, one transaction, bound to the credential's
  // organisation (ruling 50), in which the operator's credential is
  // re-checked as the bus re-checks it, under the deployment's switch, before
  // the organisation's Slack configuration is read for its member
  // (`slack-reads.ts`).
  get_administration_slack_configuration: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readSlackConfigurationForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  // Plan 13, F.2.6: each in one transaction, bound to the credential's
  // organisation (ruling 50), in which the operator's credential is
  // re-checked as the bus re-checks it, under the deployment's switch, before
  // the runs are read for its member (`import-reads.ts`).
  list_administration_import_runs: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readImportRunsForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  get_administration_import_run: ({ context, pathParameters, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readImportRunForOperator(tx, {
          context,
          runId: pathParameters.runId ?? "",
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  // Plan 13, F.2.7: each in one transaction, bound to the credential's
  // organisation (ruling 50), in which the operator's credential is
  // re-checked as the bus re-checks it, under the deployment's switch, before
  // the projection is read for its member (`member-reads.ts`).
  list_administration_invitations: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readInvitationsForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
  get_administration_organization_appearance: ({ context, reading }) =>
    withAdministrationReadTransaction(
      context.organizationId,
      (tx) =>
        readOrganizationAppearanceForOperator(tx, {
          context,
          operatorCredentials: reading.secrets.operatorCredentials,
        }),
      { database: reading.database },
    ),
});

export type AdministrationEntry = QueryCapability & {
  dispatch: { to: "administration-read"; method: AdministrationReadName };
};

export function isAdministrationEntry(
  capability: Capability,
): capability is AdministrationEntry {
  return (
    capability.kind === "query" &&
    capability.dispatch.to === "administration-read"
  );
}

/** The prefix's segments after `/api/v1/`: today, `administration` alone. */
const prefixSegments = administrationBasePath
  .slice(restApiBasePath.length + 1)
  .split("/");

/** True for the prefix itself and every path under it. */
export function isAdministrationPath(parts: readonly string[]) {
  return prefixSegments.every((segment, index) => parts[index] === segment);
}

/**
 * The administration entry whose path `parts` is, with its path parameters,
 * or undefined. A parameter matches any one non-empty segment.
 */
export function findAdministrationRead(parts: readonly string[]):
  | {
      entry: AdministrationEntry;
      pathParameters: Record<string, string>;
    }
  | undefined {
  for (const entry of capabilityRegistry.filter(isAdministrationEntry)) {
    const segments = entry.rest.path
      .slice(restApiBasePath.length + 1)
      .split("/");
    if (segments.length !== parts.length) continue;
    const pathParameters: Record<string, string> = {};
    const matched = segments.every((segment, index) => {
      const part = parts[index] ?? "";
      if (!segment.startsWith("{")) return segment === part;
      pathParameters[segment.slice(1, -1)] = part;
      return part.length > 0;
    });
    if (matched) return { entry, pathParameters };
  }
  return undefined;
}

/**
 * Whether `entry` admits the credential behind `context`: by the entry's
 * `credentialKinds` (Plan 13, F.3, ruling 25), where an absent field admits
 * agents only. An agent never reaches this — `readAdministrationEntry`
 * refuses it first (§4.1, rule 2) — so an entry admits a credential here only
 * when it names `"operator"` and the context is an operator's.
 */
function admits(
  entry: AdministrationEntry,
  context: AuthorizedCommandContext,
): boolean {
  return admitsCredentialKind(
    entry,
    isOperatorContext(context) ? "operator" : "agent",
  );
}

/** Refuses an agent credential at an administration read (§4.1, rule 2). */
export function refuseAgentAtAdministration(context: AuthorizedCommandContext) {
  if (context.actor.type === "agent") {
    throw new DomainError(
      "forbidden",
      "An agent credential cannot reach an administration read",
    );
  }
}

/** The refusal a path under the prefix that no entry admits answers. */
export function notAdmittedToAdministration(): DomainError {
  return new DomainError(
    "forbidden",
    "This credential is not admitted to this administration read",
  );
}

/**
 * `reads`, each admitting its context before it runs (ruling 230): by
 * `readAdministrationEntry`'s rule, for the registry entry that dispatches to
 * it (`entryDispatchingTo`), so before its transaction opens. A refusal is the
 * read's rejection. The scopes checked are the ones the context states; each
 * read's own re-check in its transaction then compares them with the
 * operator credential's (`assertCurrent`). `readAdministrationEntry` makes
 * the same checks before it runs a read, so a call `query` admits passes them
 * here too.
 */
function admitted(
  reads: {
    readonly [name in AdministrationReadName]: AdministrationRead;
  },
): { [name in AdministrationReadName]: AdministrationRead } {
  const lines = Object.entries(reads) as Array<
    [AdministrationReadName, AdministrationRead]
  >;
  return Object.fromEntries(
    lines.map(([name, read]) => [
      name,
      async (input: AdministrationReadInput) => {
        admitToAdministrationRead(entryDispatchingTo(name), input.context);
        return read(input);
      },
    ]),
  ) as { [name in AdministrationReadName]: AdministrationRead };
}

/**
 * The administration entry whose dispatch is the read `name`, read from the
 * registry as it stands when the read runs, as `query` reads its entry. No
 * such entry, or more than one, is a fault in this dispatch, answered as one
 * (500), never a refusal or a pass.
 */
function entryDispatchingTo(name: AdministrationReadName): AdministrationEntry {
  const found = capabilityRegistry
    .filter(isAdministrationEntry)
    .filter((entry) => entry.dispatch.method === name);
  const [entry] = found;
  if (found.length !== 1 || entry === undefined) {
    throw new Error(
      `No single capability registry administration entry dispatches to the read ${name}`,
    );
  }
  return entry;
}

/**
 * `readAdministrationEntry`'s admission, in its order and words: an agent
 * refused first (§4.1, rule 2), then a credential `entry` does not admit,
 * then one lacking the entry's scope.
 */
function admitToAdministrationRead(
  entry: AdministrationEntry,
  context: AuthorizedCommandContext,
) {
  refuseAgentAtAdministration(context);
  if (!admits(entry, context)) throw notAdmittedToAdministration();
  if (entry.scope !== null && !context.scopes.has(entry.scope)) {
    throw new DomainError("forbidden", "Credential scope is not sufficient");
  }
}

/**
 * Runs the administration read `entry` dispatches to, for `context`, or
 * throws the refusal.
 *
 * An agent credential is refused `403` first (§4.1, rule 2). Every other
 * credential is refused `403` unless the entry admits it, and then only with
 * the entry's scope. Nothing is read before any refusal. The other credential
 * REST authenticates is an operator's (F.3), admitted to the entries whose
 * `credentialKinds` names it. The read it then runs from `administrationReads`
 * makes the same checks again (`admitted`).
 */
export async function readAdministrationEntry(
  entry: AdministrationEntry,
  context: AuthorizedCommandContext,
  parameters: {
    pathParameters: Readonly<Record<string, string>>;
    searchParams: URLSearchParams;
  },
  reading: AdministrationReading,
): Promise<unknown> {
  refuseAgentAtAdministration(context);
  if (!admits(entry, context)) throw notAdmittedToAdministration();
  if (entry.scope !== null && !context.scopes.has(entry.scope)) {
    throw new DomainError("forbidden", "Credential scope is not sufficient");
  }
  const read = administrationReadNamed(entry.dispatch.method);
  return read({
    context,
    pathParameters: parameters.pathParameters,
    searchParams: parameters.searchParams,
    reading,
  });
}

/**
 * The map's read of this name. An entry with no line in the map is a fault
 * in this dispatch, answered as one (500), never as a refusal or a pass, as
 * `query` answers a query name it has no dispatch for. Own properties only,
 * so a name that is only an inherited one (`constructor`) finds nothing.
 */
function administrationReadNamed(name: string): AdministrationRead {
  const reads: Readonly<Record<string, AdministrationRead>> =
    administrationReads;
  if (!Object.hasOwn(reads, name))
    throw new Error(`No administration read named ${name}`);
  return reads[name] as AdministrationRead;
}
