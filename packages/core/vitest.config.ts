import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // X24's guard, as packages/db's configurations load it (X25): it fails a
    // case that issues a query on a `pg` client while another is in flight
    // on that client. It sees only `pg`'s clients, so a suite that opens
    // none is not affected by it.
    setupFiles: ["../db/src/test-support/one-query-at-a-time.ts"],
  },
});
