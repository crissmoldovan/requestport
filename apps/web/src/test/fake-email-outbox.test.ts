import { captureE2EMagicLink, clearE2EMagicLinks } from "@requestport/auth/e2e";
import { afterEach, describe, expect, test } from "vitest";

import { createFakeEmailOutboxHandlers } from "./fake-email-outbox.js";

const token = "e2e-token-that-is-at-least-thirty-two-characters";
const enabledEnv = {
  NODE_ENV: "development",
  REQUESTPORT_E2E_MODE: "1",
  REQUESTPORT_E2E_TOKEN: token,
};

function request(
  method: "DELETE" | "POST",
  { authorization = token, email = "Person@Example.invalid" } = {},
) {
  return new Request("http://127.0.0.1:3100/api/test/email-outbox", {
    method,
    headers: {
      "content-type": "application/json",
      "x-requestport-e2e-token": authorization,
    },
    body: method === "POST" ? JSON.stringify({ email }) : undefined,
  });
}

afterEach(() => {
  clearE2EMagicLinks(enabledEnv);
});

describe("guarded fake email outbox route", () => {
  test("returns the latest normalized recipient entry only with the exact token", async () => {
    captureE2EMagicLink(
      {
        email: "person@example.invalid",
        url: "http://127.0.0.1:3100/api/auth/magic-link/verify?credential=test-only",
      },
      enabledEnv,
    );
    const handlers = createFakeEmailOutboxHandlers(enabledEnv);

    const response = await handlers.POST(request("POST"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      url: "http://127.0.0.1:3100/api/auth/magic-link/verify?credential=test-only",
    });
  });

  test.each([
    ["missing token", ""],
    ["wrong token", `${token}-wrong`],
  ])("returns the same 404 for a %s", async (_name, authorization) => {
    const response = await createFakeEmailOutboxHandlers(enabledEnv).POST(
      request("POST", { authorization }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.text()).resolves.toBe("Not found");
  });

  test("returns 404 in production even when the test flags and token are present", async () => {
    const response = await createFakeEmailOutboxHandlers({
      ...enabledEnv,
      NODE_ENV: "production",
    }).POST(request("POST"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  test("clears only the in-process E2E outbox after exact authorization", async () => {
    captureE2EMagicLink(
      {
        email: "person@example.invalid",
        url: "http://127.0.0.1:3100/test-only-credential",
      },
      enabledEnv,
    );
    const handlers = createFakeEmailOutboxHandlers(enabledEnv);

    const clearResponse = await handlers.DELETE(request("DELETE"));
    const lookupResponse = await handlers.POST(request("POST"));

    expect(clearResponse.status).toBe(204);
    expect(lookupResponse.status).toBe(404);
  });
});
