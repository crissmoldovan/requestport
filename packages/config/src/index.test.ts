import { afterEach, expect, test, vi } from "vitest";

const requiredEnv = {
  NODE_ENV: "test",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/requestport",
  BETTER_AUTH_SECRET: "a-very-long-test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  RESEND_API_KEY: "re_test_api_key",
  RESEND_FROM_EMAIL: "hello@example.com",
  LOG_LEVEL: "info",
} as const;

const serverOnlyEnvKeys = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "LOG_LEVEL",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("exposes the typed configuration and safe logging public API", async () => {
  for (const [key, value] of Object.entries(requiredEnv)) {
    vi.stubEnv(key, value);
  }

  const publicApi = await import("./index.js");

  expect(Object.keys(publicApi).sort()).toEqual([
    "clientEnv",
    "createLogger",
    "createMetricSink",
    "redactLogValue",
    "safeLogFields",
    "safeLogRecord",
    "serverEnv",
  ]);
});

test("exposes a client-only public entry without server configuration", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", requiredEnv.NEXT_PUBLIC_APP_URL);
  for (const key of serverOnlyEnvKeys) {
    vi.stubEnv(key, undefined);
  }
  vi.resetModules();

  const publicClientApi = await import("@requestport/config/client");

  expect(Object.keys(publicClientApi)).toEqual(["clientEnv"]);
  expect(publicClientApi.clientEnv).toEqual({
    NEXT_PUBLIC_APP_URL: requiredEnv.NEXT_PUBLIC_APP_URL,
  });
});
