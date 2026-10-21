import { randomUUID } from "node:crypto";

import type { E2EEnvironment } from "@requestport/auth/e2e";
import {
  closeE2EScenarioRun,
  type E2EScenarioRowDeleter,
  type E2EScenarioRun,
  type E2EScenarioTable,
  e2eScenarioFailures,
  isE2EScenarioRequestAllowed,
  openE2EScenarioRun,
} from "../lib/e2e-scenario.js";
import {
  type E2EScenarioFault,
  e2eScenarioFaults,
  registerE2EScenarioRun,
  releaseE2EScenarioRun,
} from "../lib/e2e-scenario-fault.js";
import type { RouteState } from "./route-state-inventory.js";

/**
 * The closed local acceptance scenario catalogue.
 *
 * "Closed" is the whole point. A test hook that accepts a query, a message, or
 * an error string is a general-purpose fault-injection primitive wearing a
 * test's clothes: whatever guards stand in front of it, the thing behind them
 * can be asked to do anything. This catalogue can only be asked for one of the
 * cases it enumerates, by name, and a name it does not know resolves to
 * nothing at all rather than to a default.
 *
 * Every field of a case is drawn from a vocabulary declared here or derived
 * from the route/state inventory, so there is nowhere for caller text to live —
 * not a message, not a table, not a query. The states a case can put a surface
 * into are the inventory's own states; the tables it may create are the
 * lifecycle's own cleanup order; the failures it can emit are the lifecycle's
 * own fixed set.
 */

/** Which CI shard owns a case. The two lanes are sharded separately. */
export const e2eScenarioLanes = ["appearance", "route-state"] as const;
export type E2EScenarioLane = (typeof e2eScenarioLanes)[number];

/**
 * The acceptance concerns the reskin's browser lane must own, one name each.
 *
 * The list is the specification's own list of things only a guarded local run
 * can prove — synthetic boundaries, seeded identities and data, cleanup, and
 * the interaction and hygiene checks that a live staging journey deliberately
 * does not claim. A case declares exactly one, and the catalogue test fails
 * unless every one of them is claimed.
 */
export const e2eScenarioAspects = [
  "cleanup",
  "conflict",
  "console",
  "error",
  "fault-injection",
  "fields",
  "global-error",
  "hydration",
  "inheritance",
  "keyboard-focus",
  "loading",
  "long-values",
  "member-denied",
  "no-flash",
  "not-found",
  "overflow",
  "overlays",
  "persistence",
  "provider-unavailable",
  "redaction",
  "seeded-data",
  "seeded-identity",
  "session-switch",
  "tables",
] as const;
export type E2EScenarioAspect = (typeof e2eScenarioAspects)[number];

export type { E2EScenarioFault };
/**
 * The fault a case injects, or `none`.
 *
 * Each value is a state the route/state inventory already declares — either one
 * of its states or one of its framework boundaries — so a fault can only name a
 * condition some surface genuinely reaches. There is no `custom`, and no value
 * carries a payload.
 *
 * The list itself belongs to `e2e-scenario-fault.ts`, where the adapters that
 * act on it can name a value without reaching into this closed catalogue. It is
 * re-exported rather than restated so the two can never drift apart.
 */
export { e2eScenarioFaults };

/**
 * Who removes what a case leaves behind.
 *
 * `scenario-run` means the lifecycle's reverse-key cleanup owns it, because
 * the case created rows. `browser-context` means there is nothing in the
 * database to own: the case changed only what a disposable browser context
 * holds.
 */
export const e2eScenarioCleanupOwners = [
  "browser-context",
  "scenario-run",
] as const;
export type E2EScenarioCleanupOwner = (typeof e2eScenarioCleanupOwners)[number];

export type E2EScenarioDefinition = Readonly<{
  id: E2EScenarioId;
  aspect: E2EScenarioAspect;
  cleanupOwner: E2EScenarioCleanupOwner;
  fault: E2EScenarioFault;
  lane: E2EScenarioLane;
  /** The inventory states this case puts a surface into. */
  states: readonly RouteState[];
  /** Exactly the tables this case may create rows in, in cleanup order. */
  tables: readonly E2EScenarioTable[];
}>;

export const e2eScenarioIds = [
  "account-switch-and-sign-out",
  "conflicting-write",
  "console-hygiene",
  "data-tables",
  "fault-injection-scope",
  "form-fields",
  "global-error-boundary",
  "horizontal-overflow",
  "hydration-agreement",
  "keyboard-focus",
  "loading-boundary",
  "long-values",
  "member-denied",
  "no-flash-prepaint",
  "not-found-boundary",
  "organization-inheritance",
  "overlay-surfaces",
  "preference-persistence",
  "provider-unavailable",
  "route-error-boundary",
  "scenario-cleanup",
  "seeded-owner-identity",
  "seeded-project-data",
  "sentinel-redaction",
] as const;

export type E2EScenarioId = (typeof e2eScenarioIds)[number];

function definition(entry: E2EScenarioDefinition): E2EScenarioDefinition {
  return Object.freeze(entry);
}

export const e2eScenarios: Readonly<
  Record<E2EScenarioId, E2EScenarioDefinition>
> = Object.freeze({
  "account-switch-and-sign-out": definition({
    aspect: "session-switch",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "account-switch-and-sign-out",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "conflicting-write": definition({
    aspect: "conflict",
    cleanupOwner: "browser-context",
    fault: "conflict",
    id: "conflicting-write",
    lane: "route-state",
    states: ["conflict"],
    tables: [],
  }),
  "console-hygiene": definition({
    aspect: "console",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "console-hygiene",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "data-tables": definition({
    aspect: "tables",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "data-tables",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "fault-injection-scope": definition({
    aspect: "fault-injection",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "fault-injection-scope",
    lane: "route-state",
    states: ["default"],
    tables: [],
  }),
  "form-fields": definition({
    aspect: "fields",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "form-fields",
    lane: "appearance",
    states: ["default", "error", "pending"],
    tables: [],
  }),
  "global-error-boundary": definition({
    aspect: "global-error",
    cleanupOwner: "browser-context",
    fault: "global_error",
    id: "global-error-boundary",
    lane: "route-state",
    states: ["error"],
    tables: [],
  }),
  "horizontal-overflow": definition({
    aspect: "overflow",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "horizontal-overflow",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "hydration-agreement": definition({
    aspect: "hydration",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "hydration-agreement",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "keyboard-focus": definition({
    aspect: "keyboard-focus",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "keyboard-focus",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "loading-boundary": definition({
    aspect: "loading",
    cleanupOwner: "browser-context",
    fault: "loading",
    id: "loading-boundary",
    lane: "route-state",
    states: ["loading"],
    tables: [],
  }),
  "long-values": definition({
    aspect: "long-values",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "long-values",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "member-denied": definition({
    aspect: "member-denied",
    cleanupOwner: "browser-context",
    fault: "member_denied",
    id: "member-denied",
    lane: "route-state",
    states: ["member_denied"],
    tables: [],
  }),
  "no-flash-prepaint": definition({
    aspect: "no-flash",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "no-flash-prepaint",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "not-found-boundary": definition({
    aspect: "not-found",
    cleanupOwner: "browser-context",
    fault: "not_found",
    id: "not-found-boundary",
    lane: "route-state",
    states: ["not_found"],
    tables: [],
  }),
  "organization-inheritance": definition({
    aspect: "inheritance",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "organization-inheritance",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "overlay-surfaces": definition({
    aspect: "overlays",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "overlay-surfaces",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
  "preference-persistence": definition({
    aspect: "persistence",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "preference-persistence",
    lane: "appearance",
    states: ["default", "success"],
    tables: [],
  }),
  "provider-unavailable": definition({
    aspect: "provider-unavailable",
    cleanupOwner: "browser-context",
    fault: "provider_unavailable",
    id: "provider-unavailable",
    lane: "route-state",
    states: ["provider_unavailable"],
    tables: [],
  }),
  "route-error-boundary": definition({
    aspect: "error",
    cleanupOwner: "browser-context",
    fault: "error",
    id: "route-error-boundary",
    lane: "route-state",
    states: ["error"],
    tables: [],
  }),
  "scenario-cleanup": definition({
    aspect: "cleanup",
    cleanupOwner: "scenario-run",
    fault: "none",
    id: "scenario-cleanup",
    lane: "route-state",
    states: ["default"],
    tables: ["organizations", "projects"],
  }),
  "seeded-owner-identity": definition({
    aspect: "seeded-identity",
    cleanupOwner: "scenario-run",
    fault: "none",
    id: "seeded-owner-identity",
    lane: "route-state",
    states: ["default", "empty"],
    tables: [
      "signup_allowlist",
      "user",
      "organizations",
      "organization_members",
      "organization_appearance_defaults",
    ],
  }),
  "seeded-project-data": definition({
    aspect: "seeded-data",
    cleanupOwner: "scenario-run",
    fault: "none",
    id: "seeded-project-data",
    lane: "route-state",
    states: ["default", "destructive", "disabled", "pending", "success"],
    tables: ["projects", "project_members", "project_repositories", "requests"],
  }),
  "sentinel-redaction": definition({
    aspect: "redaction",
    cleanupOwner: "browser-context",
    fault: "none",
    id: "sentinel-redaction",
    lane: "appearance",
    states: ["default"],
    tables: [],
  }),
});

const catalogued = new Set<string>(e2eScenarioIds);

/**
 * The one way a request names a case.
 *
 * A plain property read would answer `__proto__` and `constructor` with
 * something truthy, which is precisely how a "closed" lookup stops being one,
 * so membership is decided by a set rather than by the object.
 */
export function resolveE2EScenario(id: unknown): E2EScenarioDefinition | null {
  if (typeof id !== "string" || !catalogued.has(id)) return null;

  return e2eScenarios[id as E2EScenarioId];
}

/* ------------------------------------------------------------------ *
 * The guarded hook.
 * ------------------------------------------------------------------ */

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
} as const;

function notFound() {
  return new Response("Not found", { headers: noStoreHeaders, status: 404 });
}

/**
 * The answer for a run whose register is gone.
 *
 * Distinct from `404` on purpose. `next dev` restarts itself when its heap
 * crosses the share it watches, and the register below dies with the process
 * that held it, so a release arriving after a restart is answered by a fresh
 * process that has never heard of the namespace. Answering that `404` makes it
 * indistinguishable from a driver closing a run nothing ever opened — and the
 * two want opposite things: the first leaves seeded rows whose identifiers only
 * the caller still holds, the second is a defect that must be reported.
 *
 * Reached only by a request that has already passed the guard and that names
 * the register it was given when the run was opened, so the ordering contract
 * above is untouched: a caller that fails the guard is answered `404` before a
 * byte of its body is read, whatever it sent.
 */
function gone() {
  return new Response("Gone", { headers: noStoreHeaders, status: 410 });
}

function fixedFailure(failure: string) {
  return Response.json({ failure }, { headers: noStoreHeaders, status: 500 });
}

/**
 * Creating the rows a case declares belongs to the route and query adapters
 * the inventory lists, which is where the schema and the tenant rules already
 * live. Until one is wired the hook says so with a fixed failure rather than
 * answering as though it had seeded anything — a scenario that silently
 * created nothing is the one failure mode a seeded case must never have.
 */
export type E2EScenarioRowSeeder = (
  input: Readonly<{
    definition: E2EScenarioDefinition;
    /**
     * The guarded request itself, so a tenant-scoped case can read the session
     * it was sent with. A case names no tenant and no identity: what it may
     * write into is decided by who the browser already is.
     */
    request: Request;
    run: E2EScenarioRun;
  }>,
) => Promise<void>;

export const unwiredScenarioRowSeeder: E2EScenarioRowSeeder = async ({
  definition,
}) => {
  if (definition.tables.length > 0) {
    throw new Error(e2eScenarioFailures.unavailable);
  }
};

export const unwiredScenarioRowDeleter: E2EScenarioRowDeleter = async () => {
  throw new Error(e2eScenarioFailures.unavailable);
};

export type ScenarioRouteOptions = Readonly<{
  deleteRows?: E2EScenarioRowDeleter;
  env?: E2EEnvironment;
  /**
   * Where the open runs are kept between the request that opens one and the
   * request that releases it.
   *
   * A private map per handler set is the right default — an isolated test must
   * not see another's runs — but the deployed shape of this hook is one module
   * evaluated by a development server that may re-evaluate it, and a run kept
   * in a module that has been replaced is a run whose rows nothing will ever
   * delete. The route passes a process-wide map for exactly that reason.
   */
  runs?: Map<string, E2EScenarioRun>;
  seedRows?: E2EScenarioRowSeeder;
  /**
   * The identity of the register above, minted when the register is.
   *
   * It is what tells a restart apart from a mistake. The value itself means
   * nothing and is never read for anything but equality; what matters is that
   * it is created exactly when the register is, so a module the development
   * server re-evaluates keeps both — a reload is not a restart and must not
   * look like one — and a process that exits takes both with it.
   */
  server?: string;
}>;

/**
 * The local-only hook, as a factory so a test can hand it an environment.
 *
 * Ordering is the contract: the guard runs to completion before a single byte
 * of the request body is touched, so a production deployment, a missing mode,
 * an absent or wrong token, and a proxied or non-loopback caller all get the
 * same answer whatever they sent. A body that parses is only ever consulted
 * for one thing — the name of a catalogued case — and a name the catalogue
 * does not hold is answered exactly like a name that was never sent.
 */
export function createScenarioRouteHandlers(
  options: ScenarioRouteOptions = {},
) {
  const {
    deleteRows = unwiredScenarioRowDeleter,
    env = process.env,
    runs = new Map<string, E2EScenarioRun>(),
    seedRows = unwiredScenarioRowSeeder,
    server = randomUUID(),
  } = options;

  async function parsedObject(request: Request) {
    const body: unknown = await request.json().catch((): null => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }

    return body as Record<string, unknown>;
  }

  return {
    async POST(request: Request) {
      if (!isE2EScenarioRequestAllowed({ env, request })) return notFound();

      const body = await parsedObject(request);
      if (body === null) return notFound();

      const definition = resolveE2EScenario(body.scenario);
      if (definition === null) return notFound();

      let run: E2EScenarioRun;
      try {
        run = await openE2EScenarioRun({
          deleteRows,
          seed: (opened) => seedRows({ definition, request, run: opened }),
        });
      } catch {
        return fixedFailure(e2eScenarioFailures.seed);
      }

      runs.set(run.namespace, run);
      // From here the browser's cookie means something: the adapters read this
      // register, and until now there was nothing in it to read.
      registerE2EScenarioRun(run.namespace, definition.fault, env);

      return Response.json(
        {
          fault: definition.fault,
          namespace: run.namespace,
          /**
           * Exactly the ledger, in the order the seed wrote it. A browser case
           * that has to open the surface of a row — a request, a project, a
           * tenant it must switch into — needs that row's identifier, and
           * deriving one from the namespace would make the identifier a
           * convention two modules had to keep agreeing on. Nothing here is
           * caller text: the table comes from the closed cleanup order and the
           * identifier is one this process generated.
           */
          rows: run.created,
          scenario: definition.id,
          /**
           * Which register holds this run, so the release can be told apart
           * from the one thing that looks exactly like it. Not a secret and not
           * an address: an opaque equality token this process minted, handed
           * back on the release and compared with nothing else.
           */
          server,
        },
        { headers: noStoreHeaders },
      );
    },

    async DELETE(request: Request) {
      if (!isE2EScenarioRequestAllowed({ env, request })) return notFound();

      const body = await parsedObject(request);
      const namespace = body?.namespace;
      if (typeof namespace !== "string") return notFound();

      const run = runs.get(namespace);
      if (run === undefined) {
        // A namespace this register has never held. When the caller names the
        // register it was given and that register is not this one, the process
        // that opened the run is gone and the run went with it; anything else
        // — a caller naming this very register, or naming none at all — is a
        // release for a run that was never opened here, which is the defect the
        // `404` is for.
        return typeof body?.server === "string" && body.server !== server
          ? gone()
          : notFound();
      }

      try {
        await closeE2EScenarioRun(run, deleteRows);
      } catch (failure) {
        // The sentence the cleanup composed, when it composed one. It names the
        // table it could not empty and nothing else, and it had to survive
        // three catches to get here — the deleter's, the cleanup wrapper's and
        // this one — each of which replaced it with the bare sentence. A lane
        // whose every release failed said only that they had.
        return fixedFailure(
          failure instanceof Error &&
            failure.message.startsWith(e2eScenarioFailures.cleanup)
            ? failure.message
            : e2eScenarioFailures.cleanup,
        );
      } finally {
        runs.delete(namespace);
        releaseE2EScenarioRun(namespace, env);
      }

      return new Response(null, { headers: noStoreHeaders, status: 204 });
    },

    /** The namespaces of every run this hook has opened and not released. */
    activeNamespaces(): readonly string[] {
      return [...runs.keys()].sort();
    },
  };
}
