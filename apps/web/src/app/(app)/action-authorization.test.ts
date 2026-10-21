import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Every guard a console mutation is only allowed to run behind.
 *
 * They are spies rather than stubs because *whether they ran* is itself the
 * contract. An owner/admin-only endpoint that answers a malformed submission
 * without ever looking up a session is an unauthenticated oracle: the caller
 * learns which of the values the form asks for the server rejects, one probe at
 * a time, and pays neither a session lookup nor a limiter increment for the
 * answer. Reading the submission after those two have passed costs an
 * authorized reader nothing and leaves an anonymous one with a single
 * indistinguishable answer they cannot repeat without bound.
 */
const guards = vi.hoisted(() => ({
  applicationContext: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

/**
 * Everything past the guards that a malformed submission must never reach.
 *
 * The ordering contract has two halves: the guards have to run, and the write
 * has to not. A module that satisfied the first by authenticating and then
 * wrote anyway would pass a call-count assertion on its own.
 */
const writes = vi.hoisted(() => ({
  commandBus: vi.fn(),
  importRepository: vi.fn(),
  markRequestRead: vi.fn(),
  outboxReplay: vi.fn(),
  splitImportEntry: vi.fn(),
  webhookCreate: vi.fn(),
  webhookRotate: vi.fn(),
  webhookSetStatus: vi.fn(),
  webhookVerify: vi.fn(),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: { BETTER_AUTH_SECRET: "test-signing-material" },
}));

/**
 * The web root's storage (Plan 13, G.2 and G.3): a handle whose
 * `transaction` runs its work on an empty stand-in, and that `transaction`
 * as the storage's own. The modules here open transactions on that storage,
 * or build repositories over its `db`.
 */
const rootStorage = vi.hoisted(() => {
  const db = {
    transaction: async (run: (tx: unknown) => unknown) => run({}),
  };
  return { db, transaction: db.transaction };
});

vi.mock("@requestport/db", () => ({
  createImportRepository: () => ({
    createCorrectionRun: writes.importRepository,
    createRun: writes.importRepository,
    detail: writes.importRepository,
    freeze: writes.importRepository,
    queueApply: writes.importRepository,
    requireManagerAccess: writes.importRepository,
  }),
  createOutboxRepository: () => ({ createWebhookReplay: writes.outboxReplay }),
  createRequestQueryRepository: () => ({
    markRequestRead: writes.markRequestRead,
  }),
  createWebhookRepository: () => ({ canManage: async () => true }),
}));

vi.mock("../../lib/server-request-port.js", () => ({
  webStorage: () => rootStorage,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The real module, with only `redirect` replaced: `unstable_rethrow` is the
// thing every action's catch now calls first, and a stub of it would prove
// nothing about whether the framework's control flow survives one.
vi.mock(import("next/navigation"), async (importOriginal) => ({
  ...(await importOriginal()),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: guards.enforceRateLimit,
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../lib/server-application-context.js", () => ({
  getApplicationContext: guards.applicationContext,
}));

vi.mock("../../lib/server-core-commands.js", () => ({
  coreCommandBus: { execute: writes.commandBus },
  humanCommandContext: () => ({ correlationId: "correlation", scopes: [] }),
}));

// The split form's one handler (review goes through `coreCommandBus` above).
// The form's own text readers stay real: they only parse the submission.
vi.mock(
  import("../../lib/server-import-actions.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    splitImportEntry: writes.splitImportEntry,
  }),
);

vi.mock("../../lib/server-webhooks.js", () => ({
  webhookManagementService: {
    create: writes.webhookCreate,
    rotate: writes.webhookRotate,
    setStatus: writes.webhookSetStatus,
    verify: writes.webhookVerify,
  },
}));

vi.mock("../../lib/trigger-client.js", () => ({
  dispatchImportTask: async () => ({ accepted: true }),
  triggerSlackConnectionTest: async () => {},
  triggerWebhookDelivery: async () => {},
}));

import * as importsActions from "./imports/actions.js";
import * as requestsActions from "./requests/actions.js";
import * as routingActions from "./settings/routing/actions.js";
import * as slackActions from "./slack/actions.js";
import * as webhooksActions from "./webhooks/actions.js";

/**
 * The five Server Action modules whose mutations are rate limited or reserved
 * to an organization owner or admin.
 *
 * The actions themselves are read off each module rather than listed, so an
 * action added to one of them is covered the day it is exported rather than the
 * day somebody remembers to name it here.
 */
const modules = {
  imports: importsActions,
  requests: requestsActions,
  routing: routingActions,
  slack: slackActions,
  webhooks: webhooksActions,
} as const;

type Action = (...args: never[]) => unknown;

function exportedActions(module: Record<string, unknown>): [string, Action][] {
  return Object.entries(module)
    .filter(
      (entry): entry is [string, Action] => typeof entry[1] === "function",
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * The submission no schema in any of these modules can accept.
 *
 * Every one of them asks for at least a UUID or a sixteen-character
 * idempotency key, so an empty body is malformed for all of them at once — and
 * malformed in the plainest possible way, with nothing in it that could reach
 * a write even if the guards were skipped.
 */
async function submitNothing(action: Action) {
  const empty = new FormData();

  await (action.length === 1
    ? (action as unknown as (input: unknown) => unknown)(empty)
    : (action as unknown as (previous: unknown, form: FormData) => unknown)(
        undefined,
        empty,
      ));
}

beforeEach(() => {
  for (const guard of Object.values(guards)) guard.mockReset();
  for (const write of Object.values(writes)) write.mockReset();
  guards.enforceRateLimit.mockResolvedValue(undefined);
  guards.applicationContext.mockResolvedValue({
    currentOrganization: {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "CUE++",
      role: "owner",
      slug: "example-org",
    },
    session: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
  });
});

describe("a console submission that cannot parse", () => {
  for (const [moduleName, module] of Object.entries(modules)) {
    for (const [actionName, action] of exportedActions(module)) {
      test(`${moduleName}.${actionName} still costs a session lookup and a limiter increment`, async () => {
        await submitNothing(action);

        expect({
          action: `${moduleName}.${actionName}`,
          sessionLookups: guards.applicationContext.mock.calls.length,
          limiterIncrements: guards.enforceRateLimit.mock.calls.length,
        }).toEqual({
          action: `${moduleName}.${actionName}`,
          sessionLookups: 1,
          limiterIncrements: 1,
        });
      });

      test(`${moduleName}.${actionName} reaches nothing past the guards`, async () => {
        await submitNothing(action);

        expect(
          Object.entries(writes)
            .filter(([, write]) => write.mock.calls.length > 0)
            .map(([name]) => name),
        ).toEqual([]);
      });
    }
  }
});
