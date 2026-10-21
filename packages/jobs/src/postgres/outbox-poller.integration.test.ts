import { randomUUID } from "node:crypto";

import {
  createOutboxRepository,
  createWorkerStorages,
  domainEvents,
  organizations,
  outbox,
  WORKER_DATABASE_URL_VARIABLES,
} from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// The package's own module, which registers the worker root the holder fills
// from (`index.ts`), as each Trigger.dev task module loads it. This file
// installs its storages before anything asks, so the root is not asked.
import "../index.js";
import {
  inUnit,
  useWorkerStorages,
  workerStorages,
} from "../worker-storages.js";
import {
  createOutboxPoller,
  type LeaseSettlement,
  outboxRetryDelayMs,
} from "./outbox-poller.js";

/**
 * The environment the worker's storages are built from: the driver and the
 * three variables as this process holds them, and no other name. In the
 * worker-role lane the three are set, and since I.2b's b6 a worker storage
 * refuses its first use in an environment that names `DATABASE_URL`, which
 * names the owner here, or any other owner-capable name (ruling 217 item
 * 1); in the integration project they are unset, and the test exception is
 * read instead.
 */
function workerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "REQUESTPORT_DATABASE_DRIVER",
      ...Object.values(WORKER_DATABASE_URL_VARIABLES),
    ].map((name) => [name, process.env[name]]),
  );
}

/*
 * The poller claims and releases on the dispatcher's storage, and the body
 * settles in a unit on the processor's (manifest-i2.md §5.1). In the
 * integration project the worker variables are unset, which the worker root
 * refuses (ruling 214 item 1), so this file installs storages of its own on
 * the test exception (item 1(b)), over the storage the wiring builds for the
 * worker surface (`rootStorageFromEnv("worker")`, over `DATABASE_URL`, the
 * owner): both are that storage's handle. The worker-role lane
 * (vitest.worker-role.config.ts) runs this file again with them set, where
 * the exception is not read, as the three worker logins (Done when 9). The
 * seeds and reads use that storage, the owner in both.
 */
const rootStorage = rootStorageFromEnv("worker");
useWorkerStorages(
  createWorkerStorages(workerEnvironment(), {
    unbound: "test",
    storage: rootStorage,
  }),
);
const repository = createOutboxRepository(workerStorages().dispatcher);
const organizationId = randomUUID();

/** What a routing body does last: complete the row under its claim. */
const complete = (outboxId: string, settlement: LeaseSettlement) =>
  inUnit(organizationId, (database) =>
    createOutboxRepository(database).markCompleted(outboxId, settlement),
  );
const created: string[] = [];

async function pendingOutboxRow(attemptCount = 0) {
  const eventId = randomUUID();
  await rootStorage.db.insert(domainEvents).values({
    id: eventId,
    organizationId,
    aggregateType: "organization",
    aggregateId: organizationId,
    aggregateVersion: created.length + 1,
    type: "retention.hold_changed.v1",
    schemaVersion: 1,
    actor: { type: "system", id: "track-c-test" },
    correlationId: `corr_${eventId}`,
    causationId: `cause_${eventId}`,
    data: { category: "all", status: "active" },
  });
  const [row] = await rootStorage.db
    .insert(outbox)
    .values({ eventId, attemptCount })
    .returning({ id: outbox.id });
  if (!row) throw new Error("outbox row was not created");
  created.push(row.id);
  return row.id;
}

async function stateOf(id: string) {
  const [row] = await rootStorage.db
    .select({
      state: outbox.state,
      attemptCount: outbox.attemptCount,
      leaseOwner: outbox.leaseOwner,
      // Both measured from the write that set them, which stamps
      // `updated_at` in the same statement, so a slow host cannot skew them.
      leaseSeconds: sql<number>`extract(epoch from (${outbox.leaseExpiresAt} - ${outbox.updatedAt}))::float8`,
      delaySeconds: sql<number>`extract(epoch from (${outbox.nextAttemptAt} - ${outbox.updatedAt}))::float8`,
    })
    .from(outbox)
    .where(eq(outbox.id, id));
  return row;
}

function poller(
  deliver: (outboxId: string, settlement: LeaseSettlement) => Promise<unknown>,
  options: { repository?: typeof repository; batchSize?: number } = {},
) {
  return createOutboxPoller({
    repository: options.repository ?? repository,
    deliver,
    batchSize: options.batchSize ?? 10,
    leaseMs: 60_000,
    jobTimeoutMs: 5_000,
  });
}

/** Only this file's rows: the poller claims whatever is eligible. */
const ours = (ids: string[]) => ids.filter((id) => created.includes(id));

beforeAll(async () => {
  await rootStorage.db.insert(organizations).values({
    id: organizationId,
    name: "Track C poller",
    slug: `track-c-${organizationId}`,
    status: "active",
  });
  // Every claim below takes whatever outbox rows are eligible, so a row some
  // other suite left pending in this database would be claimed too, and the
  // assertions would be about the wrong rows. Say so rather than proceed.
  const [foreign] = await rootStorage.db
    .select({ count: sql<number>`count(*)::integer` })
    .from(outbox)
    .where(inArray(outbox.state, ["pending", "leased", "accepted"]));
  expect(
    foreign?.count,
    "this database already holds claimable outbox rows",
  ).toBe(0);
});

// Domain events are append-only (`requestport_reject_append_only_mutation`),
// so this file's organisation and events stay behind. What must not stay
// behind is a claimable row: every one this file made is left completed or
// dead-lettered, and this makes sure of it if a case failed half-way.
afterAll(async () => {
  await workerStorages().close();
  if (created.length === 0) return;
  await rootStorage.db
    .update(outbox)
    .set({ state: "completed", leaseOwner: null, leaseExpiresAt: null })
    .where(
      and(
        inArray(outbox.id, created),
        inArray(outbox.state, ["pending", "leased", "accepted"]),
      ),
    );
});

describe("the Postgres worker's outbox poller", () => {
  test("claims a pending row under its lease and hands it to routing, which completes it", async () => {
    const id = await pendingOutboxRow();
    const seen: Array<Awaited<ReturnType<typeof stateOf>>> = [];
    const deliver = vi.fn(
      async (outboxId: string, settlement: LeaseSettlement) => {
        seen.push(await stateOf(outboxId));
        await complete(outboxId, settlement);
      },
    );

    const report = await poller(deliver).drainOnce();

    expect(ours(deliver.mock.calls.map(([outboxId]) => outboxId))).toEqual([
      id,
    ]);
    expect(report).toMatchObject({ claimed: 1, routed: 1 });
    // While routing ran, the row was this claim's, under the lease id the
    // claim function generated and handed to routing, leased for about a
    // minute, on its first attempt.
    const settlement = deliver.mock.calls[0]?.[1];
    expect(settlement?.kind).toBe("lease");
    expect(seen[0]).toMatchObject({
      state: "leased",
      attemptCount: 1,
      leaseOwner: settlement?.leaseId,
    });
    expect(seen[0]?.leaseSeconds).toBeCloseTo(60, 1);
    expect(await stateOf(id)).toMatchObject({ state: "completed" });
  });

  test("does not hand a row to a second poller while the first holds its lease", async () => {
    const id = await pendingOutboxRow();
    let release: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = poller(async (outboxId, settlement) => {
      entered();
      await inside;
      await complete(outboxId, settlement);
    }).drainOnce();
    await started;

    const second = vi.fn(async () => undefined);
    await expect(poller(second).drainOnce()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(second).not.toHaveBeenCalled();

    release();
    await first;
    expect(await stateOf(id)).toMatchObject({ state: "completed" });
  });

  test("puts a failed routing back with the outbox-delivery task's backoff", async () => {
    const id = await pendingOutboxRow();

    const report = await poller(async () => {
      throw new Error("routing failed");
    }).drainOnce();

    expect(report).toMatchObject({ claimed: 1, retried: 1 });
    const row = await stateOf(id);
    expect(row).toMatchObject({
      state: "pending",
      attemptCount: 1,
      leaseOwner: null,
    });
    // The first retry waits a second, as Trigger.dev's policy for this task
    // did (minTimeoutInMs 1000). The repository never waits less than that.
    expect(row?.delaySeconds).toBeCloseTo(1, 1);

    await rootStorage.db
      .update(outbox)
      .set({ state: "completed" })
      .where(eq(outbox.id, id));
  });

  test("dead-letters a row whose fifth attempt fails, as the outbox-delivery task did", async () => {
    const id = await pendingOutboxRow(4);

    const report = await poller(async () => {
      throw new Error("routing failed again");
    }).drainOnce();

    expect(report).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(await stateOf(id)).toMatchObject({
      state: "dead_letter",
      attemptCount: 5,
      leaseOwner: null,
    });
  });

  test("stops waiting for a routing that overruns, and leaves the row leased rather than retrying it", async () => {
    const id = await pendingOutboxRow();
    let finish: () => void = () => undefined;
    const overrunning = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const report = await createOutboxPoller({
      repository,
      deliver: () => overrunning,
      batchSize: 10,
      leaseMs: 60_000,
      jobTimeoutMs: 200,
    }).drainOnce();

    expect(report).toMatchObject({ claimed: 1, timedOut: 1, retried: 0 });
    // Retrying it now would make it claimable while the first routing may
    // still be running. The lease decides when it may be claimed again.
    expect(await stateOf(id)).toMatchObject({ state: "leased" });

    finish();
    await rootStorage.db
      .update(outbox)
      .set({ state: "completed", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(outbox.id, id));
  });
});

describe("two dispatcher sessions draining at once (Done when 9)", () => {
  test("never share a row", async () => {
    const ids: string[] = [];
    // One at a time: each row's event takes the next aggregate version.
    for (let row = 0; row < 6; row += 1) ids.push(await pendingOutboxRow());
    // A second storage from the same environment: another pool, so another
    // session — the owner's pool unset, a second dispatcher pool in the lane.
    const other = createWorkerStorages(workerEnvironment(), {
      unbound: "test",
      storage: rootStorage,
      poolSizes: { dispatcher: 1 },
    });
    try {
      const routed: string[][] = [[], []];
      const route =
        (into: string[]) =>
        async (outboxId: string, settlement: LeaseSettlement) => {
          into.push(outboxId);
          // Hold each row long enough for the other drain to be claiming.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await complete(outboxId, settlement);
        };
      const [first, second] = await Promise.all([
        poller(route(routed[0] as string[]), { batchSize: 3 }).drainOnce(),
        poller(route(routed[1] as string[]), {
          batchSize: 3,
          repository: createOutboxRepository(other.dispatcher),
        }).drainOnce(),
      ]);

      const all = [...(routed[0] ?? []), ...(routed[1] ?? [])];
      expect(new Set(all).size).toBe(all.length);
      expect(ours(all).sort()).toEqual([...ids].sort());
      expect((first?.claimed ?? 0) + (second?.claimed ?? 0)).toBe(6);
      for (const id of ids) {
        expect(await stateOf(id)).toMatchObject({
          state: "completed",
          attemptCount: 1,
        });
      }
    } finally {
      await other.close();
    }
  });
});

describe("the outbox retry backoff", () => {
  test("doubles from a second to a minute, like the outbox-delivery task's policy", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(outboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });
});
