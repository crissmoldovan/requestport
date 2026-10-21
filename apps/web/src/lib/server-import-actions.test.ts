import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ZodError } from "zod";

/*
  The split handler (Plan 13, F.2.6) against a database faked at the package
  boundary: what it opens, in which order, on which transaction, and what it
  hands the repository. What PostgreSQL answers is
  `packages/db/src/repositories/import-repository.integration.test.ts`'s,
  which composes the same steps.
*/

const database = vi.hoisted(() => {
  const tx = { name: "the split's transaction" };
  const calls: string[] = [];
  return {
    tx,
    calls,
    builtOn: [] as unknown[],
    authorizationOptions: [] as unknown[],
    assertCurrent: vi.fn(async () => {
      calls.push("assertCurrent");
    }),
    authorize: vi.fn(async () => {
      calls.push("authorize");
    }),
    splitEntry: vi.fn(async () => {
      calls.push("splitEntry");
      return { entryIds: ["first", "second"] };
    }),
    withTransaction: vi.fn(async (run: (tx: unknown) => unknown) => {
      calls.push("begin");
      const result = await run(tx);
      calls.push("end");
      return result;
    }),
  };
});

const parser = vi.hoisted(() => ({
  parseLegacyArtifact: vi.fn((body: string) => [
    { kind: "request", title: body.trim(), confidence: { kind: 0.9 } },
  ]),
}));

vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_SECRET: "import-actions-test-signing-material",
    REQUESTPORT_OPERATOR_CREDENTIALS: "enabled",
  },
}));

vi.mock("@requestport/db", async (importOriginal) => ({
  // The web's RequestPort composes its command bus when it is first used,
  // over the package's own port factories and a transaction manager this
  // suite never runs (Plan 13, G.6).
  ...(await importOriginal<Record<string, unknown>>()),
  createCommandTransactionManager: () => ({ run: vi.fn() }),
  createCommandAuthorizationRepository: (tx: unknown, options: unknown) => {
    database.builtOn.push(tx);
    database.authorizationOptions.push(options);
    return { assertCurrent: database.assertCurrent };
  },
  createImportReviewCommandRepository: (tx: unknown) => {
    database.builtOn.push(tx);
    return {
      authorize: database.authorize,
      splitEntry: database.splitEntry,
    };
  },
}));

/*
 * The split opens its transaction on the web root's storage (Plan 13, G.2),
 * through the web's RequestPort since G.6, which `server-web-request-port.ts`
 * composes over the storage the wiring answers the root (ruling 140). So the
 * wiring hands back the fake above, `database.withTransaction`, as that
 * storage's `transaction`, and the cases count it as they always did.
 */
vi.mock("@requestport/db/wiring", () => ({
  applicationStorageFromEnv: () => ({ transaction: database.withTransaction }),
}));

vi.mock("@requestport/importer", () => ({
  parseLegacyArtifact: parser.parseLegacyArtifact,
}));

import {
  legacySegments,
  relationshipsFromLines,
  splitImportEntry,
  splitLinesFromText,
} from "./server-import-actions.js";

const organizationId = "00000000-0000-4000-8000-0000000000d1";
const otherOrganizationId = "00000000-0000-4000-8000-0000000000d2";
const runId = "00000000-0000-4000-8000-000000000101";
const entryId = "00000000-0000-4000-8000-000000000102";
const userId = "00000000-0000-4000-8000-0000000000aa";
const meta = { expectedVersion: 3, idempotencyKey: "0123456789abcdef0123" };

function context(
  overrides: Partial<AuthorizedCommandContext> = {},
): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: userId },
    organizationId,
    scopes: new Set(["import:write"]),
    credentialId: "session-under-test",
    correlationId: "00000000-0000-4000-8000-0000000000cc",
    ...overrides,
  };
}

const input = { organizationId, runId, entryId, splitLines: [5, 2, 5] };

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("not refused");
}

beforeEach(() => {
  database.calls.length = 0;
  database.builtOn.length = 0;
  database.authorizationOptions.length = 0;
  database.assertCurrent.mockClear();
  database.authorize.mockClear();
  database.splitEntry.mockClear();
  database.withTransaction.mockClear();
  parser.parseLegacyArtifact.mockClear();
});

describe("splitImportEntry", () => {
  test("re-checks the credential first, then the reviewer, then splits, in one transaction", async () => {
    expect(await splitImportEntry(context(), input, meta)).toEqual({
      entryIds: ["first", "second"],
    });

    expect(database.calls).toEqual([
      "begin",
      "assertCurrent",
      "authorize",
      "splitEntry",
      "end",
    ]);
    expect(database.assertCurrent).toHaveBeenCalledExactlyOnceWith(context());
    expect(database.authorize).toHaveBeenCalledExactlyOnceWith({
      userId,
      organizationId,
    });
  });

  test("opens every repository on that one transaction", async () => {
    await splitImportEntry(context(), input, meta);

    expect(database.builtOn).toEqual([database.tx, database.tx]);
  });

  test("builds the re-check under the deployment's operator switch, as the bus's port is built", async () => {
    await splitImportEntry(context(), input, meta);

    expect(database.authorizationOptions).toEqual([
      { operatorCredentials: "enabled" },
    ]);
  });

  test("hands the repository the lines once each and in order, the reviewer, the version, the key and the form's secret", async () => {
    await splitImportEntry(context(), input, meta);

    expect(database.splitEntry).toHaveBeenCalledExactlyOnceWith({
      organizationId,
      runId,
      entryId,
      splitLines: [2, 5],
      segment: expect.any(Function),
      userId,
      actor: { type: "user", id: userId },
      credentialProjectId: null,
      expectedVersion: 3,
      idempotencyKey: "0123456789abcdef0123",
      fingerprintSecret: "import-actions-test-signing-material",
    });
  });

  test("for an operator, asks about its member and hands the repository the operator's own actor and bound project", async () => {
    const memberUserId = "user_import_actions_operator_member";
    const projectId = "00000000-0000-4000-8000-0000000000e1";
    const operator = context({
      actor: operatorActor({
        lineageId: "00000000-0000-4000-8000-0000000000e2",
        memberUserId,
      }),
      credentialKind: "operator",
      projectId,
      laneIds: new Set(),
      credentialId: "00000000-0000-4000-8000-0000000000e3",
    });
    await splitImportEntry(operator, input, meta);

    expect(database.authorize).toHaveBeenCalledExactlyOnceWith({
      userId: memberUserId,
      organizationId,
    });
    expect(database.splitEntry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: memberUserId,
        actor: operator.actor,
        credentialProjectId: projectId,
      }),
    );
  });

  test("the cut it hands over is the legacy parser's, at those lines", async () => {
    await splitImportEntry(context(), input, meta);
    const [[{ segment }]] = database.splitEntry.mock.calls as unknown as [
      [{ segment: (body: string) => unknown }],
    ];

    expect(segment("one\ntwo\nthree\nfour\nfive\nsix\n")).toEqual(
      legacySegments("one\ntwo\nthree\nfour\nfive\nsix\n", [2, 5]),
    );
    expect(parser.parseLegacyArtifact).toHaveBeenCalledWith("one\n");
    expect(parser.parseLegacyArtifact).toHaveBeenCalledWith(
      "two\nthree\nfour\n",
    );
    expect(parser.parseLegacyArtifact).toHaveBeenCalledWith("five\nsix\n");
  });

  test("a refused re-check touches nothing else", async () => {
    database.assertCurrent.mockRejectedValueOnce(
      new DomainError(
        "forbidden",
        "Current human authorization is no longer active",
      ),
    );

    expect(
      ((await refusal(splitImportEntry(context(), input, meta))) as DomainError)
        .code,
    ).toBe("forbidden");
    expect(database.authorize).not.toHaveBeenCalled();
    expect(database.splitEntry).not.toHaveBeenCalled();
  });

  test.each([
    ["an agent", { actor: { type: "agent" as const, id: "agent-1" } }],
    [
      "a service actor shaped as an operator, in a context that does not say operator",
      {
        actor: {
          type: "service" as const,
          id: "operator:probe",
          originatingActor: { type: "user" as const, id: userId },
        },
      },
    ],
    ["a context without import:write", { scopes: new Set(["project:manage"]) }],
  ])("refuses %s before the reviewer is checked", async (_, overrides) => {
    expect(
      (
        (await refusal(
          splitImportEntry(context(overrides), input, meta),
        )) as DomainError
      ).code,
    ).toBe("forbidden");
    expect(database.authorize).not.toHaveBeenCalled();
    expect(database.splitEntry).not.toHaveBeenCalled();
  });

  test("refuses another organisation, and a malformed input before a transaction opens", async () => {
    expect(
      (
        (await refusal(
          splitImportEntry(
            context(),
            { ...input, organizationId: otherOrganizationId },
            meta,
          ),
        )) as DomainError
      ).code,
    ).toBe("forbidden");
    expect(database.splitEntry).not.toHaveBeenCalled();

    database.withTransaction.mockClear();
    expect(
      await refusal(
        splitImportEntry(context(), { ...input, splitLines: [1] }, meta),
      ),
    ).toBeInstanceOf(ZodError);
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

describe("legacySegments", () => {
  test("cuts before each line and numbers the records", () => {
    expect(legacySegments("a\nb\nc\n", [2])).toEqual([
      {
        proposedKind: "request",
        parsedJson: {
          kind: "request",
          title: "a",
          confidence: { kind: 0.9 },
          recordIndex: 0,
        },
        confidenceJson: { kind: 0.9 },
      },
      {
        proposedKind: "request",
        parsedJson: {
          kind: "request",
          title: "b\nc",
          confidence: { kind: 0.9 },
          recordIndex: 1,
        },
        confidenceJson: { kind: 0.9 },
      },
    ]);
  });

  test("refuses a line past the record, and a segment that is not one record", () => {
    expect(() => legacySegments("a\nb\n", [3])).toThrow(
      "A split line is outside the preserved record",
    );
    parser.parseLegacyArtifact.mockReturnValueOnce([]);
    expect(() => legacySegments("a\nb\n", [2])).toThrow(
      "Each manual segment must parse as one record",
    );
  });
});

describe("the review and split forms' text", () => {
  test("split lines are read once each, in order, and between one and nineteen of them", () => {
    expect(splitLinesFromText("7, 3 3\n12")).toEqual([3, 7, 12]);
    expect(() => splitLinesFromText("1")).toThrow(ZodError);
    expect(() => splitLinesFromText("two")).toThrow(ZodError);
    expect(() =>
      splitLinesFromText(
        Array.from({ length: 20 }, (_, index) => index + 2).join(","),
      ),
    ).toThrow("A manual split requires between one and nineteen split lines");
  });

  test("relationships are one type:request per line, once each, at most twenty", () => {
    const target = "00000000-0000-4000-8000-000000000401";
    expect(
      relationshipsFromLines(
        `blocks:${target}\n\n  blocks:${target}  \r\nrelated_to:${target}`,
      ),
    ).toEqual([
      { type: "blocks", targetRequestId: target },
      { type: "related_to", targetRequestId: target },
    ]);
    expect(relationshipsFromLines("")).toEqual([]);
    expect(() => relationshipsFromLines(`follows:${target}`)).toThrow(ZodError);
    expect(() => relationshipsFromLines("blocks")).toThrow(ZodError);
    expect(() =>
      relationshipsFromLines(
        Array.from(
          { length: 21 },
          (_, index) =>
            `blocks:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ).join("\n"),
      ),
    ).toThrow("An import entry may define at most 20 relationships");
  });
});
