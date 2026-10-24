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
 * A subscription's endpoint and name, as zod 4.4.3 parsed them for
 * RequestPort 0.2.0, though the workspace runs zod 4.6.7: the URL trimmed and
 * otherwise kept as sent, a tab inside it included (4.6.7's `z.url()` removes
 * it), and the name measured in UTF-16 code units. The endpoint's resolution
 * and the repository are stand-ins, so nothing leaves the process.
 */
vi.mock("./endpoint-policy.js", () => ({
  resolveWebhookEndpoint: async () => ({}),
}));

const organizationId = "018f0000-0000-7000-8000-0000000e0001";
const userId = "018f0000-0000-7000-8000-0000000e0002";

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

const created: WebhookSubscriptionRecord[] = [];

const repository = {
  canManage: async () => true,
  validateScope: async () => true,
  create: async (input: WebhookSubscriptionRecord) => {
    created.push(input);
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

function create(input: { name: string; endpointUrl: string }) {
  return createWebhookManagementService({
    repository,
    encryption,
    fingerprintSecret: "webhook-test-fingerprint-secret-0123456789",
  }).create(
    context,
    { organizationId, ...input },
    { idempotencyKey: "create-subscription-0001", expectedVersion: 0 },
  );
}

beforeEach(() => {
  created.length = 0;
});

test("an endpoint keeps a tab inside it, trimmed only at its ends", async () => {
  await create({
    name: "Deployments",
    endpointUrl: " https://hooks.exa\tmple.com/requestport ",
  });

  expect(created.map((record) => record.endpointUrl)).toEqual([
    "https://hooks.exa\tmple.com/requestport",
  ]);
});

test("a name is measured in UTF-16 code units: 81 emoji are 162, over the 160", async () => {
  await create({
    name: "\u{1F600}".repeat(80),
    endpointUrl: "https://hooks.example.com/requestport",
  });
  await expect(
    create({
      name: "\u{1F600}".repeat(81),
      endpointUrl: "https://hooks.example.com/requestport",
    }),
  ).rejects.toThrow(/Too big: expected string to have <=160 characters/);

  expect(created.map((record) => record.name)).toEqual([
    "\u{1F600}".repeat(80),
  ]);
});
