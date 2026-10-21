import { defineConfig } from "vitest/config";

import { loadRootEnv } from "../scripts/with-root-env.mjs";

loadRootEnv();

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
