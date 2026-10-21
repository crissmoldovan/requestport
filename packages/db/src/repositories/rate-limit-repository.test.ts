import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { testPool } from "../testing.js";
import { createRateLimitRepository } from "./rate-limit-repository.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

afterAll(async () => {
  await suiteStorage.close();
});

test("consumes a rate-limit token against the live Postgres schema", async () => {
  const principalFingerprint = randomUUID();
  const repository = createRateLimitRepository(suiteStorage.db);
  const input = {
    environment: "test",
    endpointClass: "auth_initiation",
    principalFingerprint,
    limit: 2,
    windowSeconds: 600,
  };

  try {
    const first = await repository.consume(input);
    const second = await repository.consume(input);
    const denied = await repository.consume(input);
    const stored = await testPool(suiteStorage).query<{ count: number }>(
      `SELECT "count" FROM "rate_limit_buckets"
       WHERE "principal_fingerprint" = $1`,
      [principalFingerprint],
    );

    expect({ first, second, denied, stored: stored.rows }).toEqual({
      first: expect.objectContaining({ allowed: true, remaining: 1 }),
      second: expect.objectContaining({ allowed: true, remaining: 0 }),
      denied: expect.objectContaining({ allowed: false, remaining: 0 }),
      stored: [{ count: 2 }],
    });
    expect(first.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(first.retryAfterSeconds).toBeLessThanOrEqual(600);
  } finally {
    await testPool(suiteStorage).query(
      `DELETE FROM "rate_limit_buckets"
       WHERE "principal_fingerprint" = $1`,
      [principalFingerprint],
    );
  }
});
