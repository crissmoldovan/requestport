import { type E2EEnvironment, isE2EEmailMode } from "@requestport/auth/e2e";

/**
 * The synthetic conditions a guarded local run may put a surface into, and the
 * process-local register that decides whether a request is inside one.
 *
 * The shape matters more than the mechanism. A browser carries nothing but a
 * generated UUID in a cookie, and that value is inert: it means something only
 * while *this process* holds a run opened under it by the guarded hook, and the
 * hook cannot open one at all outside a non-production `NODE_ENV`,
 * `REQUESTPORT_E2E_MODE=1`, a loopback binding and the constant-time token. So
 * the cookie is not a fault-injection primitive that guards happen to stand in
 * front of — on a deployed build it is a string nothing consults, whatever it
 * says.
 *
 * The register lives on `globalThis` for the same reason the magic-link outbox
 * does: a Next server bundles a route handler and a rendered page separately,
 * and a module-scoped map would give the hook and the adapters two different
 * registers in one process.
 */

/**
 * The fault a case injects, or `none`.
 *
 * Declared here rather than in the catalogue because the adapters have to name
 * these values without reaching into the closed catalogue module; the catalogue
 * re-exports the list so there is still exactly one vocabulary.
 */
export const e2eScenarioFaults = [
  "conflict",
  "error",
  "global_error",
  "loading",
  "member_denied",
  "none",
  "not_found",
  "provider_unavailable",
] as const;

export type E2EScenarioFault = (typeof e2eScenarioFaults)[number];

const faults = new Set<string>(e2eScenarioFaults);

/**
 * The cookie a guarded browser run carries.
 *
 * It holds the namespace the hook generated and nothing else — no scenario
 * name, no state, no message. Everything a namespace means is held in this
 * process, where the guard has already run.
 */
export const E2E_SCENARIO_COOKIE = "requestport.e2e_scenario";

const runsKey = Symbol.for("requestport.e2e.scenario-runs");

type ScenarioRunGlobal = typeof globalThis & {
  [runsKey]?: Map<string, E2EScenarioFault>;
};

function runs(): Map<string, E2EScenarioFault> {
  const shared = globalThis as ScenarioRunGlobal;
  shared[runsKey] ??= new Map<string, E2EScenarioFault>();

  return shared[runsKey];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Record that a run is open, and under which fault.
 *
 * Silent rather than throwing on refusal: the caller is the guarded hook, which
 * has already decided the request may be answered, and a register that threw
 * would turn a deployment-shaped environment into a different HTTP answer —
 * which is itself a disclosure. Nothing downstream can tell a refused
 * registration from a namespace that was never opened, because they are the
 * same thing.
 */
export function registerE2EScenarioRun(
  namespace: string,
  fault: E2EScenarioFault,
  env: E2EEnvironment = process.env,
): void {
  if (!isE2EEmailMode(env)) return;
  if (!uuidPattern.test(namespace)) return;
  if (!faults.has(fault)) return;

  runs().set(namespace, fault);
}

export function releaseE2EScenarioRun(
  namespace: string,
  env: E2EEnvironment = process.env,
): void {
  if (!isE2EEmailMode(env)) return;

  runs().delete(namespace);
}

/** Drop every open run. Exists so a suite can start from a known register. */
export function forgetE2EScenarioRuns(env: E2EEnvironment = process.env): void {
  if (!isE2EEmailMode(env)) return;

  runs().clear();
}

export function isE2EScenarioRunActive(
  namespace: string,
  env: E2EEnvironment = process.env,
): boolean {
  return isE2EEmailMode(env) && runs().has(namespace);
}

/** The namespace one cookie header names, or `null` when it names none. */
export function e2eScenarioNamespaceFrom(
  cookieHeader: string | null,
): string | null {
  if (cookieHeader === null) return null;

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== E2E_SCENARIO_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();

    return value === "" ? null : value;
  }

  return null;
}

/**
 * The fault the request is inside, or `null`.
 *
 * `null` is the answer to every question that is not "this process opened this
 * exact run": no cookie, an unopened namespace, a released one, and every
 * environment that is not the guarded local one — including a deployment that
 * somehow inherited a register.
 */
export function e2eScenarioFaultFor({
  cookieHeader,
  env = process.env,
}: Readonly<{
  cookieHeader: string | null;
  env?: E2EEnvironment;
}>): E2EScenarioFault | null {
  if (!isE2EEmailMode(env)) return null;
  const namespace = e2eScenarioNamespaceFrom(cookieHeader);
  if (namespace === null) return null;

  return runs().get(namespace) ?? null;
}

export type E2EScenarioReleaseOutcome = "capped" | "released";

/**
 * Hold until the run is released, or until the cap runs out.
 *
 * This is what makes a loading boundary deterministic instead of a race: a
 * fixed delay is a bet on how fast the machine is, while a hold that the test
 * itself ends is the same observation on a loaded host as on an idle one. The
 * cap is what keeps a forgotten release from pinning a request for ever — the
 * server is a development server, and a held request holds a worker.
 */
export async function waitForE2EScenarioRelease(
  namespace: string,
  options: Readonly<{
    capMs?: number;
    env?: E2EEnvironment;
    pollMs?: number;
  }> = {},
): Promise<E2EScenarioReleaseOutcome> {
  const { capMs = 30_000, env = process.env, pollMs = 50 } = options;
  const deadline = Date.now() + capMs;

  while (isE2EScenarioRunActive(namespace, env)) {
    if (Date.now() >= deadline) return "capped";
    await new Promise((wake) => setTimeout(wake, pollMs));
  }

  return "released";
}

/**
 * What one fault asks of the query adapter every authenticated surface reads
 * through.
 *
 * Each fault is owned by exactly one adapter. `global_error` belongs to the
 * appearance boundary in the root layout, because that is the only place an
 * error reaches the global boundary at all, and `provider_unavailable` belongs
 * to the provider adapter, because an unreachable provider is a fact about a
 * provider rather than about a tenant. Both are `none` here, so no adapter has
 * to know what the others do with a value it ignores.
 */
export type E2EScenarioReadEffect =
  | "conflict"
  | "error"
  | "hold"
  | "member-denied"
  | "none"
  | "not-found";

export function e2eScenarioReadEffect({
  fault,
  isActionDispatch,
}: Readonly<{
  fault: E2EScenarioFault | null;
  isActionDispatch: boolean;
}>): E2EScenarioReadEffect {
  switch (fault) {
    case "conflict":
      // A conflict is a write outcome. Raising one while a document was being
      // read would put the surface on its error boundary and prove nothing
      // about the receipt a conflicting write draws.
      return isActionDispatch ? "conflict" : "none";
    case "error":
      return "error";
    case "loading":
      return "hold";
    case "member_denied":
      return "member-denied";
    case "not_found":
      return "not-found";
    default:
      return "none";
  }
}

export type E2EScenarioAppearanceEffect = "global-error" | "none";

export function e2eScenarioAppearanceEffect(
  fault: E2EScenarioFault | null,
): E2EScenarioAppearanceEffect {
  return fault === "global_error" ? "global-error" : "none";
}

export type E2EScenarioProviderEffect = "none" | "unavailable";

export function e2eScenarioProviderEffect(
  fault: E2EScenarioFault | null,
): E2EScenarioProviderEffect {
  return fault === "provider_unavailable" ? "unavailable" : "none";
}
