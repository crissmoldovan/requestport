import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("publishes separate server and client entry points", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  expect(packageJson.exports).toEqual({
    ".": "./src/index.ts",
    "./auth-handler": "./src/auth-handler.ts",
    "./client": "./src/client.ts",
    "./create-auth": "./src/create-auth.ts",
    "./e2e": "./src/e2e-email-outbox.ts",
    "./server": "./src/server.ts",
  });
});
