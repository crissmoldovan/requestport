import { auth } from "@requestport/auth/server";
import { createAppearanceRepository } from "@requestport/db";
import { headers } from "next/headers";
import { cache } from "react";
import {
  type AppearanceResolution,
  createAppearanceDiagnostics,
  loadAppearanceSnapshot,
} from "./appearance.js";
import {
  e2eScenarioAppearanceEffect,
  e2eScenarioFaultFor,
} from "./e2e-scenario-fault.js";
import { webLogger } from "./observability.js";
import { getCurrentOrganizationForUser } from "./server-application-context.js";
import { webStorage } from "./server-request-port.js";

/**
 * Process-scoped so the pre-`0014` rollout event stays bounded across requests
 * rather than restarting its budget on every document.
 */
const diagnostics = createAppearanceDiagnostics({ logger: webLogger });

function sessionUserId(session: unknown): string | null {
  const id = (session as { user?: { id?: unknown } } | null)?.user?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The one fault this boundary owns.
 *
 * `global-error` is the only App Router boundary that replaces the root layout,
 * so it is reachable from exactly one place: a failure inside that layout. This
 * boundary *is* that place — and the throw is deliberately raised after the
 * snapshot has resolved, because everything below falls open to the fixed
 * RequestPort triple and a failure routed through that would be swallowed
 * rather than escalated.
 */
async function raiseScenarioGlobalError() {
  const fault = e2eScenarioFaultFor({
    cookieHeader: (await headers()).get("cookie"),
  });
  if (e2eScenarioAppearanceEffect(fault) === "global-error") {
    throw new Error("E2E scenario document failure");
  }
}

/**
 * The one server-owned appearance boundary for anonymous and authenticated
 * documents. The session read is deliberately *optional*: this boundary never
 * redirects, never signs anyone out, and never reports an identity it did not
 * read — the route's own authentication boundary remains authoritative. Every
 * failure below it falls open to the fixed RequestPort triple.
 */
export const getAppearance = cache(
  async (): Promise<AppearanceResolution> =>
    loadAppearanceSnapshot({
      diagnostics,
      readOptionalUserId: async () =>
        sessionUserId(await auth.api.getSession({ headers: await headers() })),
      readCurrentOrganizationId: async (userId) =>
        (await getCurrentOrganizationForUser(userId))?.id ?? null,
      // Its repository is built over the web root's storage when the
      // snapshot is read (Plan 13, G.3).
      readSnapshot: (input) => {
        const storage = webStorage();

        return createAppearanceRepository(storage.db).readAppearanceSnapshot(
          input,
        );
      },
    }).then(async (resolution) => {
      await raiseScenarioGlobalError();

      return resolution;
    }),
);
