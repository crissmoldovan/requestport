import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's 5s default is the same number the DOM lane gives one
    // `waitFor`, so any assertion that legitimately used its whole budget
    // failed as a timeout rather than as an assertion — and a cold dynamic
    // import of a boundary module (global CSS, provider, fonts) could exceed
    // it on its own while the two lanes compete for cores. The budget is
    // raised well clear of both; nothing here waits on a wall clock, so a real
    // hang still fails, just later.
    testTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["json"],
    },
    // `@cueplusplus/tokens` publishes TypeScript source as its runtime entry,
    // so the CUE++ packages must be transformed rather than externalised.
    server: {
      deps: {
        inline: [/@cueplusplus[\\/]/u],
      },
    },
    // Lanes are routed by declared intent, not by file extension. A suite opts
    // into jsdom by naming itself `*.dom.test.ts(x)`; everything else — every
    // `renderToStaticMarkup` server-render suite included — stays in the node
    // lane, so a component that reaches for `window`/`document` at module or
    // render scope still fails here instead of in a Next.js server render.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.dom.test.{ts,tsx}"],
          // The `test` database surface (manifest-i2.md §2.2): this lane's
          // tests of the web root ask it for its storage, which it builds
          // only in a declared process. The scenario-hook suite and the
          // Slack connection test's database suite open the database through
          // storages they build. The dom lane opens nothing. Then X24's
          // guard, as packages/db's configurations load it (X25): it fails a
          // case that issues a query on a `pg` client while another is in
          // flight on that client.
          setupFiles: [
            "../../packages/db/src/test-support/declare-test-surface.ts",
            "../../packages/db/src/test-support/one-query-at-a-time.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.dom.test.{ts,tsx}"],
          setupFiles: ["./src/test/setup-dom.ts"],
        },
      },
    ],
  },
});
