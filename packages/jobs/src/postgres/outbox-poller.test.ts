import { describe, expect, test, vi } from "vitest";

import { createOutboxPoller, type OutboxPollerEvent } from "./outbox-poller.js";

/*
 * What the outbox poller does with function 3's answer when a body throws
 * (manifest-i2.md §5.1, function 3): a release refused, because the lease
 * ran out before the body failed, is counted and reported as refused, not as
 * a retry or a dead letter, and nothing else is done to the row, which is
 * claimed again when due. The release itself is tested in packages/db
 * (worker-row-security.integration.test.ts).
 */

const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";

function drain(released: boolean, attemptCount: number) {
  const repository = {
    claimBatch: vi.fn(async (_limit?: number, _leaseSeconds?: number) => [
      {
        id: "outbox-1",
        eventId: "event-1",
        organizationId,
        attemptCount,
        leaseId: "lease-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    ]),
    releaseClaim: vi.fn(
      async (
        _id: string,
        _leaseId: string,
        _deadLetter: boolean,
        _delayMs: number,
      ) => released,
    ),
  };
  const events: OutboxPollerEvent[] = [];
  const report = createOutboxPoller({
    repository,
    deliver: async () => {
      throw new Error("routing failed");
    },
    batchSize: 1,
    leaseMs: 60_000,
    jobTimeoutMs: 1_000,
    onEvent: (event) => events.push(event),
  }).drainOnce();
  return { repository, events, report };
}

describe("the Postgres worker's outbox poller, when a body throws", () => {
  test("a release refused is counted as refused, not retried, and reported", async () => {
    const { repository, events, report } = drain(false, 2);

    expect(await report).toEqual({
      claimed: 1,
      routed: 0,
      retried: 0,
      deadLettered: 0,
      timedOut: 0,
      releaseRefused: 1,
    });
    expect(repository.releaseClaim).toHaveBeenCalledWith(
      "outbox-1",
      "lease-1",
      false,
      2_000,
    );
    expect(events).toEqual([
      { type: "outbox.release_refused", outboxId: "outbox-1", attempt: 2 },
    ]);
  });

  test("a refused release on the last attempt is not counted as a dead letter", async () => {
    const { repository, events, report } = drain(false, 5);

    expect(await report).toMatchObject({ deadLettered: 0, releaseRefused: 1 });
    expect(repository.releaseClaim).toHaveBeenCalledWith(
      "outbox-1",
      "lease-1",
      true,
      16_000,
    );
    expect(events).toEqual([
      { type: "outbox.release_refused", outboxId: "outbox-1", attempt: 5 },
    ]);
  });

  test("a release that holds is a retry, or on the last attempt a dead letter", async () => {
    const retried = drain(true, 2);
    expect(await retried.report).toMatchObject({
      retried: 1,
      releaseRefused: 0,
    });
    expect(retried.events).toEqual([
      {
        type: "outbox.retry_scheduled",
        outboxId: "outbox-1",
        attempt: 2,
        delayMs: 2_000,
      },
    ]);

    const exhausted = drain(true, 5);
    expect(await exhausted.report).toMatchObject({
      deadLettered: 1,
      releaseRefused: 0,
    });
    expect(exhausted.events).toEqual([
      { type: "outbox.attempts_exhausted", outboxId: "outbox-1", attempt: 5 },
    ]);
  });
});
