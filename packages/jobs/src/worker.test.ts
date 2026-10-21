import { describe, expect, test, vi } from "vitest";

import type { JobHandlers } from "./catalogue.js";
import type { ExclusiveRunner } from "./scheduler.js";
import { defaultWorkerTiming } from "./timing.js";
import { type JobWorkerDependencies, startJobWorker } from "./worker.js";

type Logged = { level: string; event: string; fields: Record<string, unknown> };

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const idleHandlers: JobHandlers = {
  "outbox-delivery": async () => undefined,
  "webhook-delivery": async () => undefined,
  "email-delivery": async () => undefined,
  "slack-question-delivery": async () => undefined,
  "slack-message-update": async () => undefined,
  "slack-connection-test": async () => undefined,
  "legacy-import-analyze": async () => undefined,
  "legacy-import-apply": async () => undefined,
};

function dependencies(overrides: Partial<JobWorkerDependencies> = {}) {
  const logged: Logged[] = [];
  const keys: string[] = [];
  const runExclusive: ExclusiveRunner = async (key, run) => {
    keys.push(key);
    return { acquired: true, value: await run() };
  };
  const deps: JobWorkerDependencies = {
    outboxRepository: {
      claimBatch: vi.fn(
        async (_limit?: number, _leaseSeconds?: number) =>
          [] as Awaited<
            ReturnType<JobWorkerDependencies["outboxRepository"]["claimBatch"]>
          >,
      ),
      releaseClaim: vi.fn(async () => true),
    },
    importTaskDispatchRepository: { claimBatch: vi.fn(async () => []) },
    createHandlers: () => idleHandlers,
    schedules: [
      {
        id: "retention-cleanup",
        cron: "17 3 * * *",
        run: vi.fn(async () => undefined),
      },
    ],
    runExclusive,
    logger: {
      info: (event, fields = {}) =>
        logged.push({ level: "info", event, fields }),
      warn: (event, fields = {}) =>
        logged.push({ level: "warn", event, fields }),
      error: (event, fields = {}) =>
        logged.push({ level: "error", event, fields }),
    },
    ...overrides,
  };
  return { deps, logged, keys };
}

const fast = { ...defaultWorkerTiming, tickMs: 20 };

describe("the Postgres job worker", () => {
  test("refuses to start when its clocks break the lease-versus-tick rule", () => {
    const { deps } = dependencies();

    expect(() =>
      startJobWorker(deps, {
        timing: { ...defaultWorkerTiming, outboxJobTimeoutMs: 60_000 },
      }),
    ).toThrowError(/outboxJobTimeoutMs \(60000\) \+ tickMs/u);
  });

  test("becomes ready after its first outbox tick, each loop under its own advisory key", async () => {
    const { deps, logged, keys } = dependencies();
    const worker = startJobWorker(deps, { timing: fast });

    await worker.ready;

    expect(deps.outboxRepository.claimBatch).toHaveBeenCalledWith(
      expect.any(Number),
      defaultWorkerTiming.outboxLeaseMs / 1_000,
    );
    await vi.waitFor(() => {
      expect(keys).toEqual(
        expect.arrayContaining([
          "outbox",
          "imports",
          "schedule:retention-cleanup",
        ]),
      );
    });
    // Run on start: retention's slot is 03:17, whatever the time now.
    expect(deps.schedules[0]?.run).toHaveBeenCalledTimes(1);
    expect(logged).toContainEqual(
      expect.objectContaining({ event: "worker.ready" }),
    );
    await expect(worker.stop()).resolves.toEqual({ drained: true });
  });

  test("keeps ticking", async () => {
    const { deps } = dependencies();
    const worker = startJobWorker(deps, { timing: fast });
    await worker.ready;

    await vi.waitFor(() =>
      expect(
        vi.mocked(deps.outboxRepository.claimBatch).mock.calls.length,
      ).toBeGreaterThanOrEqual(3),
    );
    await worker.stop();
  });

  test("is not ready while the database refuses it, and says why without the message", async () => {
    const claimBatch = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("connect ECONNREFUSED postgres://secret@host"),
      )
      .mockResolvedValue([]);
    const { deps, logged } = dependencies({
      outboxRepository: { claimBatch, releaseClaim: vi.fn() },
    });
    let ready = false;
    const worker = startJobWorker(deps, { timing: fast });
    void worker.ready.then(() => {
      ready = true;
    });

    await vi.waitFor(() => expect(claimBatch).toHaveBeenCalledTimes(1));
    expect(ready).toBe(false);
    await worker.ready;
    expect(claimBatch.mock.calls.length).toBeGreaterThanOrEqual(2);

    const failure = logged.find(
      (entry) => entry.event === "worker.tick_failed",
    );
    expect(failure?.fields).toEqual({
      taskId: "outbox",
      errorCode: "tick_failed",
    });
    expect(JSON.stringify(logged)).not.toContain("secret");
    await worker.stop();
  });

  test("on stop, claims nothing more and waits for the tick in flight", async () => {
    const routing = deferred();
    const entered = deferred();
    const claimBatch = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "outbox-1", eventId: "e", attemptCount: 1 },
      ])
      .mockResolvedValue([]);
    const { deps, logged } = dependencies({
      outboxRepository: { claimBatch, releaseClaim: vi.fn() },
      createHandlers: () => ({
        ...idleHandlers,
        "outbox-delivery": async () => {
          entered.resolve();
          await routing.promise;
        },
      }),
    });
    const worker = startJobWorker(deps, { timing: fast });
    await entered.promise;

    const stopping = worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const claimsAtStop = claimBatch.mock.calls.length;
    routing.resolve();

    await expect(stopping).resolves.toEqual({ drained: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(claimBatch.mock.calls.length).toBe(claimsAtStop);
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "worker.stopped",
        fields: expect.objectContaining({ status: "drained" }),
      }),
    );
  });

  test("hands outbox-delivery its payload and the claim's lease, never an owner", async () => {
    const claimBatch = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "outbox-3",
          eventId: "e",
          organizationId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1",
          attemptCount: 1,
          leaseId: "0b9e2c56-3f0e-4c38-9d55-6c1f3a1c9e11",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      ])
      .mockResolvedValue([]);
    const delivered = vi.fn(async () => undefined);
    const { deps } = dependencies({
      outboxRepository: { claimBatch, releaseClaim: vi.fn() },
      createHandlers: () => ({ ...idleHandlers, "outbox-delivery": delivered }),
    });
    const worker = startJobWorker(deps, { timing: fast });

    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    expect(delivered).toHaveBeenCalledWith(
      { outboxId: "outbox-3" },
      { kind: "lease", leaseId: "0b9e2c56-3f0e-4c38-9d55-6c1f3a1c9e11" },
    );
    await worker.stop();
  });

  test("on stop, gives up on work that outlasts the drain, and says so", async () => {
    const { deps, logged } = dependencies({
      schedules: [
        {
          id: "retention-cleanup",
          cron: "17 3 * * *",
          run: () => new Promise<never>(() => undefined),
        },
      ],
    });
    const worker = startJobWorker(deps, {
      timing: { ...fast, outboxJobTimeoutMs: 50, drainMs: 100 },
    });
    await worker.ready;

    await expect(worker.stop()).resolves.toEqual({ drained: false });
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "worker.stopped",
        fields: expect.objectContaining({ status: "drain_timed_out" }),
      }),
    );
  });

  test("stops accepting children once stopping, leaving them to the repair schedules", async () => {
    const entered = deferred();
    const routing = deferred();
    let enqueued: Promise<{ id: string }> | undefined;
    const claimBatch = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "outbox-2", eventId: "e", attemptCount: 1 },
      ])
      .mockResolvedValue([]);
    const email = vi.fn(async () => undefined);
    const { deps } = dependencies({
      outboxRepository: { claimBatch, releaseClaim: vi.fn() },
      createHandlers: (runner) => ({
        ...idleHandlers,
        "email-delivery": email,
        "outbox-delivery": async () => {
          entered.resolve();
          await routing.promise;
          enqueued = runner.enqueue("email-delivery", { intentId: "late" });
          await enqueued;
        },
      }),
    });
    const worker = startJobWorker(deps, { timing: fast });
    await entered.promise;

    const stopping = worker.stop();
    routing.resolve();
    await stopping;

    await expect(enqueued).resolves.toEqual({
      id: expect.stringMatching(/^deferred:/u),
    });
    expect(email).not.toHaveBeenCalled();
  });
});
