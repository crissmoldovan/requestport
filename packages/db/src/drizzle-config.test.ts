import { afterEach, expect, test, vi } from "vitest";

const previewDatabaseUrl =
  "postgres://preview:preview@localhost:5432/requestport_preview";
const productionDatabaseUrl =
  "postgres://production:production@localhost:5432/requestport_production";

async function loadDatabaseUrl() {
  const configModule = (await import(
    new URL("../drizzle.config.ts", import.meta.url).href
  )) as {
    default: { dbCredentials?: { url?: string } };
  };

  return configModule.default.dbCredentials?.url;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("loads Preview migration configuration without unrelated auth providers", async () => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("REQUESTPORT_PREVIEW_DATABASE_URL", previewDatabaseUrl);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("BETTER_AUTH_SECRET", undefined);
  vi.stubEnv("BETTER_AUTH_URL", undefined);
  vi.stubEnv("GITHUB_CLIENT_ID", undefined);
  vi.stubEnv("GITHUB_CLIENT_SECRET", undefined);
  vi.stubEnv("RESEND_API_KEY", undefined);
  vi.stubEnv("RESEND_FROM_EMAIL", undefined);
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");

  await expect(loadDatabaseUrl()).resolves.toBe(previewDatabaseUrl);
});

test("loads the Preview database client without unrelated auth providers", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("REQUESTPORT_PREVIEW_DATABASE_URL", previewDatabaseUrl);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("BETTER_AUTH_SECRET", undefined);
  vi.stubEnv("BETTER_AUTH_URL", undefined);
  vi.stubEnv("GITHUB_CLIENT_ID", undefined);
  vi.stubEnv("GITHUB_CLIENT_SECRET", undefined);
  vi.stubEnv("RESEND_API_KEY", undefined);
  vi.stubEnv("RESEND_FROM_EMAIL", undefined);
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");

  // Importing the client builds nothing (Plan 13, G.5), so the storage a
  // root would build from this environment is built here.
  const { createStorage, storageOptionsFromEnv } = await import("./client.js");
  const storage = createStorage(storageOptionsFromEnv(process.env));

  try {
    expect(storage).toMatchObject({ db: expect.any(Object) });
  } finally {
    await storage.close();
  }
}, 30_000);

test("does not fall back to the unprefixed database in Preview", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("REQUESTPORT_PREVIEW_DATABASE_URL", undefined);
  vi.stubEnv("DATABASE_URL", productionDatabaseUrl);

  await expect(loadDatabaseUrl()).rejects.toThrow(
    "RequestPort database configuration is invalid.",
  );
});

test.each([
  "not-a-url",
  "https://localhost/requestport_preview",
  "postgres://preview:preview@localhost:5432",
])("rejects invalid Preview database URL %s", async (databaseUrl) => {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("REQUESTPORT_PREVIEW_DATABASE_URL", databaseUrl);
  vi.stubEnv("DATABASE_URL", productionDatabaseUrl);

  await expect(loadDatabaseUrl()).rejects.toThrow(
    "RequestPort database configuration is invalid.",
  );
});

test("selects the unprefixed database outside Preview", async () => {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("REQUESTPORT_PREVIEW_DATABASE_URL", previewDatabaseUrl);
  vi.stubEnv("DATABASE_URL", productionDatabaseUrl);

  await expect(loadDatabaseUrl()).resolves.toBe(productionDatabaseUrl);
});
