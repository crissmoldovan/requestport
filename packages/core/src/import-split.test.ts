import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The import split through core, over a storage, as `createRequestPort`
 * composes it (`importSplitTransaction`; manifest-g.md §2.5's `import-split`
 * row): one transaction on the storage; the bus's own re-check first, on a
 * repository opened on that transaction under the operator switch it was
 * given; then the review target, and the import repository opened on the
 * same transaction; the receipt keyed with the raw `commandFingerprintKey`,
 * read when the split runs. The web runs the same handler, which its
 * RequestPort composes the same way over the web root's storage;
 * `apps/web/src/lib/server-import-actions.test.ts` holds the web's handler
 * export over it, `splitImportEntry`, which the form calls, and
 * `legacySegments`.
 */

const mocks = vi.hoisted(() => {
  const steps: string[] = [];
  const tx = { name: "the-split-transaction" };
  return {
    steps,
    tx,
    builtOn: [] as Array<[string, unknown]>,
    authorizationOptions: [] as unknown[],
    splitEntry: vi.fn(),
    transactions: 0,
  };
});

vi.mock("@requestport/db", () => ({
  createCommandAuthorizationRepository: (tx: unknown, options: unknown) => {
    mocks.steps.push("open authorization");
    mocks.builtOn.push(["authorization", tx]);
    mocks.authorizationOptions.push(options);
    return {
      assertCurrent: async () => {
        mocks.steps.push("assertCurrent");
      },
    };
  },
  createImportReviewCommandRepository: (tx: unknown) => {
    mocks.steps.push("open imports");
    mocks.builtOn.push(["imports", tx]);
    return {
      authorize: async () => {
        mocks.steps.push("authorize");
      },
      splitEntry: async (input: unknown) => {
        mocks.steps.push("splitEntry");
        return mocks.splitEntry(input);
      },
    };
  },
}));

const { createImportSplit, importSplitTransaction } = await import(
  "./import-split.js"
);

const organizationId = "018f0000-0000-7000-8000-0000000c1001";
const runId = "018f0000-0000-7000-8000-0000000c1002";
const entryId = "018f0000-0000-7000-8000-0000000c1003";
const meta = {
  idempotencyKey: "core-split-idempotency-key",
  expectedVersion: 4,
};

const storage = {
  transaction: async <T>(work: (tx: never) => Promise<T>) => {
    mocks.transactions += 1;
    mocks.steps.push("begin");
    try {
      return await work(mocks.tx as never);
    } finally {
      mocks.steps.push("end");
    }
  },
};

function split(read: string[] = []) {
  const secrets = {
    get commandFingerprintKey() {
      read.push("commandFingerprintKey");
      return "core-split-signing-material";
    },
    operatorCredentials: "enabled" as const,
  };
  return createImportSplit({
    transaction: importSplitTransaction(storage, secrets),
    secrets,
  }).splitImportEntry;
}

function operator(): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: "018f0000-0000-7000-8000-0000000c1004",
      memberUserId: "018f0000-0000-7000-8000-0000000c1005",
    }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    scopes: new Set(["import:write"]),
    credentialId: "core-split-operator",
    correlationId: "018f0000-0000-7000-8000-0000000c1006",
  };
}

beforeEach(() => {
  mocks.steps.length = 0;
  mocks.builtOn.length = 0;
  mocks.authorizationOptions.length = 0;
  mocks.transactions = 0;
  mocks.splitEntry.mockReset();
  mocks.splitEntry.mockResolvedValue({ entryIds: ["a", "b"] });
});

describe("the import split over a storage", () => {
  test("re-checks first, then opens the import repository on the same transaction, and keys the receipt with the secret read then", async () => {
    const read: string[] = [];
    const context = operator();

    await expect(
      split(read)(
        context,
        { organizationId, runId, entryId, splitLines: [5, 2, 5] },
        meta,
      ),
    ).resolves.toEqual({ entryIds: ["a", "b"] });

    expect(mocks.transactions).toBe(1);
    expect(mocks.steps).toEqual([
      "begin",
      "open authorization",
      "assertCurrent",
      "open imports",
      "authorize",
      "splitEntry",
      "end",
    ]);
    expect(mocks.builtOn).toEqual([
      ["authorization", mocks.tx],
      ["imports", mocks.tx],
    ]);
    expect(mocks.authorizationOptions).toEqual([
      { operatorCredentials: "enabled" },
    ]);
    expect(mocks.splitEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        runId,
        entryId,
        splitLines: [2, 5],
        actor: context.actor,
        expectedVersion: 4,
        idempotencyKey: "core-split-idempotency-key",
        fingerprintSecret: "core-split-signing-material",
      }),
    );
    expect(read).toEqual(["commandFingerprintKey"]);
  });

  test("an input that is not the schema's opens no transaction", async () => {
    await expect(
      split()(operator(), { organizationId, runId, entryId }, meta),
    ).rejects.toBeInstanceOf(Error);

    expect(mocks.transactions).toBe(0);
  });

  test("another organisation is refused by the review target, after the re-check, and nothing is split", async () => {
    const error = await split()(
      operator(),
      {
        organizationId: "018f0000-0000-7000-8000-0000000c1007",
        runId,
        entryId,
        splitLines: [2],
      },
      meta,
    ).catch((refused: unknown) => refused);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("forbidden");
    expect(mocks.steps).toEqual([
      "begin",
      "open authorization",
      "assertCurrent",
      "end",
    ]);
    expect(mocks.splitEntry).not.toHaveBeenCalled();
  });
});
