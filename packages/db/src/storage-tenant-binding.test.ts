import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import {
  createStorage,
  type Database,
  recordedTenantBinding,
  type Storage,
  type TenantBinding,
} from "./client.js";
import {
  APPLICATION_DATABASE_URL_VARIABLE,
  readDatabaseUrl,
  refuseUnapprovedSharedPgDatabase,
} from "./database-url.js";
import { createAppearanceRepository } from "./repositories/appearance-repository.js";
import { resetDatabaseSurfaceDeclaration } from "./role-guard.js";
import {
  createWorkerStorages,
  tenantBindingFor,
  tenantWrappingEnabled,
  WORKER_DATABASE_URL_VARIABLES,
  withTenant,
} from "./tenant-context.js";
import { openSession } from "./testing.js";
import type { Tx } from "./transaction.js";
import { rootStorageFromEnv } from "./wiring.js";

/*
 * The tenant binding as a property of the storage (manifest-g.md §2.2, Done
 * when 13; track-g.md, G.0a; ruling 118). `createStorage` records the
 * `tenantBinding` it is given against the storage's handle, and `"wrapped"`
 * when it is given none; `withTenant` and the appearance read take it from
 * the handle they are handed, and read no environment. A composition root
 * derives its storage's binding from the environment once, when it builds.
 */

const touched = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!touched.has(key)) touched.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Where `wiring.ts` keeps each root's storage: one per surface, on `globalThis`. */
const ROOT_STORAGES = Symbol.for("requestport.root-storages");

/** Closes the storages the roots hold, and forgets them. */
async function releaseRootStorages() {
  const holder = globalThis as Record<
    symbol,
    Partial<Record<string, Storage>> | undefined
  >;
  const held = holder[ROOT_STORAGES];

  delete holder[ROOT_STORAGES];
  await Promise.all(
    Object.values(held ?? {}).map((storage) => storage?.close()),
  );
}

afterEach(async () => {
  for (const [key, value] of touched) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touched.clear();
  resetDatabaseSurfaceDeclaration("test");
  await releaseRootStorages();
});

const storages: Storage[] = [];

afterAll(async () => {
  await Promise.all(storages.map((storage) => storage.close()));
});

/**
 * Every environment `tenant-context.test.ts`'s switch case uses ("is off when
 * the variable is unset, empty, or read by a preview").
 */
const SWITCH_CASES: Record<string, string | undefined>[] = [
  { [APPLICATION_DATABASE_URL_VARIABLE]: undefined, VERCEL_ENV: undefined },
  { [APPLICATION_DATABASE_URL_VARIABLE]: "", VERCEL_ENV: undefined },
  {
    [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://a:b@h/d",
    VERCEL_ENV: "preview",
  },
  {
    [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://a:b@h/d",
    VERCEL_ENV: undefined,
  },
];

function today(): TenantBinding {
  return tenantWrappingEnabled(process.env) ? "wrapped" : "off";
}

/** A storage over this run's database, which nothing here dials but these. */
function storageWith(tenantBinding?: TenantBinding): Storage {
  const connectionString = readDatabaseUrl(process.env);

  refuseUnapprovedSharedPgDatabase(connectionString, process.env);
  const storage = createStorage({
    driver: "pg",
    connectionString,
    pool: { max: 2, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 15_000 },
    ...(tenantBinding === undefined ? {} : { tenantBinding }),
  });
  storages.push(storage);
  return storage;
}

async function binding(database: Tx | Database) {
  const [row] = (
    await database.execute(
      sql`select nullif(current_setting('requestport.organization_id', true), '') as organization_id,
                 current_setting('transaction_read_only') as read_only`,
    )
  ).rows as { organization_id: string | null; read_only: string }[];

  return row;
}

describe("what createStorage records", () => {
  test("the binding it is given, whatever the environment says", () => {
    const wrapped = storageWith("wrapped");
    const off = storageWith("off");

    for (const environment of SWITCH_CASES) {
      setEnv(environment);
      expect(tenantBindingFor(wrapped.db), JSON.stringify(environment)).toBe(
        "wrapped",
      );
      expect(tenantBindingFor(off.db), JSON.stringify(environment)).toBe("off");
    }
  });

  test("refuses a binding it does not know, rather than ignoring it", () => {
    for (const value of ["on", "", "WRAPPED"]) {
      expect(
        () =>
          createStorage({
            driver: "pg",
            connectionString: "postgresql://u:p@127.0.0.1:1/unused",
            tenantBinding: value as TenantBinding,
          }),
        JSON.stringify(value),
      ).toThrow(/tenantBinding/u);
    }
  });

  test('"wrapped" for a storage built without one, whatever the environment says (ruling 118)', () => {
    const unlabelled = storageWith();

    expect(recordedTenantBinding(unlabelled.db)).toBe("wrapped");
    for (const environment of SWITCH_CASES) {
      setEnv(environment);
      expect(tenantBindingFor(unlabelled.db), JSON.stringify(environment)).toBe(
        "wrapped",
      );
    }
  });

  test('"wrapped" for a handle no storage carries a binding for, whatever the environment says', () => {
    const storage = storageWith("off");
    // A stand-in that answers the storage's members, as the web root's
    // `webDatabase` does: not the storage's own `db`, so nothing is recorded
    // against it.
    const standIn = new Proxy({} as Database, {
      get: (_target, property) => Reflect.get(storage.db, property),
    });

    expect(recordedTenantBinding(standIn)).toBeUndefined();
    for (const environment of SWITCH_CASES) {
      setEnv(environment);
      expect(tenantBindingFor(standIn), JSON.stringify(environment)).toBe(
        "wrapped",
      );
    }
  });

  test("its storage's, for a session's handle (openSession)", async () => {
    for (const tenantBinding of ["wrapped", "off"] as const) {
      const storage = storageWith(tenantBinding);
      const session = await openSession(storage);

      try {
        for (const environment of SWITCH_CASES) {
          setEnv(environment);
          expect(
            tenantBindingFor(session.db),
            `${tenantBinding} ${JSON.stringify(environment)}`,
          ).toBe(tenantBinding);
        }
      } finally {
        session.release();
      }
    }
  });
});

describe("each root's binding (Done when 6 and 13)", () => {
  test("is \"wrapped\" for the application root, in every case of tenant-context.test.ts's switch case, because since I.2 step 5 it connects only as an application login (or a preview's own URL)", async () => {
    for (const environment of SWITCH_CASES) {
      await releaseRootStorages();
      setEnv(environment);
      resetDatabaseSurfaceDeclaration("application");
      const root = rootStorageFromEnv("application");

      expect(recordedTenantBinding(root.db), JSON.stringify(environment)).toBe(
        "wrapped",
      );
      expect(tenantBindingFor(root.db), JSON.stringify(environment)).toBe(
        "wrapped",
      );
    }
  });

  test("is tenantWrappingEnabled(process.env)'s for the worker's and the operator's roots when each builds its storage, in every case of tenant-context.test.ts's switch case", async () => {
    for (const surface of ["worker", "operator"] as const) {
      for (const environment of SWITCH_CASES) {
        await releaseRootStorages();
        setEnv(environment);
        resetDatabaseSurfaceDeclaration(surface);
        const root = rootStorageFromEnv(surface);

        expect(
          recordedTenantBinding(root.db),
          `${surface} ${JSON.stringify(environment)}`,
        ).toBe(today());
        expect(
          tenantBindingFor(root.db),
          `${surface} ${JSON.stringify(environment)}`,
        ).toBe(today());
      }
    }
  });

  test("is read once, when the root builds: a later change of the variable does not move it", async () => {
    const [unset, , , set] = SWITCH_CASES as [
      Record<string, string | undefined>,
      unknown,
      unknown,
      Record<string, string | undefined>,
    ];

    // The operator's root: the application's no longer reads the switch.
    for (const [built, later] of [
      [unset, set],
      [set, unset],
    ] as const) {
      await releaseRootStorages();
      setEnv(built);
      resetDatabaseSurfaceDeclaration("operator");
      const binding = today();
      const root = rootStorageFromEnv("operator");

      setEnv(later);
      expect(today(), JSON.stringify(later)).not.toBe(binding);
      expect(tenantBindingFor(root.db), JSON.stringify(built)).toBe(binding);
      expect(rootStorageFromEnv("operator")).toBe(root);
    }
  });

  /*
   * The roots' storages are held where every copy of this package reads them
   * (`wiring.ts`), because a bundler can give one process two copies of a
   * module (manifest-g.md §2.12). So a copy that did not build the storage
   * reads its binding too, as a second copy's `withTenant` would.
   */
  test('is the one a second copy of the package reads: a fresh module graph\'s withTenant runs on the pool of a root built "off"', async () => {
    const [unset, , , set] = SWITCH_CASES as [
      Record<string, string | undefined>,
      unknown,
      unknown,
      Record<string, string | undefined>,
    ];

    // The operator's root, built "off" where the variable is unset: the
    // application's is "wrapped" in both.
    for (const environment of [unset, set]) {
      await releaseRootStorages();
      setEnv(environment);
      resetDatabaseSurfaceDeclaration("operator");
      const binding = today();
      const root = rootStorageFromEnv("operator");

      vi.resetModules();
      const fresh = await import("./tenant-context.js");

      expect(fresh.tenantBindingFor, "a fresh copy").not.toBe(tenantBindingFor);
      expect(fresh.tenantBindingFor(root.db), JSON.stringify(environment)).toBe(
        binding,
      );
      if (binding === "off") {
        // Off: on the pool, in no transaction, so nothing is dialled here.
        expect(
          await fresh.withTenant(randomUUID(), async (database) => database, {
            database: root.db,
          }),
        ).toBe(root.db);
      }
    }
  });
});

/*
 * The worker's three bound storages (`createWorkerStorages`, I.2b's b2) bind
 * a tenant on the processor's transaction, never through a pool read
 * (manifest-g.md §2.2: "Bound worker storages are unaffected"). Before G.5
 * their handles carried no binding, and followed the environment's: "off"
 * wherever the application variable is unset. Built "off", the dispatcher's
 * and maintenance's handles keep that whatever the environment says, so a
 * pool read handed to `withTenant` on either runs on the pool as it did,
 * rather than opening a bound transaction as that login.
 */
describe("the worker's bound storages (createWorkerStorages)", () => {
  test('are built "off", so the dispatcher\'s and maintenance\'s handles are "off" whatever the environment says', async () => {
    const unreachable = (role: string) =>
      `postgresql://${role}:unused@127.0.0.1:1/unused`;
    // Building opens nothing: each URL is read when a pool first connects.
    const storages = createWorkerStorages(
      {
        REQUESTPORT_DATABASE_DRIVER: "pg",
        [WORKER_DATABASE_URL_VARIABLES.dispatcher]: unreachable("dispatcher"),
        [WORKER_DATABASE_URL_VARIABLES.processor]: unreachable("processor"),
        [WORKER_DATABASE_URL_VARIABLES.maintenance]: unreachable("maintenance"),
      },
      // A wrapped storage beside the exception, which the bound path never
      // reads: nothing of it reaches the three.
      { unbound: "test", storage: storageWith("wrapped") },
    );

    try {
      expect(storages.bound).toBe(true);
      expect(recordedTenantBinding(storages.dispatcher)).toBe("off");
      expect(recordedTenantBinding(storages.maintenance)).toBe("off");
      for (const environment of SWITCH_CASES) {
        setEnv(environment);
        expect(
          tenantBindingFor(storages.dispatcher),
          JSON.stringify(environment),
        ).toBe("off");
        expect(
          tenantBindingFor(storages.maintenance),
          JSON.stringify(environment),
        ).toBe("off");
      }
    } finally {
      await storages.close();
    }
  });
});

describe("withTenant takes the binding from the handle it is handed", () => {
  const organizationId = randomUUID();

  test('"wrapped": a pool read runs in its own bound transaction, with the application variable unset', async () => {
    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });
    const storage = storageWith("wrapped");

    const readOnly = await withTenant(
      organizationId,
      async (database) => {
        expect(database).not.toBe(storage.db);
        return binding(database);
      },
      { database: storage.db, readOnly: true },
    );

    expect(readOnly).toEqual({
      organization_id: organizationId,
      read_only: "on",
    });
  });

  test('"off": a pool read runs on the pool, in no transaction, with the application variable set', async () => {
    setEnv({
      [APPLICATION_DATABASE_URL_VARIABLE]: readDatabaseUrl(process.env),
      VERCEL_ENV: undefined,
    });
    expect(tenantWrappingEnabled(process.env)).toBe(true);
    const storage = storageWith("off");

    const seen = await withTenant(
      organizationId,
      async (database) => {
        expect(database).toBe(storage.db);
        return binding(database);
      },
      { database: storage.db, readOnly: true },
    );

    expect(seen).toEqual({ organization_id: null, read_only: "off" });
  });

  test("still refuses a malformed organisation id, whichever the binding", async () => {
    for (const tenantBinding of ["wrapped", "off"] as const) {
      const storage = storageWith(tenantBinding);

      await expect(
        withTenant("not-an-id", async () => undefined, {
          database: storage.db,
        }),
        tenantBinding,
      ).rejects.toThrow("only to an organisation id");
    }
  });
});

/*
 * Each case runs where the environment says the opposite of the storage's
 * binding, as withTenant's do, so a read that asked the environment rather
 * than the handle would open the wrong number of transactions.
 */
describe("the appearance read takes it from its handle (readAppearanceSnapshot)", () => {
  /** The transactions one user-mode read opens on `storage`'s handle. */
  async function userModeReadTransactions(storage: Storage) {
    const transaction = vi.spyOn(storage.db, "transaction");

    try {
      await createAppearanceRepository(storage.db).readAppearanceSnapshot({
        userId: `binding-${randomUUID()}`,
      });
      return transaction.mock.calls.length;
    } finally {
      transaction.mockRestore();
    }
  }

  test('"wrapped": a user-mode read opens a transaction of its own, with the application variable unset', async () => {
    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });
    expect(tenantWrappingEnabled(process.env)).toBe(false);

    expect(await userModeReadTransactions(storageWith("wrapped"))).toBe(1);
  });

  test('"off": a user-mode read opens no transaction, with the application variable set', async () => {
    setEnv({
      [APPLICATION_DATABASE_URL_VARIABLE]: readDatabaseUrl(process.env),
      VERCEL_ENV: undefined,
    });
    expect(tenantWrappingEnabled(process.env)).toBe(true);

    expect(await userModeReadTransactions(storageWith("off"))).toBe(0);
  });
});

/**
 * The workspaces `pnpm-workspace.yaml` declares, as J.0 defines them
 * (manifest-j.md §2.2 and §2.4 item 6; ruling 92): each directory one of its
 * `packages:` globs names, one level deep for `dir/*`, that holds a
 * `package.json`. A glob whose directory is absent names none, as in the
 * public seed, which keeps this file and fewer workspaces; an entry of
 * another shape is refused rather than read wrongly.
 */
function declaredWorkspaces(root: string): string[] {
  const lines = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split(
    /\r?\n/u,
  );
  const start = lines.findIndex((line) => /^packages:[ \t]*$/u.test(line));
  const globs: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (/^[ \t]*(?:#.*)?$/u.test(line)) continue;
    if (!/^[ \t]+-/u.test(line)) break;
    const entry =
      /^[ \t]+-[ \t]+(["']?)([\w.-]+(?:\/[\w.-]+)*(?:\/\*)?)\1[ \t]*(?:#.*)?$/u.exec(
        line,
      );
    if (!entry) {
      throw new Error(
        `pnpm-workspace.yaml: an entry this sweep cannot read: ${line.trim()}`,
      );
    }
    globs.push(entry[2]);
  }
  if (globs.length === 0) {
    throw new Error(
      "pnpm-workspace.yaml: no packages: list this sweep can read",
    );
  }
  return globs
    .flatMap((glob) => {
      if (!glob.endsWith("/*")) return [glob];
      const parent = glob.slice(0, -2);
      return existsSync(join(root, parent))
        ? readdirSync(join(root, parent), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`)
        : [];
    })
    .filter((directory) => existsSync(join(root, directory, "package.json")))
    .sort();
}

/*
 * Done when 13's source pin, in its final form (ruling 118): outside tests,
 * nothing calls tenantWrappingEnabled but where a composition root derives
 * its storage's binding as it builds it (wiring.ts). tenant-context.ts's own
 * line is its definition; tenantBindingFor reads no environment. The sweep
 * reads every workspace the tree declares (ruling 92).
 */
describe("who reads the switch", () => {
  const repositoryRoot = new URL("../../../", import.meta.url).pathname;
  const skipped = new Set([
    "node_modules",
    ".next",
    ".next-self-host",
    ".turbo",
    "dist",
    "coverage",
    "test",
    "tests",
    "test-support",
  ]);

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return skipped.has(entry.name) ? [] : sourceFiles(path);
      }
      return /\.[cm]?tsx?$/u.test(entry.name) &&
        !/\.test\.[cm]?tsx?$/u.test(entry.name)
        ? [path]
        : [];
    });
  }

  test("outside tests, only the roots' wiring calls tenantWrappingEnabled, to derive a root's binding", () => {
    const roots = declaredWorkspaces(repositoryRoot);
    const files = roots.map((root) => sourceFiles(join(repositoryRoot, root)));
    // Each workspace holds source the sweep reads, so it cannot pass by
    // finding nothing.
    expect(roots).toEqual(expect.arrayContaining(["apps/web", "packages/db"]));
    roots.forEach((root, index) => {
      expect(
        files[index].length,
        `${root} holds source this sweep reads`,
      ).toBeGreaterThan(0);
    });
    const calls = files.flat().flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /\btenantWrappingEnabled\(/u.test(line)
            ? [`${relative(repositoryRoot, path)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );

    // Sorted: the two lines are in two files, which a directory listing
    // need not give in any order.
    // wiring.ts's line asks it for every root but the application's, which
    // is "wrapped" whatever it answers (I.2 step 5).
    expect(calls.map((call) => call.replace(/:\d+:/u, ":")).sort()).toEqual([
      "packages/db/src/tenant-context.ts: export function tenantWrappingEnabled(",
      'packages/db/src/wiring.ts: surface === "application" || tenantWrappingEnabled(process.env)',
    ]);
  });
});
