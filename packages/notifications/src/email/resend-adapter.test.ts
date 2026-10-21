import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createResendNotificationAdapter } from "./resend-adapter.js";

/**
 * The inbound half of the Resend integration, which had no test at all.
 *
 * `apps/web/src/app/api/providers/resend/route.ts` decides whether a delivery,
 * bounce or complaint event is real, and it decides it here — the route reads
 * the three `svix-*` headers and hands them to this adapter, which hands them
 * to the `resend` SDK, which verifies them with `standardwebhooks`. Everything
 * downstream of that call trusts the result: `recordProviderCallback` writes
 * the event against a notification record. So this is the boundary where a
 * forged callback either stops or does not.
 *
 * **The signatures here are built from the Standard Webhooks specification with
 * `node:crypto`, not with the library that verifies them.** Signing with the
 * verifier's own `Webhook.sign` would prove that the pair agrees with itself,
 * which is a weaker claim and one that survives a bug present in both halves.
 * Building the signature independently proves the endpoint accepts a
 * spec-conformant signature from a stranger, which is the thing Resend actually
 * sends. It is also self-checking: get the scheme wrong and the first test
 * fails rather than passing for the wrong reason.
 *
 * The scheme: the secret is `whsec_` followed by a base64 key; the signed
 * content is `id.timestamp.payload`; the header is `v1,` followed by the
 * base64 HMAC-SHA256 of that content under the decoded key; the timestamp is
 * whole seconds since the epoch.
 */
const adapter = createResendNotificationAdapter({
  apiKey: "re_test_key_not_used_by_verification",
  from: "RequestPort <no-reply@example.invalid>",
});

function secret() {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

function sign(
  webhookSecret: string,
  id: string,
  timestampSeconds: number,
  payload: string,
) {
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64");
  const mac = createHmac("sha256", key)
    .update(`${id}.${timestampSeconds}.${payload}`)
    .digest("base64");

  return `v1,${mac}`;
}

const body = JSON.stringify({
  created_at: "2026-09-26T10:00:00.000Z",
  data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" },
  type: "email.delivered",
});

describe("the Resend callback signature boundary", () => {
  it("accepts a signature built independently from the specification", () => {
    const webhookSecret = secret();
    const id = "msg_2f0c1a";
    const timestamp = Math.floor(Date.now() / 1000);

    const event = adapter.verifyWebhook(
      body,
      {
        id,
        signature: sign(webhookSecret, id, timestamp, body),
        timestamp: String(timestamp),
      },
      webhookSecret,
    ) as { type: string };

    // Returning the parsed event, not merely "true", is what the route relies
    // on: it reads `type` and `data.email_id` straight off this value.
    expect(event.type).toBe("email.delivered");
  });

  /**
   * The case the whole endpoint exists for. A body altered after signing must
   * fail, or a caller could take a genuine delivered-event signature and swap
   * the payload for one naming somebody else's message.
   */
  it("rejects a body altered after it was signed", () => {
    const webhookSecret = secret();
    const id = "msg_2f0c1a";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(webhookSecret, id, timestamp, body);
    const tampered = body.replace("email.delivered", "email.bounced");

    expect(() =>
      adapter.verifyWebhook(
        tampered,
        { id, signature, timestamp: String(timestamp) },
        webhookSecret,
      ),
    ).toThrow();
  });

  it("rejects a signature made with a different secret", () => {
    const id = "msg_2f0c1a";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(secret(), id, timestamp, body);

    expect(() =>
      adapter.verifyWebhook(
        body,
        { id, signature, timestamp: String(timestamp) },
        secret(),
      ),
    ).toThrow();
  });

  /**
   * Replay protection, which is a property of the timestamp rather than of the
   * signature: the signature below is genuine and stays genuine forever. Only
   * the age of the message makes it refusable, so an interceptor cannot bank a
   * valid callback and send it again later.
   */
  it("rejects a correctly signed message that is too old", () => {
    const webhookSecret = secret();
    const id = "msg_2f0c1a";
    const hoursAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 6;

    expect(() =>
      adapter.verifyWebhook(
        body,
        {
          id,
          signature: sign(webhookSecret, id, hoursAgo, body),
          timestamp: String(hoursAgo),
        },
        webhookSecret,
      ),
    ).toThrow();
  });

  it("rejects a message whose id was changed after signing", () => {
    const webhookSecret = secret();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign(webhookSecret, "msg_2f0c1a", timestamp, body);

    expect(() =>
      adapter.verifyWebhook(
        body,
        { id: "msg_someone_else", signature, timestamp: String(timestamp) },
        webhookSecret,
      ),
    ).toThrow();
  });
});
