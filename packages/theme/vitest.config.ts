import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["json"],
    },
  },
});
