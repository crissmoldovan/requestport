import type { WorkerStorages } from "@requestport/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * The webhook delivery body's endpoint policy (Plan 13, G.6; ruling 137): the
 * `production` switch it hands `deliverWebhook` (`@requestport/webhooks`)
 * comes from the worker's settings, `productionWebhookEndpoints`, which the
 * worker root fills from `NODE_ENV` and core's `postgres` background from its
 * `environment` option. The `privateReceivers` switch (H.10) comes from
 * `privateWebhookReceivers`, which the worker root fills from
 * `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` and core's `postgres` background
 * from its `privateWebhookReceivers` option. Everything the body reaches
 * besides the policy is a stand-in: the storages, the outbox repository, the
 * event schemas, the envelope's decryption and the POST itself.
 */

const delivered = vi.hoisted(() => [] as Array<Record<string, unknown>>);

const organizationId = "018f0000-0000-7000-8000-0000000e5101";
const deliveryId = "018f0000-0000-7000-8000-0000000e5102";

const outboxRepository = {
  loadWebhookDelivery: vi.fn(async () => ({
    subscription: { endpointUrl: "http://receiver.example:8080/hook" },
    requestSensitivity: "normal",
    event: {
      id: "018f0000-0000-7000-8000-0000000e5103",
      type: "request.created",
      schemaVersion: 1,
      occurredAt: new Date("2026-10-04T12:00:00.000Z"),
      organizationId,
      projectId: null,
      requestId: null,
      aggregateType: "request",
      aggregateId: "018f0000-0000-7000-8000-0000000e5104",
      aggregateVersion: 1,
      actor: { type: "user", id: "user_webhook_body" },
      data: {},
      links: {},
    },
  })),
  claimWebhookDelivery: vi.fn(async () => ({
    attemptId: "018f0000-0000-7000-8000-0000000e5105",
    attemptNumber: 1,
    signingKeyId: "key-1",
    secretCiphertext: "ciphertext",
    organizationId,
    subscriptionId: "018f0000-0000-7000-8000-0000000e5106",
  })),
  addWebhookResolvedIps: vi.fn(async () => undefined),
  finishWebhookAttempt: vi.fn(async () => undefined),
};

vi.mock("@requestport/db", () => ({
  createOutboxRepository: () => outboxRepository,
}));
vi.mock("@requestport/domain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCoreEventSchemaRegistry: () => ({
    parse: (_type: string, data: unknown) => data,
  }),
  deserializeEncryptedEnvelope: (value: unknown) => value,
  sanitizeEventActor: (actor: unknown) => actor,
  sanitizeEventLinks: (links: unknown) => links,
}));
vi.mock("@requestport/webhooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deliverWebhook: async (input: Record<string, unknown>) => {
    delivered.push(input);
    return { status: 204 };
  },
}));
vi.mock("../webhook-encryption.js", () => ({
  webhookAad: () => "aad",
  webhookEncryption: () => ({ decrypt: async () => ({ secret: "secret" }) }),
}));

/** One processing unit per call, on a stand-in handle the repository ignores. */
const storages = {
  bound: false,
  dispatcher: {},
  maintenance: {},
  resolveJobOrganization: async () => organizationId,
  withTenant: async (
    _organization: string,
    work: (database: unknown) => unknown,
  ) => work({}),
  roleReports: async () => null,
  close: async () => undefined,
};

const { useWorkerSettings, useWorkerStorages } = await import(
  "../worker-storages.js"
);
useWorkerStorages(storages as unknown as WorkerStorages);
const { runWebhookDelivery } = await import("./webhook-delivery.js");

const runner = {
  kind: "postgres" as const,
  enqueue: async () => ({ id: "job-1" }),
  sleep: async () => undefined,
  waitBeforeRetry: async () => undefined,
  dispatchOutbox: async () => ({ accepted: false }),
};

function settings(
  productionWebhookEndpoints: boolean,
  privateWebhookReceivers = false,
) {
  return {
    environment: "webhook-body-test",
    publicUrl: "https://requestport.example",
    productionWebhookEndpoints,
    privateWebhookReceivers,
    secrets: {
      workSweepFingerprintSecret: "sweep",
      workspaceKeys: undefined,
      slackStateSecret: undefined,
      webhookKeys: undefined,
      email: undefined,
    },
  };
}

beforeEach(() => {
  delivered.length = 0;
});

afterEach(() => {
  useWorkerSettings(undefined);
  vi.unstubAllEnvs();
});

describe("the webhook delivery body's endpoint policy", () => {
  test.each([
    [true, "development"],
    [false, "production"],
  ] as const)(
    "is the worker's settings' productionWebhookEndpoints (%s), whatever NODE_ENV is (%s)",
    async (productionWebhookEndpoints, nodeEnvironment) => {
      vi.stubEnv("NODE_ENV", nodeEnvironment);
      useWorkerSettings(settings(productionWebhookEndpoints));

      await runWebhookDelivery({ deliveryId }, runner as never);

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.production).toBe(productionWebhookEndpoints);
    },
  );

  test.each([true, false])(
    "hands deliverWebhook the worker's settings' privateWebhookReceivers (%s) as privateReceivers",
    async (privateWebhookReceivers) => {
      useWorkerSettings(settings(true, privateWebhookReceivers));

      await runWebhookDelivery({ deliveryId }, runner as never);

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.privateReceivers).toBe(privateWebhookReceivers);
      expect(delivered[0]?.production).toBe(true);
    },
  );
});
