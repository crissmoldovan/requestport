import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookSignatureInput = {
  eventId: string;
  deliveryId: string;
  timestamp: number;
  attempt: number;
  schemaVersion: number;
  keyId: string;
  secret: string;
  rawBody: Uint8Array;
};

function hmac(
  input: Pick<WebhookSignatureInput, "timestamp" | "secret" | "rawBody">,
) {
  return createHmac("sha256", input.secret)
    .update(String(input.timestamp))
    .update(".")
    .update(input.rawBody)
    .digest("hex");
}

export function createWebhookHeaders(input: WebhookSignatureInput) {
  return {
    "content-type": "application/json; charset=utf-8",
    "requestport-event-id": input.eventId,
    "requestport-delivery-id": input.deliveryId,
    "requestport-timestamp": String(input.timestamp),
    "requestport-signature": `v1=${input.keyId}:${hmac(input)}`,
    "requestport-attempt": String(input.attempt),
    "requestport-schema-version": String(input.schemaVersion),
  };
}

export function verifyWebhookSignature(input: {
  timestamp: number;
  rawBody: Uint8Array;
  signature: string;
  secrets: ReadonlyMap<string, string>;
  now?: number;
  toleranceSeconds?: number;
}) {
  const match = /^v1=([A-Za-z0-9._-]{1,128}):([0-9a-f]{64})$/u.exec(
    input.signature,
  );
  if (!match) return false;
  const [, keyId, suppliedHex] = match;
  const secret = input.secrets.get(keyId ?? "");
  if (!secret || !suppliedHex) return false;
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (Math.abs(now - input.timestamp) > (input.toleranceSeconds ?? 300))
    return false;
  const expected = Buffer.from(
    hmac({ timestamp: input.timestamp, rawBody: input.rawBody, secret }),
    "hex",
  );
  const supplied = Buffer.from(suppliedHex, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
