import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The web's dispatch of committed rows (manifest-i2.md §2.4; track-i2.md D5).
 * Each claim and acceptance runs through a repository bound to the command's
 * organisation, which the caller now passes. The bus swallows a failed
 * dispatch and the repair picks the row up later, so what is asserted here
 * is that dispatch happened — claimed, started, accepted — and through a
 * repository built for that organisation, not only that nothing threw.
 */

const recorded = vi.hoisted(() => ({
  bound: [] as Array<[string, string]>,
  calls: [] as string[],
  started: [] as Array<[string, unknown]>,
}));

vi.mock("@requestport/db", () => {
  const bound = (kind: string) => (organizationId: string) => {
    recorded.bound.push([kind, organizationId]);
    return {
      // One outbox row per event, named after it; one per correlation.
      idsForEvents: async (eventIds: string[]) => {
        recorded.calls.push(`${kind}.idsForEvents ${eventIds.join(",")}`);
        return eventIds.map((id) => ({ id: `outbox-of-${id}` }));
      },
      idsForCorrelation: async (correlationId: string) => {
        recorded.calls.push(`${kind}.idsForCorrelation ${correlationId}`);
        return [{ id: `outbox-of-${correlationId}` }];
      },
      claimOne: async (id: string, owner: string) => {
        recorded.calls.push(`${kind}.claimOne ${id} ${owner.split(":")[0]}`);
        return kind === "outbox"
          ? { id, eventId: "event-1", attemptCount: 1 }
          : { id, taskKind: "analyze", taskPayload: {}, attemptCount: 1 };
      },
      markAccepted: async (id: string, _owner: string, runId: string) => {
        recorded.calls.push(`${kind}.markAccepted ${id} ${runId}`);
        // The acceptance held (it answers false once the lease has expired).
        return true;
      },
    };
  };
  const unbound = {
    claimOne: () => {
      throw new Error("an unbound repository was used for a committed row");
    },
    markAccepted: () => {
      throw new Error("an unbound repository was used for a committed row");
    },
  };
  return {
    boundOutboxRepository: bound("outbox"),
    boundImportTaskDispatchRepository: bound("import"),
    createOutboxRepository: () => unbound,
    createImportTaskDispatchRepository: () => unbound,
  };
});

// The web root, whose storage the dispatches and their reads are built over
// when they run (Plan 13, G.3). The bound fakes above ignore its handle.
vi.mock("./server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: async (taskId: string, payload: unknown) => {
      recorded.started.push([taskId, payload]);
      return { id: `run_${recorded.started.length}` };
    },
  },
  idempotencyKeys: { create: async (key: string) => key },
}));

vi.mock("@requestport/config", () => ({
  createLogger: () => ({ info() {}, warn() {} }),
}));

const {
  dispatchCommittedCorrelation,
  dispatchCommittedEvents,
  dispatchCommittedOutbox,
  dispatchImportTask,
} = await import("./trigger-client.js");

beforeEach(() => {
  vi.stubEnv("REQUESTPORT_JOB_RUNNER", undefined);
  recorded.bound.length = 0;
  recorded.calls.length = 0;
  recorded.started.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dispatching a committed row, bound to its organisation (D5)", () => {
  test("an outbox row is claimed, started and accepted through a repository bound to the organisation", async () => {
    await expect(dispatchCommittedOutbox("outbox-1", "org-a")).resolves.toEqual(
      { accepted: true, runId: "run_1" },
    );

    expect(recorded.bound).toContainEqual(["outbox", "org-a"]);
    expect(
      recorded.bound.every(([, organization]) => organization === "org-a"),
    ).toBe(true);
    expect(recorded.calls).toEqual([
      "outbox.claimOne outbox-1 web",
      "outbox.markAccepted outbox-1 run_1",
    ]);
    expect(recorded.started).toEqual([
      ["outbox-delivery", { outboxId: "outbox-1" }],
    ]);
  });

  test("an import dispatch is claimed, started and accepted through a repository bound to the organisation", async () => {
    await expect(dispatchImportTask("dispatch-1", "org-b")).resolves.toEqual({
      accepted: true,
      runId: "run_1",
    });

    expect(recorded.bound).toContainEqual(["import", "org-b"]);
    expect(
      recorded.bound.every(([, organization]) => organization === "org-b"),
    ).toBe(true);
    expect(recorded.calls).toEqual([
      "import.claimOne dispatch-1 web-import",
      "import.markAccepted dispatch-1 run_1",
    ]);
    expect(recorded.started).toEqual([
      ["legacy-import-analyze", { dispatchId: "dispatch-1", attemptCount: 1 }],
    ]);
  });

  test("each call binds its own organisation", async () => {
    await dispatchCommittedOutbox("outbox-1", "org-a");
    await dispatchCommittedOutbox("outbox-2", "org-b");

    expect(recorded.bound.filter(([kind]) => kind === "outbox")).toEqual([
      ["outbox", "org-a"],
      ["outbox", "org-b"],
    ]);
  });
});

describe("dispatching what a command committed, by the organisation of each row (D5)", () => {
  test("a command's events: their rows are read and dispatched bound to the events' organisation", async () => {
    await dispatchCommittedEvents([
      { id: "event-1", organizationId: "org-a" },
      { id: "event-2", organizationId: "org-a" },
    ]);

    expect(recorded.bound).toEqual([
      ["outbox", "org-a"],
      ["outbox", "org-a"],
      ["import", "org-a"],
      ["outbox", "org-a"],
      ["import", "org-a"],
    ]);
    expect(recorded.calls).toEqual([
      "outbox.idsForEvents event-1,event-2",
      "outbox.claimOne outbox-of-event-1 web",
      "outbox.claimOne outbox-of-event-2 web",
      "outbox.markAccepted outbox-of-event-1 run_1",
      "outbox.markAccepted outbox-of-event-2 run_2",
    ]);
  });

  test("events of two organisations are each read and dispatched bound to their own", async () => {
    // D5 says one command's events share one organisation. This does not
    // rely on it: each organisation's events are read under its own binding.
    await dispatchCommittedEvents([
      { id: "event-a", organizationId: "org-a" },
      { id: "event-b", organizationId: "org-b" },
    ]);

    const reads = recorded.calls.filter((call) =>
      call.startsWith("outbox.idsForEvents"),
    );

    expect(reads).toEqual([
      "outbox.idsForEvents event-a",
      "outbox.idsForEvents event-b",
    ]);
    expect(recorded.bound.filter(([kind]) => kind === "outbox")).toEqual([
      ["outbox", "org-a"],
      ["outbox", "org-a"],
      ["outbox", "org-b"],
      ["outbox", "org-b"],
    ]);
    expect(recorded.started).toEqual([
      ["outbox-delivery", { outboxId: "outbox-of-event-a" }],
      ["outbox-delivery", { outboxId: "outbox-of-event-b" }],
    ]);
  });

  test("no events: nothing is read and nothing dispatched", async () => {
    await dispatchCommittedEvents([]);

    expect(recorded.bound).toEqual([]);
    expect(recorded.calls).toEqual([]);
  });

  test("a correlation: its rows are read and dispatched bound to the organisation given", async () => {
    await dispatchCommittedCorrelation("correlation-1", "org-c");

    expect(
      recorded.bound.every(([, organization]) => organization === "org-c"),
    ).toBe(true);
    expect(recorded.calls).toEqual([
      "outbox.idsForCorrelation correlation-1",
      "outbox.claimOne outbox-of-correlation-1 web",
      "outbox.markAccepted outbox-of-correlation-1 run_1",
    ]);
  });
});

/*
 * The call sites no behavioural suite reaches: the Slack interaction, the
 * MCP route and the administration actions' composition have no harness
 * that commits a row, so what they hand on is checked in their source.
 * The operations, imports, administration and core-bus sites are asserted
 * by behaviour in their own suites.
 */
describe("the call sites no suite drives, read from their source (D5)", () => {
  const source = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");

  test("the Slack interaction hands its committed events to dispatchCommittedEvents, and reads no outbox row itself", () => {
    const slack = source("./server-slack.ts");

    expect(slack).toMatch(
      /import \{ dispatchCommittedEvents \} from "\.\/trigger-client\.js";/u,
    );
    expect(slack).toContain("await dispatchCommittedEvents(committed.events);");
    expect(slack).not.toMatch(/idsForEvents|outboxRepository/u);
  });

  test("the administration actions dispatch a correlation through dispatchCommittedCorrelation", () => {
    const actions = source("./server-administration-actions.ts");

    expect(actions).toMatch(
      /import \{ dispatchCommittedCorrelation \} from "\.\/trigger-client\.js";/u,
    );
    expect(actions).toMatch(/^\s+dispatchCommittedCorrelation,$/mu);
    expect(actions).not.toMatch(/idsForCorrelation|outboxRepository/u);
  });

  test("the MCP route binds every import dispatch and its delivery read to the context's organisation", () => {
    // The route's import tools and its delivery replay run core's bodies,
    // over the web's RequestPort and its background port (Plan 13, G.6;
    // ruling 137), so their dispatches and the delivery read are read where
    // they moved, with the route itself.
    const route = [
      "../app/mcp/route.ts",
      "../../../../packages/core/src/mcp-only/legacy-import.ts",
      "../../../../packages/core/src/mcp-only/webhooks.ts",
    ]
      .map(source)
      .join("\n");
    const dispatches = [
      ...route.matchAll(/dispatchImportTask\(\s*([^,]+),\s*([^)]+?),?\s*\)/gu),
    ];

    expect(dispatches).toHaveLength(2);
    for (const [, , organization] of dispatches)
      expect(organization?.trim()).toBe("context.organizationId");
    // The first argument: the call is also handed the web root's handle
    // (Plan 13, G.3).
    expect(
      [...route.matchAll(/boundOutboxRepository\(\s*([^,)]+?)\s*[,)]/gu)].map(
        ([, organization]) => organization?.trim(),
      ),
    ).toEqual(["context.organizationId"]);
  });
});
