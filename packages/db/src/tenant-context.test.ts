import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import {
  createStorage,
  type Database,
  HostHandoffRefusalError,
  type Storage,
  storageOptionsFromEnv,
} from "./client.js";
import { APPLICATION_DATABASE_URL_VARIABLE } from "./database-url.js";
import {
  type DatabaseSurface,
  declaredDatabaseSurface,
  resetDatabaseSurfaceDeclaration,
} from "./role-guard.js";
import {
  bindTenant,
  bindUser,
  createWorkerStorages,
  inTenantTransaction,
  retriesReadOnlyTransactions,
  retryReadOnce,
  TenantBindingError,
  tenantWrappingEnabled,
  type WorkerStorages,
  withAdministrationReadTransaction,
  withIsolatedTenantBinding,
  withTenant,
  withTenantRead,
  withUserBinding,
} from "./tenant-context.js";
import { createTestStorage } from "./testing.js";
import type { Tx } from "./transaction.js";
import { withHostConstructionToken } from "./wiring.js";

// Built from this process's environment, as each test lane sets it.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
 * The "wrapping waits for the application variable" and "a wrapped pool
 * read" cases set and unset that variable, and read through a storage built
 * after it, as the operator's and the worker's roots build theirs
 * (`wiring.ts`): from the environment, with the tenantBinding the variable
 * gives, read once, then. The application root's is "wrapped" whatever the
 * variable says (I.2 step 5).
 */
const builtAsARoot: Storage[] = [];

function storageAsARootBuildsIt(): Storage {
  const storage = createStorage({
    ...storageOptionsFromEnv(process.env),
    tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
  });

  builtAsARoot.push(storage);
  return storage;
}

/*
 * The per-transaction tenant binding (manifest-i2.md §2.3; track-i2.md D1,
 * D6, D10, D11). These run as the local superuser, which bypasses every
 * policy: what they pin is the binding itself — what a transaction carries,
 * which transitions are refused, and when a read is wrapped at all. What the
 * policies then do with a binding is row-security.integration.test.ts's.
 */

afterAll(async () => {
  await Promise.all(builtAsARoot.map((storage) => storage.close()));
  await suiteStorage.close();
});

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

/**
 * Turns wrapping on as it is turned on for a root other than the
 * application's: by setting the application variable, which a storage built
 * after it takes as `"wrapped"` (`storageAsARootBuildsIt`). It names the same
 * database the suite already uses, so a client this suite's pools build
 * meanwhile connects where it always did.
 */
function switchWrappingOn() {
  setEnv({
    [APPLICATION_DATABASE_URL_VARIABLE]: process.env.DATABASE_URL,
    VERCEL_ENV: undefined,
  });
}

class Rollback extends Error {}

async function inRolledBackTransaction(work: (tx: Tx) => Promise<void>) {
  await expect(
    suiteStorage.db.transaction(async (tx) => {
      await work(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function binding(database: Tx | Database) {
  const [row] = (
    await database.execute(
      sql`select nullif(current_setting('requestport.organization_id', true), '') as organization_id,
                 nullif(current_setting('requestport.user_id', true), '') as user_id,
                 current_setting('transaction_read_only') as read_only`,
    )
  ).rows as {
    organization_id: string | null;
    user_id: string | null;
    read_only: string;
  }[];

  return row;
}

describe("binding a transaction (D10's transitions)", () => {
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const userU = `user_${randomUUID()}`;
  const userV = `user_${randomUUID()}`;

  test("binds an unbound transaction to an organisation, which the policies' reader then returns", async () => {
    await inRolledBackTransaction(async (tx) => {
      await bindTenant(tx, organizationA);

      const [row] = (
        await tx.execute(
          sql`select requestport_private.bound_organization_id()::text as bound`,
        )
      ).rows as { bound: string }[];

      expect(row?.bound).toBe(organizationA);
      expect(await binding(tx)).toMatchObject({
        organization_id: organizationA,
        user_id: null,
      });
    });
  });

  test("binds an organisation and a human together, and the same organisation again idempotently", async () => {
    await inRolledBackTransaction(async (tx) => {
      await bindTenant(tx, organizationA, { userId: userU });
      await bindTenant(tx, organizationA);
      await bindTenant(tx, organizationA.toUpperCase(), { userId: userU });

      expect(await binding(tx)).toMatchObject({
        organization_id: organizationA,
        user_id: userU,
      });
    });
  });

  test("refuses another organisation, and leaves the first binding as it was", async () => {
    await inRolledBackTransaction(async (tx) => {
      await bindTenant(tx, organizationA, { userId: userU });

      await expect(bindTenant(tx, organizationB)).rejects.toBeInstanceOf(
        TenantBindingError,
      );
      await expect(
        bindTenant(tx, organizationA, { userId: userV }),
      ).rejects.toBeInstanceOf(TenantBindingError);
      expect(await binding(tx)).toMatchObject({
        organization_id: organizationA,
        user_id: userU,
      });
    });
  });

  test("refuses user mode inside an organisation, and an organisation inside user mode", async () => {
    await inRolledBackTransaction(async (tx) => {
      await bindTenant(tx, organizationA);
      await expect(bindUser(tx, userU)).rejects.toBeInstanceOf(
        TenantBindingError,
      );
    });
    await inRolledBackTransaction(async (tx) => {
      await bindUser(tx, userU);
      await bindUser(tx, userU);
      await expect(bindTenant(tx, organizationA)).rejects.toBeInstanceOf(
        TenantBindingError,
      );
      await expect(
        bindTenant(tx, organizationA, { userId: userU }),
      ).rejects.toBeInstanceOf(TenantBindingError);
      await expect(bindUser(tx, userV)).rejects.toBeInstanceOf(
        TenantBindingError,
      );
      expect(await binding(tx)).toMatchObject({
        organization_id: null,
        user_id: userU,
      });
    });
  });

  test("refuses what is not an organisation id or a user id before sending anything", async () => {
    await inRolledBackTransaction(async (tx) => {
      for (const value of ["", "not-a-uuid", `${organizationA} `, "%"]) {
        await expect(bindTenant(tx, value)).rejects.toBeInstanceOf(
          TenantBindingError,
        );
      }
      await expect(bindUser(tx, "")).rejects.toBeInstanceOf(TenantBindingError);
      expect(await binding(tx)).toMatchObject({
        organization_id: null,
        user_id: null,
      });
    });
  });

  test("a binding ends with its transaction, and the next one on the connection is unbound (P1)", async () => {
    const storage = createTestStorage({
      driver: "pg",
      pool: {
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 15_000,
      },
    });

    try {
      const [before] = (
        await storage.db.execute(sql`select pg_backend_pid() as pid`)
      ).rows as { pid: number }[];

      await storage.transaction(async (tx) => {
        await bindTenant(tx, organizationB, { userId: userV });
      });

      const [after] = (
        await storage.db.execute(sql`select pg_backend_pid() as pid`)
      ).rows as { pid: number }[];

      expect(after?.pid).toBe(before?.pid);
      expect(await binding(storage.db)).toMatchObject({
        organization_id: null,
        user_id: null,
      });
      await expect(
        storage.db.execute(
          sql`select requestport_private.bound_organization_id()`,
        ),
      ).rejects.toMatchObject({
        cause: {
          code: "42501",
          message: "requestport: no organisation is bound to this transaction",
        },
      });
    } finally {
      await storage.close();
    }
  });
});

describe("wrapping waits for the application variable (ruling 17)", () => {
  const organizationA = randomUUID();

  test("is off when the variable is unset, empty, or read by a preview", () => {
    expect(tenantWrappingEnabled({})).toBe(false);
    expect(
      tenantWrappingEnabled({ [APPLICATION_DATABASE_URL_VARIABLE]: "" }),
    ).toBe(false);
    expect(
      tenantWrappingEnabled({
        [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://a:b@h/d",
        VERCEL_ENV: "preview",
      }),
    ).toBe(false);
    expect(
      tenantWrappingEnabled({
        [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://a:b@h/d",
      }),
    ).toBe(true);
  });

  test("off: a pool read runs on the pool exactly as today, in no transaction", async () => {
    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });
    const storage = storageAsARootBuildsIt();

    const seen = await withTenant(
      organizationA,
      async (database) => {
        expect(database).toBe(storage.db);
        return binding(database);
      },
      { database: storage.db },
    );

    expect(seen).toMatchObject({ organization_id: null, read_only: "off" });
  });

  test("on: a pool read runs in its own transaction, bound, and read-only when asked", async () => {
    switchWrappingOn();
    const storage = storageAsARootBuildsIt();

    const readOnly = await withTenant(
      organizationA,
      async (database) => {
        expect(database).not.toBe(storage.db);
        return binding(database as Tx);
      },
      { database: storage.db, readOnly: true },
    );
    const readWrite = await withTenant(
      organizationA,
      (database) => binding(database as Tx),
      { database: storage.db, userId: "user_reader" },
    );

    expect(readOnly).toEqual({
      organization_id: organizationA,
      user_id: null,
      read_only: "on",
    });
    expect(readWrite).toEqual({
      organization_id: organizationA,
      user_id: "user_reader",
      read_only: "off",
    });
  });

  test("handed a transaction, it binds that transaction whatever the switch says", async () => {
    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });

    await inRolledBackTransaction(async (tx) => {
      const seen = await withTenant(
        organizationA,
        async (database) => {
          expect(database).toBe(tx);
          return binding(tx);
        },
        { database: tx, readOnly: true },
      );

      expect(seen).toMatchObject({ organization_id: organizationA });
      await expect(
        withTenant(randomUUID(), async () => undefined, { database: tx }),
      ).rejects.toBeInstanceOf(TenantBindingError);
    });
  });

  test("a method's own transaction binds whatever the switch says", async () => {
    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });

    const seen = await inTenantTransaction(
      suiteStorage.db,
      organizationA,
      (tx) => binding(tx),
    );

    expect(seen).toMatchObject({
      organization_id: organizationA,
      read_only: "off",
    });

    // Handed a transaction, it is a savepoint, and the binding outlives it:
    // the outer transaction now serves that organisation (D10).
    await inRolledBackTransaction(async (tx) => {
      await inTenantTransaction(tx, organizationA, async () => undefined);
      expect(await binding(tx)).toMatchObject({
        organization_id: organizationA,
      });
    });
  });
});

describe("a wrapped pool read (§2.3 item 3)", () => {
  const organizationA = randomUUID();

  test("on the pool, wraps exactly as withTenant does", async () => {
    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });
    const off = storageAsARootBuildsIt();

    expect(
      await withTenantRead(
        organizationA,
        async (database) => {
          expect(database).toBe(off.db);
          return "pool";
        },
        { database: off.db },
      ),
    ).toBe("pool");

    switchWrappingOn();
    const wrapped = storageAsARootBuildsIt();

    expect(
      await withTenantRead(
        organizationA,
        (database) => binding(database as Tx),
        { database: wrapped.db, readOnly: true, userId: "user_reader" },
      ),
    ).toEqual({
      organization_id: organizationA,
      user_id: "user_reader",
      read_only: "on",
    });
  });

  test("handed a transaction, leaves it as its opener bound it", async () => {
    switchWrappingOn();

    await inRolledBackTransaction(async (tx) => {
      const seen = await withTenantRead(
        organizationA,
        async (database) => {
          expect(database).toBe(tx);
          return binding(tx);
        },
        { database: tx },
      );

      expect(seen).toMatchObject({ organization_id: null, user_id: null });
      // A second organisation in the same transaction is the opener's affair.
      await withTenantRead(randomUUID(), async () => undefined, {
        database: tx,
      });
    });
  });
});

describe("bindings that must not outlive their read (§2.5.1)", () => {
  test("user mode: a read-only transaction bound to the user alone", async () => {
    const seen = await withUserBinding("user_listing", (tx) => binding(tx), {
      database: suiteStorage.db,
    });

    expect(seen).toEqual({
      organization_id: null,
      user_id: "user_listing",
      read_only: "on",
    });
  });

  test("handed a transaction, the binding is undone when the read ends", async () => {
    const organizationA = randomUUID();
    const organizationB = randomUUID();

    await inRolledBackTransaction(async (tx) => {
      expect(
        await withUserBinding("user_listing", (inner) => binding(inner), {
          database: tx,
        }),
      ).toMatchObject({ user_id: "user_listing" });
      expect(
        await withIsolatedTenantBinding(
          organizationA,
          (inner) => binding(inner),
          {
            database: tx,
          },
        ),
      ).toMatchObject({ organization_id: organizationA });
      expect(
        await withIsolatedTenantBinding(
          organizationB,
          (inner) => binding(inner),
          {
            database: tx,
          },
        ),
      ).toMatchObject({ organization_id: organizationB });
      expect(await binding(tx)).toMatchObject({
        organization_id: null,
        user_id: null,
      });
    });
  });

  test("a user-mode read inside an organisation-bound transaction is refused", async () => {
    await inRolledBackTransaction(async (tx) => {
      await bindTenant(tx, randomUUID());
      await expect(
        withUserBinding("user_listing", async () => undefined, {
          database: tx,
        }),
      ).rejects.toBeInstanceOf(TenantBindingError);
    });
  });
});

describe("the read-only retry (D6)", () => {
  /*
   * pg, the server driver both trees have, never retries: its pool has no
   * read retry (`readRetryFor`). The private tree's hosted-driver.test.ts
   * holds the case of the hosted driver, which does, as it stood before
   * J.2b.
   */
  test("does not apply on pg, whose pool never retries a read", async () => {
    const pg = createStorage({
      driver: "pg",
      connectionString: "postgresql://u:p@127.0.0.1:5432/d",
    });

    try {
      expect(retriesReadOnlyTransactions(pg.db)).toBe(false);
    } finally {
      // It opened no connection.
      await pg.close();
    }
  });

  // The shapes read-retry.ts's isConnectionFailure recognises, as Drizzle
  // hands them up: the WebSocket's error event as the cause of its wrapper.
  const socketGone = Object.assign(new Error("Failed query: select 1"), {
    cause: { type: "error" },
  });

  test("re-runs the whole read once after a connection failure", async () => {
    let calls = 0;
    const result = await retryReadOnce(async () => {
      calls += 1;
      if (calls === 1) throw socketGone;
      return "second";
    }, true);

    expect(result).toBe("second");
    expect(calls).toBe(2);
  });

  test("asks once more, never twice", async () => {
    let calls = 0;

    await expect(
      retryReadOnce(async () => {
        calls += 1;
        throw socketGone;
      }, true),
    ).rejects.toBe(socketGone);
    expect(calls).toBe(2);
  });

  test("does not repeat anything but a connection failure, nor anything it was not asked to", async () => {
    let calls = 0;
    const refused = Object.assign(new Error("permission denied"), {
      cause: { code: "42501" },
    });

    await expect(
      retryReadOnce(async () => {
        calls += 1;
        throw refused;
      }, true),
    ).rejects.toBe(refused);
    await expect(
      retryReadOnce(async () => {
        calls += 1;
        throw socketGone;
      }, false),
    ).rejects.toBe(socketGone);
    expect(calls).toBe(2);
  });
});

/*
 * The trusted boundary (manifest-i2.md §2.3, ruling 44). I.2 defends against
 * a missing predicate in application code, not against a compromised
 * application process, which could call `set_config` itself. So the binding
 * is set in one file only: this sweep fails on any source file in a
 * workspace the tree declares that names either setting or calls
 * `set_config(`, outside `tenant-context.ts` and outside tests. That the
 * database does not stop a direct call is recorded in
 * row-security.integration.test.ts ("the trusted boundary").
 */
const repositoryRoot = new URL("../../../", import.meta.url).pathname;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".next-self-host",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);
const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "test-support",
  "__tests__",
]);

function sourceFilesUnder(...roots: string[]) {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(join(directory, entry.name));
        }
      } else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) {
        files.push(relative(repositoryRoot, join(directory, entry.name)));
      }
    }
  };
  for (const root of roots) walk(join(repositoryRoot, root));
  return files.sort();
}

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

function isTestFile(file: string) {
  return (
    /\.test\.[cm]?[jt]sx?$/u.test(file) ||
    file.split("/").some((segment) => TEST_DIRECTORIES.has(segment))
  );
}

/** Each line of `file` that `pattern` matches, as `file:line: text`. */
function matchingLines(file: string, pattern: RegExp) {
  return readFileSync(join(repositoryRoot, file), "utf8")
    .split("\n")
    .flatMap((text, index) =>
      pattern.test(text) ? [`${file}:${index + 1}: ${text.trim()}`] : [],
    );
}

describe("the trusted boundary (§2.3, ruling 44)", () => {
  const roots = declaredWorkspaces(repositoryRoot);
  const files = sourceFilesUnder(...roots);
  const binding = /requestport\.(?:organization_id|user_id)|\bset_config\s*\(/u;

  /*
   * Mentions that are not the binding, each with its reason, matched whole.
   */
  const notTheBinding = new Map([
    [
      'apps/web/src/lib/organization-cookie.ts:1: export const CURRENT_ORGANIZATION_COOKIE = "requestport.organization_id";',
      "the web's organisation cookie shares the setting's name; it is a cookie and never reaches SQL",
    ],
  ]);

  test("sweeps the source it claims to", () => {
    // Every workspace the tree declares, each holding source the sweep reads,
    // so it cannot pass by finding nothing (ruling 92).
    expect(roots).toEqual(expect.arrayContaining(["apps/web", "packages/db"]));
    for (const root of roots) {
      expect(
        files.filter((file) => file.startsWith(`${root}/`) && !isTestFile(file))
          .length,
        `${root} holds source this sweep reads`,
      ).toBeGreaterThan(0);
    }
    expect(files).toContain("packages/db/src/tenant-context.ts");
    expect(files).toContain("apps/web/src/lib/organization-cookie.ts");
    if (roots.includes("trigger")) {
      expect(files).toContain("trigger/src/database-surface.ts");
    }
    expect(files.filter((file) => !isTestFile(file)).length).toBeGreaterThan(
      300,
    );
  });

  test("no source file outside tenant-context.ts names the binding or calls set_config", () => {
    const found = files
      .filter(
        (file) =>
          !isTestFile(file) && file !== "packages/db/src/tenant-context.ts",
      )
      .flatMap((file) => matchingLines(file, binding))
      .filter((line) => !notTheBinding.has(line));

    expect(found).toEqual([]);
  });

  test("tenant-context.ts is where the binding is set", () => {
    expect(
      matchingLines("packages/db/src/tenant-context.ts", /set_config\(/u)
        .length,
    ).toBeGreaterThan(0);
  });

  test("only a Vitest setup file declares test, and only the four setups and the two role lanes load it", () => {
    const declaring = files
      .flatMap((file) =>
        matchingLines(file, /declareDatabaseSurface\(\s*["'`]test["'`]\s*\)/u),
      )
      .map((line) => line.slice(0, line.indexOf(":")));

    expect([...new Set(declaring)]).toEqual([
      "packages/db/src/role-guard.test.ts",
      "packages/db/src/test-support/declare-test-surface.ts",
    ]);

    const loading = files
      .filter((file) => /(?:^|\/)vitest\.[^/]*config\.[cm]?ts$/u.test(file))
      .filter(
        (file) => matchingLines(file, /declare-test-surface/u).length > 0,
      );

    expect(loading).toEqual([
      "apps/web/vitest.config.ts",
      "packages/auth/vitest.config.ts",
      "packages/db/vitest.application-role.config.ts",
      "packages/db/vitest.config.ts",
      "packages/jobs/vitest.config.ts",
      "packages/jobs/vitest.worker-role.config.ts",
    ]);
  });

  test("only tests reset the surface declaration", () => {
    const resetting = files
      .filter((file) => !isTestFile(file))
      .filter(
        (file) =>
          matchingLines(file, /resetDatabaseSurfaceDeclaration/u).length > 0,
      );

    expect(resetting).toEqual(["packages/db/src/role-guard.ts"]);
  });
});

describe("the administration reads' transaction (ruling 50)", () => {
  test("is one transaction, bound to the organisation whatever the switch says", async () => {
    const organizationId = randomUUID();

    setEnv({ [APPLICATION_DATABASE_URL_VARIABLE]: undefined });
    const seen = await withAdministrationReadTransaction(
      organizationId,
      async (tx) =>
        (
          await tx.execute<{ bound: string; in_transaction: boolean }>(
            sql`select current_setting('requestport.organization_id', true) as bound,
                       now() = statement_timestamp() as in_transaction`,
          )
        ).rows,
      { database: suiteStorage.db },
    );

    // now() is the transaction's start, so it differs from this statement's
    // start only inside a transaction that began earlier — which the bind
    // statement guarantees.
    expect(seen).toEqual([{ bound: organizationId, in_transaction: false }]);
  });
});

/*
 * The worker's storages and the host's handoff (Plan 13, H.5; manifest-h.md
 * §2.7.1; rulings 145 and 160). While
 * `globalThis[Symbol.for("requestport.host")]` is set, `createWorkerStorages`
 * answers only a caller whose options carry a construction token the
 * handoff admits, and hands that token to each storage it builds; it refuses
 * any other caller, bound or not, before it reads its environment, by name,
 * with one console line. Unset, as on Vercel and in the Trigger.dev worker,
 * which never set it, it answers as it does without one (the next describe).
 */
describe("createWorkerStorages and the host's handoff", () => {
  const HOST = Symbol.for("requestport.host");
  const holder = globalThis as Record<symbol, unknown>;
  const unreachable = "postgres://worker:worker@127.0.0.1:1/requestport";
  const boundEnv = {
    REQUESTPORT_DATABASE_DRIVER: "pg",
    REQUESTPORT_DISPATCHER_DATABASE_URL: unreachable,
    REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL: unreachable,
    REQUESTPORT_MAINTENANCE_DATABASE_URL: unreachable,
  };
  const refusalLine =
    "HostHandoffRefusalError: RequestPort's createWorkerStorages refused: " +
    "the host's handoff is present, and the caller passed no construction " +
    "token it admits. While it is present, the web answers the storage, " +
    "Better Auth and RequestPort it carries and builds none of its own " +
    "(manifest-h.md §2.7.1).";
  const opened: Array<ReturnType<typeof createWorkerStorages>> = [];

  afterEach(async () => {
    delete holder[HOST];
    vi.restoreAllMocks();
    await Promise.all(opened.splice(0).map((storages) => storages.close()));
  });

  /** Captures console.error's lines, and prints none. */
  function consoleErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => undefined);
  }

  /** What `createWorkerStorages` threw, or undefined when it answered. */
  function refusalOf(
    build: () => ReturnType<typeof createWorkerStorages>,
  ): unknown {
    try {
      opened.push(build());
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test("absent, it answers as it does without one: unset, on the test exception, the storage's handle; set, three storages of its own", () => {
    const logged = consoleErrors();

    expect(HOST in holder).toBe(false);
    const unbound = createWorkerStorages(
      {},
      { unbound: "test", storage: suiteStorage },
    );
    const bound = createWorkerStorages(boundEnv);
    opened.push(unbound, bound);

    expect(unbound.bound).toBe(false);
    expect(unbound.dispatcher).toBe(suiteStorage.db);
    expect(bound.bound).toBe(true);
    expect(bound.dispatcher).not.toBe(suiteStorage.db);
    expect(logged).not.toHaveBeenCalled();
  });

  test("present, it refuses a caller that passes no token, unbound or bound, before it reads its environment, with HostHandoffRefusalError and one console line each, naming createWorkerStorages", () => {
    const logged = consoleErrors();
    holder[HOST] = { admitsConstruction: () => true };
    // A partial set is refused as configuration when the environment is
    // read; here the construction is refused first.
    const partialEnv = { REQUESTPORT_DISPATCHER_DATABASE_URL: unreachable };

    for (const env of [{}, boundEnv, partialEnv]) {
      const refusal = refusalOf(() =>
        createWorkerStorages(env, { unbound: "test", storage: suiteStorage }),
      );

      expect(refusal).toBeInstanceOf(HostHandoffRefusalError);
      expect(`${(refusal as Error).name}: ${(refusal as Error).message}`).toBe(
        refusalLine,
      );
    }
    expect(logged.mock.calls).toEqual([
      [refusalLine],
      [refusalLine],
      [refusalLine],
    ]);
    expect(opened).toEqual([]);
  });

  test("present, it refuses a token the handoff does not admit", () => {
    const logged = consoleErrors();
    const token = Object.freeze({});
    holder[HOST] = {
      admitsConstruction: (candidate: unknown) => candidate === token,
    };

    const refusal = refusalOf(() =>
      createWorkerStorages(
        boundEnv,
        withHostConstructionToken({}, Object.freeze({})),
      ),
    );

    expect(refusal).toBeInstanceOf(HostHandoffRefusalError);
    expect(logged.mock.calls).toEqual([[refusalLine]]);
  });

  test("present, the token it admits answers, and reaches each of the three storages it builds, which createStorage would refuse without it", () => {
    const logged = consoleErrors();
    const token = Object.freeze({});
    const asked: unknown[] = [];
    holder[HOST] = {
      admitsConstruction: (candidate: unknown) => {
        asked.push(candidate);
        return candidate === token;
      },
    };

    const refusal = refusalOf(() =>
      createWorkerStorages(boundEnv, withHostConstructionToken({}, token)),
    );

    expect(refusal).toBeUndefined();
    expect(opened.map((storages) => storages.bound)).toEqual([true]);
    // Once for createWorkerStorages, then once for each storage it built.
    expect(asked).toEqual([token, token, token, token]);
    expect(logged).not.toHaveBeenCalled();
  });
});

/*
 * The worker's storages with none of the three variables set (Plan 13,
 * I.2b's b5; ruling 214 item 1). `createWorkerStorages` refuses, naming the
 * three, before it reads the storage its caller gives, unless the caller
 * asks for one of two exceptions, each admitted only in the process it names:
 * `embedded`, over a PGlite storage, in a process that has declared
 * `embedded` (`requestport start` on PGlite, ruling 74); and `test`, in a
 * process that has declared `test`, which only a Vitest setup file can. With
 * the three set, the exception is not read. This file's process has declared
 * `test` (its setup file); a case that needs another declaration replaces it
 * and puts `test` back.
 */
describe("createWorkerStorages with none of the three variables set", () => {
  const VARIABLES = [
    "REQUESTPORT_DISPATCHER_DATABASE_URL",
    "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
    "REQUESTPORT_MAINTENANCE_DATABASE_URL",
  ] as const;
  const unreachable = "postgres://worker:worker@127.0.0.1:1/requestport";
  const boundEnv: NodeJS.ProcessEnv = {
    REQUESTPORT_DATABASE_DRIVER: "pg",
    ...Object.fromEntries(VARIABLES.map((name) => [name, unreachable])),
  };
  const unsetRefusal =
    "RequestPort's worker connects as its three roles, and " +
    "REQUESTPORT_DISPATCHER_DATABASE_URL, " +
    "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL and " +
    "REQUESTPORT_MAINTENANCE_DATABASE_URL are unset. Set all three, each to " +
    "a login in its worker group.";
  const opened: WorkerStorages[] = [];
  const built: Storage[] = [];

  afterEach(async () => {
    resetDatabaseSurfaceDeclaration("test");
    await Promise.all(opened.splice(0).map((storages) => storages.close()));
    await Promise.all(built.splice(0).map((storage) => storage.close()));
  });

  type Options = NonNullable<Parameters<typeof createWorkerStorages>[1]>;

  /**
   * `source`'s exception, storage and handle behind getters that record each
   * read: `database` is the option that carried the handle before b5.
   */
  function recorded(source: Record<string, unknown>) {
    const reads: string[] = [];
    const options = {};
    for (const key of ["unbound", "storage", "database"]) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.push(key);
          return source[key];
        },
      });
    }
    return { options: options as Options, reads };
  }

  /** What `build` threw, or "" when it answered (and is then closed). */
  function refusalOf(build: () => WorkerStorages): string {
    try {
      opened.push(build());
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  }

  /** `work` in a process declared as `surface` (none, when undefined). */
  function declaredAs<T>(surface: DatabaseSurface | undefined, work: () => T) {
    resetDatabaseSurfaceDeclaration(surface);
    try {
      return work();
    } finally {
      resetDatabaseSurfaceDeclaration("test");
    }
  }

  function pgliteStorage(): Storage {
    const storage = createStorage({ driver: "pglite", dataDir: "memory://" });
    built.push(storage);
    return storage;
  }

  test("with no exception asked for, it refuses, naming the three, and reads neither the storage nor the handle it is given", () => {
    expect(declaredDatabaseSurface()).toBe("test");
    const blank = Object.fromEntries(VARIABLES.map((name) => [name, "  "]));

    for (const env of [
      {},
      blank,
      { ...blank, REQUESTPORT_DATABASE_DRIVER: "pg" },
    ]) {
      const { options, reads } = recorded({
        storage: suiteStorage,
        database: suiteStorage.db,
      });

      expect(refusalOf(() => createWorkerStorages(env, options))).toBe(
        unsetRefusal,
      );
      expect(reads, JSON.stringify(env)).toEqual(["unbound"]);
    }
    expect(refusalOf(() => createWorkerStorages({}))).toBe(unsetRefusal);
    expect(opened).toEqual([]);
  });

  test("the test exception, in a process declared test: all three are the storage's handle, and withTenant hands work that handle", async () => {
    const storages = createWorkerStorages(
      {},
      { unbound: "test", storage: suiteStorage },
    );
    opened.push(storages);

    expect(storages.bound).toBe(false);
    expect(storages.dispatcher).toBe(suiteStorage.db);
    expect(storages.maintenance).toBe(suiteStorage.db);
    await expect(
      storages.withTenant(randomUUID(), async (database) => database),
    ).resolves.toBe(suiteStorage.db);
    await expect(
      storages.withTenant("not-an-organisation", async () => "never"),
    ).rejects.toBeInstanceOf(TenantBindingError);
    await expect(storages.roleReports()).resolves.toBeNull();
  });

  test("the test exception is refused in a process declared as anything but test, naming the declaration and the three, before the storage is read", () => {
    for (const surface of [
      "worker",
      "application",
      "operator",
      "embedded",
      undefined,
    ] as const) {
      const { options, reads } = recorded({
        unbound: "test",
        storage: suiteStorage,
        database: suiteStorage.db,
      });
      const message = declaredAs(surface, () =>
        refusalOf(() => createWorkerStorages({}, options)),
      );

      expect(message, String(surface)).toContain(
        "RequestPort's worker runs unbound on the test exception only in a process that has declared the test surface",
      );
      expect(message, String(surface)).toContain(
        `this process has declared ${surface ?? "no surface"}.`,
      );
      for (const name of VARIABLES) expect(message).toContain(name);
      expect(reads, String(surface)).toEqual(["unbound"]);
    }
  });

  test("the test exception is refused without a storage", () => {
    expect(
      refusalOf(() => createWorkerStorages({}, { unbound: "test" })),
    ).toContain(
      "RequestPort's worker runs unbound on the test exception only over the storage its caller gives, and it was given none.",
    );
  });

  test("the embedded exception, in a process declared embedded, over a PGlite storage: all three are that storage's handle", () => {
    const pglite = pgliteStorage();
    const storages = declaredAs("embedded", () =>
      createWorkerStorages({}, { unbound: "embedded", storage: pglite }),
    );
    opened.push(storages);

    expect(storages.bound).toBe(false);
    expect(storages.dispatcher).toBe(pglite.db);
    expect(storages.maintenance).toBe(pglite.db);
  });

  test("the embedded exception is refused in a process declared as anything but embedded, naming the declaration, before the storage is read", () => {
    const pglite = pgliteStorage();

    for (const surface of [
      "test",
      "worker",
      "application",
      "operator",
      undefined,
    ] as const) {
      const { options, reads } = recorded({
        unbound: "embedded",
        storage: pglite,
        database: pglite.db,
      });
      const message = declaredAs(surface, () =>
        refusalOf(() => createWorkerStorages({}, options)),
      );

      expect(message, String(surface)).toContain(
        "RequestPort's worker runs unbound on the embedded exception only in a process that has declared the embedded surface",
      );
      expect(message, String(surface)).toContain(
        `this process has declared ${surface ?? "no surface"}.`,
      );
      for (const name of VARIABLES) expect(message).toContain(name);
      expect(reads, String(surface)).toEqual(["unbound"]);
    }
  });

  test("the embedded exception is refused over a storage on another driver, or without one, naming the driver and the three", () => {
    const pg = createTestStorage({
      driver: "pg",
      connectionString: unreachable,
    });
    built.push(pg);

    for (const storage of [pg, undefined]) {
      const message = declaredAs("embedded", () =>
        refusalOf(() =>
          createWorkerStorages({}, { unbound: "embedded", storage }),
        ),
      );

      expect(message).toContain(
        "RequestPort's worker runs unbound on the embedded exception only over a PGlite storage",
      );
      expect(message).toContain(
        storage === undefined
          ? "it was given none."
          : "it was given one on pg.",
      );
      for (const name of VARIABLES) expect(message).toContain(name);
    }
  });

  test("no other exception opens the unbound path", () => {
    for (const unbound of ["pglite", "worker", "", "TEST"]) {
      const message = refusalOf(() =>
        createWorkerStorages({}, {
          unbound,
          storage: suiteStorage,
        } as unknown as Options),
      );

      expect(message, unbound).toContain(
        "RequestPort's worker runs unbound only on the embedded or the test exception",
      );
    }
  });

  test("with the three set, an exception is not read: the storages are bound, as the three name", () => {
    const { options, reads } = recorded({
      unbound: "test",
      storage: suiteStorage,
      database: suiteStorage.db,
    });
    const storages = createWorkerStorages(boundEnv, options);
    opened.push(storages);

    expect(storages.bound).toBe(true);
    expect(storages.dispatcher).not.toBe(suiteStorage.db);
    expect(reads).toEqual([]);
  });
});
