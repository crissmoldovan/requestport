import type { WorkerStorages } from "@requestport/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The import bodies' settlement refused after their effects (manifest-i2.md
 * §5.1 Settlement): each logs `import.settlement_refused` and answers
 * `superseded`, and neither throws, so a run whose claim was taken over
 * does not retry into effects it has already had. The outbox body's
 * equivalent is in outbox-delivery.test.ts.
 *
 * The repositories are recorders; the storages are unset-shaped, each unit
 * handing the factories a stand-in handle they ignore. The command
 * transaction manager runs `work` on a unit of work whose `imports` port is
 * the import recorder.
 */

const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
const dispatchId = "0b9e2c56-3f0e-4c38-9d55-6c1f3a1c9e11";
const runId = "2d8f3a1e-7b64-4c1f-9a0e-5e2b7c9d1f33";
const projectId = "8a1c4e2f-3b5d-4f6a-8c7e-9d0b1a2c3e4f";
const reportId = "5c3e1a9b-2d4f-4e6a-8b0c-7d9e1f2a3b4c";
const attemptCount = 2;
const settlement = { kind: "trigger_run", runId: "run_self" } as const;

const dispatches = {
  claimStanding: vi.fn(),
  load: vi.fn(),
  markCompleted: vi.fn(),
};
const imports = {
  listAnalyzableArtifacts: vi.fn(),
  findMapping: vi.fn(),
  saveAnalysis: vi.fn(),
  lockForApply: vi.fn(),
  requireManagerAccess: vi.fn(),
  detail: vi.fn(),
  listEntryApplications: vi.fn(),
  createReport: vi.fn(),
  completeApply: vi.fn(),
};
const outbox = { idsForEvents: vi.fn() };
const appended: unknown[] = [];
const unitOfWork = {
  port: (name: string) => (name === "imports" ? imports : undefined),
  domainEvents: {
    append: vi.fn(async (events: unknown[]) => {
      appended.push(...events);
    }),
  },
};
const storages = {
  bound: false,
  dispatcher: {},
  maintenance: {},
  resolveJobOrganization: vi.fn(
    async (): Promise<string | null> => organizationId,
  ),
  withTenant: async (_: string, work: (database: unknown) => unknown) =>
    work({}),
  roleReports: async () => null,
  close: async () => undefined,
};

vi.mock("@requestport/db", () => ({
  createCollaborationRepository: () => ({}),
  createCommandTransactionManager: () => ({
    run: (work: (uow: typeof unitOfWork) => unknown) => work(unitOfWork),
  }),
  createImportRepository: () => imports,
  createImportTaskDispatchRepository: () => dispatches,
  createOutboxRepository: () => outbox,
  createRequestRepository: () => ({}),
  createRoutingRepository: () => ({}),
  createWorkerStorages: () => storages,
}));

/*
 * The bodies take these from worker-storages.ts, which, with nothing
 * installed, builds through the worker root that `@requestport/jobs`' own
 * module registers. This file does not load that module, and the root refuses
 * a process that has not declared the worker surface (manifest-g.md §2.10).
 * Installed instead, as an entry point installs its own: stand-in storages,
 * and the worker root's settings, as `requestport-jobs` installs them
 * (`cli.ts`).
 */
const { useWorkerSettings, useWorkerStorages } = await import(
  "../worker-storages.js"
);
const { workerSettingsFromRoot } = await import("../worker-root.js");
useWorkerStorages(storages as unknown as WorkerStorages);
useWorkerSettings(workerSettingsFromRoot());

const { runImportAnalyze } = await import("./import-analyze.js");
const { runImportApply } = await import("./import-apply.js");

const runner = {
  kind: "trigger" as const,
  enqueue: vi.fn(async () => ({ id: "job-1" })),
  sleep: vi.fn(async () => undefined),
  waitBeforeRetry: vi.fn(async () => undefined),
  dispatchOutbox: vi.fn(async () => ({ accepted: true })),
};

function dispatch(taskKind: "analyze" | "apply", runState: string) {
  return {
    dispatch: {
      id: dispatchId,
      organizationId,
      importRunId: runId,
      taskKind,
      attemptCount,
      state: "accepted",
      taskPayload:
        taskKind === "analyze"
          ? { kind: "analyze", runId }
          : {
              kind: "apply",
              organizationId,
              runId,
              manifestSha256: "a".repeat(64),
              actor: { type: "user", id: "user-1" },
            },
    },
    runState,
  };
}

/** Runs `body`, returning what it resolved to and every line it logged. */
async function logged<T>(body: () => Promise<T>) {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  const warn = vi.spyOn(console, "warn").mockImplementation(capture);
  const log = vi.spyOn(console, "log").mockImplementation(capture);
  try {
    return { result: await body(), lines: lines.join("\n") };
  } finally {
    write.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  appended.length = 0;
  storages.resolveJobOrganization.mockResolvedValue(organizationId);
  dispatches.claimStanding.mockResolvedValue("held");
  // Refused: the claim was taken over while the body ran.
  dispatches.markCompleted.mockResolvedValue(false);
  imports.listAnalyzableArtifacts.mockResolvedValue([]);
  imports.saveAnalysis.mockResolvedValue(undefined);
  imports.requireManagerAccess.mockResolvedValue(undefined);
  imports.detail.mockResolvedValue({
    report: { id: reportId, counts: { skipped: 1 } },
    entries: [],
  });
  imports.listEntryApplications.mockResolvedValue([]);
  imports.createReport.mockResolvedValue(reportId);
  imports.completeApply.mockResolvedValue(undefined);
  outbox.idsForEvents.mockResolvedValue([]);
});

describe("an import body whose settlement is refused after its effects", () => {
  test("analyze: saves its analysis, then answers superseded and logs the refusal", async () => {
    dispatches.load.mockResolvedValue(dispatch("analyze", "analyzing"));

    const { result, lines } = await logged(() =>
      runImportAnalyze({ dispatchId, attemptCount }, settlement),
    );

    expect(result).toEqual({ status: "superseded" });
    expect(imports.saveAnalysis).toHaveBeenCalledWith({
      runId,
      entries: [],
    });
    expect(dispatches.markCompleted.mock.calls).toEqual([
      [dispatchId, attemptCount, settlement],
    ]);
    expect(lines).toContain("import.settlement_refused");
  });

  test("apply: completes the run, then answers superseded and logs the refusal", async () => {
    dispatches.load.mockResolvedValue(dispatch("apply", "approved"));
    imports.lockForApply.mockResolvedValue({
      alreadyApplied: false,
      source: { projectId },
      run: { parserVersion: "legacy:1" },
    });

    const { result, lines } = await logged(() =>
      runImportApply({ dispatchId, attemptCount }, runner, settlement),
    );

    expect(result).toEqual({ status: "superseded" });
    expect(imports.completeApply).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
    expect(dispatches.markCompleted.mock.calls).toEqual([
      [dispatchId, attemptCount, settlement],
    ]);
    expect(lines).toContain("import.settlement_refused");
  });

  test("apply, a run already applied: answers superseded and logs the refusal", async () => {
    dispatches.load.mockResolvedValue(dispatch("apply", "approved"));
    imports.lockForApply.mockResolvedValue({
      alreadyApplied: true,
      source: { projectId },
      run: { parserVersion: "legacy:1" },
    });

    const { result, lines } = await logged(() =>
      runImportApply({ dispatchId, attemptCount }, runner, settlement),
    );

    expect(result).toEqual({ status: "superseded" });
    expect(imports.completeApply).not.toHaveBeenCalled();
    expect(dispatches.markCompleted.mock.calls).toEqual([
      [dispatchId, attemptCount, settlement],
    ]);
    expect(lines).toContain("import.settlement_refused");
  });

  test("each completes, not superseded, when the settlement holds", async () => {
    dispatches.markCompleted.mockResolvedValue(true);
    dispatches.load.mockResolvedValue(dispatch("analyze", "analyzing"));
    await expect(
      runImportAnalyze({ dispatchId, attemptCount }, settlement),
    ).resolves.toMatchObject({ status: "completed" });

    dispatches.load.mockResolvedValue(dispatch("apply", "approved"));
    imports.lockForApply.mockResolvedValue({
      alreadyApplied: false,
      source: { projectId },
      run: { parserVersion: "legacy:1" },
    });
    await expect(
      runImportApply({ dispatchId, attemptCount }, runner, settlement),
    ).resolves.toMatchObject({ alreadyApplied: false, reportId });
  });
});
