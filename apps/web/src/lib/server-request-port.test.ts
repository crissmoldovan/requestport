import type { Storage } from "@requestport/db";
import { afterEach, describe, expect, test, vi } from "vitest";

/*
 * The web's composition root (manifest-g.md §2.9; G.1): the one application
 * storage this process runs on, which Better Auth's installer asks the same
 * function for (`packages/auth/src/create-auth.test.ts` holds that half).
 * The wiring builds it the first time it is asked, and keeps it for the
 * process (G.5).
 */

/** Where role-guard.ts keeps this process's declaration. */
const DECLARATION = Symbol.for("requestport.database-surface");

/** Where `@requestport/db/wiring` keeps each root's storage, one per surface. */
const ROOT_STORAGES = Symbol.for("requestport.root-storages");

type Holder = Record<symbol, unknown>;

/*
 * Loaded once, before any case runs, so the cold import of `@requestport/db`'s
 * module graph is not spent from the first case's budget. The cases that
 * replace the wiring, or load the root afresh, call `vi.resetModules()`
 * themselves, so they do not depend on another case having run first.
 */
const { webStorage } = await import("./server-request-port.js");
const { applicationStorageFromEnv } = await import("@requestport/db/wiring");
const { DatabaseSurfaceError } = await import("@requestport/db");
const { testPool } = await import("@requestport/db/testing");

/** Closes the storages the roots hold, and forgets them. */
async function releaseRootStorages() {
  const holder = globalThis as Holder;
  const held = holder[ROOT_STORAGES] as
    | Partial<Record<string, Storage>>
    | undefined;

  delete holder[ROOT_STORAGES];
  await Promise.all(
    Object.values(held ?? {}).map((storage) => storage?.close()),
  );
}

afterEach(async () => {
  vi.doUnmock("@requestport/db/wiring");
  vi.unstubAllEnvs();
  vi.resetModules();
  await releaseRootStorages();
});

describe("the web root", () => {
  test("is the web process's one application storage, the one the wiring builds for it", () => {
    // Until G.5 the package also built a default storage as it loaded, and
    // this case showed the root's was not that one. The package builds none
    // now (`packages/db/src/client.test.ts`, "importing the package").
    const storage = webStorage();

    expect(storage).toBe(applicationStorageFromEnv());
    expect(webStorage()).toBe(storage);
  });

  test("asks for nothing as it is imported, and for the storage once it is called", async () => {
    vi.resetModules();
    const askedFor = vi.fn(() => ({ db: {} }));
    vi.doMock("@requestport/db/wiring", () => ({
      applicationStorageFromEnv: askedFor,
    }));

    const root = await import("./server-request-port.js");

    expect(askedFor).not.toHaveBeenCalled();
    root.webStorage();
    expect(askedFor).toHaveBeenCalledTimes(1);
  });

  test("throws, rather than return a storage, in a process that has declared nothing", () => {
    const holder = globalThis as Holder;
    const declared = holder[DECLARATION];

    delete holder[DECLARATION];
    try {
      expect(() => webStorage()).toThrow(DatabaseSurfaceError);
    } finally {
      holder[DECLARATION] = declared;
    }
    expect(webStorage().db).toBeDefined();
  });

  test("answers the same storage from a fresh copy of its module graph, as from a bundler's second copy (§2.12)", async () => {
    const storage = webStorage();

    vi.resetModules();
    const fresh = await import("./server-request-port.js");

    expect(fresh.webStorage()).toBe(storage);
  });

  test("builds its storage when first asked, and opens no connection: over a database nothing listens on, only its first use fails", async () => {
    const held = webStorage();

    // The storage the wiring held is closed and forgotten, so the next ask
    // builds one, under the environment as it then is.
    await releaseRootStorages();
    vi.stubEnv("REQUESTPORT_DATABASE_DRIVER", "pg");
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://requestport:requestport@127.0.0.1:1/requestport",
    );
    // The application root dials only this variable (I.2 step 5), which a
    // track's `.env.local` sets: it names nothing either.
    vi.stubEnv(
      "REQUESTPORT_APPLICATION_DATABASE_URL",
      "postgres://requestport:requestport@127.0.0.1:1/requestport",
    );

    const storage = webStorage();

    expect(storage).not.toBe(held);
    expect(storage.driver).toBe("pg");
    // No client constructed, so no connection string read and nothing dialled.
    expect(
      (testPool(storage) as unknown as { totalCount: number }).totalCount,
    ).toBe(0);
    await expect(storage.ready()).rejects.toBeInstanceOf(Error);
  });
});
