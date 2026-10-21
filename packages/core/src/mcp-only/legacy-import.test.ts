import {
  type AuthorizedCommandContext,
  DomainError,
  operatorActor,
} from "@requestport/domain";
import { LEGACY_PARSER_VERSION } from "@requestport/importer";
import { describe, expect, test } from "vitest";

import { createLegacyImportAnalysis } from "./legacy-import.js";

/*
 * The legacy import tools for an agent (manifest-g.md §2.5; MCP's
 * `analyze_legacy_import`, and with ruling 137 `list_legacy_imports`,
 * `get_legacy_import`, `apply_legacy_import` and `correct_legacy_import`),
 * moved into core: anything but an agent's call is refused before the
 * transaction opens; in it, the agent's import grant is checked first. The
 * analysis's snapshot must be the bound project's, and its run is created as
 * the agent under this deployment's parser version, keyed with the raw
 * fingerprint key. The analysis and the apply start their committed dispatch
 * after the transaction, bound to the context's organisation. The repository
 * and the dispatch are stand-ins that record each call, so nothing here
 * opens a database.
 */

const organizationId = "018f0000-0000-7000-8000-0000000c5001";
const projectId = "018f0000-0000-7000-8000-0000000c5002";
const agentId = "018f0000-0000-7000-8000-0000000c5003";
const authorizationId = "018f0000-0000-7000-8000-0000000c5004";
const delegatedBy = "018f0000-0000-7000-8000-0000000c5005";
const sourceId = "018f0000-0000-7000-8000-0000000c5006";
const snapshotId = "018f0000-0000-7000-8000-0000000c5007";
const meta = { idempotencyKey: "legacy-import-test-key", expectedVersion: 0 };
const secret = "legacy-import-test-signing-material-0000001";

function agentContext(
  project: string | null = projectId,
): AuthorizedCommandContext {
  return {
    actor: {
      type: "agent",
      id: agentId,
      delegatedBy: { type: "user", id: delegatedBy },
    },
    organizationId,
    projectId: project,
    scopes: new Set(["import:write"]),
    credentialId: authorizationId,
    correlationId: "018f0000-0000-7000-8000-0000000c5008",
  };
}

/** An import run's detail, of `source`'s project, as the repository answers it. */
function runDetail(source = projectId, manifestSha256 = "manifest-sha") {
  return {
    run: { id: "run-1", manifestSha256 },
    source: { id: sourceId, projectId: source },
    snapshot: { id: snapshotId },
    entries: [
      {
        entry: { id: "entry-1" },
        artifact: {
          id: "artifact-1",
          relativePath: "notes/one.md",
          mediaType: "text/markdown",
          byteSize: 12,
          sha256: "artifact-sha",
          secretScanStatus: "clean",
          content: "never answered",
        },
      },
    ],
    conflicts: [],
    report: { entries: 1 },
  };
}

function recordingAnalysis(
  capture: unknown = { found: true },
  detail: unknown = runDetail(),
) {
  const calls: Array<[string, ...unknown[]]> = [];
  let transactions = 0;
  const analysis = createLegacyImportAnalysis({
    dispatchImportTask: async (dispatchId, organization) => {
      calls.push(["dispatchImportTask", dispatchId, organization]);
    },
    transaction: async (work) => {
      transactions += 1;
      calls.push(["transaction"]);
      return work({
        imports: () => ({
          listForProject: async (organization, project) => {
            calls.push(["listForProject", organization, project]);
            return [{ id: "run-1" }] as never;
          },
          detail: async (organization, runId) => {
            calls.push(["detail", organization, runId]);
            return detail as never;
          },
          queueApply: async (input) => {
            calls.push(["queueApply", input]);
            return { dispatchId: "apply-dispatch-1" } as never;
          },
          createCorrectionRun: async (input) => {
            calls.push(["createCorrectionRun", input]);
            return { id: "correction-1", state: "queued" } as never;
          },
          requireAgentAccess: async (authorization) => {
            // The grant is read as the repository reads it, project included.
            calls.push([
              "requireAgentAccess",
              {
                organizationId: authorization.organizationId,
                projectId: authorization.projectId,
                agentPrincipalId: authorization.agentPrincipalId,
                authorizationId: authorization.authorizationId,
                delegatedByUserId: authorization.delegatedByUserId,
              },
            ]);
            return { laneIds: [], scopes: ["import:write"] };
          },
          findCaptureForProject: async (input) => {
            calls.push(["findCaptureForProject", input]);
            return capture as never;
          },
          createRun: async (input) => {
            calls.push(["createRun", input]);
            return {
              id: "run-1",
              state: "queued",
              dispatchId: "dispatch-1",
            } as never;
          },
        }),
      });
    },
    secrets: { commandFingerprintKey: secret },
  });
  return { analysis, calls, transactions: () => transactions };
}

describe("queueLegacyImportAnalysis", () => {
  test("checks the agent's grant, finds the snapshot in its project, and creates the run as the agent, in one transaction", async () => {
    const { analysis, calls, transactions } = recordingAnalysis();

    await expect(
      analysis.queueLegacyImportAnalysis(
        { sourceId, snapshotId },
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    ).resolves.toEqual({
      id: "run-1",
      state: "queued",
      dispatchId: "dispatch-1",
    });

    expect(transactions()).toBe(1);
    expect(calls).toEqual([
      ["transaction"],
      [
        "requireAgentAccess",
        {
          organizationId,
          projectId,
          agentPrincipalId: agentId,
          authorizationId,
          delegatedByUserId: delegatedBy,
        },
      ],
      [
        "findCaptureForProject",
        { organizationId, projectId, sourceId, snapshotId },
      ],
      [
        "createRun",
        {
          organizationId,
          sourceId,
          snapshotId,
          actorType: "agent",
          actorId: agentId,
          parserVersion: LEGACY_PARSER_VERSION,
          idempotencyKey: meta.idempotencyKey,
          expectedVersion: meta.expectedVersion,
          fingerprintSecret: secret,
        },
      ],
    ]);
  });

  test("answers a snapshot the project does not hold as not found, and creates no run", async () => {
    const { analysis, calls } = recordingAnalysis(null);

    await expect(
      analysis.queueLegacyImportAnalysis(
        { sourceId, snapshotId },
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Import snapshot was not found",
    });
    expect(calls.map(([call]) => call)).toEqual([
      "transaction",
      "requireAgentAccess",
      "findCaptureForProject",
    ]);
  });

  test("refuses a credential bound to no project where the grant is read, inside the transaction", async () => {
    const { analysis, calls } = recordingAnalysis();

    await expect(
      analysis.queueLegacyImportAnalysis(
        { sourceId, snapshotId },
        { context: agentContext(null), credentialKind: "agent", meta },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "This credential is not bound to a project, so it cannot reach project data",
    });
    expect(calls).toEqual([["transaction"]]);
  });

  test.each([
    [
      "an operator's call",
      (): AuthorizedCommandContext => ({
        actor: operatorActor({
          lineageId: "018f0000-0000-7000-8000-0000000c5009",
          memberUserId: delegatedBy,
        }),
        credentialKind: "operator",
        organizationId,
        projectId,
        scopes: new Set(["import:write"]),
        credentialId: "operator-credential",
        correlationId: "018f0000-0000-7000-8000-0000000c500a",
      }),
      "operator",
    ],
    [
      "an agent's context stated as an operator's",
      () => agentContext(),
      "operator",
    ],
    [
      "a person's context stated as an agent's",
      (): AuthorizedCommandContext => ({
        actor: { type: "user", id: delegatedBy },
        organizationId,
        scopes: new Set(["import:write"]),
        credentialId: "a-live-session",
        correlationId: "018f0000-0000-7000-8000-0000000c500b",
      }),
      "agent",
    ],
  ] as const)(
    "refuses %s before the transaction opens",
    async (_, context, credentialKind) => {
      const { analysis, transactions } = recordingAnalysis();

      const error = await analysis
        .queueLegacyImportAnalysis(
          { sourceId, snapshotId },
          { context: context(), credentialKind, meta },
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: "forbidden",
        message: "This kind of credential is not admitted to this command",
      });
      expect(transactions()).toBe(0);
    },
  );
});

const grantCheck = [
  "requireAgentAccess",
  {
    organizationId,
    projectId,
    agentPrincipalId: agentId,
    authorizationId,
    delegatedByUserId: delegatedBy,
  },
];

const notAnAgent = (): AuthorizedCommandContext => ({
  actor: operatorActor({
    lineageId: "018f0000-0000-7000-8000-0000000c5009",
    memberUserId: delegatedBy,
  }),
  credentialKind: "operator",
  organizationId,
  projectId,
  scopes: new Set(["import:write"]),
  credentialId: "operator-credential",
  correlationId: "018f0000-0000-7000-8000-0000000c500a",
});

describe("analyze", () => {
  test("queues the analysis in one transaction, then starts its committed dispatch bound to the context's organisation, and answers the run", async () => {
    const { analysis, calls, transactions } = recordingAnalysis();

    await expect(
      analysis.analyze(
        { sourceId, snapshotId },
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    ).resolves.toEqual({ runId: "run-1", state: "queued" });

    expect(transactions()).toBe(1);
    expect(calls.map(([call]) => call)).toEqual([
      "transaction",
      "requireAgentAccess",
      "findCaptureForProject",
      "createRun",
      "dispatchImportTask",
    ]);
    expect(calls.at(-1)).toEqual([
      "dispatchImportTask",
      "dispatch-1",
      organizationId,
    ]);
  });

  test("starts nothing when the snapshot is not the project's", async () => {
    const { analysis, calls } = recordingAnalysis(null);

    await expect(
      analysis.analyze(
        { sourceId, snapshotId },
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(calls.map(([call]) => call)).not.toContain("dispatchImportTask");
  });
});

describe("list", () => {
  test("checks the agent's grant, then lists the bound project's runs, in one transaction", async () => {
    const { analysis, calls, transactions } = recordingAnalysis();

    await expect(
      analysis.list({ context: agentContext(), credentialKind: "agent" }),
    ).resolves.toEqual({ items: [{ id: "run-1" }] });

    expect(transactions()).toBe(1);
    expect(calls).toEqual([
      ["transaction"],
      grantCheck,
      ["listForProject", organizationId, projectId],
    ]);
  });
});

describe("detail", () => {
  test("checks the agent's grant, reads the run, and answers it with each artifact's description but not its content", async () => {
    const { analysis, calls } = recordingAnalysis();

    const answered = await analysis.detail("run-1", {
      context: agentContext(),
      credentialKind: "agent",
    });

    expect(calls).toEqual([
      ["transaction"],
      grantCheck,
      ["detail", organizationId, "run-1"],
    ]);
    const { content: _content, ...described } =
      runDetail().entries[0]?.artifact ?? {};
    expect(answered).toEqual({
      run: runDetail().run,
      source: runDetail().source,
      snapshot: runDetail().snapshot,
      entries: [{ entry: { id: "entry-1" }, artifact: described }],
      conflicts: [],
      report: { entries: 1 },
    });
  });

  test.each([
    ["a run that does not exist", null],
    [
      "a run of another project",
      runDetail("018f0000-0000-7000-8000-0000000c50ff"),
    ],
  ])("answers %s as not found", async (_, detail) => {
    const { analysis } = recordingAnalysis(undefined, detail);

    await expect(
      analysis.detail("run-1", {
        context: agentContext(),
        credentialKind: "agent",
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Import run was not found",
    });
  });
});

describe("apply", () => {
  test("checks the grant and the run's project and manifest hash, queues the apply as the agent on its grant, then starts its dispatch bound to the context's organisation", async () => {
    const { analysis, calls, transactions } = recordingAnalysis();

    await expect(
      analysis.apply(
        { runId: "run-1", manifestSha256: "manifest-sha" },
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    ).resolves.toEqual({ runId: "run-1", state: "queued" });

    expect(transactions()).toBe(1);
    expect(calls).toEqual([
      ["transaction"],
      grantCheck,
      ["detail", organizationId, "run-1"],
      [
        "queueApply",
        {
          organizationId,
          runId: "run-1",
          manifestSha256: "manifest-sha",
          actorType: "agent",
          actorId: agentId,
          taskActor: {
            type: "agent",
            id: agentId,
            authorizationId,
            delegatedByUserId: delegatedBy,
            projectId,
          },
          idempotencyKey: meta.idempotencyKey,
          expectedVersion: meta.expectedVersion,
          fingerprintSecret: secret,
        },
      ],
      ["dispatchImportTask", "apply-dispatch-1", organizationId],
    ]);
  });

  test.each([
    ["a run that does not exist", null, "not_found"],
    [
      "a run of another project",
      runDetail("018f0000-0000-7000-8000-0000000c50ff"),
      "not_found",
    ],
    [
      "a run whose manifest hash is not the approved one",
      runDetail(projectId, "another-sha"),
      "validation_failed",
    ],
  ])("refuses %s, and queues and starts nothing", async (_, detail, code) => {
    const { analysis, calls } = recordingAnalysis(undefined, detail);

    await expect(
      analysis.apply(
        { runId: "run-1", manifestSha256: "manifest-sha" },
        { context: agentContext(), credentialKind: "agent", meta },
      ),
    ).rejects.toMatchObject({ code });
    expect(calls.map(([call]) => call)).toEqual([
      "transaction",
      "requireAgentAccess",
      "detail",
    ]);
  });
});

describe("correct", () => {
  test("checks the grant and the run's project, then opens a correction run as the agent under its correlation id", async () => {
    const { analysis, calls } = recordingAnalysis();
    const context = agentContext();

    await expect(
      analysis.correct("run-1", { context, credentialKind: "agent", meta }),
    ).resolves.toEqual({ runId: "correction-1", state: "queued" });

    expect(calls).toEqual([
      ["transaction"],
      grantCheck,
      ["detail", organizationId, "run-1"],
      [
        "createCorrectionRun",
        {
          organizationId,
          originalRunId: "run-1",
          actorType: "agent",
          actorId: agentId,
          correlationId: context.correlationId,
          idempotencyKey: meta.idempotencyKey,
          expectedVersion: meta.expectedVersion,
          fingerprintSecret: secret,
        },
      ],
    ]);
  });
});

describe("each tool beside the analysis", () => {
  test.each(["list", "detail", "apply", "correct", "analyze"] as const)(
    "%s refuses anything but an agent's call before the transaction opens",
    async (tool) => {
      const { analysis, transactions } = recordingAnalysis();
      const call = {
        context: notAnAgent(),
        credentialKind: "operator",
        meta,
      } as const;
      const run = {
        list: () => analysis.list(call),
        detail: () => analysis.detail("run-1", call),
        apply: () =>
          analysis.apply({ runId: "run-1", manifestSha256: "x" }, call),
        correct: () => analysis.correct("run-1", call),
        analyze: () => analysis.analyze({ sourceId, snapshotId }, call),
      }[tool];

      await expect(run()).rejects.toMatchObject({
        code: "forbidden",
        message: "This kind of credential is not admitted to this command",
      });
      expect(transactions()).toBe(0);
    },
  );

  test.each(["list", "detail", "apply", "correct"] as const)(
    "%s refuses a credential bound to no project where the grant is read, inside the transaction",
    async (tool) => {
      const { analysis, calls } = recordingAnalysis();
      const call = {
        context: agentContext(null),
        credentialKind: "agent",
        meta,
      } as const;
      const run = {
        list: () => analysis.list(call),
        detail: () => analysis.detail("run-1", call),
        apply: () =>
          analysis.apply({ runId: "run-1", manifestSha256: "x" }, call),
        correct: () => analysis.correct("run-1", call),
      }[tool];

      await expect(run()).rejects.toMatchObject({
        code: "forbidden",
        message:
          "This credential is not bound to a project, so it cannot reach project data",
      });
      expect(calls).toEqual([["transaction"]]);
    },
  );
});
