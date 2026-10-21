import { describe, expect, test, vi } from "vitest";

import { selectServerMagicLinkSender } from "./server-magic-link.js";

const token = "e2e-token-that-is-at-least-thirty-two-characters";

describe("server magic-link sender selection", () => {
  test("selects only the in-memory sender for a fully guarded local E2E run", () => {
    const e2eSender = vi.fn(async () => undefined);
    const resendSender = vi.fn(async () => undefined);
    const createE2ESender = vi.fn(() => e2eSender);
    const createResendSender = vi.fn(() => resendSender);

    const selected = selectServerMagicLinkSender({
      createE2ESender,
      createResendSender,
      env: {
        NODE_ENV: "development",
        REQUESTPORT_E2E_MODE: "1",
        REQUESTPORT_E2E_TOKEN: token,
      },
    });

    expect(selected).toBe(e2eSender);
    expect(createE2ESender).toHaveBeenCalledOnce();
    expect(createResendSender).not.toHaveBeenCalled();
  });

  test("fails closed in unit tests without constructing the Resend sender", async () => {
    const createE2ESender = vi.fn();
    const createResendSender = vi.fn();

    const selected = selectServerMagicLinkSender({
      createE2ESender,
      createResendSender,
      env: { NODE_ENV: "test" },
    });

    await expect(
      selected({
        email: "person@example.invalid",
        url: "https://credential.example.invalid",
      }),
    ).rejects.toThrow("Magic-link delivery is unavailable in unit tests");
    expect(createE2ESender).not.toHaveBeenCalled();
    expect(createResendSender).not.toHaveBeenCalled();
  });

  test.each([
    { NODE_ENV: "development", REQUESTPORT_E2E_MODE: "1" },
    {
      NODE_ENV: "development",
      REQUESTPORT_E2E_MODE: "1",
      REQUESTPORT_E2E_TOKEN: "short",
    },
    {
      NODE_ENV: "production",
      REQUESTPORT_E2E_MODE: "1",
      REQUESTPORT_E2E_TOKEN: token,
    },
    {
      REQUESTPORT_E2E_MODE: "1",
      REQUESTPORT_E2E_TOKEN: token,
    },
  ])("keeps partial or production guards on the Resend path", (env) => {
    const e2eSender = vi.fn(async () => undefined);
    const resendSender = vi.fn(async () => undefined);
    const createE2ESender = vi.fn(() => e2eSender);
    const createResendSender = vi.fn(() => resendSender);

    const selected = selectServerMagicLinkSender({
      createE2ESender,
      createResendSender,
      env,
    });

    expect(selected).toBe(resendSender);
    expect(createE2ESender).not.toHaveBeenCalled();
    expect(createResendSender).toHaveBeenCalledOnce();
  });
});
