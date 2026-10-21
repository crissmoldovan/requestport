import type {
  AuthorizedCommandContext,
  EncryptedEnvelope,
  EnvelopeEncryption,
} from "@requestport/domain";
import { beforeEach, expect, test, vi } from "vitest";

import {
  createWebhookManagementService,
  type WebhookManagementRepository,
  type WebhookSubscriptionRecord,
} from "./management.js";

/**
 * The ids the management service makes with `uuid` (`management.ts`): a
 * verification's event and delivery ids, `v5` of the receipt's idempotency
 * fingerprint, and a new subscription's id, `v7`, when no `createId` is given.
 * The service runs as written. The delivery and the endpoint's resolution are
 * stand-ins, so nothing leaves the process, and the repository and the
 * encryption answer from memory.
 *
 * The two `v5` ids below were computed with `uuid` 13.0.0, the version this
 * package declared before Plan 13's G.7a moved it to 14.0.1 (ruling 144), so
 * they are the ids an endpoint was sent, for this idempotency key under this
 * fingerprint secret, before that move.
 */
const sent = vi.hoisted(
  () => [] as Array<{ eventId: string; deliveryId: string }>,
);

vi.mock("./deliver.js", () => ({
  deliverWebhook: async (input: { eventId: string; deliveryId: string }) => {
    sent.push({ eventId: input.eventId, deliveryId: input.deliveryId });
    return { status: 200 };
  },
}));
vi.mock("./endpoint-policy.js", () => ({
  resolveWebhookEndpoint: async () => ({}),
}));

const organizationId = "018f0000-0000-7000-8000-0000000d0001";
const subscriptionId = "018f0000-0000-7000-8000-0000000d0002";
const userId = "018f0000-0000-7000-8000-0000000d0003";

const context: AuthorizedCommandContext = {
  actor: { type: "user", id: userId },
  organizationId,
  scopes: new Set(["webhook:manage"]),
  credentialId: "session_1",
  correlationId: "correlation-1",
};

const envelope: EncryptedEnvelope = {
  ciphertext: new Uint8Array([1]),
  nonce: new Uint8Array([2]),
  wrappedDek: new Uint8Array([3]),
  kekVersion: "v1",
};

const subscription: WebhookSubscriptionRecord = {
  id: subscriptionId,
  organizationId,
  projectId: null,
  name: "Deployments",
  endpointUrl: "https://hooks.example.com/requestport",
  eventTypes: [],
  projectIds: [],
  laneIds: [],
  requestTypes: [],
  status: "pending_verification",
  version: 1,
  currentSecretCiphertext: envelope,
  currentSecretKeyId: "whk_current",
  nextSecretCiphertext: null,
  nextSecretKeyId: null,
  overlapEndsAt: null,
  verifiedAt: null,
  createdBy: userId,
  createdAt: new Date("2026-10-05T00:00:00.000Z"),
  updatedAt: new Date("2026-10-05T00:00:00.000Z"),
};

const created: string[] = [];

const repository = {
  canManage: async () => true,
  validateScope: async () => true,
  find: async () => subscription,
  markVerified: async () => ({ version: 2, replayed: false }),
  create: async (input: WebhookSubscriptionRecord) => {
    created.push(input.id);
    return {
      record: input,
      secretCiphertext: envelope,
      keyId: input.currentSecretKeyId,
      overlapEndsAt: null,
      replayed: false,
    };
  },
} as Partial<WebhookManagementRepository> as WebhookManagementRepository;

const encryption: EnvelopeEncryption = {
  encrypt: async () => envelope,
  decrypt: async <T>() => ({ secret: "plaintext-secret" }) as T,
  rewrap: async (sealed) => sealed,
};

function service() {
  return createWebhookManagementService({
    repository,
    encryption,
    fingerprintSecret: "webhook-test-fingerprint-secret-0123456789",
  });
}

beforeEach(() => {
  sent.length = 0;
  created.length = 0;
});

test("a verification's event and delivery ids are uuid v5 of its idempotency fingerprint: the ids uuid 13.0.0 gave, each time it runs under that key", async () => {
  const meta = {
    idempotencyKey: "verify-subscription-0001",
    expectedVersion: 1,
  };
  await service().verify(context, { organizationId, id: subscriptionId }, meta);
  await service().verify(context, { organizationId, id: subscriptionId }, meta);

  const ids = {
    eventId: "0fd5552a-a4d7-531d-8517-276372aeda9c",
    deliveryId: "dee70aa7-386c-5464-891a-48fab3b3df23",
  };
  expect(sent).toEqual([ids, ids]);
});

test("a subscription created without createId gets a uuid v7 stamped with the millisecond it was made, and the next one a greater id", async () => {
  const input = {
    organizationId,
    name: "Deployments",
    endpointUrl: "https://hooks.example.com/requestport",
  };
  const before = Date.now();
  await service().create(context, input, {
    idempotencyKey: "create-subscription-0001",
    expectedVersion: 0,
  });
  await service().create(context, input, {
    idempotencyKey: "create-subscription-0002",
    expectedVersion: 0,
  });
  const after = Date.now();

  expect(created).toHaveLength(2);
  for (const id of created) {
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const stamp = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  }
  expect(created[1] > created[0]).toBe(true);
});
