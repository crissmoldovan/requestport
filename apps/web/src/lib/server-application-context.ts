import { requireHumanSession } from "@requestport/auth/server";
import { createFoundationQueryRepository } from "@requestport/db";
import { DomainError } from "@requestport/domain";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import {
  type LoadedApplicationContext,
  loadApplicationContext,
} from "./application-context.js";
import { resolveCurrentOrganization } from "./current-organization.js";
import {
  type E2EScenarioFault,
  e2eScenarioReadEffect,
} from "./e2e-scenario-fault.js";
import { CURRENT_ORGANIZATION_COOKIE } from "./organization-cookie.js";
import { webStorage } from "./server-request-port.js";
import {
  applyE2EScenarioPageEffect,
  readE2EScenarioRequest,
} from "./server-scenario-boundary.js";

async function preferredOrganizationId() {
  return (await cookies()).get(CURRENT_ORGANIZATION_COOKIE)?.value;
}

/**
 * The one authenticated read every surface goes through, loaded once per
 * request.
 *
 * It is separated from the two entry points below so a guarded local run can
 * suspend a *page* without suspending the shell that wraps it, and still leave
 * one database round trip per document. Its query repository is built over
 * the web root's storage when the load runs (Plan 13, G.3).
 */
const loadContext = cache(async () => {
  const storage = webStorage();

  return loadApplicationContext({
    preferredOrganizationId: await preferredOrganizationId(),
    query: createFoundationQueryRepository(storage.db),
    redirect,
    requireSession: async () => requireHumanSession(await headers()),
  });
});

/**
 * Whether this request has already been given its one conflict.
 *
 * A Server Action dispatch is one request that does two things: it runs the
 * action, and then it re-renders the page — with the same headers, so the same
 * register answers the same way. A conflict raised on both is not a conflicting
 * write, it is an error boundary, and the receipt the case exists to see never
 * renders. So the conflict is raised exactly once per request, and the marker
 * is a per-request cache rather than module state precisely because two
 * concurrent requests must not share it.
 */
const scenarioConflictMarker = cache(() => ({ raised: false }));

/**
 * Raise the injected conflict, once, if this request is inside one.
 *
 * Exported for the administration action wiring, whose commands resolve their
 * own session rather than reading the context below.
 */
export function raiseScenarioConflict(fault: E2EScenarioFault | null): void {
  if (e2eScenarioReadEffect({ fault, isActionDispatch: true }) !== "conflict") {
    return;
  }
  const marker = scenarioConflictMarker();
  if (marker.raised) return;
  marker.raised = true;

  throw new DomainError("conflict", "E2E scenario conflicting write");
}

/**
 * Put the loaded context into the synthetic state the open run declares.
 *
 * The two segments ask for different things and that is the point. A page
 * suspends, throws, or answers not-found — its own boundaries are what the case
 * is about. The shell above it only ever adopts a reduced role, because a
 * layout that threw would replace the very chrome a member-denied surface has
 * to keep showing.
 */
async function inScenarioState(
  context: LoadedApplicationContext,
  segment: "layout" | "page",
): Promise<LoadedApplicationContext> {
  const { cookieHeader, fault, isActionDispatch } =
    await readE2EScenarioRequest();
  const effect = e2eScenarioReadEffect({ fault, isActionDispatch });
  if (effect === "none") return context;

  if (effect === "member-denied") {
    const organization = context.currentOrganization;

    return organization === null || organization.role === "member"
      ? context
      : {
          ...context,
          currentOrganization: { ...organization, role: "member" },
        };
  }

  if (segment === "layout") return context;

  if (effect === "conflict") {
    raiseScenarioConflict(fault);

    return context;
  }
  await applyE2EScenarioPageEffect(effect, cookieHeader);

  return context;
}

/**
 * The authenticated context a rendered page or a dispatched action reads.
 *
 * Under a guarded local run this is where a page suspends, fails, or answers
 * not-found, so the boundary the segment declares is the one that renders.
 */
export async function getApplicationContext() {
  // Deliberately not memoised: the load beneath it is, so a document still
  // makes one database read, but the synthetic state has to be re-evaluated on
  // every call. A memoised wrapper would also memoise a *rejection*, and the
  // render that follows a Server Action would then be handed the action's own
  // conflict instead of the receipt the surface draws from it.
  return inScenarioState(await loadContext(), "page");
}

/**
 * The same context, read by the authenticated shell.
 *
 * The shell is above every page-level boundary, so it deliberately does not
 * suspend or fail with the page: a loading, error, or not-found case has to see
 * the chrome stay while the work area changes, which is exactly what those
 * boundaries promise.
 */
export const getApplicationLayoutContext = cache(async () =>
  inScenarioState(await loadContext(), "layout"),
);

export async function getCurrentOrganizationForUser(userId: string) {
  const storage = webStorage();
  const context = await resolveCurrentOrganization({
    preferredOrganizationId: await preferredOrganizationId(),
    query: createFoundationQueryRepository(storage.db),
    userId,
  });
  return context.currentOrganization;
}
