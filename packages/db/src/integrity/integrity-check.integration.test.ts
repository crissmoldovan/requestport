import { afterAll, expect, test } from "vitest";

import { createStorage, storageOptionsFromEnv } from "../client.js";
import { tenantWrappingEnabled } from "../tenant-context.js";
import { runIntegrityCheck } from "./integrity-check.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

afterAll(async () => {
  await suiteStorage.close();
});

test("executes every staging integrity query without a type-resolution error", async () => {
  const result = await runIntegrityCheck({ database: suiteStorage.db });

  expect(result.checks).toHaveLength(16);
  expect(result.checks.map((check) => check.name)).toContain(
    "webhook_filter_project_reference",
  );
});
