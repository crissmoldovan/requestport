import { describe, expect, test, vi } from "vitest";

import { createImportDispatchPoller } from "./import-dispatch-poller.js";

const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";

function repository(
  rows: Array<{
    id: string;
    taskKind: "analyze" | "apply";
    attemptCount: number;
  }>,
) {
  return {
    claimBatch: vi.fn(async (_limit?: number, _leaseSeconds?: number) =>
      rows.map((row) => ({
        ...row,
        organizationId,
        leaseId: `lease-${row.id}`,
        leaseExpiresAt: new Date(Date.now() + 600_000),
      })),
    ),
  };
}

describe("the Postgres worker's import dispatch poller", () => {
  test("claims under its lease and runs each dispatch as the task its kind names", async () => {
    const repo = repository([
      { id: "dispatch-a", taskKind: "analyze", attemptCount: 1 },
      { id: "dispatch-b", taskKind: "apply", attemptCount: 2 },
    ]);
    const analyze = vi.fn(async () => ({ status: "completed" }));
    const apply = vi.fn(async () => ({ status: "completed" }));

    const report = await createImportDispatchPoller({
      repository: repo,
      handlers: {
        "legacy-import-analyze": analyze,
        "legacy-import-apply": apply,
      },
      batchSize: 2,
      leaseMs: 600_000,
      jobTimeoutMs: 1_000,
    }).drainOnce();

    // Function 4 takes seconds; the lease id is the claim's, not an owner.
    expect(repo.claimBatch).toHaveBeenCalledWith(2, 600);
    // The same payload the import-dispatch-repair schedule gives Trigger.dev,
    // and the claim's lease to settle under (manifest-i2.md §5.1).
    expect(analyze).toHaveBeenCalledWith(
      { dispatchId: "dispatch-a", attemptCount: 1 },
      { kind: "lease", leaseId: "lease-dispatch-a" },
    );
    expect(apply).toHaveBeenCalledWith(
      { dispatchId: "dispatch-b", attemptCount: 2 },
      { kind: "lease", leaseId: "lease-dispatch-b" },
    );
    expect(report).toEqual({ claimed: 2, ran: 2, failed: 0, timedOut: 0 });
  });

  test("leaves a failed dispatch leased; its lease and attempt budget decide what happens next", async () => {
    const repo = repository([
      { id: "dispatch-c", taskKind: "apply", attemptCount: 1 },
    ]);
    const events: unknown[] = [];

    const report = await createImportDispatchPoller({
      repository: repo,
      handlers: {
        "legacy-import-analyze": vi.fn(),
        "legacy-import-apply": async () => {
          throw new Error("apply failed");
        },
      },
      batchSize: 1,
      leaseMs: 600_000,
      jobTimeoutMs: 1_000,
      onEvent: (event) => events.push(event),
    }).drainOnce();

    // There is no retry call to make: `claimBatch` claims it again once the
    // lease has run out, and dead-letters it once its attempts are spent.
    expect(report).toEqual({ claimed: 1, ran: 0, failed: 1, timedOut: 0 });
    expect(events).toEqual([
      {
        type: "import.dispatch_failed",
        dispatchId: "dispatch-c",
        attempt: 1,
        errorMessage: "apply failed",
      },
    ]);
  });

  test("stops waiting for a dispatch that overruns", async () => {
    vi.useFakeTimers();
    try {
      const drain = createImportDispatchPoller({
        repository: repository([
          { id: "dispatch-d", taskKind: "analyze", attemptCount: 1 },
        ]),
        handlers: {
          "legacy-import-analyze": () => new Promise(() => undefined),
          "legacy-import-apply": vi.fn(),
        },
        batchSize: 1,
        leaseMs: 600_000,
        jobTimeoutMs: 1_000,
      }).drainOnce();

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(drain).resolves.toEqual({
        claimed: 1,
        ran: 0,
        failed: 0,
        timedOut: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
