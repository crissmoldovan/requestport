import { createHmac } from "node:crypto";
import { render } from "@react-email/render";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createSafeResendClient } from "./resend-client.js";
import { createMagicLinkSender } from "./send-magic-link.js";

const sentinelUrl =
  "https://requestport.test/magic-link/verify?token=sentinel-token";
const sentinelEmail = "Secret.Person@Example.com";
const sentinelFingerprintKey = "sentinel-fingerprint-key";
const sentinelApiKey = "sentinel-resend-api-key";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("direct Resend magic-link delivery", () => {
  test("sends the React email directly with a fresh entity reference", async () => {
    const send = vi.fn(async (_payload: { react: unknown }) => ({
      data: { id: "provider_123" },
      error: null,
    }));
    const logs: unknown[] = [];
    const sender = createMagicLinkSender({
      sendEmail: send,
      fingerprintKey: sentinelFingerprintKey,
      fromEmail: "RequestPort <access@requestport.test>",
      logger: {
        info: (fields) => logs.push(fields),
        error: (fields) => logs.push(fields),
      },
      randomId: () => "correlation_123",
    });

    await sender({ email: sentinelEmail, url: sentinelUrl });

    const payload = send.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      from: "RequestPort <access@requestport.test>",
      to: sentinelEmail,
      subject: "Sign in to RequestPort",
      headers: { "X-Entity-Ref-ID": "correlation_123" },
    });
    await expect(render(payload?.react as never)).resolves.toContain(
      sentinelUrl,
    );
    expect(logs).toEqual([
      {
        correlationId: "correlation_123",
        emailFingerprint: createHmac("sha256", sentinelFingerprintKey)
          .update("secret.person@example.com")
          .digest("hex"),
        outcome: "sent",
        providerMessageId: "provider_123",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(sentinelEmail);
    expect(JSON.stringify(logs)).not.toContain("sentinel-token");
    expect(JSON.stringify(logs)).not.toContain(sentinelFingerprintKey);
  });

  test("sanitizes provider failures and never logs credentials or provider details", async () => {
    const providerDetail = "provider rejected sentinel-api-key";
    const logs: unknown[] = [];
    const sender = createMagicLinkSender({
      sendEmail: vi.fn(async () => ({
        data: null,
        error: new Error(providerDetail),
      })),
      fingerprintKey: sentinelFingerprintKey,
      fromEmail: "RequestPort <access@requestport.test>",
      logger: {
        info: (fields) => logs.push(fields),
        error: (fields) => logs.push(fields),
      },
      randomId: () => "correlation_456",
    });

    const result = sender({ email: sentinelEmail, url: sentinelUrl });

    await expect(result).rejects.toThrow("Unable to send sign-in link");
    await expect(result).rejects.not.toThrow(providerDetail);
    const captured = JSON.stringify(logs);
    expect(captured).not.toContain(sentinelEmail);
    expect(captured).not.toContain("sentinel-token");
    expect(captured).not.toContain("sentinel-api-key");
    expect(captured).not.toContain(providerDetail);
    expect(captured).not.toContain(sentinelFingerprintKey);
    expect(logs).toEqual([
      {
        correlationId: "correlation_456",
        emailFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: "failed",
      },
    ]);
  });

  test("the real Resend failure boundary emits only RequestPort-safe diagnostics", async () => {
    const providerDetail = "provider-secret-detail";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            name: "validation_error",
            message: providerDetail,
            statusCode: 422,
          },
          { status: 422 },
        ),
      ),
    );
    const resend = createSafeResendClient(sentinelApiKey);
    const logs: unknown[] = [];
    const sender = createMagicLinkSender({
      sendEmail: (payload) => resend.emails.send(payload),
      fingerprintKey: sentinelFingerprintKey,
      fromEmail: "RequestPort <access@requestport.test>",
      logger: {
        info: (fields) => logs.push(fields),
        error: (fields) => logs.push(fields),
      },
      randomId: () => "correlation_real_sdk",
    });

    const result = sender({ email: sentinelEmail, url: sentinelUrl });
    await expect(result).rejects.toThrow("Unable to send sign-in link");

    const captured = JSON.stringify({
      console: consoleError.mock.calls,
      logs,
    });
    expect(captured).not.toContain(providerDetail);
    expect(captured).not.toContain(sentinelEmail);
    expect(captured).not.toContain("sentinel-token");
    expect(captured).not.toContain(sentinelApiKey);
    expect(captured).not.toContain(sentinelFingerprintKey);
  });

  test("the real Resend success boundary keeps React rendering and safe logs", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchRequest = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ id: "provider_real_sdk" }),
    );
    vi.stubGlobal("fetch", fetchRequest);
    const resend = createSafeResendClient(sentinelApiKey);
    const logs: unknown[] = [];
    const sender = createMagicLinkSender({
      sendEmail: (payload) => resend.emails.send(payload),
      fingerprintKey: sentinelFingerprintKey,
      fromEmail: "RequestPort <access@requestport.test>",
      logger: {
        info: (fields) => logs.push(fields),
        error: (fields) => logs.push(fields),
      },
      randomId: () => "correlation_real_success",
    });

    await sender({ email: sentinelEmail, url: sentinelUrl });

    expect(consoleError).not.toHaveBeenCalled();
    expect(logs).toEqual([
      {
        correlationId: "correlation_real_success",
        emailFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: "sent",
        providerMessageId: "provider_real_sdk",
      },
    ]);
    const requestBody = JSON.parse(
      String(fetchRequest.mock.calls[0]?.[1]?.body),
    );
    expect(requestBody.html).toContain("Sign in to RequestPort");
  });
});
