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
 * The agent keys' lifetime bound, measured against the plugin that enforces it.
 *
 * The api-key plugin reads `keyExpiration.maxExpiresIn` in days: create and
 * update both divide the requested `expiresIn` (seconds) by 86,400 and compare
 * the result with it. The composition used to set it to `365 * 24 * 60 * 60`,
 * a number of seconds, so the bound was 31,536,000 days and any lifetime was
 * issued. RequestPort's own issuance caps at 365 days before it calls the
 * plugin (`api-key-service.ts`), so this is the plugin's bound on a direct
 * call to its endpoints, which is exactly what a mock of `createApiKey` cannot
 * see. This file calls the real endpoints for that reason.
 */
const day = 24 * 60 * 60;

/*
 * `auth` is `server.ts`'s, over this process's application storage
 * (`applicationStorageFromEnv`, `@requestport/db/wiring`; manifest-g.md
 * §2.12). The rows it reads are seeded through the same storage, and the file
 * closes it when it ends.
 */
afterAll(async () => {
  await applicationStorageFromEnv().close();
});

test("refuses an agent key lifetime over 365 days, at create and at update", {
  timeout: 120_000,
}, async () => {
  const userId = `expirybound_${crypto.randomUUID()}`;
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
       values ($1, 'Expiry bound', $2, now())`,
    [userId, email],
  );

  try {
    await expect(
      auth.api.createApiKey({
        body: {
          configId: "requestport-agent",
          expiresIn: 366 * day,
          name: "Too long lived",
          userId,
        },
      }),
      "a 366-day agent key must be refused by the plugin's own bound",
    ).rejects.toMatchObject({ body: { code: "EXPIRES_IN_IS_TOO_LARGE" } });

    const created = (await auth.api.createApiKey({
      body: {
        configId: "requestport-agent",
        expiresIn: 365 * day,
        name: "A year",
        userId,
      },
    })) as { id?: unknown; key?: unknown };
    expect(
      typeof created.key,
      "a 365-day agent key is within the bound and must be issued",
    ).toBe("string");
    expect(typeof created.id).toBe("string");

    await expect(
      auth.api.updateApiKey({
        body: {
          configId: "requestport-agent",
          keyId: created.id as string,
          expiresIn: 366 * day,
          userId,
        },
      }),
      "extending an agent key past 365 days must be refused as well",
    ).rejects.toMatchObject({ body: { code: "EXPIRES_IN_IS_TOO_LARGE" } });
  } finally {
    await query(`delete from "apikey" where "reference_id" = $1`, [
      userId,
    ]).catch(() => undefined);
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
