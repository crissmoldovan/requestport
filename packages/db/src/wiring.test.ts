import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applicationStorageOptionsFromEnv as clientApplicationStorageOptionsFromEnv,
  storageOptionsFromEnv as clientStorageOptionsFromEnv,
  createStorage,
  type Storage,
  type StorageOptions,
} from "./client.js";
import { UNOVERRIDABLE_PG_VARIABLES } from "./database-url.js";
import {
  createDatabaseRoleGuard,
  DatabaseSurfaceError,
  declaredDatabaseSurface,
  ROLE_GUARD_MODES,
  resetDatabaseSurfaceDeclaration,
  UNDECLARED_SURFACE_MESSAGE,
  WORKER_ROLE_GUARD_MODES,
} from "./role-guard.js";
import { tenantWrappingEnabled } from "./tenant-context.js";
import {
  applicationStorageFromEnv,
  applicationStorageOptionsFromEnv,
  assertDeclaredDatabaseSurface,
  hostConstructionToken,
  installHostHandoff,
  rootStorageFromEnv,
  storageOptionsFromEnv,
  withHostConstructionToken,
} from "./wiring.js";

/*
 * The roots' wiring (manifest-g.md §2.2, §2.9, §2.12; track-g.md, G.0a): the
 * synchronous declaration check each composition root makes before it
 * builds, and the storage each root builds on first use and keeps for the
 * process.
 *
 * Every case that clears the declaration puts this package's `test` back,
 * through `resetDatabaseSurfaceDeclaration`, which only tests may call. Every
 * case ends by closing and forgetting the storages the roots built, where
 * `wiring.ts` keeps them (`releaseRootStorages`, below), so the next case's
 * root builds afresh under that case's environment.
 */

/** Where `wiring.ts` keeps each root's storage: one per surface, on `globalThis`. */
const ROOT_STORAGES = Symbol.for("requestport.root-storages");

type RootStorageHolder = Record<
  symbol,
  Partial<Record<string, Storage>> | undefined
>;

/** Closes the storages the roots hold, and forgets them. */
async function releaseRootStorages() {
  const holder = globalThis as RootStorageHolder;
  const held = holder[ROOT_STORAGES];

  delete holder[ROOT_STORAGES];
  await Promise.all(
    Object.values(held ?? {}).map((storage) => storage?.close()),
  );
}

afterEach(async () => {
  resetDatabaseSurfaceDeclaration("test");
  await releaseRootStorages();
  vi.doUnmock("./client.js");
  vi.resetModules();
});

const ROOT_SURFACES = ["application", "worker", "operator"] as const;

/**
 * `./wiring.js` from a fresh module graph whose `./client.js` records the
 * options of each `createStorage` call made through it, with the real
 * `./client.js` of that graph beside it, and that graph's `./role-guard.js`,
 * whose error class the wiring throws. `client.ts` builds no storage of its
 * own as it loads, so what the record holds is what the roots built (Done
 * when 3, with the spy on `createStorage`: ruling 122's note). Mocked for
 * this graph only: `vi.doMock`, undone after each case.
 */
async function wiringRecordingStorages() {
  const built: StorageOptions[] = [];
  const graph: { client?: typeof import("./client.js") } = {};

  vi.doMock("./client.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./client.js")>();

    graph.client = actual;
    return {
      ...actual,
      createStorage: (options: StorageOptions) => {
        built.push(options);
        return actual.createStorage(options);
      },
    };
  });
  vi.resetModules();
  const wiring = await import("./wiring.js");
  const roleGuard = await import("./role-guard.js");

  return {
    wiring,
    roleGuard,
    built,
    client: graph.client as typeof import("./client.js"),
  };
}

describe("the roots' declaration check (§2.9, M4 as ruling 71 holds it)", () => {
  test("refuses a process that has declared nothing, naming the root's surface", () => {
    resetDatabaseSurfaceDeclaration();

    for (const surface of ROOT_SURFACES) {
      expect(() => assertDeclaredDatabaseSurface(surface), surface).toThrow(
        DatabaseSurfaceError,
      );
      expect(() => assertDeclaredDatabaseSurface(surface), surface).toThrow(
        `declareDatabaseSurface("${surface}")`,
      );
    }
  });

  test("refuses a process declared as another surface", () => {
    for (const declared of ROOT_SURFACES) {
      resetDatabaseSurfaceDeclaration(declared);

      for (const surface of ROOT_SURFACES.filter((s) => s !== declared)) {
        expect(
          () => assertDeclaredDatabaseSurface(surface),
          `${declared} asked as ${surface}`,
        ).toThrow(`declared as ${declared}`);
      }
    }
  });

  test("passes the root's own surface, and test, which only a Vitest setup declares", () => {
    for (const surface of ROOT_SURFACES) {
      resetDatabaseSurfaceDeclaration(surface);
      expect(assertDeclaredDatabaseSurface(surface)).toBe(surface);
    }

    resetDatabaseSurfaceDeclaration("test");
    for (const surface of ROOT_SURFACES) {
      expect(assertDeclaredDatabaseSurface(surface)).toBe("test");
    }
  });

  test("is synchronous, and declares nothing itself", () => {
    resetDatabaseSurfaceDeclaration();

    expect(() => assertDeclaredDatabaseSurface("worker")).toThrow(
      DatabaseSurfaceError,
    );
    expect(declaredDatabaseSurface()).toBeUndefined();
  });
});

describe("each root's storage, built on first use (§2.9, §2.12)", () => {
  test("in a process that has declared nothing, a root throws rather than build a storage: createStorage is not called (Done when 3)", async () => {
    const { wiring, roleGuard, built } = await wiringRecordingStorages();

    resetDatabaseSurfaceDeclaration();
    for (const surface of ROOT_SURFACES) {
      expect(() => wiring.rootStorageFromEnv(surface), surface).toThrow(
        roleGuard.DatabaseSurfaceError,
      );
    }
    expect(() => wiring.applicationStorageFromEnv()).toThrow(
      roleGuard.DatabaseSurfaceError,
    );
    expect(built).toEqual([]);
  });

  test("once the surface is declared, a root builds its storage on the first ask, once, and answers that storage on every later one", async () => {
    const { wiring, built } = await wiringRecordingStorages();

    // Loading the wiring built nothing.
    expect(built).toEqual([]);
    for (const surface of ROOT_SURFACES) {
      resetDatabaseSurfaceDeclaration(surface);

      const storage = wiring.rootStorageFromEnv(surface);

      expect(wiring.rootStorageFromEnv(surface), surface).toBe(storage);
    }
    resetDatabaseSurfaceDeclaration("application");
    expect(wiring.applicationStorageFromEnv()).toBe(
      wiring.rootStorageFromEnv("application"),
    );
    // One storage per surface: a deployed process declares one surface, so
    // it holds one; this Vitest process asked for all three.
    expect(built).toHaveLength(ROOT_SURFACES.length);
  });

  test("builds the application's from applicationStorageOptionsFromEnv(process.env) and every other root's from storageOptionsFromEnv(process.env), with a role guard of its own, in the worker's modes where the worker surface is declared and in ROLE_GUARD_MODES elsewhere, the application's \"wrapped\" and every other's with the tenantBinding tenantWrappingEnabled gives", async () => {
    // Two different URLs, so the two readers answer apart.
    setEnv({
      DATABASE_URL: "postgresql://owner:p@owner.example/owner-db",
      REQUESTPORT_APPLICATION_DATABASE_URL:
        "postgresql://app:p@app.example/app-db",
      VERCEL_ENV: undefined,
    });
    const { wiring, built } = await wiringRecordingStorages();
    const expectedFor = (surface: (typeof ROOT_SURFACES)[number]) =>
      surface === "application"
        ? applicationStorageOptionsFromEnv(process.env)
        : storageOptionsFromEnv(process.env);
    const readerOf = (options: StorageOptions) =>
      typeof options.connectionString === "function"
        ? options.connectionString()
        : options.connectionString;

    for (const surface of ROOT_SURFACES) {
      resetDatabaseSurfaceDeclaration(surface);
      wiring.rootStorageFromEnv(surface);
    }

    expect(built).toHaveLength(ROOT_SURFACES.length);
    for (const [index, options] of built.entries()) {
      const { connectionString, guard, tenantBinding, ...rest } = options;
      const expected = expectedFor(ROOT_SURFACES[index] ?? "application");
      const { connectionString: expectedConnectionString, ...expectedRest } =
        expected;

      expect(rest, ROOT_SURFACES[index]).toEqual(expectedRest);
      expect(typeof connectionString).toBe(typeof expectedConnectionString);
      // The same reader: it answers the URL this environment names, read
      // now, as the root's pool would read it when it connects.
      expect(readerOf(options)).toBe(readerOf(expected));
      expect(readerOf(options), ROOT_SURFACES[index]).toBe(
        ROOT_SURFACES[index] === "application"
          ? "postgresql://app:p@app.example/app-db"
          : "postgresql://owner:p@owner.example/owner-db",
      );
      expect(tenantBinding, ROOT_SURFACES[index]).toBe(
        ROOT_SURFACES[index] === "application" ||
          tenantWrappingEnabled(process.env)
          ? "wrapped"
          : "off",
      );
      // A guard reads the declaration when it is asked, so each is asked
      // under its own root's surface (Plan 13, I.2b's b5; ruling 214 item 2).
      resetDatabaseSurfaceDeclaration(ROOT_SURFACES[index]);
      expect(guard?.modes, ROOT_SURFACES[index]).toEqual(
        ROOT_SURFACES[index] === "worker"
          ? WORKER_ROLE_GUARD_MODES
          : ROLE_GUARD_MODES,
      );
      expect(typeof guard?.beforeConnect).toBe("function");
    }
    // A guard of its own for each storage.
    expect(new Set(built.map((options) => options.guard)).size).toBe(
      ROOT_SURFACES.length,
    );
  });

  test("building it opens no connection: over a database nothing listens on, the root builds, and only its first use fails", async () => {
    // pg refuses these before it reads the connection string; none is set.
    // The application root reads only the application variable (I.2 step
    // 5), so that is the one pointed at the unreachable server.
    setEnv({
      ...Object.fromEntries(
        UNOVERRIDABLE_PG_VARIABLES.map((name) => [name, undefined]),
      ),
      REQUESTPORT_DATABASE_DRIVER: "pg",
      REQUESTPORT_APPLICATION_DATABASE_URL:
        "postgresql://u:p@127.0.0.1:1/unreachable",
      VERCEL_ENV: undefined,
      DATABASE_URL: "postgresql://u:p@127.0.0.1:1/unreachable",
    });
    const { wiring, built, client } = await wiringRecordingStorages();

    const storage = wiring.applicationStorageFromEnv();

    expect(built).toHaveLength(1);
    // No client constructed, so no connection string read and nothing dialled.
    expect(client.driverPoolOf(storage).totalCount).toBe(0);
    await expect(storage.ready()).rejects.toBeInstanceOf(Error);
  });

  test("once the surface is declared, a root answers one storage for its surface, the same in every module graph of the process (§2.12)", async () => {
    resetDatabaseSurfaceDeclaration("application");
    const storage = applicationStorageFromEnv();

    vi.resetModules();
    const fresh = await import("./wiring.js");

    // The same object, from a copy of the module this file never loaded
    // before: a bundler's second copy would answer it too.
    expect(fresh.applicationStorageFromEnv()).toBe(storage);
    expect(fresh.rootStorageFromEnv("application")).toBe(storage);
  });

  test("carries storageOptionsFromEnv and applicationStorageOptionsFromEnv, client.ts's, the two the roots build from", () => {
    expect(storageOptionsFromEnv).toBe(clientStorageOptionsFromEnv);
    expect(applicationStorageOptionsFromEnv).toBe(
      clientApplicationStorageOptionsFromEnv,
    );
  });
});

/*
 * The second half of Done when 3 (manifest-g.md §2.9, Revision 3): the guard
 * reads the declaration when it checks, so the case is a query made while
 * nothing is declared, on a guard built with no surface of its own. The
 * refusal comes from reading the connection string, before anything is
 * dialled, so the address is one nothing listens on.
 */
describe("a guarded storage used before any declaration (§2.9)", () => {
  test("in the guard's default modes, as in enforce mode, its first query is refused with the undeclared message", async () => {
    // pg refuses these before it reads the connection string; none is set.
    setEnv(
      Object.fromEntries(
        UNOVERRIDABLE_PG_VARIABLES.map((name) => [name, undefined]),
      ),
    );
    resetDatabaseSurfaceDeclaration();

    for (const modes of [
      {},
      { declaration: "enforce", role: "enforce", environment: "enforce" },
    ] as const) {
      const storage = createStorage({
        driver: "pg",
        connectionString: "postgresql://u:p@127.0.0.1:1/undeclared",
        guard: createDatabaseRoleGuard({
          env: {},
          modes,
          write: () => undefined,
        }),
      });

      try {
        const refusal = await storage.db.execute(sql`select 1`).then(
          () => undefined,
          (error: unknown) => error,
        );
        const messages: string[] = [];

        for (
          let current: unknown = refusal;
          current instanceof Error;
          current = current.cause
        ) {
          messages.push(current.message);
        }
        expect(messages.join(" <- "), JSON.stringify(modes)).toContain(
          UNDECLARED_SURFACE_MESSAGE,
        );
      } finally {
        await storage.close();
      }
    }
  });
});

/*
 * The environment a case sets, put back after it, and a client built as a
 * pool builds one. Each root's storage against the rule a storage is built
 * by from this process's environment with REQUESTPORT_DATABASE_DRIVER unset,
 * in every VERCEL_ENV case (G.1's neutrality, manifest-g.md §5), is the
 * private tree's hosted-driver.test.ts's to judge, as it stood before J.2b:
 * its cases hold that default to the hosted driver. Here each root is judged
 * on this run's own driver.
 */
const touched = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!touched.has(key)) touched.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of touched) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touched.clear();
});

function newClientOf(pool: object) {
  const { Client, options } = pool as {
    Client: new (config?: unknown) => object;
    options: unknown;
  };
  return new Client(options);
}

describe("each root's storage options are storageOptionsFromEnv(process.env)'s", () => {
  test("this run's own driver, as the gate selects it", () => {
    for (const surface of ROOT_SURFACES) {
      resetDatabaseSurfaceDeclaration(surface);
      expect(rootStorageFromEnv(surface).driver, surface).toBe(
        storageOptionsFromEnv(process.env).driver,
      );
    }
  });
});

describe("each root's storage carries the role guard", () => {
  test("reading its connection string runs the guard's declaration check, which refuses a process that has declared nothing and writes no line: each root's storage", async () => {
    // pg refuses these before it reads the connection string; none is set.
    setEnv(
      Object.fromEntries(
        UNOVERRIDABLE_PG_VARIABLES.map((name) => [name, undefined]),
      ),
    );
    await releaseRootStorages();
    vi.resetModules();
    const client = await import("./client.js");
    const wiring = await import("./wiring.js");
    const roleGuard = await import("./role-guard.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused: string[] = [];

    try {
      for (const surface of ROOT_SURFACES) {
        resetDatabaseSurfaceDeclaration(surface);
        const storage = wiring.rootStorageFromEnv(surface);

        // The check reads the declaration when a client is built: with none,
        // the guard refuses the read. PGlite reads no connection string; its
        // guard runs as it starts.
        resetDatabaseSurfaceDeclaration();
        if (storage.driver !== "pglite") {
          expect(
            () => newClientOf(client.driverPoolOf(storage)),
            surface,
          ).toThrow(roleGuard.DatabaseRoleGuardError);
          expect(
            () => newClientOf(client.driverPoolOf(storage)),
            surface,
          ).toThrow(UNDECLARED_SURFACE_MESSAGE);
          refused.push(surface);
        }
      }

      // One refusal from each root's storage's own guard, and no line.
      expect(refused).toEqual(
        storageOptionsFromEnv(process.env).driver === "pglite"
          ? []
          : [...ROOT_SURFACES],
      );
      expect(
        warn.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.includes("database.role_guard.declaration")),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
      await releaseRootStorages();
      vi.resetModules();
    }
  });
});

/*
 * The host's handoff in the roots' wiring (Plan 13, H.5; manifest-h.md
 * §2.7.1; rulings 141, 145 and 160). While
 * `globalThis[Symbol.for("requestport.host")]` is set, the application root
 * answers the storage it carries and builds none, and holds none in G's
 * holder; a handoff without one is refused there, by name, with one console
 * line. The reader that root uses, `hostHandoffMember`, answers the same
 * way for any member.
 */
describe("the roots' wiring and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const handoffHolder = globalThis as Record<symbol, unknown>;

  afterEach(() => {
    delete handoffHolder[HOST];
    vi.restoreAllMocks();
  });

  /** Captures console.error's lines, and prints none. */
  function consoleErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  /** What `run` threw, or undefined when it returned. */
  function thrownBy(run: () => unknown): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test("absent, hostHandoffMember answers undefined for every member, and the application root builds as it always has", async () => {
    const { wiring, built } = await wiringRecordingStorages();
    resetDatabaseSurfaceDeclaration("application");

    expect(HOST in handoffHolder).toBe(false);
    for (const member of ["requestPort", "auth", "storage"] as const) {
      expect(wiring.hostHandoffMember("a test", member), member).toBe(
        undefined,
      );
    }
    wiring.rootStorageFromEnv("application");
    expect(built).toHaveLength(1);
  });

  test("present, the application root answers the handoff's storage in every module graph, builds none and holds none", async () => {
    const { wiring, built } = await wiringRecordingStorages();
    const storage = { the: "host's storage" } as unknown as Storage;
    handoffHolder[HOST] = { storage };
    resetDatabaseSurfaceDeclaration("application");

    expect(wiring.rootStorageFromEnv("application")).toBe(storage);
    expect(wiring.applicationStorageFromEnv()).toBe(storage);
    vi.resetModules();
    const fresh = await import("./wiring.js");
    expect(fresh.applicationStorageFromEnv()).toBe(storage);
    expect(built).toEqual([]);
    expect(ROOT_STORAGES in globalThis).toBe(false);
  });

  test("present without a storage, the application root refuses with HostHandoffRefusalError and one console line naming it, and builds none, though the handoff would admit a construction", async () => {
    const logged = consoleErrors();
    const { wiring, built } = await wiringRecordingStorages();
    handoffHolder[HOST] = {
      requestPort: {},
      auth: {},
      admitsConstruction: () => true,
    };
    resetDatabaseSurfaceDeclaration("application");

    const refusal = thrownBy(() => wiring.applicationStorageFromEnv());
    const line =
      "HostHandoffRefusalError: RequestPort's application root " +
      "(rootStorageFromEnv) refused: the host's handoff is present, and it " +
      "carries no storage. While it is present, the web answers the " +
      "storage, Better Auth and RequestPort it carries and builds none of " +
      "its own (manifest-h.md §2.7.1).";

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
      line,
    );
    expect(logged.mock.calls).toEqual([[line]]);
    expect(built).toEqual([]);
    expect(ROOT_STORAGES in globalThis).toBe(false);
  });

  test("present, the declaration check still comes first: a process that has declared nothing is refused before the handoff is read", async () => {
    const { wiring, roleGuard } = await wiringRecordingStorages();
    handoffHolder[HOST] = { storage: {} };
    resetDatabaseSurfaceDeclaration();

    expect(() => wiring.applicationStorageFromEnv()).toThrow(
      roleGuard.DatabaseSurfaceError,
    );
  });

  test("present, the worker and operator roots are not answered from it: the storage they would build meets createStorage's refusal", async () => {
    const logged = consoleErrors();
    handoffHolder[HOST] = { storage: {}, admitsConstruction: () => false };

    for (const surface of ["worker", "operator"] as const) {
      resetDatabaseSurfaceDeclaration(surface);
      const refusal = thrownBy(() => rootStorageFromEnv(surface));

      expect((refusal as Error).name, surface).toBe("HostHandoffRefusalError");
      expect((refusal as Error).message, surface).toContain(
        "RequestPort's createStorage refused",
      );
    }
    expect(logged).toHaveBeenCalledTimes(2);
    expect(ROOT_STORAGES in globalThis).toBe(false);
  });

  test("present, hostHandoffMember answers each member the handoff carries, and refuses one it does not carry, naming the site and the member, with one console line", async () => {
    const logged = consoleErrors();
    const { wiring } = await wiringRecordingStorages();
    const members = { requestPort: { a: 1 }, auth: { b: 2 }, storage: {} };
    handoffHolder[HOST] = members;

    for (const member of ["requestPort", "auth", "storage"] as const) {
      expect(wiring.hostHandoffMember("a test", member), member).toBe(
        members[member],
      );
    }
    expect(logged).not.toHaveBeenCalled();

    handoffHolder[HOST] = { storage: {} };
    const refusal = thrownBy(() =>
      wiring.hostHandoffMember("webRequestPort()", "requestPort"),
    );

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect((refusal as Error).message).toMatch(
      /^RequestPort's webRequestPort\(\) refused: the host's handoff is present, and it carries no requestPort\. /u,
    );
    expect(logged.mock.calls).toEqual([
      [`HostHandoffRefusalError: ${(refusal as Error).message}`],
    ]);
  });

  test("a handoff that is not an object carries no member: each reader refuses", async () => {
    consoleErrors();
    const { wiring } = await wiringRecordingStorages();

    for (const value of [null, true, "handoff", 1]) {
      handoffHolder[HOST] = value;
      expect(
        (thrownBy(() => wiring.hostHandoffMember("a test", "auth")) as Error)
          .name,
        String(value),
      ).toBe("HostHandoffRefusalError");
    }
  });

  test("a member that is null is a member the handoff does not carry: the reader refuses it", async () => {
    const logged = consoleErrors();
    const { wiring } = await wiringRecordingStorages();
    handoffHolder[HOST] = { auth: null, storage: null };

    for (const member of ["auth", "storage"] as const) {
      expect(
        (thrownBy(() => wiring.hostHandoffMember("a test", member)) as Error)
          .message,
        member,
      ).toContain(`it carries no ${member}`);
    }
    expect(logged).toHaveBeenCalledTimes(2);
  });

  test("withHostConstructionToken hands back the options it is given when there is no token, and otherwise a copy carrying it under a symbol, the original unchanged", () => {
    const options = { driver: "pg" as const, connectionString: "x" };
    const token = Object.freeze({});

    expect(withHostConstructionToken(options, undefined)).toBe(options);
    const carried = withHostConstructionToken(options, token);

    expect(carried).not.toBe(options);
    // Its string-keyed members, compared alone: toEqual compares symbol keys.
    expect(Object.fromEntries(Object.entries(carried))).toEqual(options);
    expect(Object.keys(carried)).toEqual(Object.keys(options));
    expect(Object.getOwnPropertySymbols(carried).map(String)).toEqual([
      "Symbol(requestport.host-construction-token)",
    ]);
    expect(
      (carried as unknown as Record<symbol, unknown>)[
        Symbol.for("requestport.host-construction-token")
      ],
    ).toBe(token);
    expect(Object.getOwnPropertySymbols(options)).toEqual([]);
  });

  /*
   * The host's side (`requestport start`'s serving composition,
   * `apps/requestport/src/serve/serve.ts`): the token only its closure holds,
   * and the handoff it sets and takes back.
   */
  const hostMembers = () => ({
    requestPort: { the: "host's RequestPort" },
    auth: { the: "host's Better Auth" },
    storage: { the: "host's storage" } as unknown as Storage,
  });

  test("installHostHandoff sets the members it is handed, frozen, with admitsConstruction, and never the token", () => {
    const token = hostConstructionToken();
    const members = hostMembers();

    installHostHandoff(members, token);

    const installed = handoffHolder[HOST] as Record<string, unknown>;
    expect(Object.keys(installed).sort()).toEqual([
      "admitsConstruction",
      "auth",
      "requestPort",
      "storage",
    ]);
    expect(installed.requestPort).toBe(members.requestPort);
    expect(installed.auth).toBe(members.auth);
    expect(installed.storage).toBe(members.storage);
    expect(Object.isFrozen(installed)).toBe(true);
    expect(Object.values(installed)).not.toContain(token);
  });

  test("the handoff admits its own token and nothing else: not another token, not an equal object, not undefined", () => {
    const token = hostConstructionToken();
    installHostHandoff(hostMembers(), token);

    const { admitsConstruction } = handoffHolder[HOST] as {
      admitsConstruction: (candidate: unknown) => boolean;
    };
    expect(Object.isFrozen(token)).toBe(true);
    expect(admitsConstruction(token)).toBe(true);
    expect(admitsConstruction(hostConstructionToken())).toBe(false);
    expect(admitsConstruction({})).toBe(false);
    expect(admitsConstruction(undefined)).toBe(false);
  });

  test("installHostHandoff refuses while a handoff is set: one process serves one instance", () => {
    installHostHandoff(hostMembers(), hostConstructionToken());

    expect(() =>
      installHostHandoff(hostMembers(), hostConstructionToken()),
    ).toThrow(
      "The host's handoff is already set in this process: one process serves one instance.",
    );
  });

  test("what installHostHandoff answers takes back the handoff it set, and leaves one it did not set alone", () => {
    const remove = installHostHandoff(hostMembers(), hostConstructionToken());
    remove();
    expect(HOST in handoffHolder).toBe(false);

    const foreign = { storage: {} };
    handoffHolder[HOST] = foreign;
    remove();
    expect(handoffHolder[HOST]).toBe(foreign);
  });

  test("with the host's handoff set, createStorage builds for options carrying its token, and refuses, by name, options without it", async () => {
    const logged = consoleErrors();
    const token = hostConstructionToken();
    installHostHandoff(hostMembers(), token);

    const built = createStorage({
      driver: "pglite",
      dataDir: "memory://",
      ...withHostConstructionToken({}, token),
    });
    try {
      expect(built.driver).toBe("pglite");
    } finally {
      await built.close();
    }
    expect(logged).not.toHaveBeenCalled();
    const refusal = thrownBy(() =>
      createStorage({ driver: "pglite", dataDir: "memory://" }),
    );
    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect((refusal as Error).message).toMatch(
      /^RequestPort's createStorage refused: /u,
    );
    expect(logged).toHaveBeenCalledTimes(1);
  });

  /*
   * `requestport start` on PGlite declares `embedded` (ruling 73), and Next,
   * served in the same process, asks its application root for a storage
   * (ruling 141): with the handoff set, that root answers the handoff's
   * storage there too.
   */
  test("in a process declared embedded, with the handoff present, the application root answers the handoff's storage and builds none", async () => {
    const { wiring, built } = await wiringRecordingStorages();
    const storage = { the: "host's PGlite storage" } as unknown as Storage;
    handoffHolder[HOST] = { storage };
    resetDatabaseSurfaceDeclaration("embedded");

    expect(wiring.assertDeclaredDatabaseSurface("application")).toBe(
      "embedded",
    );
    expect(wiring.applicationStorageFromEnv()).toBe(storage);
    vi.resetModules();
    const fresh = await import("./wiring.js");
    expect(fresh.applicationStorageFromEnv()).toBe(storage);
    expect(built).toEqual([]);
    expect(ROOT_STORAGES in globalThis).toBe(false);
  });

  test("in a process declared embedded, without the handoff, the application root is refused by the declaration check, as before", async () => {
    const { wiring, roleGuard, built } = await wiringRecordingStorages();
    resetDatabaseSurfaceDeclaration("embedded");

    expect(HOST in handoffHolder).toBe(false);
    expect(() => wiring.applicationStorageFromEnv()).toThrow(
      roleGuard.DatabaseSurfaceError,
    );
    expect(() => wiring.applicationStorageFromEnv()).toThrow(
      "declared as embedded",
    );
    expect(built).toEqual([]);
  });

  test("in a process declared embedded, the handoff lets the application root through and no other: the worker and operator roots are refused by the declaration check", async () => {
    const { wiring, roleGuard, built } = await wiringRecordingStorages();
    handoffHolder[HOST] = { storage: {}, admitsConstruction: () => true };
    resetDatabaseSurfaceDeclaration("embedded");

    for (const surface of ["worker", "operator"] as const) {
      expect(() => wiring.rootStorageFromEnv(surface), surface).toThrow(
        roleGuard.DatabaseSurfaceError,
      );
    }
    expect(built).toEqual([]);
  });

  test("in a process declared embedded, a handoff that carries no storage is refused by the handoff's rule, naming the application root", async () => {
    const logged = consoleErrors();
    const { wiring, built } = await wiringRecordingStorages();
    handoffHolder[HOST] = { requestPort: {}, auth: {} };
    resetDatabaseSurfaceDeclaration("embedded");

    const refusal = thrownBy(() => wiring.applicationStorageFromEnv());

    expect((refusal as Error).name).toBe("HostHandoffRefusalError");
    expect((refusal as Error).message).toContain(
      "RequestPort's application root (rootStorageFromEnv) refused",
    );
    expect(logged).toHaveBeenCalledTimes(1);
    expect(built).toEqual([]);
  });
});
