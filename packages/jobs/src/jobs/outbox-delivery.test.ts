import type { WorkerStorages } from "@requestport/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

const outboxRepository = {
  claimStanding: vi.fn(async () => "held"),
  loadEvent: vi.fn(),
  deadLetter: vi.fn(async () => true),
  markCompleted: vi.fn(async () => true),
  matchingWebhookSubscriptions: vi.fn(async () => []),
  ensureWebhookDelivery: vi.fn(async () => "delivery-1"),
};
const notificationRepository = {
  materializeRequestIntents: vi.fn(async () => []),
  materializeQuestionIntents: vi.fn(async () => []),
  materializeInvitationIntents: vi.fn(async () => []),
};
/*
 * The worker's storages, unset-shaped: the resolver answers the row's
 * organisation, and each unit hands the repositories a stand-in handle the
 * factories below ignore. What each unit was bound to is recorded.
 */
const units: string[] = [];
const storages = {
  bound: false,
  dispatcher: {},
  maintenance: {},
  resolveJobOrganization: vi.fn(
    async (): Promise<string | null> => organizationId,
  ),
  withTenant: vi.fn(
    async (organization: string, work: (database: unknown) => unknown) => {
      units.push(organization);
      return work({});
    },
  ),
  roleReports: async () => null,
  close: async () => undefined,
};

vi.mock("@requestport/db", () => ({
  createOutboxRepository: () => outboxRepository,
  createNotificationRepository: () => notificationRepository,
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

const { deliverOutboxEvent } = await import("./outbox-delivery.js");
const { SettlementPendingError } = await import("../settlement.js");

const lease = { kind: "lease", leaseId: "lease-1" } as const;

/** A runner that records what routing asked it to start. */
const runner = {
  kind: "postgres" as const,
  enqueue: vi.fn(async () => ({ id: "job-1" })),
  sleep: vi.fn(async () => undefined),
  waitBeforeRetry: vi.fn(async () => undefined),
  dispatchOutbox: vi.fn(async () => ({ accepted: false })),
};

const organizationId = "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a1";
const triple = {
  theme: "cue",
  density: "normal",
  mode: "dark",
};

function loaded(type: string, data: Record<string, unknown>) {
  return {
    event: {
      id: "018f0000-0000-7000-8000-000000000001",
      organizationId,
      type,
      data,
      projectId: null,
      requestId: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  units.length = 0;
  storages.resolveJobOrganization.mockResolvedValue(organizationId);
  outboxRepository.claimStanding.mockResolvedValue("held");
  outboxRepository.deadLetter.mockResolvedValue(true);
  outboxRepository.markCompleted.mockResolvedValue(true);
  outboxRepository.matchingWebhookSubscriptions.mockResolvedValue([]);
  notificationRepository.materializeRequestIntents.mockResolvedValue([]);
  notificationRepository.materializeQuestionIntents.mockResolvedValue([]);
  notificationRepository.materializeInvitationIntents.mockResolvedValue([]);
});

describe("appearance events on the durable outbox worker", () => {
  test.each([
    [
      "appearance.organization_defaults_initialized.v1",
      { organizationId, ...triple },
    ],
    [
      "appearance.organization_defaults_updated.v1",
      {
        organizationId,
        changedFields: ["theme"],
        before: {
          theme: "requestport",
          density: "normal",
          mode: "dark",
        },
        after: triple,
      },
    ],
  ])("routes %s to completion", async (type, data) => {
    outboxRepository.loadEvent.mockResolvedValue(loaded(type, data));

    await expect(
      deliverOutboxEvent("outbox-1", runner, lease),
    ).resolves.toMatchObject({
      status: "routed",
    });
    expect(outboxRepository.markCompleted).toHaveBeenCalledWith(
      "outbox-1",
      lease,
    );
    expect(outboxRepository.deadLetter).not.toHaveBeenCalled();
  });

  test("dead-letters a malformed appearance payload as a schema failure", async () => {
    outboxRepository.loadEvent.mockResolvedValue(
      loaded("appearance.organization_defaults_initialized.v1", {
        organizationId,
        theme: "midnight",
        density: "normal",
        mode: "dark",
      }),
    );

    await expect(
      deliverOutboxEvent("outbox-2", runner, lease),
    ).resolves.toEqual({
      status: "dead_letter",
      reason: "event_schema_invalid",
    });
    expect(outboxRepository.deadLetter).toHaveBeenCalledWith("outbox-2", lease);
    expect(outboxRepository.markCompleted).not.toHaveBeenCalled();
  });

  test("dead-letters an unknown event version as an unregistered type", async () => {
    outboxRepository.loadEvent.mockResolvedValue(
      loaded("appearance.organization_defaults_updated.v2", {
        organizationId,
        changedFields: [],
        before: triple,
        after: triple,
      }),
    );

    // A newer web deployment emitting a `.v2` envelope against this worker is a
    // rollout ordering problem, not a corrupt payload. The reasons stay
    // distinct so staging acceptance can tell the two apart.
    await expect(
      deliverOutboxEvent("outbox-3", runner, lease),
    ).resolves.toEqual({
      status: "dead_letter",
      reason: "event_type_unregistered",
    });
    expect(outboxRepository.deadLetter).toHaveBeenCalledWith("outbox-3", lease);
  });

  test("dead-letters a missing outbox event", async () => {
    outboxRepository.loadEvent.mockResolvedValue(null);

    await expect(
      deliverOutboxEvent("outbox-4", runner, lease),
    ).resolves.toEqual({
      status: "dead_letter",
      reason: "event_missing",
    });
    // The returned object says "dead_letter" whatever the repository was
    // asked to do, so the name of this test was carried entirely by a value
    // the branch computes for itself. Without these two the write could be
    // deleted — or swapped for `markCompleted`, its opposite — and nothing
    // here would notice.
    expect(outboxRepository.deadLetter).toHaveBeenCalledWith("outbox-4", lease);
    expect(outboxRepository.markCompleted).not.toHaveBeenCalled();
  });

  test.each([
    [
      "organization.created.v1",
      {
        organizationId,
        name: "RequestPort",
        slug: "requestport",
        status: "active",
      },
    ],
    [
      "organization.member_changed.v1",
      {
        membershipId: "6f2f6cf6-6c4a-4b1e-9d0d-2f43b5c1b0a2",
        role: "owner",
        status: "active",
      },
    ],
    ["retention.hold_changed.v1", { category: "all", status: "active" }],
  ])("remains backward compatible with %s", async (type, data) => {
    outboxRepository.loadEvent.mockResolvedValue(loaded(type, data));

    await expect(
      deliverOutboxEvent("outbox-5", runner, lease),
    ).resolves.toMatchObject({
      status: "routed",
    });
    expect(outboxRepository.deadLetter).not.toHaveBeenCalled();
  });

  test("starts its children through the runner it is given, keyed as before", async () => {
    outboxRepository.loadEvent.mockResolvedValue(
      loaded("retention.hold_changed.v1", {
        category: "all",
        status: "active",
      }),
    );
    outboxRepository.matchingWebhookSubscriptions.mockResolvedValue([
      { id: "subscription-1" },
    ] as never);
    notificationRepository.materializeRequestIntents.mockResolvedValue([
      { id: "intent-email", channel: "email" },
    ] as never);
    notificationRepository.materializeQuestionIntents.mockResolvedValue([
      { id: "intent-slack", channel: "slack" },
    ] as never);

    await expect(
      deliverOutboxEvent("outbox-6", runner, lease),
    ).resolves.toMatchObject({
      status: "routed",
      webhookDeliveries: ["delivery-1"],
      notificationIntents: ["intent-email", "intent-slack"],
    });
    expect(runner.enqueue.mock.calls).toEqual([
      ["webhook-delivery", { deliveryId: "delivery-1" }],
      [
        "email-delivery",
        { intentId: "intent-email" },
        { idempotencyKey: "email:intent-email" },
      ],
      [
        "slack-question-delivery",
        { intentId: "intent-slack" },
        { idempotencyKey: "slack:intent-slack" },
      ],
    ]);
    expect(outboxRepository.markCompleted).toHaveBeenCalledWith(
      "outbox-6",
      lease,
    );
  });
});

/*
 * Settlement (manifest-i2.md §5.1; ruling 59): the standing is read before
 * any effect, and a settlement refused after the effects is reported, not
 * thrown.
 */
describe("the claim this body settles", () => {
  const routedEvent = () =>
    loaded("retention.hold_changed.v1", { category: "all", status: "active" });

  test("reads its standing in the first unit, bound to the resolved organisation", async () => {
    outboxRepository.loadEvent.mockResolvedValue(routedEvent());

    await deliverOutboxEvent("outbox-7", runner, lease);

    expect(storages.resolveJobOrganization).toHaveBeenCalledWith(
      "outbox",
      "outbox-7",
    );
    expect(outboxRepository.claimStanding).toHaveBeenCalledWith(
      "outbox-7",
      lease,
    );
    expect(units).toEqual([organizationId, organizationId, organizationId]);
  });

  test("a run whose acceptance is not recorded yet throws the retryable error before any effect", async () => {
    const run = { kind: "trigger_run", runId: "run_1" } as const;
    outboxRepository.claimStanding.mockResolvedValue("pending_acceptance");

    await expect(
      deliverOutboxEvent("outbox-8", runner, run),
    ).rejects.toBeInstanceOf(SettlementPendingError);
    expect(outboxRepository.claimStanding).toHaveBeenCalledWith(
      "outbox-8",
      run,
    );
    expect(outboxRepository.loadEvent).not.toHaveBeenCalled();
    expect(outboxRepository.ensureWebhookDelivery).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(outboxRepository.markCompleted).not.toHaveBeenCalled();
    expect(outboxRepository.deadLetter).not.toHaveBeenCalled();
  });

  test("a superseded claim returns without any effect", async () => {
    outboxRepository.claimStanding.mockResolvedValue("superseded");

    await expect(
      deliverOutboxEvent("outbox-9", runner, lease),
    ).resolves.toEqual({ status: "superseded" });
    expect(outboxRepository.loadEvent).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(outboxRepository.markCompleted).not.toHaveBeenCalled();
    expect(outboxRepository.deadLetter).not.toHaveBeenCalled();
  });

  test("a row the resolver does not find in flight is superseded, and nothing is bound or written", async () => {
    storages.resolveJobOrganization.mockResolvedValue(null);

    await expect(
      deliverOutboxEvent("outbox-10", runner, lease),
    ).resolves.toEqual({ status: "superseded" });
    expect(units).toEqual([]);
    expect(outboxRepository.claimStanding).not.toHaveBeenCalled();
    expect(outboxRepository.deadLetter).not.toHaveBeenCalled();
  });

  test("a completion refused after the effects returns superseded, and does not throw", async () => {
    outboxRepository.loadEvent.mockResolvedValue(routedEvent());
    outboxRepository.matchingWebhookSubscriptions.mockResolvedValue([
      { id: "subscription-1" },
    ] as never);
    outboxRepository.markCompleted.mockResolvedValue(false);
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
    const warn = vi.spyOn(console, "warn").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      await expect(
        deliverOutboxEvent("outbox-11", runner, lease),
      ).resolves.toEqual({ status: "superseded" });
    } finally {
      write.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
    expect(runner.enqueue).toHaveBeenCalledWith("webhook-delivery", {
      deliveryId: "delivery-1",
    });
    expect(outboxRepository.markCompleted).toHaveBeenCalledWith(
      "outbox-11",
      lease,
    );
    expect(lines.join("\n")).toContain("outbox.settlement_refused");
  });

  test("a dead letter refused is superseded too, not a dead letter", async () => {
    outboxRepository.loadEvent.mockResolvedValue(null);
    outboxRepository.deadLetter.mockResolvedValue(false);

    await expect(
      deliverOutboxEvent("outbox-12", runner, lease),
    ).resolves.toEqual({ status: "superseded" });
    expect(outboxRepository.deadLetter).toHaveBeenCalledWith(
      "outbox-12",
      lease,
    );
  });
});
