import { afterEach, describe, expect, test, vi } from "vitest";

import type { JobHandlers } from "../catalogue.js";
import { createPostgresJobRunner, type RunnerEvent } from "./runner.js";

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handlers(overrides: Partial<JobHandlers> = {}): JobHandlers {
  const idle = async () => undefined;
  return {
    "outbox-delivery": idle,
    "webhook-delivery": idle,
    "email-delivery": idle,
    "slack-question-delivery": idle,
    "slack-message-update": idle,
    "slack-connection-test": idle,
    "legacy-import-analyze": idle,
    "legacy-import-apply": idle,
    ...overrides,
  };
}

function setup(
  overrides: Partial<JobHandlers>,
  options: { concurrency?: number; jobTimeoutMs?: number } = {},
) {
  const events: RunnerEvent[] = [];
  const runner = createPostgresJobRunner({
    concurrency: options.concurrency ?? 2,
    jobTimeoutMs: options.jobTimeoutMs ?? 60_000,
    onEvent: (event) => events.push(event),
  });
  runner.bind(handlers(overrides));
  return { runner, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the Postgres worker's in-process job runner", () => {
  test("is the postgres runner", () => {
    expect(setup({}).runner.kind).toBe("postgres");
  });

  test("accepts a job before it finishes, then runs it with its payload", async () => {
    const gate = deferred();
    const email = vi.fn(async () => gate.promise);
    const { runner } = setup({ "email-delivery": email });

    const accepted = await runner.enqueue("email-delivery", {
      intentId: "intent-1",
    });

    expect(accepted.id).toEqual(expect.any(String));
    await vi.waitFor(() =>
      expect(email).toHaveBeenCalledWith({ intentId: "intent-1" }),
    );
    expect(runner.stats()).toEqual({ queued: 0, running: 1 });
    gate.resolve();
    await runner.drain(1_000);
    expect(runner.stats()).toEqual({ queued: 0, running: 0 });
  });

  test("runs no more than its concurrency at once, and queues the rest", async () => {
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;
    const webhook = vi.fn(async () => {
      const gate = gates[started];
      started += 1;
      await gate?.promise;
    });
    const { runner } = setup(
      { "webhook-delivery": webhook },
      { concurrency: 2 },
    );

    for (const deliveryId of ["a", "b", "c"]) {
      await runner.enqueue("webhook-delivery", { deliveryId });
    }

    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(2));
    expect(runner.stats()).toEqual({ queued: 1, running: 2 });

    gates[0]?.resolve();
    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(3));
    gates[1]?.resolve();
    gates[2]?.resolve();
    await expect(runner.drain(1_000)).resolves.toBe(true);
  });

  test("starts a keyed job once while one with the same key is queued or running", async () => {
    const gate = deferred();
    const email = vi.fn(async () => gate.promise);
    const { runner, events } = setup({ "email-delivery": email });

    const first = await runner.enqueue(
      "email-delivery",
      { intentId: "i" },
      { idempotencyKey: "email:i" },
    );
    const second = await runner.enqueue(
      "email-delivery",
      { intentId: "i" },
      { idempotencyKey: "email:i" },
    );

    expect(second.id).toBe(first.id);
    gate.resolve();
    await runner.drain(1_000);
    expect(email).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "job.duplicate", job: "email-delivery" }),
    );

    // Once it has finished, the claim in its own table is what decides; the
    // runner starts it again.
    await runner.enqueue(
      "email-delivery",
      { intentId: "i" },
      { idempotencyKey: "email:i" },
    );
    await runner.drain(1_000);
    expect(email).toHaveBeenCalledTimes(2);
  });

  test("records a failed job and carries on, without failing the job that started it", async () => {
    const slack = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider_delivery_failed"))
      .mockResolvedValueOnce(undefined);
    const { runner, events } = setup({ "slack-question-delivery": slack });

    await expect(
      runner.enqueue("slack-question-delivery", { intentId: "x" }),
    ).resolves.toEqual({ id: expect.any(String) });
    await runner.enqueue("slack-question-delivery", { intentId: "y" });
    await runner.drain(1_000);

    expect(slack).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "job.failed",
        job: "slack-question-delivery",
        errorMessage: "provider_delivery_failed",
      }),
    );
  });

  test("stops waiting for a job that outlives its timeout, and frees its slot", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const webhook = vi.fn(async () => never);
    const email = vi.fn(async () => undefined);
    const { runner, events } = setup(
      { "webhook-delivery": webhook, "email-delivery": email },
      { concurrency: 1, jobTimeoutMs: 5_000 },
    );

    await runner.enqueue("webhook-delivery", { deliveryId: "stuck" });
    await runner.enqueue("email-delivery", { intentId: "next" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(email).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "job.timed_out",
        job: "webhook-delivery",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(email).toHaveBeenCalledWith({ intentId: "next" });
  });

  test("once draining, defers new jobs to the repair schedules instead of starting them", async () => {
    const gate = deferred();
    const webhook = vi.fn(async () => gate.promise);
    const email = vi.fn(async () => undefined);
    const { runner, events } = setup({
      "webhook-delivery": webhook,
      "email-delivery": email,
    });

    await runner.enqueue("webhook-delivery", { deliveryId: "w" });
    await vi.waitFor(() => expect(webhook).toHaveBeenCalled());
    runner.stopAccepting();

    // A job still in flight may still ask for another.
    await expect(
      runner.enqueue("email-delivery", { intentId: "late" }),
    ).resolves.toEqual({ id: expect.stringMatching(/^deferred:/u) });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "job.deferred", job: "email-delivery" }),
    );

    const drained = runner.drain(1_000);
    gate.resolve();
    await expect(drained).resolves.toBe(true);
    expect(email).not.toHaveBeenCalled();
  });

  test("says when a drain ran out of time with work still running", async () => {
    vi.useFakeTimers();
    const { runner } = setup({
      "slack-message-update": async () => new Promise<never>(() => undefined),
    });
    await runner.enqueue("slack-message-update", { operationId: "op" });
    runner.stopAccepting();

    const drained = runner.drain(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(drained).resolves.toBe(false);
  });

  test("really waits when a job asks to sleep, and does not before a retry", async () => {
    vi.useFakeTimers();
    const { runner } = setup({});
    let slept = false;

    const sleeping = runner.sleep(3).then(() => {
      slept = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(slept).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(slept).toBe(true);

    // The job's own table holds the retry time; the repair schedule picks it
    // up, so there is nothing to wait for in the process.
    await expect(runner.waitBeforeRetry(600)).resolves.toBeUndefined();
  });

  test("leaves a committed outbox row for the poller rather than claiming it", async () => {
    const { runner } = setup({});

    await expect(
      runner.dispatchOutbox("outbox-1", "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1"),
    ).resolves.toEqual({
      accepted: false,
    });
  });

  test.each([
    ["outbox-delivery", { outboxId: "outbox-1" }],
    ["legacy-import-analyze", { dispatchId: "dispatch-1", attemptCount: 1 }],
    ["legacy-import-apply", { dispatchId: "dispatch-1", attemptCount: 1 }],
  ] as const)(
    "refuses to start %s, which settles under the claim that starts it (manifest-i2.md §5.1)",
    async (name, payload) => {
      const settled = vi.fn(async () => undefined);
      const { runner } = setup({ [name]: settled });

      await expect(runner.enqueue(name, payload as never)).rejects.toThrowError(
        /settles under the claim/u,
      );
      expect(runner.stats()).toEqual({ queued: 0, running: 0 });
      expect(settled).not.toHaveBeenCalled();
    },
  );

  test("refuses to run before it has been given its handlers", async () => {
    const runner = createPostgresJobRunner({ concurrency: 1, jobTimeoutMs: 1 });

    await expect(
      runner.enqueue("email-delivery", { intentId: "i" }),
    ).rejects.toThrowError(/handlers/u);
  });
});
