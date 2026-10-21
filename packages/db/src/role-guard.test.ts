import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import {
  applicationStorageOptionsFromEnv,
  createStorage,
  DATABASE_DRIVER_VARIABLE,
  type Storage,
  storageOptionsFromEnv,
} from "./client.js";
import {
  APPLICATION_DATABASE_URL_VARIABLE,
  applicationDatabaseUrlSelected,
  refuseUnapprovedSharedPgDatabase,
} from "./database-url.js";
import { HOSTED_DRIVERS } from "./hosted-driver.js";
import { createFoundationQueryRepository } from "./repositories/foundation-query.js";
import {
  createDatabaseRoleGuard,
  DatabaseRoleGuardError,
  type DatabaseSurface,
  DatabaseSurfaceError,
  declareDatabaseSurface,
  declaredDatabaseSurface,
  ENVIRONMENT_NOT_PERMITTED_MESSAGE,
  environmentObjections,
  GROUP_MEMBERSHIP_SQL,
  groupObjections,
  ownerCapableVariableNames,
  ROLE_CHECK_SQL,
  ROLE_GUARD_MODES,
  ROLE_NOT_PERMITTED_MESSAGE,
  type RoleGuardCheck,
  type RoleGuardMode,
  resetDatabaseSurfaceDeclaration,
  resolvedRolesFrom,
  roleObjections,
  sessionRoleObjections,
  UNDECLARED_SURFACE_MESSAGE,
  WORKER_ROLE_GUARD_MODES,
} from "./role-guard.js";
import {
  createWorkerStorages,
  tenantWrappingEnabled,
  WORKER_DATABASE_URL_VARIABLES,
  WORKER_GROUP_ROLES,
  type WorkerStorageRole,
  type WorkerStorages,
} from "./tenant-context.js";
import {
  createTestStorage,
  openSession,
  rawQuery,
  type TestSession,
} from "./testing.js";

// Built from this process's environment, as each test lane sets it: over
// DATABASE_URL, the owner, whatever the application variable names.
const suiteStorage = createStorage({
  ...storageOptionsFromEnv(process.env),
  tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
});

/*
 * The role guard (manifest-i2.md §2.2, §2.9 "The role guard's refusals";
 * Done when 6). Most refusals are shown with every check forced to enforce
 * (`ENFORCE`). Unforced, every guard's declaration and role checks enforce: a
 * guard that judges `worker`, or that watches one of the worker's storages,
 * since I.2b's b5 (`WORKER_ROLE_GUARD_MODES`; ruling 214 item 2), and every
 * other guard since I.2 step 5 (`ROLE_GUARD_MODES`; ruling 221 item 4); and
 * so does every environment check, the worker's since b6 and the
 * application's since §3 step 7 (ruling 224 item 2). The
 * guarded storages built here have guards of their own, so the process's
 * `test` declaration, which this package's Vitest setup makes, is never what
 * they judge.
 */

const ENFORCE: Record<RoleGuardCheck, RoleGuardMode> = {
  declaration: "enforce",
  role: "enforce",
  environment: "enforce",
};

/** Every check handed to a guard at warn: what no option may relax a check to. */
const ALL_WARN: Record<RoleGuardCheck, RoleGuardMode> = {
  declaration: "warn",
  role: "warn",
  environment: "warn",
};

afterAll(async () => {
  await suiteStorage.close();
});

describe("declaring the surface (D21)", () => {
  afterEach(() => {
    resetDatabaseSurfaceDeclaration("test");
    vi.unstubAllEnvs();
  });

  test("this package's Vitest setup has declared test", () => {
    expect(declaredDatabaseSurface()).toBe("test");
  });

  test("the same surface twice is idempotent, and a different one is refused", () => {
    resetDatabaseSurfaceDeclaration();
    expect(declaredDatabaseSurface()).toBeUndefined();

    declareDatabaseSurface("application");
    declareDatabaseSurface("application");
    expect(declaredDatabaseSurface()).toBe("application");

    for (const other of ["worker", "operator", "test"] as const) {
      expect(() => declareDatabaseSurface(other)).toThrow(DatabaseSurfaceError);
      expect(() => declareDatabaseSurface(other)).toThrow(
        `already declared as application; this process cannot also declare ${other}`,
      );
    }
    expect(declaredDatabaseSurface()).toBe("application");
  });

  test("refuses a surface it does not know", () => {
    resetDatabaseSurfaceDeclaration();
    expect(() =>
      declareDatabaseSurface("importer" as unknown as DatabaseSurface),
    ).toThrow("must be one of application, worker, operator, embedded, test");
    expect(declaredDatabaseSurface()).toBeUndefined();
  });

  test("refuses test outside Vitest", () => {
    resetDatabaseSurfaceDeclaration();
    vi.stubEnv("VITEST", undefined);

    expect(() => declareDatabaseSurface("test")).toThrow(
      "declared only by a Vitest setup file",
    );
    expect(declaredDatabaseSurface()).toBeUndefined();
  });

  test("holds the declaration where a second copy of this module would see it", () => {
    resetDatabaseSurfaceDeclaration();
    declareDatabaseSurface("worker");

    expect(
      (globalThis as Record<symbol, unknown>)[
        Symbol.for("requestport.database-surface")
      ],
    ).toBe("worker");
  });
});

describe("what each check objects to", () => {
  const clean = {
    role: "probe",
    superuser: false,
    bypassRls: false,
    ownsPublicTable: false,
    memberOfBypassingRole: false,
  };

  test("application and worker object to every way a role can bypass the policies", () => {
    for (const surface of ["application", "worker"] as const) {
      expect(roleObjections(surface, clean)).toEqual([]);
      expect(roleObjections(surface, { ...clean, superuser: true })).toEqual([
        "superuser",
      ]);
      expect(roleObjections(surface, { ...clean, bypassRls: true })).toEqual([
        "bypassrls",
      ]);
      expect(
        roleObjections(surface, { ...clean, ownsPublicTable: true }),
      ).toEqual(["owns_public_table"]);
      expect(
        roleObjections(surface, { ...clean, memberOfBypassingRole: true }),
      ).toEqual(["member_of_bypassing_role"]);
    }
  });

  test("the login is judged as the role is when they differ, for application and worker only", () => {
    const login = { ...clean, role: "owner_login", superuser: true };

    for (const surface of ["application", "worker"] as const) {
      expect(sessionRoleObjections(surface, clean, login)).toEqual([
        "session_user_superuser",
      ]);
      expect(sessionRoleObjections(surface, clean, clean)).toEqual([]);
      expect(
        sessionRoleObjections(surface, clean, { ...clean, role: "other" }),
      ).toEqual([]);
    }
    expect(sessionRoleObjections("operator", clean, login)).toEqual([]);
    expect(sessionRoleObjections("test", clean, login)).toEqual([]);
  });

  test("operator objects to the reverse, and test to nothing", () => {
    expect(roleObjections("operator", clean)).toEqual([
      "cannot_bypass_row_security",
    ]);
    expect(roleObjections("operator", { ...clean, bypassRls: true })).toEqual(
      [],
    );
    expect(roleObjections("operator", { ...clean, superuser: true })).toEqual(
      [],
    );
    expect(roleObjections("test", { ...clean, superuser: true })).toEqual([]);
  });

  test("the environment check names DATABASE_URL, every DATABASE_URL_*, POSTGRES_* and PG*, never a value, and none of RequestPort's own database variables, for application and worker (the worker's since b6) and no other surface", () => {
    const env = {
      DATABASE_URL: "postgresql://owner:secret@owner.example/db",
      DATABASE_URL_UNPOOLED: "postgresql://owner:secret@owner.example/db",
      DATABASE_URL_POOLED: "postgresql://owner:secret@owner.example/db",
      POSTGRES_URL: "x",
      POSTGRES_PASSWORD: "",
      PGHOST: "owner.example",
      PGHOST_UNPOOLED: "owner.example",
      PGPASSWORD: "secret",
      [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://app:pw@app/db",
      REQUESTPORT_DISPATCHER_DATABASE_URL: "postgresql://d:pw@w/db",
      REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL: "postgresql://p:pw@w/db",
      REQUESTPORT_MAINTENANCE_DATABASE_URL: "postgresql://m:pw@w/db",
      REQUESTPORT_LOCAL_DATABASE_URL: "postgresql://owner:secret@127.0.0.1/db",
      REQUESTPORT_PREVIEW_DATABASE_URL: "postgresql://owner:secret@p/db",
      XDATABASE_URL_UNPOOLED: "kept",
      DATABASE_URLS: "kept",
      REQUESTPORT_PGLITE_DATA_DIR: "/tmp/x",
      NODE_ENV: "production",
    };
    const names = [
      "DATABASE_URL",
      "DATABASE_URL_POOLED",
      "DATABASE_URL_UNPOOLED",
      "PGHOST",
      "PGHOST_UNPOOLED",
      "PGPASSWORD",
      "POSTGRES_PASSWORD",
      "POSTGRES_URL",
    ];

    expect(ownerCapableVariableNames(env)).toEqual(names);
    for (const surface of ["application", "worker"] as const) {
      expect(environmentObjections(surface, env), surface).toEqual(names);
      expect(
        JSON.stringify(environmentObjections(surface, env)),
        surface,
      ).not.toMatch(/secret|owner\.example/u);
    }
    for (const surface of [
      "operator",
      "test",
      "embedded",
      undefined,
    ] as const) {
      expect(environmentObjections(surface, env)).toEqual([]);
    }
    expect(
      environmentObjections("application", {
        [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://app:pw@app/db",
        NODE_ENV: "production",
      }),
    ).toEqual([]);
  });

  /*
   * The names the audit of 2026-10-17 found that the rule had missed (ruling
   * 217 item 2): a direct owner URL, `DATABASE_URL_UNPOOLED`, and so any
   * `DATABASE_URL_*`. One case per name, alone in its environment.
   */
  test.each([
    "DATABASE_URL_UNPOOLED",
    "DATABASE_URL_POOLED",
    "DATABASE_URL_NON_POOLING",
    "DATABASE_URL_",
  ])("%s is owner-capable, by its name alone, whatever its value", (name) => {
    for (const value of ["postgresql://owner:secret@owner.example/db", ""]) {
      expect(ownerCapableVariableNames({ [name]: value })).toEqual([name]);
      expect(environmentObjections("application", { [name]: value })).toEqual([
        name,
      ]);
    }
  });

  test("every check enforces: the declaration and role checks, the application's and the operator's since step 5 and the worker's since b5, and the environment check, the worker's since b6 and the application's since step 7", () => {
    expect(ROLE_GUARD_MODES).toEqual({
      declaration: "enforce",
      role: "enforce",
      environment: "enforce",
    });
    expect(Object.isFrozen(ROLE_GUARD_MODES)).toBe(true);
    expect(WORKER_ROLE_GUARD_MODES).toEqual({
      declaration: "enforce",
      role: "enforce",
      environment: "enforce",
    });
    expect(Object.isFrozen(WORKER_ROLE_GUARD_MODES)).toBe(true);
  });
});

/*
 * A worker storage's guard (Plan 13, I.2b step b2; manifest-i2.md §5.2 b2's
 * last item): the role check, and also exactly one RequestPort group, its
 * own. Shown here against answers a stand-in query gives; against real
 * logins in packages/jobs' worker-row-security suite (Done when 13).
 */
describe("a worker storage's group check, without a connection", () => {
  const plain = {
    which: "current",
    role: "rp_worker_login",
    superuser: false,
    bypass_rls: false,
    owns_public_table: false,
    member_of_bypassing_role: false,
  };
  const answering =
    (groups: string[], role: Record<string, unknown> = plain) =>
    async (text: string) => {
      if (text === ROLE_CHECK_SQL) {
        return { rows: [role, { ...role, which: "session" }] };
      }
      if (text === GROUP_MEMBERSHIP_SQL) {
        return { rows: groups.map((group_role) => ({ group_role })) };
      }
      throw new Error(`unexpected query: ${text}`);
    };
  const guardFor = (
    modes: Partial<Record<RoleGuardCheck, RoleGuardMode>> = {},
    lines: string[] = [],
  ) =>
    createDatabaseRoleGuard({
      surface: () => "worker",
      env: {},
      modes,
      write: (line) => lines.push(line),
      expectedGroup: "requestport_dispatcher",
      storage: "dispatcher",
      announcePassed: true,
    });

  test("objects unless the role is in its own group and no other", () => {
    expect(groupObjections("requestport_dispatcher", [])).toEqual([
      "not_member_of_requestport_dispatcher",
    ]);
    expect(
      groupObjections("requestport_dispatcher", [
        "requestport_tenant_processor",
        "requestport_dispatcher",
      ]),
    ).toEqual(["member_of_requestport_tenant_processor"]);
    expect(
      groupObjections("requestport_dispatcher", ["requestport_dispatcher"]),
    ).toEqual([]);
  });

  test("passes its own group's login, and writes one line naming the role, the storage and the mode it ran in, enforce", async () => {
    const lines: string[] = [];
    const guard = guardFor({}, lines);

    await expect(
      guard.checkRole(answering(["requestport_dispatcher"])),
    ).resolves.toBe("passed");
    await expect(
      guard.checkRole(answering(["requestport_dispatcher"])),
    ).resolves.toBe("passed");

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        level: "info",
        event: "database.role_guard.role",
        status: "passed",
        mode: "enforce",
        surface: "worker",
        storage: "dispatcher",
        role: "rp_worker_login",
        objections: [],
      }),
    ]);
    expect(guard.report()).toMatchObject({ storage: "dispatcher" });
  });

  test("in its default modes, refuses a login in the wrong group, one in two groups, and an owner-shaped one in none, and serves none of them", async () => {
    const lines: string[] = [];

    await expect(
      guardFor({}, lines).checkRole(
        answering(["requestport_tenant_processor"]),
      ),
    ).rejects.toMatchObject({
      name: "DatabaseRoleGuardError",
      message: `${ROLE_NOT_PERMITTED_MESSAGE} for the worker surface: rp_worker_login (not_member_of_requestport_dispatcher, member_of_requestport_tenant_processor).`,
      finding: {
        check: "role",
        status: "refused",
        role: "rp_worker_login",
        objections: [
          "not_member_of_requestport_dispatcher",
          "member_of_requestport_tenant_processor",
        ],
      },
    });
    await expect(
      guardFor({}, lines).checkRole(
        answering(["requestport_dispatcher", "requestport_maintenance"]),
      ),
    ).rejects.toThrow(/member_of_requestport_maintenance/u);
    await expect(
      guardFor({}, lines).checkRole(
        answering([], { ...plain, bypass_rls: true }),
      ),
    ).rejects.toThrow(/bypassrls, not_member_of_requestport_dispatcher/u);
    // A refusal is thrown, not written.
    expect(lines).toEqual([]);
  });

  test.each([
    ["a superuser", { superuser: true }, ["superuser"]],
    ["BYPASSRLS", { bypass_rls: true }, ["bypassrls"]],
    [
      "the owner of a table in public",
      { owns_public_table: true },
      ["owns_public_table"],
    ],
    [
      "a member of a bypassing role",
      { member_of_bypassing_role: true },
      ["member_of_bypassing_role"],
    ],
  ])(
    "in its default modes, refuses a login in its own group that is %s, and writes no line",
    async (_what, flags, objections) => {
      const lines: string[] = [];

      await expect(
        guardFor({}, lines).checkRole(
          answering(["requestport_dispatcher"], { ...plain, ...flags }),
        ),
      ).rejects.toMatchObject({
        name: "DatabaseRoleGuardError",
        finding: {
          check: "role",
          status: "refused",
          surface: "worker",
          role: "rp_worker_login",
          objections,
        },
      });
      expect(lines).toEqual([]);
    },
  );

  test("no environment variable changes a mode: in an environment naming every switch one might try, the worker's and the application's role checks still refuse, the application's environment check still refuses an owner-capable name, and a guard that finds nothing declared is still refused", async () => {
    const switches = {
      REQUESTPORT_ROLE_GUARD: "off",
      REQUESTPORT_ROLE_GUARD_MODE: "warn",
      REQUESTPORT_ROLE_GUARD_MODES:
        '{"declaration":"warn","role":"warn","environment":"warn"}',
      REQUESTPORT_ROLE_GUARD_ROLE: "warn",
      REQUESTPORT_WORKER_ROLE_GUARD: "warn",
      ROLE_GUARD_MODES: "warn",
      NODE_ENV: "development",
      VERCEL_ENV: "preview",
    };
    // In the guard's own environment and in the process's.
    for (const [name, value] of Object.entries(switches)) {
      vi.stubEnv(name, value);
    }
    try {
      const worker = createDatabaseRoleGuard({
        surface: () => "worker",
        env: { ...switches },
        write: () => undefined,
        expectedGroup: "requestport_dispatcher",
        storage: "dispatcher",
        announcePassed: true,
      });

      await expect(
        worker.checkRole(answering(["requestport_tenant_processor"])),
      ).rejects.toMatchObject({
        name: "DatabaseRoleGuardError",
        finding: { check: "role", status: "refused" },
      });
      expect(worker.modes).toEqual(WORKER_ROLE_GUARD_MODES);

      const application = createDatabaseRoleGuard({
        surface: () => "application",
        env: { ...switches },
        write: () => undefined,
      });

      await expect(
        application.checkRole(answering([], { ...plain, bypass_rls: true })),
      ).rejects.toMatchObject({
        name: "DatabaseRoleGuardError",
        finding: { check: "role", status: "refused", surface: "application" },
      });
      expect(application.modes).toEqual(ROLE_GUARD_MODES);
      expect(() =>
        createDatabaseRoleGuard({
          surface: () => "application",
          env: {
            ...switches,
            DATABASE_URL: `postgresql://o:${"pw"}@owner.example/db`,
          },
          write: () => undefined,
        }).beforeConnect(),
      ).toThrow(`${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names DATABASE_URL.`);
      expect(() =>
        createDatabaseRoleGuard({
          surface: () => undefined,
          env: { ...switches },
          write: () => undefined,
        }).beforeConnect(),
      ).toThrow(UNDECLARED_SURFACE_MESSAGE);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a passed line is written with console.info, and every failed line, the application's among them, with console.warn (ruling 215 item 7); a refusal writes none, the application's environment refusal among them (I.2 step 7)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = (spy: typeof info) =>
      spy.mock.calls.map(([line]) => {
        const event = JSON.parse(String(line)) as Record<string, unknown>;
        return [event.level, event.event, event.status, event.surface];
      });
    const down = new Error("the connection is down");
    const unreachable = async () => {
      throw down;
    };

    try {
      // A worker storage's guard with no `write`, as `createWorkerStorages`
      // builds each in production.
      const worker = () =>
        createDatabaseRoleGuard({
          surface: () => "worker",
          env: {},
          expectedGroup: "requestport_dispatcher",
          storage: "dispatcher",
          announcePassed: true,
        });

      await expect(
        worker().checkRole(answering(["requestport_dispatcher"])),
      ).resolves.toBe("passed");
      // The application's environment check refuses since step 7, and a
      // refusal is thrown, not written.
      expect(() =>
        createDatabaseRoleGuard({
          surface: () => "application",
          env: { DATABASE_URL: "postgresql://owner:pw@owner.example/db" },
        }).beforeConnect(),
      ).toThrow(`${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names DATABASE_URL.`);
      await expect(
        createDatabaseRoleGuard({
          surface: () => "application",
          env: {},
        }).checkRole(answering([], { ...plain, bypass_rls: true })),
      ).rejects.toMatchObject({ name: "DatabaseRoleGuardError" });
      await expect(
        createDatabaseRoleGuard({
          surface: () => "application",
          env: {},
        }).checkRole(unreachable),
      ).rejects.toBe(down);
      expect(() =>
        createDatabaseRoleGuard({
          surface: () => undefined,
          env: {},
        }).beforeConnect(),
      ).toThrow(UNDECLARED_SURFACE_MESSAGE);
      await expect(worker().checkRole(unreachable)).rejects.toBe(down);

      expect(events(info)).toEqual([
        ["info", "database.role_guard.role", "passed", "worker"],
      ]);
      expect(events(warn)).toEqual([
        ["warn", "database.role_guard.role", "failed", "application"],
        ["warn", "database.role_guard.role", "failed", "worker"],
      ]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("a mode handed to it raises a check and relaxes none: with every check handed at warn, its modes are still the worker's, and it still refuses", async () => {
    const relaxed = guardFor(ALL_WARN);

    await expect(
      relaxed.checkRole(answering(["requestport_tenant_processor"])),
    ).rejects.toMatchObject({
      name: "DatabaseRoleGuardError",
      finding: { check: "role", status: "refused" },
    });
    expect(relaxed.modes).toEqual(WORKER_ROLE_GUARD_MODES);
    expect(guardFor({ environment: "enforce" }).modes).toEqual({
      declaration: "enforce",
      role: "enforce",
      environment: "enforce",
    });
  });

  test("judges in the worker's modes whatever surface it finds: used before any declaration it is refused, as a guard with no group is", () => {
    const worker = (surface: DatabaseSurface | undefined) =>
      createDatabaseRoleGuard({
        surface: () => surface,
        env: {},
        write: () => undefined,
        expectedGroup: "requestport_dispatcher",
        storage: "dispatcher",
      });
    const undeclared = worker(undefined);

    expect(() => undeclared.beforeConnect()).toThrow(
      UNDECLARED_SURFACE_MESSAGE,
    );
    // Refused every time: it fails closed.
    expect(() => undeclared.beforeConnect()).toThrow(
      UNDECLARED_SURFACE_MESSAGE,
    );
    expect(undeclared.modes).toEqual(WORKER_ROLE_GUARD_MODES);

    const lines: string[] = [];
    const root = createDatabaseRoleGuard({
      surface: () => undefined,
      env: {},
      write: (line) => lines.push(line),
    });

    expect(root.modes).toEqual(ROLE_GUARD_MODES);
    expect(() => root.beforeConnect()).toThrow(UNDECLARED_SURFACE_MESSAGE);
    expect(() => root.beforeConnect()).toThrow(UNDECLARED_SURFACE_MESSAGE);
    expect(lines).toEqual([]);

    // In a process declared `test`, as the suites' worker storages are: the
    // worker's modes, nothing undeclared, and `test` is not role-checked.
    const suite = worker("test");

    expect(suite.modes).toEqual(WORKER_ROLE_GUARD_MODES);
    expect(() => suite.beforeConnect()).not.toThrow();
  });

  test("a guard built with no group, as each root's storage's is, asks no group", async () => {
    const asked: string[] = [];
    const guard = createDatabaseRoleGuard({
      surface: () => "worker",
      env: {},
      write: () => undefined,
    });

    await guard.checkRole(async (text) => {
      asked.push(text);
      return { rows: [plain, { ...plain, which: "session" }] };
    });
    expect(asked).toEqual([ROLE_CHECK_SQL]);
  });
});

/*
 * The modes (Plan 13, I.2b's b5; ruling 214 item 2), chosen for each check
 * when it runs, from the surface the guard reads then. Shown here against
 * answers a stand-in query gives; against this server below ("as worker, in
 * its default modes"), and against real worker logins in packages/jobs'
 * worker-row-security suite (Done when 13).
 */
describe("the modes, chosen for each check when it runs", () => {
  const row = (flags: Record<string, unknown> = {}) => ({
    which: "current",
    role: "rp_probe",
    superuser: false,
    bypass_rls: false,
    owns_public_table: false,
    member_of_bypassing_role: false,
    ...flags,
  });
  const answering =
    (current: Record<string, unknown>) => async (text: string) => {
      if (text === ROLE_CHECK_SQL) {
        return { rows: [current, { ...current, which: "session" }] };
      }
      throw new Error(`unexpected query: ${text}`);
    };
  const bypassing = answering(row({ bypass_rls: true }));

  test("a guard with no group that judges worker, as each root's storage's does in a process declared worker, refuses an owner-shaped role, whatever mode it is handed", async () => {
    for (const modes of [{}, ALL_WARN]) {
      const lines: string[] = [];
      const guard = createDatabaseRoleGuard({
        surface: () => "worker",
        env: {},
        modes,
        write: (line) => lines.push(line),
      });

      await expect(
        guard.checkRole(bypassing),
        JSON.stringify(modes),
      ).rejects.toThrow(
        `${ROLE_NOT_PERMITTED_MESSAGE} for the worker surface: rp_probe (bypassrls).`,
      );
      expect(lines, JSON.stringify(modes)).toEqual([]);
      expect(guard.modes, JSON.stringify(modes)).toEqual(
        WORKER_ROLE_GUARD_MODES,
      );
    }
  });

  test("the application's and the operator's role checks refuse in their default modes, and with every check handed at warn, writing no line", async () => {
    for (const [surface, answer, objection] of [
      ["application", bypassing, "bypassrls"],
      ["operator", answering(row()), "cannot_bypass_row_security"],
    ] as const) {
      for (const modes of [{}, ALL_WARN]) {
        const label = `${surface} ${JSON.stringify(modes)}`;
        const lines: string[] = [];
        const guard = createDatabaseRoleGuard({
          surface: () => surface,
          env: {},
          modes,
          write: (line) => lines.push(line),
        });

        expect(guard.modes, label).toEqual(ROLE_GUARD_MODES);
        await expect(guard.checkRole(answer), label).rejects.toMatchObject({
          name: "DatabaseRoleGuardError",
          message: `${ROLE_NOT_PERMITTED_MESSAGE} for the ${surface} surface: rp_probe (${objection}).`,
          finding: {
            check: "role",
            status: "refused",
            surface,
            role: "rp_probe",
            objections: [objection],
          },
        });
        expect(lines, label).toEqual([]);
      }
    }
  });

  test("the application's environment check refuses in its default modes, as its declaration and role checks have since step 5: a process naming DATABASE_URL and DATABASE_URL_UNPOOLED is refused at every use, naming both and never a value, and no line is written (I.2 step 7; b6 named DATABASE_URL_*)", () => {
    const secret = "S3NT1NEL-owner-value-never-printed";
    const lines: string[] = [];
    const application = createDatabaseRoleGuard({
      surface: () => "application",
      env: {
        DATABASE_URL: `postgresql://owner:${secret}@owner.example/db`,
        DATABASE_URL_UNPOOLED: `postgresql://owner:${secret}@owner.example/db`,
      },
      write: (line) => lines.push(line),
    });

    expect(application.modes).toEqual({
      declaration: "enforce",
      role: "enforce",
      environment: "enforce",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let thrown: unknown;
      try {
        application.beforeConnect();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DatabaseRoleGuardError);
      expect((thrown as Error).message).toBe(
        `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names DATABASE_URL, DATABASE_URL_UNPOOLED.`,
      );
      expect((thrown as Error).message).not.toContain(secret);
    }
    expect(lines).toEqual([]);
  });

  test("follow the surface the guard reads when each check runs, not the one it was built under", async () => {
    let surface: DatabaseSurface | undefined = "operator";
    const guard = createDatabaseRoleGuard({
      surface: () => surface,
      env: {},
      write: () => undefined,
    });

    await expect(guard.checkRole(bypassing)).resolves.toBe("passed");
    expect(guard.modes).toEqual(ROLE_GUARD_MODES);

    surface = "application";
    await expect(guard.checkRole(bypassing)).rejects.toThrow(
      "for the application surface",
    );
    expect(guard.modes).toEqual(ROLE_GUARD_MODES);

    surface = "worker";
    await expect(guard.checkRole(bypassing)).rejects.toThrow(
      "for the worker surface",
    );
    expect(guard.modes).toEqual(WORKER_ROLE_GUARD_MODES);
  });

  test("a role check that could not run throws the connection's error, the worker's, the application's and the operator's", async () => {
    const down = new Error("connect ECONNREFUSED 127.0.0.1:1");
    const unreachable = async (): Promise<never> => {
      throw down;
    };

    for (const surface of ["worker", "application", "operator"] as const) {
      await expect(
        createDatabaseRoleGuard({
          surface: () => surface,
          env: {},
          write: () => undefined,
        }).checkRole(unreachable),
        surface,
      ).rejects.toBe(down);
    }
  });
});

describe("the declaration and environment checks, without a connection", () => {
  test("the application's environment check refuses in its default modes, every time, records the finding, and writes no line (I.2 step 7)", () => {
    const lines: string[] = [];
    const guard = createDatabaseRoleGuard({
      surface: () => "application",
      env: { DATABASE_URL: "postgresql://owner:pw@owner.example/db" },
      write: (line) => lines.push(line),
    });

    expect(() => guard.beforeConnect()).toThrow(
      `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names DATABASE_URL.`,
    );
    expect(() => guard.beforeConnect()).toThrow(
      `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names DATABASE_URL.`,
    );
    expect(lines).toEqual([]);
    expect(guard.report().findings).toEqual([
      {
        check: "declaration",
        status: "passed",
        surface: "application",
        objections: [],
      },
      {
        check: "environment",
        status: "refused",
        surface: "application",
        objections: ["DATABASE_URL"],
      },
    ]);
  });

  test("an undeclared process is refused every time, in the default modes, with every check handed at warn, and in enforce mode, and no line is written", () => {
    for (const modes of [{}, ALL_WARN, ENFORCE]) {
      const lines: string[] = [];
      const guard = createDatabaseRoleGuard({
        surface: () => undefined,
        env: {},
        modes,
        write: (line) => lines.push(line),
      });

      expect(() => guard.beforeConnect(), JSON.stringify(modes)).toThrow(
        UNDECLARED_SURFACE_MESSAGE,
      );
      expect(() => guard.beforeConnect(), JSON.stringify(modes)).toThrow(
        UNDECLARED_SURFACE_MESSAGE,
      );
      expect(lines, JSON.stringify(modes)).toEqual([]);
      expect(guard.report().findings, JSON.stringify(modes)).toEqual([
        {
          check: "declaration",
          status: "refused",
          surface: undefined,
          objections: ["undeclared"],
        },
      ]);
    }
  });

  test("refuses an application process naming an owner-capable variable in its default modes, and with every check handed at warn, every time, naming the variable and never its value, and passes one naming only the application variable (I.2 step 7)", () => {
    const secret = "S3NT1NEL-owner-value-never-printed";

    for (const modes of [{}, ALL_WARN]) {
      for (const name of [
        "DATABASE_URL",
        "DATABASE_URL_UNPOOLED",
        "POSTGRES_URL",
        "PGHOST",
      ]) {
        const label = `${name} ${JSON.stringify(modes)}`;
        const lines: string[] = [];
        const guard = createDatabaseRoleGuard({
          surface: () => "application",
          env: { [name]: `postgresql://owner:${secret}@owner.example/db` },
          modes,
          write: (line) => lines.push(line),
        });

        for (let attempt = 0; attempt < 2; attempt += 1) {
          let thrown: unknown;
          try {
            guard.beforeConnect();
          } catch (error) {
            thrown = error;
          }
          expect(thrown, label).toBeInstanceOf(DatabaseRoleGuardError);
          expect((thrown as Error).message, label).toBe(
            `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names ${name}.`,
          );
          expect((thrown as DatabaseRoleGuardError).finding, label).toEqual({
            check: "environment",
            status: "refused",
            surface: "application",
            objections: [name],
          });
        }
        expect(lines, label).toEqual([]);
      }

      const passing = createDatabaseRoleGuard({
        surface: () => "application",
        env: { [APPLICATION_DATABASE_URL_VARIABLE]: "postgresql://a:b@c/d" },
        modes,
        write: () => undefined,
      });

      expect(() => passing.beforeConnect()).not.toThrow();
      expect(
        passing.report().findings.find((f) => f.check === "environment"),
      ).toEqual({
        check: "environment",
        status: "passed",
        surface: "application",
        objections: [],
      });
    }
  });

  /*
   * The worker's environment check (Plan 13, I.2b's b6; ruling 217 item 1):
   * in the worker's own modes, with nothing handed to raise them, a guard
   * that judges `worker` refuses a process naming an owner-capable variable,
   * every time, whether it watches one of the worker's storages or a root's.
   */
  test("refuses a worker process naming an owner-capable variable in its default modes, every time, naming the variable and never its value, and passes one naming only the worker's own variables", () => {
    const secret = "S3NT1NEL-owner-value-never-printed";
    const own = {
      REQUESTPORT_DATABASE_DRIVER: "pg",
      REQUESTPORT_DISPATCHER_DATABASE_URL: "postgresql://d:pw@w/db",
      REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL: "postgresql://p:pw@w/db",
      REQUESTPORT_MAINTENANCE_DATABASE_URL: "postgresql://m:pw@w/db",
    };
    const guardFor = (
      env: NodeJS.ProcessEnv,
      expectedGroup: string | undefined,
      lines: string[],
    ) =>
      createDatabaseRoleGuard({
        surface: () => "worker",
        env,
        write: (line) => lines.push(line),
        ...(expectedGroup === undefined
          ? {}
          : { expectedGroup, storage: "dispatcher" }),
      });

    for (const name of [
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "PGHOST",
      "POSTGRES_URL",
    ]) {
      for (const expectedGroup of [undefined, "requestport_dispatcher"]) {
        const label = `${name}, ${expectedGroup ?? "a root's guard"}`;
        const lines: string[] = [];
        const guard = guardFor(
          { ...own, [name]: `postgresql://owner:${secret}@owner.example/db` },
          expectedGroup,
          lines,
        );

        expect(guard.modes, label).toEqual(WORKER_ROLE_GUARD_MODES);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let thrown: unknown;
          try {
            guard.beforeConnect();
          } catch (error) {
            thrown = error;
          }
          expect(thrown, label).toBeInstanceOf(DatabaseRoleGuardError);
          expect((thrown as Error).message, label).toBe(
            `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names ${name}.`,
          );
          expect((thrown as DatabaseRoleGuardError).finding, label).toEqual({
            check: "environment",
            status: "refused",
            surface: "worker",
            objections: [name],
          });
        }
        // A refusal is thrown, not written.
        expect(lines, label).toEqual([]);
      }
    }

    for (const expectedGroup of [undefined, "requestport_dispatcher"]) {
      const lines: string[] = [];
      const guard = guardFor({ ...own }, expectedGroup, lines);

      expect(() => guard.beforeConnect()).not.toThrow();
      expect(
        guard.report().findings.find((f) => f.check === "environment"),
      ).toEqual({
        check: "environment",
        status: "passed",
        surface: "worker",
        objections: [],
      });
      expect(lines).toEqual([]);
    }
  });
});

/*
 * `embedded`, PGlite's surface (Plan 13, H.4; manifest-h.md §2.6 item 4,
 * ruling 73; ruling 158, item 3): declared by `requestport start`'s serving
 * process on PGlite, never role-checked, and taken by a PGlite storage
 * alone. No case here dials a server: the pg storages are built and refused
 * before they read a connection string.
 */
describe("embedded: PGlite's surface, which only a PGlite storage takes", () => {
  afterEach(() => {
    resetDatabaseSurfaceDeclaration("test");
    vi.unstubAllEnvs();
  });

  const superuser = {
    role: "postgres",
    superuser: true,
    bypassRls: true,
    ownsPublicTable: true,
    memberOfBypassingRole: false,
  };

  test("is declared outside Vitest, once, as any surface but test is", () => {
    resetDatabaseSurfaceDeclaration();
    vi.stubEnv("VITEST", undefined);

    declareDatabaseSurface("embedded");
    declareDatabaseSurface("embedded");
    expect(declaredDatabaseSurface()).toBe("embedded");
    expect(() => declareDatabaseSurface("application")).toThrow(
      "already declared as embedded; this process cannot also declare application",
    );
  });

  test("objects to nothing: no role check, no environment check, whatever the role", async () => {
    expect(roleObjections("embedded", superuser)).toEqual([]);
    expect(
      sessionRoleObjections("embedded", superuser, {
        ...superuser,
        role: "other",
      }),
    ).toEqual([]);
    expect(
      environmentObjections("embedded", { DATABASE_URL: "x", PGHOST: "y" }),
    ).toEqual([]);

    const lines: string[] = [];
    const queries: string[] = [];
    const guard = createDatabaseRoleGuard({
      surface: () => "embedded",
      env: { DATABASE_URL: "postgresql://a:b@c/d" },
      modes: ENFORCE,
      write: (line) => lines.push(line),
    });

    guard.beforeConnect();
    expect(
      await guard.checkRole(async (text) => {
        queries.push(text);
        return { rows: [] };
      }),
    ).toBe("skipped");
    expect(queries).toEqual([]);
    expect(lines).toEqual([]);
    expect(guard.report()).toEqual({
      surface: "embedded",
      findings: [
        {
          check: "declaration",
          status: "passed",
          surface: "embedded",
          objections: [],
        },
        {
          check: "environment",
          status: "skipped",
          surface: "embedded",
          objections: [],
        },
        {
          check: "role",
          status: "skipped",
          surface: "embedded",
          objections: [],
        },
      ],
    });
  });

  test("a PGlite storage takes it and serves, its role check skipped", async () => {
    const guard = createDatabaseRoleGuard({
      surface: () => "embedded",
      env: {},
      modes: ENFORCE,
      write: () => undefined,
    });
    const storage = createStorage({
      driver: "pglite",
      dataDir: "memory://",
      guard,
    });
    try {
      await storage.ready();
      const { rows } = await storage.db.execute<{ role: string }>(
        sql`select current_user::text as role`,
      );
      expect(rows).toEqual([{ role: "postgres" }]);
      expect(
        guard.report().findings.find((finding) => finding.check === "role"),
      ).toEqual({
        check: "role",
        status: "skipped",
        surface: "embedded",
        objections: [],
      });
    } finally {
      await storage.close();
    }
  });

  test("a storage on any other driver refuses it as it is built, whatever the modes", () => {
    for (const driver of ["pg", ...HOSTED_DRIVERS] as const) {
      for (const modes of [{}, ENFORCE]) {
        let reads = 0;
        expect(
          () =>
            createStorage({
              driver,
              connectionString: () => {
                reads += 1;
                return "postgresql://unused:unused@127.0.0.1:1/unused";
              },
              guard: createDatabaseRoleGuard({
                surface: () => "embedded",
                env: {},
                modes,
                write: () => undefined,
              }),
            }),
          `${driver} ${JSON.stringify(modes)}`,
        ).toThrow(DatabaseSurfaceError);
        expect(reads).toBe(0);
      }
    }
    expect(() =>
      createStorage({
        driver: "pg",
        connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
        guard: createDatabaseRoleGuard({
          surface: () => "embedded",
          env: {},
          write: () => undefined,
        }),
      }),
    ).toThrow(
      "RequestPort database surface `embedded` is taken only by a PGlite storage, and this one is on the pg driver.",
    );
  });

  test("a pg storage built before the declaration refuses it before its first use, reading no connection string", async () => {
    let surface: DatabaseSurface | undefined;
    let reads = 0;
    const storage = createStorage({
      driver: "pg",
      connectionString: () => {
        reads += 1;
        return "postgresql://unused:unused@127.0.0.1:1/unused";
      },
      pool: {
        max: 1,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: 1_000,
      },
      guard: createDatabaseRoleGuard({
        surface: () => surface,
        env: {},
        write: () => undefined,
      }),
    });
    try {
      surface = "embedded";
      expect(await refusal(storage.ready())).toContain(
        "RequestPort database surface `embedded` is taken only by a PGlite storage, and this one is on the pg driver.",
      );
      expect(await refusal(storage.ready())).toContain(
        "is taken only by a PGlite storage",
      );
      expect(reads).toBe(0);
    } finally {
      await storage.close();
    }
  });
});

/*
 * Real login roles, because the role check reads the role a connection
 * resolved to, and only a login shows that. Named from this database so
 * tracks sharing the server never collide, stored with one SCRAM iteration,
 * created before these cases and dropped after them — with the two tables the
 * owning role and the owning group are given. The three groups are `NOLOGIN`.
 */
const password = randomUUID().replaceAll("-", "");
const roles = {
  bypass: "",
  owner: "",
  member: "",
  memberGroup: "",
  application: "",
  superMember: "",
  superGroup: "",
  ownerMember: "",
  ownerGroup: "",
};
let ownedTable = "";
let groupOwnedTable = "";
const storages: Storage[] = [];

/*
 * The owner's own storage, over `DATABASE_URL`, for the DDL and seeding
 * here. Until I.2 step 5's first slice, this suite's storage was the
 * application's login in the application-role lane, which may do neither.
 * It reads `DATABASE_URL` too now, and the application's storage is the
 * lane block's own (below).
 */
let ownerStorage: Storage | undefined;

function owner() {
  ownerStorage ??= createTestStorage({ driver: "pg" });
  return ownerStorage;
}

afterAll(async () => {
  await ownerStorage?.close();
});

async function withAdmin<T>(work: (session: TestSession) => Promise<T>) {
  const session = await openSession(owner());
  try {
    return await work(session);
  } finally {
    session.release();
  }
}

/** Runs one DDL statement with identifiers passed through `format(%I)`. */
async function ddl(session: TestSession, template: string, ...names: string[]) {
  await session.query(
    `select pg_catalog.set_config('requestport.test_ddl', $1, false)`,
    [JSON.stringify(names)],
  );
  await session.query(`
    do $$
    declare
      names text[] := array(select jsonb_array_elements_text(current_setting('requestport.test_ddl')::jsonb));
    begin
      execute format(${`'${template.replaceAll("'", "''")}'`}, variadic names);
    end $$`);
}

function urlFor(role: string) {
  const url = new URL(process.env.DATABASE_URL as string);
  url.username = role;
  url.password = password;
  return url.toString();
}

function guardedStorage(
  connectionString: string,
  surface: DatabaseSurface,
  modes: Partial<Record<RoleGuardCheck, RoleGuardMode>> = ENFORCE,
  lines: string[] = [],
) {
  refuseUnapprovedSharedPgDatabase(connectionString, process.env);
  const storage = createStorage({
    driver: "pg",
    connectionString,
    pool: {
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    },
    guard: createDatabaseRoleGuard({
      surface: () => surface,
      env: {},
      modes,
      write: (line) => lines.push(line),
    }),
  });
  storages.push(storage);
  return storage;
}

/**
 * The messages of a rejection and of each `cause` under it: Drizzle wraps a
 * failure in `Failed query: …`, with the guard's error as its cause.
 */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;

    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(" <- ");
  }
  throw new Error("expected a refusal, and the promise resolved");
}

describe.sequential("the role check, as each kind of role (Done when 6)", () => {
  beforeAll(async () => {
    await withAdmin(async (session) => {
      const { rows } = await session.query<{ base: string }>(
        "select left(current_database(), 40) as base",
      );
      const base = (rows[0] as { base: string }).base;

      roles.bypass = `${base}_guard_bypass`;
      roles.owner = `${base}_guard_owner`;
      roles.member = `${base}_guard_member`;
      roles.memberGroup = `${base}_guard_bypass_group`;
      roles.application = `${base}_guard_app`;
      roles.superMember = `${base}_guard_super_member`;
      roles.superGroup = `${base}_guard_super_group`;
      roles.ownerMember = `${base}_guard_owner_member`;
      roles.ownerGroup = `${base}_guard_owner_group`;
      ownedTable = `${base}_guard_owned`;
      groupOwnedTable = `${base}_guard_group_owned`;

      await session.query("SET scram_iterations = 1");
      // What an interrupted run left: the tables first, which two roles own.
      await ddl(session, "drop table if exists public.%I", ownedTable);
      await ddl(session, "drop table if exists public.%I", groupOwnedTable);
      for (const role of Object.values(roles)) {
        await ddl(session, "drop role if exists %I", role);
      }
      const login = `login password '${password}' nosuperuser nocreatedb nocreaterole noreplication`;
      await ddl(session, `create role %I ${login} bypassrls`, roles.bypass);
      await ddl(session, `create role %I ${login} nobypassrls`, roles.owner);
      await ddl(
        session,
        "create role %I nologin nosuperuser bypassrls",
        roles.memberGroup,
      );
      await ddl(
        session,
        `create role %I ${login} nobypassrls in role %I`,
        roles.member,
        roles.memberGroup,
      );
      await ddl(
        session,
        `create role %I ${login} nobypassrls in role requestport_application`,
        roles.application,
      );
      await ddl(session, "create table public.%I (id int)", ownedTable);
      await ddl(
        session,
        "alter table public.%I owner to %I",
        ownedTable,
        roles.owner,
      );
      // A login in a superuser group, and a login in a group that owns a
      // table in public: neither is a superuser, has BYPASSRLS or owns a
      // table itself.
      await ddl(session, "create role %I nologin superuser", roles.superGroup);
      await ddl(
        session,
        `create role %I ${login} nobypassrls in role %I`,
        roles.superMember,
        roles.superGroup,
      );
      await ddl(
        session,
        "create role %I nologin nosuperuser nobypassrls",
        roles.ownerGroup,
      );
      await ddl(
        session,
        `create role %I ${login} nobypassrls in role %I`,
        roles.ownerMember,
        roles.ownerGroup,
      );
      await ddl(session, "create table public.%I (id int)", groupOwnedTable);
      await ddl(
        session,
        "alter table public.%I owner to %I",
        groupOwnedTable,
        roles.ownerGroup,
      );
      await session.query("RESET scram_iterations");
    });
  });

  afterAll(async () => {
    await Promise.all(storages.map((storage) => storage.close()));
    await withAdmin(async (session) => {
      await ddl(session, "drop table if exists public.%I", ownedTable);
      await ddl(session, "drop table if exists public.%I", groupOwnedTable);
      for (const role of Object.values(roles)) {
        if (role) await ddl(session, "drop role if exists %I", role);
      }
    });
  });

  test("refuses the local superuser", async () => {
    const storage = guardedStorage(
      process.env.DATABASE_URL as string,
      "application",
    );

    expect(await refusal(storage.db.execute(sql`select 1`))).toMatch(
      new RegExp(
        `${ROLE_NOT_PERMITTED_MESSAGE} for the application surface: .*\\(superuser, bypassrls`,
        "u",
      ),
    );
  });

  test("refuses a NOSUPERUSER BYPASSRLS role, a role owning a public table, and a member of a BYPASSRLS role", async () => {
    const cases = [
      [roles.bypass, "bypassrls"],
      [roles.owner, "owns_public_table"],
      [roles.member, "member_of_bypassing_role"],
    ] as const;

    for (const [role, objection] of cases) {
      for (const surface of ["application", "worker"] as const) {
        const storage = guardedStorage(urlFor(role), surface);

        expect(
          await refusal(storage.db.execute(sql`select 1`)),
          `${role} as ${surface}`,
        ).toContain(`${role} (${objection})`);
        // Refused once, refused for every later use: it fails closed.
        expect(await refusal(storage.ready())).toContain(
          ROLE_NOT_PERMITTED_MESSAGE,
        );
        expect(
          await refusal(
            storage.transaction(async (tx) => tx.execute(sql`select 1`)),
          ),
        ).toContain(ROLE_NOT_PERMITTED_MESSAGE);
      }
    }
  });

  test("passes the application group's login, and refuses it on the operator surface", async () => {
    const application = guardedStorage(
      urlFor(roles.application),
      "application",
    );
    const { rows } = await application.db.execute<{ role: string }>(
      sql`select current_user::text as role`,
    );

    expect(rows).toEqual([{ role: roles.application }]);

    const operator = guardedStorage(urlFor(roles.application), "operator");

    expect(await refusal(operator.ready())).toContain(
      `${roles.application} (cannot_bypass_row_security)`,
    );

    const owner = guardedStorage(
      process.env.DATABASE_URL as string,
      "operator",
    );

    await expect(owner.ready()).resolves.toBeUndefined();
  });

  test("judges the role the connection resolved to, whatever the variable is called", async () => {
    // A BYPASSRLS login in the application variable, and no owner-capable
    // name anywhere: the environment check has nothing to see, and the role
    // check refuses it.
    const env = {
      [DATABASE_DRIVER_VARIABLE]: "pg",
      [APPLICATION_DATABASE_URL_VARIABLE]: urlFor(roles.bypass),
    };
    const lines: string[] = [];
    const storage = createStorage({
      ...applicationStorageOptionsFromEnv(env),
      pool: {
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 15_000,
      },
      guard: createDatabaseRoleGuard({
        surface: () => "application",
        env,
        modes: ENFORCE,
        write: (line) => lines.push(line),
      }),
    });
    storages.push(storage);

    expect(await refusal(storage.ready())).toContain(
      `${roles.bypass} (bypassrls)`,
    );
    expect(ownerCapableVariableNames(env)).toEqual([]);
  });

  /*
   * The application's environment check at a storage's first use (I.2 step
   * 7; ruling 224 item 2), built as the application root builds its own:
   * `applicationStorageOptionsFromEnv` and a guard over the same environment,
   * the application group's login in the application variable, and no mode
   * handed. For a name it refuses, the role check is asked first, the
   * connection its query needs is refused, the role check writes its one
   * `failed` line, and the use throws the environment refusal.
   */
  function applicationStorageIn(env: NodeJS.ProcessEnv, lines: string[]) {
    const storage = createStorage({
      ...applicationStorageOptionsFromEnv(env),
      pool: {
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 15_000,
      },
      guard: createDatabaseRoleGuard({
        surface: () => "application",
        env,
        write: (line) => lines.push(line),
      }),
    });
    storages.push(storage);
    return storage;
  }

  test.each([
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "PGHOST",
    "POSTGRES_URL",
  ])(
    "as application, in its default modes, a storage in a process naming %s is refused at its first use and every use after, naming the variable and never its value; its role check, which needs a connection, could not run (I.2 step 7)",
    async (name) => {
      const secret = "S3NT1NEL-owner-value-never-printed";
      const lines: string[] = [];
      const storage = applicationStorageIn(
        {
          [DATABASE_DRIVER_VARIABLE]: "pg",
          [APPLICATION_DATABASE_URL_VARIABLE]: urlFor(roles.application),
          [name]: `postgresql://owner:${secret}@owner.example/db`,
        },
        lines,
      );

      for (const message of [
        await refusal(storage.db.execute(sql`select 1`)),
        await refusal(storage.ready()),
      ]) {
        expect(message).toContain(
          `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names ${name}.`,
        );
        expect(message).not.toContain(secret);
        expect(message).not.toContain("owner.example");
      }
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        {
          level: "warn",
          event: "database.role_guard.role",
          timestamp: expect.any(String),
          status: "failed",
          mode: "enforce",
          surface: "application",
          objections: [],
        },
      ]);
      expect(lines.join("\n")).not.toContain(secret);
    },
  );

  test("as application, in its default modes, a storage in a process naming none of them passes its environment check, then its role check as the application group's login, and serves (I.2 step 7)", async () => {
    const lines: string[] = [];
    const storage = applicationStorageIn(
      {
        [DATABASE_DRIVER_VARIABLE]: "pg",
        [APPLICATION_DATABASE_URL_VARIABLE]: urlFor(roles.application),
      },
      lines,
    );
    const { rows } = await storage.db.execute<{ role: string }>(
      sql`select current_user::text as role`,
    );

    expect(rows).toEqual([{ role: roles.application }]);
    expect(lines).toEqual([]);
  });

  test("as worker, in its default modes, refuses the local superuser, and refuses it with every check handed at warn", async () => {
    for (const modes of [{}, ALL_WARN]) {
      const storage = guardedStorage(
        process.env.DATABASE_URL as string,
        "worker",
        modes,
      );

      expect(
        await refusal(storage.db.execute(sql`select 1`)),
        JSON.stringify(modes),
      ).toMatch(
        new RegExp(
          `${ROLE_NOT_PERMITTED_MESSAGE} for the worker surface: .*\\(superuser, bypassrls`,
          "u",
        ),
      );
    }
  });

  test("as application, in its default modes, refuses the local superuser and each owner-shaped role, and refuses them with every check handed at warn, writing no line", async () => {
    const cases = [
      [process.env.DATABASE_URL as string, "superuser, bypassrls"],
      [urlFor(roles.bypass), "bypassrls"],
      [urlFor(roles.owner), "owns_public_table"],
      [urlFor(roles.member), "member_of_bypassing_role"],
    ] as const;

    for (const modes of [{}, ALL_WARN]) {
      for (const [url, objections] of cases) {
        const label = `${new URL(url).username} ${JSON.stringify(modes)}`;
        const lines: string[] = [];
        const storage = guardedStorage(url, "application", modes, lines);

        expect(await refusal(storage.ready()), label).toMatch(
          new RegExp(
            `${ROLE_NOT_PERMITTED_MESSAGE} for the application surface: .*\\(${objections}`,
            "u",
          ),
        );
        // Refused once, refused for every later use: it fails closed.
        expect(
          await refusal(storage.db.execute(sql`select 1`)),
          label,
        ).toContain(ROLE_NOT_PERMITTED_MESSAGE);
        expect(lines, label).toEqual([]);
      }
    }
  });

  test("as application, in its default modes, refuses at its first use a login that is only a member of a superuser group, and one that is only a member of a group owning a table in public, and refuses them with every check handed at warn, writing no line", async () => {
    const cases = [
      [roles.superMember, "member_of_bypassing_role"],
      [roles.ownerMember, "owns_public_table"],
    ] as const;

    for (const modes of [{}, ALL_WARN]) {
      for (const [role, objection] of cases) {
        const label = `${role} ${JSON.stringify(modes)}`;
        const lines: string[] = [];
        const storage = guardedStorage(
          urlFor(role),
          "application",
          modes,
          lines,
        );

        expect(
          await refusal(storage.db.execute(sql`select 1`)),
          label,
        ).toContain(
          `${ROLE_NOT_PERMITTED_MESSAGE} for the application surface: ${role} (${objection}).`,
        );
        // Refused once, refused for every later use: it fails closed.
        expect(await refusal(storage.ready()), label).toContain(
          ROLE_NOT_PERMITTED_MESSAGE,
        );
        expect(lines, label).toEqual([]);
      }
    }
  });

  test("as operator, in its default modes, refuses the application group's login, and refuses it with every check handed at warn, writing no line; the local superuser and a NOSUPERUSER BYPASSRLS role pass", async () => {
    for (const modes of [{}, ALL_WARN]) {
      const lines: string[] = [];
      const application = guardedStorage(
        urlFor(roles.application),
        "operator",
        modes,
        lines,
      );

      expect(
        await refusal(application.ready()),
        JSON.stringify(modes),
      ).toContain(
        `${ROLE_NOT_PERMITTED_MESSAGE} for the operator surface: ${roles.application} (cannot_bypass_row_security).`,
      );
      expect(
        await refusal(application.db.execute(sql`select 1`)),
        JSON.stringify(modes),
      ).toContain(ROLE_NOT_PERMITTED_MESSAGE);
      expect(lines, JSON.stringify(modes)).toEqual([]);

      for (const url of [
        process.env.DATABASE_URL as string,
        urlFor(roles.bypass),
      ]) {
        await expect(
          guardedStorage(url, "operator", modes).ready(),
          `${new URL(url).username} ${JSON.stringify(modes)}`,
        ).resolves.toBeUndefined();
      }
    }
  });

  test("judges the login a session connected as, not only the role it set (session_user)", async () => {
    // The owner's login, told by its connection string to act as the
    // application group: `current_user` is the group, which passes, but the
    // session can `RESET ROLE` to the superuser it logged in as.
    const withRole = (login: string) => {
      const url = new URL(login);
      url.searchParams.set("options", "-c role=requestport_application");
      return url.toString();
    };

    for (const surface of ["application", "worker"] as const) {
      const owner = guardedStorage(
        withRole(process.env.DATABASE_URL as string),
        surface,
      );

      expect(await refusal(owner.ready()), surface).toMatch(
        new RegExp(
          `${ROLE_NOT_PERMITTED_MESSAGE} for the ${surface} surface: ` +
            "requestport_application, logged in as .* \\(session_user_superuser, " +
            "session_user_bypassrls",
          "u",
        ),
      );
    }

    // A clean login acting as its own group passes: nothing it can reset
    // to bypasses the policies.
    const clean = guardedStorage(
      withRole(urlFor(roles.application)),
      "application",
    );
    const { rows } = await clean.db.execute<{ role: string; login: string }>(
      sql`select current_user::text as role, session_user::text as login`,
    );

    expect(rows).toEqual([
      { role: "requestport_application", login: roles.application },
    ]);
  });

  test("a role check that could not run writes its failed line and is asked again on the next use, which judges the role: the application's refuses the local superuser and the operator's passes it, with the role check handed at warn as without", async () => {
    const reachable = process.env.DATABASE_URL as string;
    const unreachable = new URL(reachable);
    unreachable.port = "1";

    for (const surface of ["application", "operator"] as const) {
      for (const modes of [{}, { role: "warn" as const }]) {
        const label = `${surface} ${JSON.stringify(modes)}`;
        let down = true;
        const lines: string[] = [];
        const guard = createDatabaseRoleGuard({
          surface: () => surface,
          env: {},
          modes,
          write: (line) => lines.push(line),
        });
        const storage = createStorage({
          driver: "pg",
          connectionString: () => (down ? unreachable.toString() : reachable),
          pool: {
            max: 1,
            idleTimeoutMillis: 10_000,
            connectionTimeoutMillis: 5_000,
          },
          guard,
        });
        storages.push(storage);

        const first = await refusal(storage.ready());

        expect(first, label).not.toContain(ROLE_NOT_PERMITTED_MESSAGE);
        expect(
          guard.report().findings.find((f) => f.check === "role")?.status,
          label,
        ).toBe("failed");

        down = false;
        if (surface === "application") {
          expect(await refusal(storage.ready()), label).toContain(
            ROLE_NOT_PERMITTED_MESSAGE,
          );
          expect(
            guard.report().findings.find((f) => f.check === "role"),
            label,
          ).toMatchObject({
            status: "refused",
            objections: expect.arrayContaining(["superuser", "bypassrls"]),
          });
        } else {
          await expect(storage.ready(), label).resolves.toBeUndefined();
          expect(
            guard.report().findings.find((f) => f.check === "role")?.status,
            label,
          ).toBe("passed");
        }
        expect(
          lines.map((line) => JSON.parse(line) as Record<string, unknown>),
          label,
        ).toEqual([
          expect.objectContaining({
            event: "database.role_guard.role",
            status: "failed",
            mode: "enforce",
            surface,
          }),
        ]);
      }
    }
  });

  test("a storage queried before any declaration fails, on pg and on PGlite, in the guard's default modes", async () => {
    const undeclared = () =>
      createDatabaseRoleGuard({
        surface: () => undefined,
        env: {},
        write: () => undefined,
      });
    const pg = createStorage({
      driver: "pg",
      connectionString: process.env.DATABASE_URL as string,
      pool: {
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 15_000,
      },
      guard: undeclared(),
    });
    storages.push(pg);

    expect(await refusal(pg.ready())).toContain(UNDECLARED_SURFACE_MESSAGE);

    const pglite = createStorage({
      driver: "pglite",
      dataDir: "memory://",
      guard: undeclared(),
    });
    storages.push(pglite);

    expect(await refusal(pglite.ready())).toContain(UNDECLARED_SURFACE_MESSAGE);
  });

  test("writes nothing: the check runs as a role with no privilege, in a read-only transaction", async () => {
    await withAdmin(async (session) => {
      await session.query("BEGIN");
      try {
        const nobody = `${roles.bypass}_nobody`;
        await ddl(session, "create role %I nologin", nobody);
        await session.query("SET TRANSACTION READ ONLY");
        await ddl(session, "set local role %I", nobody);

        const { rows } = await session.query(ROLE_CHECK_SQL);

        // The role it set, and the login it could reset to.
        expect(rows).toEqual([
          {
            which: "current",
            role: nobody,
            superuser: false,
            bypass_rls: false,
            owns_public_table: false,
            member_of_bypassing_role: false,
          },
          expect.objectContaining({ which: "session", superuser: true }),
        ]);
      } finally {
        await session.query("ROLLBACK");
      }
    });
  });
});

/*
 * A worker storage's environment check at its first use, on this server
 * (Plan 13, I.2b's b6; ruling 217 item 1; manifest-i2.md §5.3 Done when 13's
 * last clause). Three real logins, one in each worker group, so that a
 * storage whose environment the check passes goes on to pass its role check
 * as its own login. For one it refuses, the role check is asked first, the
 * connection that check needs is refused, the role check writes its one
 * `failed` line, and the use throws the environment refusal. The environment
 * judged is the one handed to `createWorkerStorages`, which every deployed
 * caller fills from its own process. No mode is handed to the guards: these
 * are the worker's own.
 */
describe.sequential("a worker storage's environment check, at its first use (I.2b's b6)", () => {
  const SECRET = "S3NT1NEL-owner-value-never-printed";
  const logins: Record<WorkerStorageRole, string> = {
    dispatcher: "",
    processor: "",
    maintenance: "",
  };
  const opened: WorkerStorages[] = [];

  beforeAll(async () => {
    await withAdmin(async (session) => {
      const { rows } = await session.query<{ base: string }>(
        "select left(current_database(), 40) as base",
      );
      const base = (rows[0] as { base: string }).base;

      await session.query("SET scram_iterations = 1");
      for (const role of Object.keys(logins) as WorkerStorageRole[]) {
        logins[role] = `${base}_guard_w${role.slice(0, 1)}`;
        await ddl(session, "drop role if exists %I", logins[role]);
        await ddl(
          session,
          `create role %I login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication in role %I`,
          logins[role],
          WORKER_GROUP_ROLES[role],
        );
      }
      await session.query("RESET scram_iterations");
    });
  });

  afterAll(async () => {
    await Promise.all(opened.splice(0).map((storages) => storages.close()));
    await withAdmin(async (session) => {
      for (const login of Object.values(logins)) {
        if (login) await ddl(session, "drop role if exists %I", login);
      }
    });
  });

  /** The driver and the three variables, each naming its login here. */
  function workerEnv(): NodeJS.ProcessEnv {
    return {
      [DATABASE_DRIVER_VARIABLE]: "pg",
      [WORKER_DATABASE_URL_VARIABLES.dispatcher]: urlFor(logins.dispatcher),
      [WORKER_DATABASE_URL_VARIABLES.processor]: urlFor(logins.processor),
      [WORKER_DATABASE_URL_VARIABLES.maintenance]: urlFor(logins.maintenance),
    };
  }

  test.each([
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "PGHOST",
    "POSTGRES_URL",
  ])(
    "handed an environment naming %s, each storage is refused at its first use, in its default modes, naming the variable and never its value, and its role check, which needs a connection, could not run",
    async (name) => {
      const lines: string[] = [];
      const storages = createWorkerStorages(
        {
          ...workerEnv(),
          [name]: `postgresql://owner:${SECRET}@owner.example/db`,
        },
        { guard: { write: (line) => lines.push(line) } },
      );
      opened.push(storages);

      const refusals = [
        await refusal(storages.dispatcher.execute(sql`select 1`)),
        await refusal(storages.maintenance.execute(sql`select 1`)),
        await refusal(
          storages.withTenant(randomUUID(), (database) =>
            database.execute(sql`select 1`),
          ),
        ),
      ];

      for (const message of refusals) {
        expect(message).toContain(
          `${ENVIRONMENT_NOT_PERMITTED_MESSAGE}: it names ${name}.`,
        );
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain("owner.example");
      }
      // Each storage's first use asks its role check first, whose query needs
      // a connection, and the environment check refused the connection: so
      // the role check could not run, wrote its one `failed` line, naming no
      // role and no value, and threw the refusal (the header's enforce mode).
      expect(
        lines
          .map((line) => JSON.parse(line))
          .sort((a, b) => String(a.storage).localeCompare(String(b.storage))),
      ).toEqual(
        ["dispatcher", "maintenance", "processor"].map((storage) => ({
          level: "warn",
          event: "database.role_guard.role",
          timestamp: expect.any(String),
          status: "failed",
          mode: "enforce",
          surface: "worker",
          storage,
          objections: [],
        })),
      );
      expect(lines.join("\n")).not.toContain(SECRET);
    },
  );

  test("handed an environment naming none of them, each storage passes its environment check, then its role check as its own login, in enforce mode, and serves", async () => {
    const lines: string[] = [];
    const storages = createWorkerStorages(workerEnv(), {
      guard: { write: (line) => lines.push(line) },
    });
    opened.push(storages);

    const reports = await storages.roleReports();

    for (const role of Object.keys(logins) as WorkerStorageRole[]) {
      const findings = Object.fromEntries(
        (reports?.[role].findings ?? []).map((finding) => [
          finding.check,
          finding,
        ]),
      );

      expect(findings.environment, role).toEqual({
        check: "environment",
        status: "passed",
        surface: "worker",
        objections: [],
      });
      expect(findings.role, role).toMatchObject({
        status: "passed",
        surface: "worker",
        role: logins[role],
      });
    }
    expect(
      lines
        .map((line) => JSON.parse(line))
        .sort((a, b) => String(a.storage).localeCompare(String(b.storage))),
    ).toEqual(
      ["dispatcher", "maintenance", "processor"].map((storage) =>
        expect.objectContaining({
          event: "database.role_guard.role",
          status: "passed",
          mode: "enforce",
          storage,
          role: logins[storage as WorkerStorageRole],
        }),
      ),
    );
    await expect(
      storages.dispatcher.execute(sql`select 1 as one`),
    ).resolves.toMatchObject({ rows: [{ one: 1 }] });
  });
});

describe("each root's storage (wiring.ts, Plan 13 G.5)", () => {
  test("reads the declaration where the connection string is read, and the role before the first use", () => {
    const source = readFileSync(
      new URL("./client.ts", import.meta.url),
      "utf8",
    );
    const wiring = readFileSync(
      new URL("./wiring.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /function guardedReaderOf[\s\S]*?guard\.beforeConnect\(\);\s*return read\(\);/u,
    );
    expect(source).toMatch(
      /new SingleSessionPglite\(\(\) => \{\s*\/\/[^\n]*\n\s*guard\?\.beforeConnect\(\);/u,
    );
    // The storage each composition root builds carries a guard of its own.
    expect(wiring).toMatch(
      /const options =\s*surface === "application"\s*\?\s*applicationStorageOptionsFromEnv\(process\.env\)\s*:\s*storageOptionsFromEnv\(process\.env\);[\s\S]*?return createStorage\(\{\s*\.\.\.options,\s*guard: createDatabaseRoleGuard\(\),/u,
    );
  });

  test("is guarded, and its readiness probe runs the guard's checks first, which the guard's report answers", async () => {
    // Built as wiring.ts builds each root's storage (the pin above), with the
    // guard held here, because a root keeps its guard to itself. Until G.5
    // the default storage's `checkDatabaseReadiness` answered this report;
    // `/api/health/ready` asks the web root's `ready()` and never read it.
    const guard = createDatabaseRoleGuard();
    const storage = createStorage({
      ...storageOptionsFromEnv(process.env),
      guard,
      tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
    });

    try {
      await storage.ready();
      const report = guard.report();

      expect(report.surface).toBe("test");
      expect(report.findings).toEqual(
        expect.arrayContaining([
          {
            check: "declaration",
            status: "passed",
            surface: "test",
            objections: [],
          },
          { check: "role", status: "skipped", surface: "test", objections: [] },
        ]),
      );
    } finally {
      await storage.close();
    }
  });
});

/*
 * Wherever the application variable is set: in the application-role lane
 * (vitest.application-role.config.ts), which sets it to a login of its own,
 * and in a track whose `.env.local` names the track's application login
 * (`scripts/create-track-worktree.mjs`). The storage built here from the
 * application's options, as the application root's is, is that login, and
 * its pool reads are wrapped in bound transactions. Skipped in every other
 * run.
 */
describe.runIf(applicationDatabaseUrlSelected(process.env))(
  "wherever the application variable names a login, as in the application-role lane",
  () => {
    const applicationStorage = createStorage({
      ...applicationStorageOptionsFromEnv(process.env),
      tenantBinding: tenantWrappingEnabled(process.env) ? "wrapped" : "off",
    });

    afterAll(async () => {
      await applicationStorage.close();
    });

    test("the application's storage connects as the login the variable names, which the role check passes for the application", async () => {
      const { rows } = await applicationStorage.db.execute(
        sql.raw(ROLE_CHECK_SQL),
      );
      const { current: role, session } = resolvedRolesFrom(
        rows as Record<string, unknown>[],
      );

      expect(role.role).toBe(
        decodeURIComponent(
          new URL(process.env[APPLICATION_DATABASE_URL_VARIABLE] as string)
            .username,
        ),
      );
      expect(session.role).toBe(role.role);
      expect(roleObjections("application", role)).toEqual([]);

      const groups = await rawQuery<{ group: string }>(
        owner(),
        `select g.rolname::text as "group"
         from pg_catalog.pg_auth_members m
         join pg_catalog.pg_roles g on g.oid = m.roleid
         join pg_catalog.pg_roles r on r.oid = m.member
         where r.rolname = $1`,
        [role.role],
      );
      expect(groups.rows).toEqual([{ group: "requestport_application" }]);
      expect(tenantWrappingEnabled()).toBe(true);
    });

    test("a repository read through the application's storage binds its organisation", async () => {
      const organizationId = randomUUID();
      const projectId = randomUUID();
      const userId = `lane-${organizationId.slice(0, 8)}`;
      const seed: [string, unknown[]][] = [
        [
          `insert into public."user" (id, name, email) values ($1, 'Lane', $1 || '@example.test')`,
          [userId],
        ],
        [
          `insert into public.organizations (id, name, slug, status) values ($1, 'Lane', $2, 'active')`,
          [organizationId, `lane-${organizationId.slice(0, 8)}`],
        ],
        [
          `insert into public.organization_members (organization_id, user_id, role, status) values ($1, $2, 'admin', 'active')`,
          [organizationId, userId],
        ],
        [
          `insert into public.projects (id, organization_id, name, slug, key_prefix, status) values ($1, $2, 'Lane', 'lane', 'LAN', 'active')`,
          [projectId, organizationId],
        ],
      ];
      const inReplica = (statements: [string, unknown[]][]) =>
        withAdmin(async (session) => {
          await session.query("BEGIN");
          await session.query("SET LOCAL session_replication_role = replica");
          for (const [text, values] of statements) {
            await session.query(text, values);
          }
          await session.query("COMMIT");
        });

      await inReplica(seed);
      try {
        // Unbound, as this role, the policy refuses the read outright.
        await expect(
          applicationStorage.db.execute(
            sql`select id from public.projects where id = ${projectId}`,
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
        expect(
          (
            await createFoundationQueryRepository(
              applicationStorage.db,
            ).listOrganizationProjects(userId, organizationId)
          ).map((project) => project.id),
        ).toEqual([projectId]);
      } finally {
        await inReplica([
          ["delete from public.projects where id = $1", [projectId]],
          [
            "delete from public.organization_members where organization_id = $1",
            [organizationId],
          ],
          ["delete from public.organizations where id = $1", [organizationId]],
          [`delete from public."user" where id = $1`, [userId]],
        ]);
      }
    });
  },
);
