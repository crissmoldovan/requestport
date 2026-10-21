import { randomUUID } from "node:crypto";

import { auth } from "@requestport/auth/server";
import { createFoundationQueryRepository } from "@requestport/db";
import type { E2EOwnerStorage } from "@requestport/db/e2e";
import { resolveCurrentOrganization } from "../../../../lib/current-organization.js";
import { openE2EOwnerStorage } from "../../../../lib/e2e-owner-storage.js";
import type { E2EScenarioRun } from "../../../../lib/e2e-scenario.js";
import {
  createE2EScenarioRowDeleter,
  createE2EScenarioRowSeeder,
  type E2EScenarioSqlExecutor,
  type E2EScenarioViewer,
} from "../../../../lib/e2e-scenario-seed.js";
import { CURRENT_ORGANIZATION_COOKIE } from "../../../../lib/organization-cookie.js";
import { webStorage } from "../../../../lib/server-request-port.js";
import { createScenarioRouteHandlers } from "../../../../test/e2e-scenarios.js";

/**
 * The owner storage, kept where a module reload cannot orphan its pool, and
 * built on the first statement a guarded request runs — never at import — by
 * `openE2EOwnerStorage`, which refuses it where `VERCEL_ENV` is set and
 * outside E2E mode.
 */
const ownerKey = Symbol.for("requestport.e2e.scenario-hook-owner-storage");
type OwnerStorageGlobal = typeof globalThis & {
  [ownerKey]?: E2EOwnerStorage;
};

function ownerStorage(): E2EOwnerStorage {
  const holder = globalThis as OwnerStorageGlobal;

  holder[ownerKey] ??= openE2EOwnerStorage();
  return holder[ownerKey];
}

/**
 * The one SQL port the guarded hook writes and deletes through.
 *
 * Statements are parameterised by the seeder, so nothing a caller sent can
 * reach the text. Going through a pool directly rather than through a
 * repository is deliberate: a repository would apply the tenant and command
 * rules that make it the *product*, and a seeded state exists precisely to
 * stand somewhere the product's own commands cannot put it.
 *
 * That pool is the owner's, not the application's (D20): the acceptance
 * server's application storage, the one the web root builds, is an
 * application-role login under row security, which refuses rows outside the
 * organisation a transaction is bound to, and a scenario seeds across
 * organisations. Who the viewer is (`readViewer` below) is still read
 * through the web root's storage, as the product reads it. The owner storage
 * is held above, on its own symbol, apart from the roots' storages
 * (`@requestport/db/wiring`): it is this hook's alone.
 */
const execute: E2EScenarioSqlExecutor = async ({ text, values }) => {
  const answered = await ownerStorage().query(text, values);

  return { rows: answered.rows };
};

/** The organization identifier the request's own cookie prefers, if any. */
function preferredOrganizationId(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (header === null) return undefined;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== CURRENT_ORGANIZATION_COOKIE) {
      continue;
    }
    return decodeURIComponent(pair.slice(separator + 1).trim());
  }

  return undefined;
}

/**
 * Who the guarded request is, resolved exactly the way a rendered document
 * resolves it: the session it carries, and the tenant that session is currently
 * inside. A scenario therefore cannot seed into a tenant the browser is not
 * already looking at, and an unauthenticated call resolves to nobody.
 */
async function readViewer(request: Request): Promise<E2EScenarioViewer | null> {
  const session = await auth.api
    .getSession({ headers: request.headers })
    .catch(() => null);
  const userId = (session as { user?: { id?: unknown } } | null)?.user?.id;
  if (typeof userId !== "string" || userId === "") return null;

  const storage = webStorage();
  const { currentOrganization } = await resolveCurrentOrganization({
    preferredOrganizationId: preferredOrganizationId(request),
    query: createFoundationQueryRepository(storage.db),
    userId,
  });
  if (currentOrganization === null) return null;

  return { organizationId: currentOrganization.id, userId };
}

/**
 * The open runs, kept where a module reload cannot take them.
 *
 * The development server this hook is served by may re-evaluate a route module
 * between two requests, and a run held in the replaced module is a run whose
 * rows the release will not find — the hook answers "nothing opened that",
 * truthfully, and the seeded rows survive the run that created them. The
 * register the adapters read is on `globalThis` for the same reason.
 */
const runsKey = Symbol.for("requestport.e2e.scenario-hook-runs");
/**
 * The register's own identity, minted beside it and on the same object.
 *
 * `next dev` restarts itself when its heap crosses the share it watches, and a
 * run held in the process that exits is a run the next process cannot release.
 * This is how the release is told which of the two happened: the value survives
 * a module re-evaluation for exactly the reason the register does — both are
 * assigned only when absent — and neither survives the process.
 */
const serverKey = Symbol.for("requestport.e2e.scenario-hook-server");
type ScenarioRunGlobal = typeof globalThis & {
  [runsKey]?: Map<string, E2EScenarioRun>;
  [serverKey]?: string;
};
const shared = globalThis as ScenarioRunGlobal;
shared[runsKey] ??= new Map<string, E2EScenarioRun>();
shared[serverKey] ??= randomUUID();

const handlers = createScenarioRouteHandlers({
  deleteRows: createE2EScenarioRowDeleter(execute),
  runs: shared[runsKey],
  seedRows: createE2EScenarioRowSeeder({ execute, readViewer }),
  server: shared[serverKey],
});

export const DELETE = handlers.DELETE;
export const POST = handlers.POST;
