import { DomainError } from "@requestport/domain";
import { beforeEach, describe, expect, test, vi } from "vitest";

const serverEnv: Record<string, string | undefined> = {};
const verifyWebhook = vi.fn();
const recordProviderCallback = vi.fn();
const enforceRateLimit = vi.fn();

vi.mock("@requestport/config/server", () => ({
  get serverEnv() {
    return serverEnv;
  },
}));
vi.mock("@requestport/db", () => ({
  createNotificationRepository: () => ({
    recordProviderCallback: (...args: unknown[]) =>
      recordProviderCallback(...args),
  }),
}));
// The web root, whose storage the callback's record builds its repository
// over when it runs (Plan 13, G.3).
vi.mock("../../../../lib/server-request-port.js", () => ({
  webStorage: () => ({ db: {} }),
}));
vi.mock("@requestport/notifications", () => ({
  createResendNotificationAdapter: () => ({ verifyWebhook }),
}));
vi.mock("../../../../lib/observability.js", () => ({
  webLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../../../lib/security/rate-limit.js", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
  rateLimitFingerprint: (...parts: string[]) => parts.join(":"),
  requestIp: () => "203.0.113.7",
}));

const { POST } = await import("./route.js");

const body = JSON.stringify({
  created_at: "2026-09-26T10:00:00.000Z",
  data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" },
  type: "email.delivered",
});

const signedHeaders = {
  "content-type": "application/json",
  "svix-id": "msg_2f0c1a",
  "svix-signature": "v1,whatever-the-adapter-is-told-to-make-of-it",
  "svix-timestamp": "1790000000",
};

function callback(
  headers: Record<string, string> = signedHeaders,
  payload = body,
) {
  return POST(
    new Request("https://requestport.com/api/providers/resend", {
      body: payload,
      headers,
      method: "POST",
    }),
  );
}

function configure() {
  serverEnv.RESEND_API_KEY = "re_test";
  serverEnv.RESEND_FROM_EMAIL = "RequestPort <no-reply@requestport.com>";
  serverEnv.RESEND_WEBHOOK_SECRET = "whsec_at_least_sixteen_characters";
}

beforeEach(() => {
  for (const key of Object.keys(serverEnv)) delete serverEnv[key];
  verifyWebhook.mockReset();
  recordProviderCallback.mockReset();
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
});

/**
 * The refusals this endpoint makes, and the order it makes them in.
 *
 * Signature verification lives one layer down and is tested against real
 * cryptography in `@requestport/notifications`' `resend-adapter.test.ts`; the
 * adapter is a double here on purpose, because these tests are about what the
 * route does with a verdict rather than how the verdict is reached. Mocking the
 * verifier to prove "a forged signature is rejected" would prove nothing at all
 * — the mock would be doing the rejecting.
 *
 * What is worth proving here is the *ordering*, and a status code cannot show
 * it: a route that recorded the event and then refused would answer 400 exactly
 * like one that refused first. So the database double is watched instead.
 */
describe("the Resend provider callback", () => {
  test("answers 503 while the capability is unconfigured, which is today's state", async () => {
    const response = await callback();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "provider_unavailable",
    });
    // Nothing was read, verified or written: the capability being off is not
    // the same as the endpoint being broken, and it must cost nothing.
    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(recordProviderCallback).not.toHaveBeenCalled();
  });

  test("refuses a body that is not declared as JSON", async () => {
    configure();

    const response = await callback({
      ...signedHeaders,
      "content-type": "text/plain",
    });

    expect(response.status).toBe(415);
    expect(verifyWebhook).not.toHaveBeenCalled();
  });

  test.each([["svix-id"], ["svix-timestamp"], ["svix-signature"]])(
    "refuses a callback missing %s",
    async (header) => {
      configure();
      const headers = { ...signedHeaders };
      delete (headers as Record<string, string>)[header];

      const response = await callback(headers);

      expect(response.status).toBe(400);
      expect(verifyWebhook).not.toHaveBeenCalled();
    },
  );

  /**
   * The claim the endpoint exists to make. A rejected signature must not reach
   * the database — otherwise a forged callback still writes a row and the
   * verification is decoration.
   */
  test("never records an event whose signature did not verify", async () => {
    configure();
    verifyWebhook.mockImplementation(() => {
      throw new Error("signature mismatch");
    });

    const response = await callback();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_callback",
    });
    expect(recordProviderCallback).not.toHaveBeenCalled();
  });

  test("records a verified event against the id the signature covered", async () => {
    configure();
    verifyWebhook.mockReturnValue({
      created_at: "2026-09-26T10:00:00.000Z",
      data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" },
      type: "email.delivered",
    });
    recordProviderCallback.mockResolvedValue({ conflict: false });

    const response = await callback();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(recordProviderCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "msg_2f0c1a",
        provider: "resend",
        providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
        // `email.delivered` becomes `delivered`: the stored status is the
        // provider's vocabulary with its own prefix removed.
        status: "delivered",
      }),
    );
  });

  test("refuses an event whose timestamp is not a date", async () => {
    configure();
    verifyWebhook.mockReturnValue({
      created_at: "not-a-date",
      type: "email.delivered",
    });

    const response = await callback();

    expect(response.status).toBe(400);
    expect(recordProviderCallback).not.toHaveBeenCalled();
  });

  /**
   * Resend retries, so the same `svix-id` arrives more than once. A repeat
   * carrying a *different* body is not a retry — it is the same event id
   * claiming two histories, and the repository says so rather than overwriting.
   */
  test("answers 409 when a repeated event id carries a different body", async () => {
    configure();
    verifyWebhook.mockReturnValue({
      created_at: "2026-09-26T10:00:00.000Z",
      data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" },
      type: "email.delivered",
    });
    recordProviderCallback.mockResolvedValue({ conflict: true });

    const response = await callback();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "provider_event_conflict",
    });
  });

  test("answers 429 with the provider's retry hint when rate limited", async () => {
    configure();
    enforceRateLimit.mockRejectedValue(
      new DomainError("rate_limited", "too many", { retryAfterSeconds: 30 }),
    );

    const response = await callback();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(verifyWebhook).not.toHaveBeenCalled();
  });
});
