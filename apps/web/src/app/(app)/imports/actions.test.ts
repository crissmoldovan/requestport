import {
  type AuthorizedCommandContext,
  createCoreCommandRegistry,
  DomainError,
  importReviewCommandInputSchemas,
  splitImportEntryInputSchema,
} from "@requestport/domain";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";

const imports = vi.hoisted(() => ({
  detail: vi.fn(),
  dispatchImportTask: vi.fn(),
  queueApply: vi.fn(),
  requireManagerAccess: vi.fn(),
}));

const review = vi.hoisted(() => ({
  execute: vi.fn(),
  splitImportEntry: vi.fn(),
  humanCommandContext: undefined as unknown as Mock,
  session: {
    user: { id: "00000000-0000-4000-8000-0000000000aa" },
    session: { id: "session-under-test" },
  },
  organization: {
    id: "00000000-0000-4000-8000-0000000000d1",
    name: "CUE++",
    role: "owner",
    slug: "example-org",
  },
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_SECRET: "test-signing-material",
    REQUESTPORT_WORKSPACE_KEK_VERSION: "v1",
  },
}));

// The real package, with no database behind it: the forms that still write
// through the import repository reach the fake below, and the bus is
// replaced, so nothing here opens a transaction.
vi.mock("@requestport/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCommandTransactionManager: () => ({ run: vi.fn() }),
  createImportRepository: () => ({
    detail: imports.detail,
    queueApply: imports.queueApply,
    requireManagerAccess: imports.requireManagerAccess,
  }),
}));

/*
 * The forms open their transaction on the web root's storage (Plan 13, G.2),
 * so the root hands back a storage whose `transaction` runs the work on a
 * fake transaction. The command bus is replaced below, and
 * `server-core-commands.ts` holds no transaction manager of its own: the bus
 * is the web's RequestPort's (Plan 13, G.6).
 */
vi.mock("../../../lib/server-request-port.js", () => {
  const db = {
    transaction: async (run: (transaction: unknown) => Promise<unknown>) =>
      run({}),
  };
  return {
    webStorage: () => ({ db, transaction: db.transaction }),
    webDatabase: db,
  };
});

vi.mock("@requestport/importer", () => ({
  LEGACY_PARSER_VERSION: "legacy-fr@1",
  parseLegacyArtifact: () => [],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("../../../lib/observability.js", () => ({
  webMetrics: { count: vi.fn(), gauge: vi.fn(), observe: vi.fn() },
}));

vi.mock("../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: async () => {},
  rateLimitFingerprint: () => "fingerprint",
}));

vi.mock("../../../lib/server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: review.organization,
    session: review.session,
  }),
}));

// The real `humanCommandContext`, watched: what the forms hand the bus and
// the split handler is the context a signed-in person really carries. Only
// the bus is replaced.
vi.mock("../../../lib/server-core-commands.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../lib/server-core-commands.js")
    >();
  review.humanCommandContext = vi.fn(original.humanCommandContext);
  return {
    ...original,
    coreCommandBus: { execute: review.execute },
    humanCommandContext: review.humanCommandContext,
  };
});

// The real text readers; only the split handler is replaced.
vi.mock("../../../lib/server-import-actions.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  splitImportEntry: review.splitImportEntry,
}));

vi.mock("../../../lib/trigger-client.js", () => ({
  dispatchImportTask: imports.dispatchImportTask,
}));

import {
  applyImportAction,
  freezeImportAction,
  reviewImportEntryAction,
  splitImportEntryAction,
} from "./actions.js";
import { initialImportActionState } from "./import-action-state.js";

/**
 * Where a rejected import submission is allowed to land.
 *
 * The review form and the apply form each draw a field for what they ask for,
 * so §7 puts a rejection about one of them on that control's own error line —
 * including the mismatched manifest prefix, which is the one gate standing
 * between a reviewer and an irreversible write. The approval control draws no
 * field and keeps the fixed banner.
 */

const key = "0123456789abcdef0123";
const runId = "00000000-0000-4000-8000-000000000101";
const entryId = "00000000-0000-4000-8000-000000000102";
const canonicalId = "00000000-0000-4000-8000-000000000401";
const targetRequestId = "00000000-0000-4000-8000-000000000402";
const manifestSha256 =
  "9f2c0b7a4d1e5c6b8a0f3d2e7c1b4a6d8e0f2c4b6a8d0e2f4c6b8a0d2e4f6c8b";

function reviewForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("runId", runId);
  data.set("entryId", entryId);
  data.set("decision", "map_existing");
  data.set("proposedCanonicalId", canonicalId);
  data.set("targetProjectId", "");
  data.set("relationships", "");
  data.set("idempotencyKey", key);
  data.set("expectedVersion", "3");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

function splitForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("runId", runId);
  data.set("entryId", entryId);
  data.set("splitLines", "5, 2 5");
  data.set("idempotencyKey", key);
  data.set("expectedVersion", "3");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

function applyForm(overrides: Record<string, string> = {}) {
  const data = new FormData();
  data.set("runId", runId);
  data.set("manifestConfirmation", manifestSha256.slice(0, 12));
  data.set("idempotencyKey", key);
  data.set("expectedVersion", "4");
  for (const [name, value] of Object.entries(overrides)) data.set(name, value);

  return data;
}

/** The context `humanCommandContext` returned on its only call. */
function contextHandedOver(): AuthorizedCommandContext {
  expect(review.humanCommandContext).toHaveBeenCalledExactlyOnceWith(
    review.session,
    review.organization.id,
  );
  return review.humanCommandContext.mock.results[0]
    ?.value as AuthorizedCommandContext;
}

beforeEach(() => {
  for (const mock of Object.values(imports)) mock.mockReset();
  imports.requireManagerAccess.mockResolvedValue(undefined);
  imports.dispatchImportTask.mockResolvedValue({ accepted: true });
  imports.queueApply.mockResolvedValue({
    dispatchId: "00000000-0000-4000-8000-000000000501",
  });
  imports.detail.mockResolvedValue({
    run: { id: runId, manifestSha256, state: "approved", version: 4 },
  });
  review.execute.mockReset();
  review.execute.mockResolvedValue({ id: entryId, version: 4 });
  review.splitImportEntry.mockReset();
  review.splitImportEntry.mockResolvedValue({
    entryIds: [entryId, "00000000-0000-4000-8000-000000000103", "x"],
  });
  review.humanCommandContext?.mockClear();
});

/*
  Each form, given a valid submission, reaches its one handler exactly once,
  with the context `humanCommandContext` built for the signed-in person, the
  version and key the form carried, and the input its handler parses: the
  review form the bus command `review_legacy_import_entry`, the split form
  the handler `splitImportEntry`.
*/
describe("each review form reaches its handler", () => {
  test("the review form sends review_legacy_import_entry once, as the signed-in person, with the form's version and key", async () => {
    expect(
      await reviewImportEntryAction(
        initialImportActionState,
        reviewForm({
          relationships: `blocks:${targetRequestId}\nblocks:${targetRequestId}`,
        }),
      ),
    ).toEqual({ status: "success", message: "Import decision saved." });

    const context = contextHandedOver();
    expect(review.execute).toHaveBeenCalledOnce();
    expect(review.execute.mock.calls[0]?.[0]).toStrictEqual({
      name: "review_legacy_import_entry",
      context,
      input: {
        organizationId: review.organization.id,
        runId,
        entryId,
        decision: "map_existing",
        proposedCanonicalId: canonicalId,
        targetProjectId: null,
        relationships: [{ type: "blocks", targetRequestId }],
      },
      meta: { expectedVersion: 3, idempotencyKey: key },
    });
    expect(context.actor).toEqual({
      type: "user",
      id: review.session.user.id,
    });
    expect(context.credentialId).toBe(review.session.session.id);
    expect(context.scopes.has("import:write")).toBe(true);
    expect(review.splitImportEntry).not.toHaveBeenCalled();
  });

  test("what the review form sends is what the registered command parses, field for field", async () => {
    await reviewImportEntryAction(
      initialImportActionState,
      reviewForm({
        decision: "create",
        proposedCanonicalId: "",
        targetProjectId: "00000000-0000-4000-8000-000000000301",
      }),
    );
    const sent = review.execute.mock.calls[0]?.[0] as {
      name: string;
      input: Record<string, unknown>;
    };
    const definition = createCoreCommandRegistry().resolve(sent.name);

    expect(definition?.parse(sent.input)).toStrictEqual(sent.input);
    expect(Object.keys(sent.input).sort()).toEqual(
      Object.keys(
        importReviewCommandInputSchemas.review_legacy_import_entry.shape,
      ).sort(),
    );
  });

  test("the split form calls splitImportEntry once, as the signed-in person, with its lines once each and in order", async () => {
    expect(
      await splitImportEntryAction(initialImportActionState, splitForm()),
    ).toEqual({
      status: "success",
      message: "Bundle split into 3 records for individual review.",
    });

    const context = contextHandedOver();
    expect(review.splitImportEntry).toHaveBeenCalledOnce();
    expect(review.splitImportEntry.mock.calls[0]).toStrictEqual([
      context,
      {
        organizationId: review.organization.id,
        runId,
        entryId,
        splitLines: [2, 5],
      },
      { expectedVersion: 3, idempotencyKey: key },
    ]);
    expect(
      splitImportEntryInputSchema.parse(
        review.splitImportEntry.mock.calls[0]?.[1],
      ),
    ).toStrictEqual(review.splitImportEntry.mock.calls[0]?.[1]);
    expect(context.scopes.has("import:write")).toBe(true);
    expect(review.execute).not.toHaveBeenCalled();
  });

  test.each([
    [
      "review",
      () =>
        reviewImportEntryAction(
          initialImportActionState,
          reviewForm({ idempotencyKey: "short" }),
        ),
    ],
    [
      "split",
      () =>
        splitImportEntryAction(
          initialImportActionState,
          splitForm({ idempotencyKey: "short" }),
        ),
    ],
  ])(
    "the %s form refuses a short key without reaching its handler",
    async (_, submit) => {
      expect(await submit()).toMatchObject({
        field: "idempotencyKey",
        status: "error",
      });
      expect(review.execute).not.toHaveBeenCalled();
      expect(review.splitImportEntry).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "review",
      () => reviewImportEntryAction(initialImportActionState, reviewForm()),
      review.execute,
    ],
    [
      "split",
      () => splitImportEntryAction(initialImportActionState, splitForm()),
      review.splitImportEntry,
    ],
  ] as const)(
    "the %s form answers its handler's refusal as the forms always have",
    async (_, submit, handler) => {
      handler.mockRejectedValueOnce(
        new DomainError("forbidden", "Import management access is denied"),
      );
      expect(await submit()).toEqual({
        status: "error",
        message: "Only organization owners and admins can manage imports.",
      });
      handler.mockRejectedValueOnce(
        new DomainError(
          "version_conflict",
          "Import entry changed concurrently",
        ),
      );
      expect(await submit()).toEqual({
        status: "error",
        message: "The import changed. Refresh before trying again.",
      });
    },
  );
});

describe("a rejected import review", () => {
  test("names the control a rejected canonical identifier belongs to", async () => {
    expect(
      await reviewImportEntryAction(
        initialImportActionState,
        reviewForm({ proposedCanonicalId: "not-a-uuid" }),
      ),
    ).toMatchObject({ field: "proposedCanonicalId", status: "error" });
  });

  test("names the decision control when the decision is not one of the five", async () => {
    expect(
      await reviewImportEntryAction(
        initialImportActionState,
        reviewForm({ decision: "maybe" }),
      ),
    ).toMatchObject({ field: "decision", status: "error" });
  });

  test("keeps the fixed message for a relationship line it cannot read, without reaching the bus", async () => {
    expect(
      await reviewImportEntryAction(
        initialImportActionState,
        reviewForm({ relationships: "follows:nothing" }),
      ),
    ).toEqual({ status: "error", message: "Import action failed." });
    expect(review.execute).not.toHaveBeenCalled();
  });
});

describe("a rejected split", () => {
  test("keeps the fixed message for a line it cannot read, and refuses twenty lines, without reaching the handler", async () => {
    expect(
      await splitImportEntryAction(
        initialImportActionState,
        splitForm({ splitLines: "1" }),
      ),
    ).toEqual({ status: "error", message: "Import action failed." });
    expect(
      await splitImportEntryAction(
        initialImportActionState,
        splitForm({
          splitLines: Array.from({ length: 20 }, (_, index) => index + 2).join(
            ",",
          ),
        }),
      ),
    ).toEqual({
      status: "error",
      message: "The import data or confirmation hash is invalid.",
    });
    expect(review.splitImportEntry).not.toHaveBeenCalled();
  });
});

describe("a rejected application", () => {
  test("names the confirmation control when the typed prefix is malformed", async () => {
    expect(
      await applyImportAction(
        initialImportActionState,
        applyForm({ manifestConfirmation: "not-a-hash" }),
      ),
    ).toMatchObject({ field: "manifestConfirmation", status: "error" });
  });

  test("names the confirmation control when the typed prefix is simply wrong", async () => {
    expect(
      await applyImportAction(
        initialImportActionState,
        applyForm({ manifestConfirmation: "000000000000" }),
      ),
    ).toEqual({
      field: "manifestConfirmation",
      message: "The import data or confirmation hash is invalid.",
      status: "error",
    });
  });

  test("queues the application when the prefix matches the frozen manifest", async () => {
    expect(
      await applyImportAction(initialImportActionState, applyForm()),
    ).toMatchObject({ status: "success" });
    // Dispatched bound to the organisation the run was queued in (D5).
    expect(imports.dispatchImportTask.mock.calls).toEqual([
      [
        "00000000-0000-4000-8000-000000000501",
        "00000000-0000-4000-8000-0000000000d1",
      ],
    ]);
  });
});

describe("a rejected approval", () => {
  test("keeps the fixed message for the hidden-metadata approval control", async () => {
    const data = new FormData();
    data.set("runId", "not-a-uuid");
    data.set("idempotencyKey", key);
    data.set("expectedVersion", "3");

    expect(await freezeImportAction(initialImportActionState, data)).toEqual({
      message: "Import action failed.",
      status: "error",
    });
  });
});
