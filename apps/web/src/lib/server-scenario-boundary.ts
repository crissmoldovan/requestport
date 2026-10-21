import { headers } from "next/headers";
import { notFound } from "next/navigation";

import {
  type E2EScenarioReadEffect,
  e2eScenarioFaultFor,
  e2eScenarioNamespaceFrom,
  e2eScenarioProviderEffect,
  e2eScenarioReadEffect,
  waitForE2EScenarioRelease,
} from "./e2e-scenario-fault.js";

/**
 * The request-scoped half of the scenario adapters: the one place that reads
 * the incoming headers, and the one place that turns a decided effect into a
 * suspension, a throw, or a not-found.
 *
 * Keeping it separate from `e2e-scenario-fault.ts` keeps that module free of
 * `next/*`, which is what lets the whole decision table be proven without a
 * request. Keeping it separate from the tenant adapter lets a *public* surface
 * — one with no organization to resolve — reach its own segment boundaries
 * through the same register.
 */

/** The fixed text a synthetic route failure carries. Nothing derives from it. */
export const scenarioRouteFailure = "E2E scenario route failure";

/**
 * The incoming headers, or `null` when there is no request to read them from.
 *
 * `headers()` throws synchronously outside a request store rather than
 * rejecting, so the guard is a `try` rather than a `catch` on the promise.
 */
async function readRequestHeaders(): Promise<Headers | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}

export async function readE2EScenarioRequest() {
  // Outside a request there is no run, and saying so is the honest answer
  // rather than an error. Several surfaces are rendered to static markup by
  // their own suites — `renderToStaticMarkup` has no request store — and a
  // reader that threw there would make consulting the register a change to the
  // surface under test rather than an addition to it.
  const requestHeaders = await readRequestHeaders();
  const cookieHeader = requestHeaders?.get("cookie") ?? null;

  return {
    cookieHeader,
    fault: e2eScenarioFaultFor({ cookieHeader }),
    // Next sends `Next-Action` on a Server Action dispatch and on nothing else,
    // so this is the request's own answer to "is a write being made" rather
    // than a second guess at it.
    isActionDispatch: (requestHeaders?.get("next-action") ?? null) !== null,
  };
}

/**
 * Suspend, fail, or answer not-found, as the open run declares.
 *
 * The hold waits for the case to release its run rather than for a fixed
 * number of milliseconds: a timed sleep is a bet on how fast the machine is,
 * and the same bet loses on a loaded host and wins on an idle one.
 */
export async function applyE2EScenarioPageEffect(
  effect: E2EScenarioReadEffect,
  cookieHeader: string | null,
): Promise<void> {
  if (effect === "hold") {
    const namespace = e2eScenarioNamespaceFrom(cookieHeader);
    if (namespace !== null) await waitForE2EScenarioRelease(namespace);

    return;
  }
  if (effect === "not-found") notFound();
  if (effect === "error") throw new Error(scenarioRouteFailure);
}

/**
 * The page-level boundary a public surface reaches through.
 *
 * A surface with no tenant to resolve still has a segment loading, error, and
 * not-found boundary of its own, and those boundaries are exactly what the
 * route/state inventory declares for it.
 */
export async function applyE2EScenarioBoundary(): Promise<void> {
  const { cookieHeader, fault } = await readE2EScenarioRequest();

  await applyE2EScenarioPageEffect(
    e2eScenarioReadEffect({ fault, isActionDispatch: false }),
    cookieHeader,
  );
}

/**
 * Whether the open run declares this request's outbound provider unreachable.
 *
 * Providers are configured by deployment settings, so a local run cannot make
 * one genuinely unavailable by changing data; this is the one axis where the
 * synthetic condition has to be asked for by name.
 */
export async function isE2EScenarioProviderUnavailable(): Promise<boolean> {
  const { fault } = await readE2EScenarioRequest();

  return e2eScenarioProviderEffect(fault) === "unavailable";
}
