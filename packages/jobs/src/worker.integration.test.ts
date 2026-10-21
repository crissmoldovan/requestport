import { randomUUID } from "node:crypto";

import {
  createAdvisoryExclusiveRunner,
  createImportTaskDispatchRepository,
  createOutboxRepository,
  createWorkerStorages,
  domainEvents,
  organizations,
  outbox,
  WORKER_DATABASE_URL_VARIABLES,
} from "@requestport/db";
import { rootStorageFromEnv } from "@requestport/db/wiring";
import { and, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createJobHandlers } from "./catalogue.js";
import { defaultWorkerTiming } from "./timing.js";
import {
  type JobWorker,
  POSTGRES_WORKER_POOL_SIZES,
  startJobWorker,
} from "./worker.js";
import { workerSettingsFromRoot } from "./worker-root.js";
import {
  useWorkerSettings,
  useWorkerStorages,
  workerStorages,
} from "./worker-storages.js";

/*
 * The storage the wiring builds for the worker surface
 * (`rootStorageFromEnv("worker")`, over `DATABASE_URL`), the owner in both
 * projects, which the worker root itself no longer asks for: the seeds and
 * reads use it, and the worker's three storages are its handle in the
 * integration project, where the worker variables are unset (the test
 * exception, below).
 */
const rootStorage = rootStorageFromEnv("worker");
const organizationId = randomUUID();
const created: string[] = [];
let aggregateVersion = 0;
const workers: JobWorker[] = [];

async function committedEvent() {
  const eventId = randomUUID();
  await rootStorage.db.insert(domainEvents).values({
    id: eventId,
    organizationId,
    aggregateType: "organization",
    aggregateId: organizationId,
    aggregateVersion: ++aggregateVersion,
    // Registered, with no webhook subscription or notification behind it,
    // so routing it touches only the outbox.
    type: "retention.hold_changed.v1",
    schemaVersion: 1,
    actor: { type: "system", id: "track-c-test" },
    correlationId: `corr_${eventId}`,
    causationId: `cause_${eventId}`,
    data: { category: "all", status: "active" },
  });
  const [row] = await rootStorage.db
    .insert(outbox)
    .values({ eventId })
    .returning({ id: outbox.id });
  if (!row) throw new Error("outbox row was not created");
  created.push(row.id);
  return row.id;
}

async function states(ids: string[]) {
  const rows = await rootStorage.db
    .select({
      id: outbox.id,
      state: outbox.state,
      attemptCount: outbox.attemptCount,
    })
    .from(outbox)
    .where(inArray(outbox.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function until(condition: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function worker(routed: string[]) {
  const started = startJobWorker(
    {
      // As cli.ts builds it: claims and locks on the dispatcher's storage,
      // which in the integration project is rootStorage's handle on the test
      // exception (beforeAll), and in the worker-role lane the dispatcher's
      // login.
      outboxRepository: createOutboxRepository(workerStorages().dispatcher),
      importTaskDispatchRepository: createImportTaskDispatchRepository(
        workerStorages().dispatcher,
      ),
      createHandlers: (runner) => {
        const handlers = createJobHandlers(runner);
        return {
          ...handlers,
          "outbox-delivery": async (payload, settlement) => {
            routed.push(payload.outboxId);
            return handlers["outbox-delivery"](payload, settlement);
          },
        };
      },
      // The schedules touch every table; these cases are about the outbox.
      schedules: [],
      runExclusive: createAdvisoryExclusiveRunner(workerStorages().dispatcher),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    { timing: { ...defaultWorkerTiming, tickMs: 250 } },
  );
  workers.push(started);
  return started;
}

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

beforeAll(async () => {
  // The storages cli.ts builds through the worker root
  // (`workerStoragesFromRoot`), with its pool sizes: the three logins in the
  // worker-role lane. In the integration project the worker variables are
  // unset, which the root refuses, so this asks for the test exception
  // (ruling 214 item 1(b)) over that storage, the owner; with the three set,
  // the exception is not read.
  useWorkerStorages(
    createWorkerStorages(workerEnvironment(), {
      unbound: "test",
      storage: rootStorage,
      poolSizes: POSTGRES_WORKER_POOL_SIZES,
    }),
  );
  // And the settings cli.ts installs beside them, from the worker root.
  useWorkerSettings(workerSettingsFromRoot());
  await rootStorage.db.insert(organizations).values({
    id: organizationId,
    name: "Track C worker",
    slug: `track-c-worker-${organizationId}`,
    status: "active",
  });
  const [claimable] = await rootStorage.db
    .select({ count: sql<number>`count(*)::integer` })
    .from(outbox)
    .where(inArray(outbox.state, ["pending", "leased", "accepted"]));
  expect(
    claimable?.count,
    "this database already holds claimable outbox rows",
  ).toBe(0);
});

afterAll(async () => {
  await Promise.all(workers.map((started) => started.stop()));
  await workerStorages().close();
  useWorkerStorages(undefined);
  useWorkerSettings(undefined);
  // Domain events are append-only, so the organisation stays; no row this
  // file made may stay claimable.
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

describe("the requestport-jobs worker against PostgreSQL", () => {
  test("routes a committed event to completion with no Trigger.dev anywhere", async () => {
    const routed: string[] = [];
    const started = worker(routed);
    await started.ready;

    const id = await committedEvent();
    await until(
      async () => (await states([id])).get(id)?.state === "completed",
      25_000,
    );

    expect((await states([id])).get(id)).toMatchObject({
      state: "completed",
      attemptCount: 1,
    });
    expect(routed.filter((routedId) => routedId === id)).toEqual([id]);
    await expect(started.stop()).resolves.toEqual({ drained: true });
  });

  test("two workers on one database route each row once between them", async () => {
    const routedByA: string[] = [];
    const routedByB: string[] = [];
    const a = worker(routedByA);
    const b = worker(routedByB);
    await Promise.all([a.ready, b.ready]);

    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => committedEvent()));
    await until(async () => {
      const current = await states(ids);
      return ids.every((id) => current.get(id)?.state === "completed");
    }, 25_000);

    const routed = [...routedByA, ...routedByB].filter((id) =>
      ids.includes(id),
    );
    expect(routed.sort()).toEqual([...ids].sort());
    for (const row of (await states(ids)).values()) {
      expect(row.attemptCount).toBe(1);
    }
    await Promise.all([a.stop(), b.stop()]);
  });
});
