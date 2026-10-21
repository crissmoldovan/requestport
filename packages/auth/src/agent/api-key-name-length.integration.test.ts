import { testPool } from "@requestport/db/testing";
import { applicationStorageFromEnv } from "@requestport/db/wiring";
import { afterAll, expect, test, vi } from "vitest";
import { auth } from "../server.js";

/*
 * The rows here are seeded through the application root's storage, and the
 * application role may not write them (it holds no INSERT on
 * `signup_allowlist`), so in this file the application
 * root dials DATABASE_URL: the application variable is set to it before
 * anything is imported, whatever the run's environment names (a track's
 * `.env.local` names its application login; Plan 13, I.2 step 5, slice 1).
 */
vi.hoisted(() => {
  if (typeof process.env.DATABASE_URL === "string") {
    process.env.REQUESTPORT_APPLICATION_DATABASE_URL = process.env.DATABASE_URL;
  }
});

/**
 * The credential name contract, measured against the library that enforces it.
 *
 * `issueInput.name` and `provision_agent`'s `displayName` both allow 160
 * characters, and the provisioning path hands the display name straight to
 * Better Auth as the credential's name. Better Auth's own default is 32, and
 * the refusal above it arrives as an `APIError` — which nothing in this
 * repository recognises, so an agent was told only that the operation failed.
 *
 * Every other test of this path supplies its own `createApiKey`, so none of
 * them could see the bound: `api-key-service.test.ts` mocks it, and a mock has
 * no opinion about name length. This one calls the real endpoint, which is the
 * only way this particular guard can fire.
 *
 * A display name of 35 characters is not unusual — "<project> worker" reaches
 * it with a two-word project — so the practical effect was that provisioning
 * failed for ordinary names and succeeded for short ones.
 */
const longName = `Agent ${"a".repeat(120)}`;

/*
 * `auth` is `server.ts`'s, over this process's application storage
 * (`applicationStorageFromEnv`, `@requestport/db/wiring`; manifest-g.md
 * §2.12). The rows it reads are seeded through the same storage, and the file
 * closes it when it ends.
 */
afterAll(async () => {
  await applicationStorageFromEnv().close();
});

test("issues a credential whose name is as long as the contract allows", {
  timeout: 120_000,
}, async () => {
  expect(longName.length).toBeGreaterThan(32);
  expect(longName.length).toBeLessThanOrEqual(160);

  const userId = `namelength_${crypto.randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const query = (text: string, values: unknown[]) =>
    testPool(applicationStorageFromEnv()).query(text, values);

  await query(
    `insert into "signup_allowlist" ("normalized_email", "status")
       values (lower($1), 'active')`,
    [email],
  );
  await query(
    `insert into "user" ("id", "name", "email", "updated_at")
       values ($1, 'Name length', $2, now())`,
    [userId, email],
  );

  try {
    const created = await auth.api.createApiKey({
      body: {
        configId: "requestport-agent",
        expiresIn: 90 * 24 * 60 * 60,
        name: longName,
        userId,
      },
    });

    expect(
      typeof (created as { key?: unknown }).key,
      "a credential must be issued for a name the contract permits",
    ).toBe("string");
  } finally {
    await query(`delete from "apikey" where "user_id" = $1`, [userId]).catch(
      () => undefined,
    );
    await query(`delete from "user" where "id" = $1`, [userId]).catch(
      () => undefined,
    );
    await query(
      `delete from "signup_allowlist"
         where lower("normalized_email") = lower($1)`,
      [email],
    ).catch(() => undefined);
  }
});
