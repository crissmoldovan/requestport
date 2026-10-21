import { defineConfig } from "vitest/config";

import { loadRootEnv } from "../../scripts/with-root-env.mjs";

loadRootEnv();

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // The `test` database surface (manifest-i2.md §2.2), declared before any
    // suite is imported.
    setupFiles: ["../db/src/test-support/declare-test-surface.ts"],
    // A test file here opens the database @requestport/db tests against when it
    // queries a storage it builds over it (`createStorage`, or the application
    // root's through @requestport/db/wiring), or reaches a pool through
    // @requestport/db/testing (`testPool`, `testPoolOfHandle`). One that
    // imports only types, schema objects, or a repository factory it hands a
    // fake does not. The files are deliberately not named or counted here: an
    // earlier list in this comment was false as soon as a file was added. To
    // see the files that build a storage or reach a pool, from the repository
    // root (a listed file that never queries the storage it builds opens
    // nothing):
    //   grep -rlE --include='*.test.ts' --include='*.test.tsx' \
    //     'create(Test)?Storage\(|StorageFromEnv\(|"@requestport/db/testing"' \
    //     packages/auth/src
    //
    // This workspace's test task is not ordered after @requestport/db#test and
    // may run beside it. That ordering was tried on 2026-09-27 and removed: it
    // cost gate time, its workspace-specific turbo.json entry silently replaced
    // the generic `test` task for this workspace, and it did not help — the db
    // suite still timed out in seven of nine forced runs with the two never
    // overlapping, and no blocking lock between them was ever caught.
    //
    // The 30-second budget is for the reason given in
    // packages/db/vitest.config.ts: each of those files opens its own
    // connections, and opening one through the hosted driver took seconds on a
    // loaded host. apps/web already uses 30s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["json"],
    },
  },
});
