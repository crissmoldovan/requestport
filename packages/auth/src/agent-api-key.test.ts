import { randomUUID } from "node:crypto";
import { createStorage, identitySchema } from "@requestport/db";
import { testPool } from "@requestport/db/testing";
import { storageOptionsFromEnv } from "@requestport/db/wiring";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, describe, expect, test } from "vitest";

import { createAuthOptions } from "./server-options.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage(storageOptionsFromEnv(process.env));

afterAll(async () => {
  await suiteStorage.close();
});

// Agent credentials are Better Auth api keys, and the api key model was
// unreachable through the adapter for the same reason dynamic client
// registration was: Better Auth calls the model `apikey`. Nothing in this
// repository exercised it through Better Auth — the credential suites insert
// `apikey` rows with raw SQL and read them with Drizzle — so every agent bearer
// request failed the same way and no test noticed.
function createAuth() {
  return betterAuth(
    createAuthOptions({
      database: drizzleAdapter(suiteStorage.db, {
        provider: "pg",
        schema: identitySchema,
        transaction: true,
      }),
      env: {
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "api-key-integration-secret".padEnd(32, "!"),
        BETTER_AUTH_URL: "https://requestport.com",
      },
      assertSignupAllowed: async () => ({ allowed: true }),
      sendMagicLink: async () => undefined,
    }),
  );
}

async function seedUser() {
  const userId = `user_${randomUUID()}`;
  const email = `${userId}@example.invalid`;
  await testPool(suiteStorage).query(
    `INSERT INTO "signup_allowlist" ("normalized_email", "status")
     VALUES ($1, 'active')`,
    [email],
  );
  await testPool(suiteStorage).query(
    'INSERT INTO "user" ("id", "name", "email", "updated_at")' +
      " VALUES ($1, 'Api key owner', $2, now())",
    [userId, email],
  );
  return { userId, email };
}

describe("agent api keys through Better Auth", () => {
  test("issues a key the bearer path can then verify", async () => {
    const auth = createAuth();
    const { userId, email } = await seedUser();

    try {
      const created = await auth.api.createApiKey({
        body: {
          name: "Agent credential",
          userId,
          configId: "requestport-agent",
          // Seconds, while the configured minimum is in days.
          expiresIn: 7 * 24 * 60 * 60,
        },
      });

      expect(created.key).toMatch(/^rp_/u);

      await expect(
        auth.api.verifyApiKey({
          body: { key: created.key, configId: "requestport-agent" },
        }),
      ).resolves.toMatchObject({ valid: true });

      // A key that was never issued must not verify, or "valid" means nothing.
      await expect(
        auth.api.verifyApiKey({
          body: {
            key: `rp_${randomUUID()}`,
            configId: "requestport-agent",
          },
        }),
      ).resolves.toMatchObject({ valid: false });
    } finally {
      await testPool(suiteStorage).query('DELETE FROM "user" WHERE "id" = $1', [
        userId,
      ]);
      await testPool(suiteStorage).query(
        'DELETE FROM "signup_allowlist" WHERE "normalized_email" = $1',
        [email],
      );
    }
  });
});
