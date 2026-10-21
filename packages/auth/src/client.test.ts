import { expect, test } from "vitest";

test("the client public subpath loads without server-only environment values", async () => {
  const serverKeys = [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
  ] as const;
  const saved = new Map(serverKeys.map((key) => [key, process.env[key]]));
  for (const key of serverKeys) delete process.env[key];

  try {
    const clientModule = await import("@requestport/auth/client");
    expect(clientModule.authClient).toBeDefined();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 15_000);
