import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  E2E_TOKEN_HEADER,
  type E2EEnvironment,
  isE2EEmailMode,
} from "@requestport/auth/e2e";

/**
 * The typed local-only scenario primitive.
 *
 * A deterministic browser suite has to be able to ask the server for a state
 * the product cannot otherwise be talked into — a loading boundary that never
 * resolves, a conflicting write, an unreachable provider — and it has to be
 * able to do that without leaving a single row behind. This module is the two
 * halves of that: the guard that decides whether such a request may be
 * answered at all, and the run lifecycle that records exactly what a scenario
 * created and removes it in the reverse of the order its foreign keys were
 * satisfied.
 *
 * Two properties are deliberately structural rather than conventional:
 *
 * - **nothing here is open-ended.** A scenario cannot carry SQL, a query, or a
 *   message; the tables it may touch come from one closed list and the failures
 *   it may emit come from another. Free-form text is what turns a test hook
 *   into a general-purpose fault-injection primitive, and a closed vocabulary
 *   is the only thing that keeps that from happening by accident;
 * - **cleanup is a `finally`, not a step.** A scenario that fails half-way is
 *   exactly the scenario most likely to strand rows, so the rows recorded
 *   before a failing seed are removed on the failing path too.
 */

/** The reusable constant-time token header the E2E lifecycle already owns. */
export { E2E_TOKEN_HEADER };

/**
 * Every table a scenario may create a row in, in the order a writer must
 * satisfy: a table appears only after every table it references.
 *
 * Cleanup walks this list backwards, which is what makes "delete the child
 * before the parent" a property of the list rather than of each call site.
 * `e2e-scenario.test.ts` re-derives the foreign keys from the checked-in
 * migrations and fails if any edge here runs the wrong way, so the order
 * cannot drift away from the schema it describes.
 */
export const e2eScenarioTables = [
  "signup_allowlist",
  "verification",
  "user",
  "session",
  "organizations",
  "organization_members",
  "organization_appearance_defaults",
  "user_appearance_preferences",
  "projects",
  "project_members",
  "project_repositories",
  "requests",
  "questions",
  "answers",
  "webhook_subscriptions",
] as const;

/**
 * Every foreign key that could refuse a delete this cleanup issues.
 *
 * Cleanup removes the rows a scenario recorded, by id. Anything the
 * *application* wrote while the browser drove it is not recorded and not
 * removed — so a row nobody is tracking can end up pointing at a row this is
 * about to delete, and a non-cascading key turns that into `23503` and a dead
 * lane. The hazard is real, though the one that has fired so far belonged to
 * the *other* cleanup: on staging acceptance 34842342037,
 * `retention_holds_created_by_user_id_user_id_fk` refused the foundation
 * fixture's delete-by-email in `tests/fixtures/auth.ts`, not a delete issued
 * here, and it read as flakiness because the lane passed on retry. This
 * register was first written as though that incident were this cleanup's. It
 * was not; the class is shared, the incident was not.
 *
 * The ordering test next to this could not have caught it: it skips any edge
 * whose child is not listed above, so it checks the order of the tables that
 * are listed and cannot see one that should be. This register answers the
 * other question — which keys could refuse — and `e2e-scenario.test.ts`
 * requires every one the migrations declare to appear here by name.
 *
 * Read it as a list of hazards that have not been observed to fire, not as a
 * proof that they cannot. Each says what it is and what would have to happen;
 * none of them is dismissed as impossible, because the one that fired was in
 * exactly this position the day before it did.
 */
export const uncleanedReferences: Readonly<
  Record<string, { edge: string; why: string }>
> = {
  agent_credentials_created_by_user_id_user_id_fk: {
    edge: "agent_credentials -> user",
    why: "A scenario that provisions an agent leaves a credential the run never recorded, pointing at the user it did. Not yet reached: no route/state case drives provisioning.",
  },
  agent_principals_created_by_user_id_user_id_fk: {
    edge: "agent_principals -> user",
    why: "As above, for the principal the credential hangs off.",
  },
  operator_credentials_member_user_id_user_id_fk: {
    edge: "operator_credentials -> user",
    why: "An operator credential restricts deleting the member who issued it (Plan 13, F.3), so its audit trail keeps a person. Not yet reached: no route/state case issues one.",
  },
  domain_events_project_fk: {
    edge: "domain_events -> projects",
    why: "`domain_events` is append-only by trigger, so these rows can never be deleted by anything. A scenario whose project accumulates an event cannot clean up after itself at all — the only remedy is not to record the project, or not to write the event.",
  },
  domain_events_request_fk: {
    edge: "domain_events -> requests",
    why: "The same trigger, for a request rather than a project.",
  },
  import_sources_repository_fk: {
    edge: "import_sources -> project_repositories",
    why: "An import source outlives the repository row a scenario recorded. Not yet reached: no case drives an import.",
  },
  legacy_aliases_source_project_fk: {
    edge: "legacy_aliases -> projects",
    why: "Written by the legacy importer, which no route/state case drives.",
  },
  legacy_aliases_canonical_request_fk: {
    edge: "legacy_aliases -> requests",
    why: "As above, against the request an alias resolves to.",
  },
  oauth_access_token_session_id_session_id_fk: {
    edge: "oauth_access_token -> session",
    why: "Signing in through the OAuth provider mints a token against the session, and `session` is cleaned. The agent-consent journey is the case that can reach this.",
  },
  oauth_refresh_token_session_id_session_id_fk: {
    edge: "oauth_refresh_token -> session",
    why: "The refresh half of the same mint.",
  },
  retention_holds_created_by_user_id_user_id_fk: {
    edge: "retention_holds -> user",
    why: "The shape that has actually fired, though against the foundation fixture's delete-by-email rather than a delete issued here — staging acceptance 34842342037, since fixed in `tests/fixtures/auth.ts`. This cleanup deletes by recorded id and has not met it, but a scenario recording a user who places a hold would.",
  },
  retention_holds_released_by_user_id_user_id_fk: {
    edge: "retention_holds -> user",
    why: "The same table by its other user column; it fires the moment a held row is released by a scenario's user.",
  },
  retention_tombstones_organization_id_organizations_id_fk: {
    edge: "retention_tombstones -> organizations",
    why: "A tombstone survives the organization it describes, which is the point of a tombstone. Not yet reached: no case drives retention.",
  },
  security_audit_records_organization_id_organizations_id_fk: {
    edge: "security_audit_records -> organizations",
    why: "The audit trail is append-only, so like `domain_events` these rows cannot be deleted. Any case whose organization is audited cannot be cleaned up.",
  },
  slack_action_tokens_answer_fk: {
    edge: "slack_action_tokens -> answers",
    why: "Slack callbacks are inactive in both environments, so nothing writes this today.",
  },
  slack_installations_installed_by_user_id_user_id_fk: {
    edge: "slack_installations -> user",
    why: "As above, for the install record.",
  },
};

export type E2EScenarioTable = (typeof e2eScenarioTables)[number];

const scenarioTables = new Set<string>(e2eScenarioTables);

/**
 * The complete failure vocabulary.
 *
 * A browser failure is read from a transcript hours later by someone who
 * cannot re-run it, so the text has to mean the same thing every time. It also
 * has to be safe to print: an underlying driver error carries connection
 * strings, identifiers, and row values, and a scenario hook that re-threw one
 * would publish them into CI logs and screenshots. Every throw below replaces
 * whatever it caught with one of these.
 */
export const e2eScenarioFailures = {
  body: "E2E scenario body failed",
  cleanup: "E2E scenario cleanup failed",
  namespace: "E2E scenario namespace is invalid",
  seed: "E2E scenario seed failed",
  table: "E2E scenario table is outside the cleanup order",
  unavailable: "E2E scenario hook is unavailable",
  unknown: "E2E scenario is not catalogued",
} as const;

export type E2EScenarioFailure =
  (typeof e2eScenarioFailures)[keyof typeof e2eScenarioFailures];

/**
 * The one Error a caller of this module can ever see.
 *
 * It is returned rather than thrown so every site reads `throw
 * fixedFailure(...)`: a `throw` is the one form every reader — and every
 * control-flow analysis — agrees ends a path, including inside a `catch` whose
 * `finally` still has work to do.
 */
function fixedFailure(failure: E2EScenarioFailure): Error {
  return new Error(failure);
}

/** One row a scenario created, addressed the way cleanup will address it. */
export type E2EScenarioRow = Readonly<{
  table: E2EScenarioTable;
  id: string;
}>;

/** The live handle a seed and a body are given. */
export type E2EScenarioRun = {
  /** The generated UUID every row this scenario creates is namespaced by. */
  readonly namespace: string;
  /** Exactly the rows recorded so far, in the order they were recorded. */
  readonly created: readonly E2EScenarioRow[];
  record(table: E2EScenarioTable, id: string): void;
};

/**
 * The one way rows leave the database.
 *
 * It is a port rather than a query so the lifecycle can be proven without one:
 * the ordering contract is about which batch is deleted first, and a test that
 * needed a database to observe that would be testing the database.
 */
export type E2EScenarioRowDeleter = (
  batch: Readonly<{ table: E2EScenarioTable; ids: readonly string[] }>,
) => Promise<void>;

export type E2EScenarioLifecycle = Readonly<{
  deleteRows: E2EScenarioRowDeleter;
  seed: (run: E2EScenarioRun) => Promise<void>;
  /** Overridable only so a test can observe the namespace it generated. */
  createNamespace?: () => string;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function createRun(namespace: string): E2EScenarioRun {
  if (!uuidPattern.test(namespace))
    throw fixedFailure(e2eScenarioFailures.namespace);
  const created: E2EScenarioRow[] = [];

  return {
    namespace,
    get created() {
      return [...created];
    },
    record(table, id) {
      if (!scenarioTables.has(table))
        throw fixedFailure(e2eScenarioFailures.table);
      if (typeof id !== "string" || id === "") {
        throw fixedFailure(e2eScenarioFailures.table);
      }
      created.push({ id, table });
    },
  };
}

/**
 * Remove everything a run recorded, child rows first.
 *
 * Grouping by table and walking `e2eScenarioTables` backwards is what makes
 * the order a property of the schema rather than of the order a seed happened
 * to write in. Within a table the recorded order is kept, so a self-referencing
 * chain is deleted in the order it was built rather than in an arbitrary one.
 */
async function cleanupRun(
  run: E2EScenarioRun,
  deleteRows: E2EScenarioRowDeleter,
) {
  const byTable = new Map<E2EScenarioTable, string[]>();
  for (const row of run.created) {
    const ids = byTable.get(row.table);
    if (ids) ids.push(row.id);
    else byTable.set(row.table, [row.id]);
  }

  for (let index = e2eScenarioTables.length - 1; index >= 0; index -= 1) {
    const table = e2eScenarioTables[index];
    if (table === undefined) continue;
    const ids = byTable.get(table);
    if (!ids || ids.length === 0) continue;
    try {
      await deleteRows({ ids, table });
    } catch {
      // Which table, and nothing else. The database's own message is dropped
      // here as it is everywhere in this module — it can carry a row's values
      // into a public log — but the table is one of a closed, checked-in list
      // and names nothing a run created. Without it a failed cleanup says only
      // that one happened, which is how a release that failed on every case of
      // a lane left no way to tell whether the trouble was the rows a change
      // had just started seeding or the ones that were always there.
      throw new Error(`${e2eScenarioFailures.cleanup}: ${table}`);
    }
  }
}

async function cleanupOrFail(
  run: E2EScenarioRun,
  deleteRows: E2EScenarioRowDeleter,
) {
  try {
    await cleanupRun(run, deleteRows);
  } catch (failure) {
    // A message this module composed is kept; anything else is replaced. The
    // one composed above is the fixed cleanup sentence and a table name from
    // the closed list, so letting it through adds nothing a database said —
    // and recognising it by its own prefix means a message from anywhere else,
    // including the driver, still cannot reach a log through here.
    if (
      failure instanceof Error &&
      failure.message.startsWith(e2eScenarioFailures.cleanup)
    ) {
      throw failure;
    }

    throw fixedFailure(e2eScenarioFailures.cleanup);
  }
}

/**
 * Seed a scenario and hand back its live run.
 *
 * A seed that fails half-way has still created rows, and those rows are the
 * ones most likely to be forgotten, so they are removed here before the fixed
 * seed failure is raised. The cleanup runs inside its own guard: a cleanup
 * failure on a failing seed must not replace the seed failure with a different
 * one, because the first thing a reader needs to know is which half broke.
 */
export async function openE2EScenarioRun(
  lifecycle: E2EScenarioLifecycle,
): Promise<E2EScenarioRun> {
  const run = createRun((lifecycle.createNamespace ?? randomUUID)());

  try {
    await lifecycle.seed(run);
  } catch {
    await cleanupRun(run, lifecycle.deleteRows).catch(() => undefined);
    throw fixedFailure(e2eScenarioFailures.seed);
  }

  return run;
}

/** Release a live run, removing every row it recorded. */
export async function closeE2EScenarioRun(
  run: E2EScenarioRun,
  deleteRows: E2EScenarioRowDeleter,
) {
  await cleanupOrFail(run, deleteRows);
}

/**
 * Run a scenario end to end with cleanup in a `finally`.
 *
 * This is the shape an in-process caller wants; the HTTP hook opens and closes
 * the same run across two requests. Both funnel through one cleanup, so the
 * reverse-key order is proven once rather than per entry point.
 */
export async function withE2EScenarioRun<T>(
  lifecycle: E2EScenarioLifecycle,
  body: (run: E2EScenarioRun) => Promise<T>,
): Promise<T> {
  const run = await openE2EScenarioRun(lifecycle);
  let raised = false;

  try {
    return await body(run);
  } catch {
    raised = true;
    throw fixedFailure(e2eScenarioFailures.body);
  } finally {
    if (raised) {
      await cleanupRun(run, lifecycle.deleteRows).catch(() => undefined);
    } else {
      await cleanupOrFail(run, lifecycle.deleteRows);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The guard.
 * ------------------------------------------------------------------ */

/**
 * Whether a host names the loopback interface itself.
 *
 * Only literal addresses qualify. `localhost` is a *name*, and a name is
 * resolved by whatever the machine's resolver says today — which is not a
 * property of how the server was bound. The E2E server binds `127.0.0.1`
 * explicitly, so the address it was bound to is the thing worth checking.
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "") return false;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(host);
  if (bracketed) return bracketed[1] === "::1";

  const address = host.replace(/:\d+$/u, "");
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (!octets) return false;

  const parts = octets.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return false;

  return parts[0] === 127;
}

/**
 * Whether one forwarded element names the loopback interface.
 *
 * A forwarded element is an address rather than an authority: RFC 7239 may
 * quote it, and an IPv6 address is written bracketed there but bare in
 * `X-Forwarded-For`. Past those two spellings the rule is the literal-address
 * rule above, `localhost` included — a name still says nothing about a socket.
 */
function isLoopbackForwardedValue(value: string): boolean {
  const trimmed = value.trim();
  const unquoted = (/^"(.*)"$/u.exec(trimmed)?.[1] ?? trimmed).trim();

  return unquoted === "::1" || isLoopbackHost(unquoted);
}

/** Every element of a comma-separated forwarded list, empty entries included. */
function forwardedElements(value: string): string[] {
  return value.split(",");
}

/**
 * Every origin an RFC 7239 `Forwarded` header names, or `null` when it names
 * none.
 *
 * A header carrying only a scheme or a protocol says nothing about which
 * socket the request reached, and "says nothing" is not the same answer as
 * "says it reached ours".
 */
function forwardedOrigins(value: string): string[] | null {
  const origins: string[] = [];

  for (const element of forwardedElements(value)) {
    for (const parameter of element.split(";")) {
      const named = /^\s*(?:for|host)\s*=\s*(.*?)\s*$/iu.exec(parameter);
      if (named?.[1] !== undefined) origins.push(named[1]);
    }
  }

  return origins.length > 0 ? origins : null;
}

/** The port an authority names, defaulting to the scheme's own. */
function authorityPort(host: string): string {
  const bracketed = /^\[[^\]]+\](?::(\d+))?$/u.exec(host);
  if (bracketed) return bracketed[1] ?? "80";

  return /:(\d+)$/u.exec(host)?.[1] ?? "80";
}

/** The forwarded headers whose every value must name a loopback address. */
const forwardedAddressHeaders = [
  "x-forwarded-for",
  "x-forwarded-host",
] as const;

/**
 * Whether the request reached the loopback socket the E2E server binds.
 *
 * The `Host` header is the authority the caller addressed, and the Next
 * runtime passes it through verbatim: a request sent to `127.0.0.1:3100` still
 * says exactly that here. `request.url` does not — Next rebuilds it from a
 * normalised `localhost` whatever `--hostname` the server was started with, so
 * a host read out of it describes the framework rather than the socket, and it
 * is deliberately not read. That is also why `localhost` is refused rather
 * than added to the accepted set: accepting it would accept every request the
 * framework can synthesise, which is the opposite of a binding check.
 *
 * The forwarded headers are checked by *value* rather than by presence,
 * because the runtime injects the whole `x-forwarded-*` family on every
 * route-handler request from the socket it accepted — refusing them on sight
 * refuses every request the server can produce. A caller may set them itself,
 * and the observed runtime keeps a client's value rather than replacing it, so
 * an inbound claim of a public client, a rewritten host or port, or a
 * terminated TLS hop is refused exactly as a real proxy's would be.
 */
function isLoopbackBound(request: Request): boolean {
  const host = request.headers.get("host");
  if (host === null || !isLoopbackHost(host)) return false;

  const forwarded = request.headers.get("forwarded");
  if (forwarded !== null) {
    const origins = forwardedOrigins(forwarded);
    if (origins === null || !origins.every(isLoopbackForwardedValue)) {
      return false;
    }
  }

  for (const header of forwardedAddressHeaders) {
    const value = request.headers.get(header);
    if (value === null) continue;
    if (!forwardedElements(value).every(isLoopbackForwardedValue)) return false;
  }

  const proto = request.headers.get("x-forwarded-proto");
  if (proto !== null && proto.trim().toLowerCase() !== "http") return false;

  const port = request.headers.get("x-forwarded-port");

  return port === null || port.trim() === authorityPort(host);
}

export type E2EScenarioGuardInput = Readonly<{
  request: Request;
  env?: E2EEnvironment;
}>;

/**
 * Every condition the scenario hook requires, evaluated before anything about
 * the request body is read.
 *
 * All four must hold: a non-production `NODE_ENV` (`development` for the
 * checked-in Next E2E server, `test` for isolated route tests), the explicit
 * `REQUESTPORT_E2E_MODE=1` opt-in, a loopback-bound request, and the existing
 * constant-time token header. Any one of them missing is the same answer, and
 * the answer never depends on the body — a hook that parsed first would answer
 * a malformed production request differently from a well-formed one, and that
 * difference is itself the disclosure.
 */
export function isE2EScenarioRequestAllowed({
  env = process.env,
  request,
}: E2EScenarioGuardInput): boolean {
  if (!isE2EEmailMode(env)) return false;
  if (!isLoopbackBound(request)) return false;

  const expected = env.REQUESTPORT_E2E_TOKEN;
  const provided = request.headers.get(E2E_TOKEN_HEADER);
  if (!expected || provided === null) return false;

  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();

  return timingSafeEqual(expectedDigest, providedDigest);
}
