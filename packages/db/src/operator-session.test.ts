import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BOOTSTRAP_OWNER_ACTOR, bootstrapOwner } from "@requestport/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { MIGRATION_LOCK_KEY, migrate } from "./migrate.js";
import {
  alterLoginStatement,
  commentLoginStatement,
  createLoginStatement,
  INSTANCE_CLAIM_LOCK_KEY,
  INSTANCE_LOGIN_GROUPS,
  INSTANCE_LOGIN_KINDS,
  type InstanceLoginKind,
  instanceClaimComment,
  instanceLoginNames,
  instanceLoginUrls,
  OperatorRefusalError,
  type OperatorSession,
  openOperatorSession,
  ownerRefusedByRoleGuard,
  packagedMigrationsFolder,
  parseInstanceClaim,
  scramSha256Verifier,
} from "./operator-session.js";
import {
  DatabaseRoleGuardError,
  DatabaseSurfaceError,
  declaredDatabaseSurface,
  REQUESTPORT_GROUP_ROLES,
  type RoleGuardFinding,
  resetDatabaseSurfaceDeclaration,
} from "./role-guard.js";
import { WORKER_GROUP_ROLES } from "./tenant-context.js";
import { createTestStorage, rawQuery } from "./testing.js";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const journalEntries = (
  JSON.parse(
    readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries: unknown[] }
).entries.length;

const password = () => randomBytes(32).toString("base64url");
const passwordsFor = () =>
  Object.fromEntries(
    INSTANCE_LOGIN_KINDS.map((kind) => [kind, password()]),
  ) as Record<InstanceLoginKind, string>;

describe("the instance's logins and the statements that make them", () => {
  test("names each login rp_<id>_<kind>, unquoted-safe, under 64 bytes, and never a group's name", () => {
    const names = instanceLoginNames("0123456789abcdef");

    expect(names).toEqual({
      application: "rp_0123456789abcdef_application",
      dispatcher: "rp_0123456789abcdef_dispatcher",
      processor: "rp_0123456789abcdef_tenant_processor",
      maintenance: "rp_0123456789abcdef_maintenance",
    });
    const longest = Object.values(instanceLoginNames("a".repeat(32)));
    for (const name of longest) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z_][a-z0-9_]*$/u);
      expect(REQUESTPORT_GROUP_ROLES).not.toContain(name);
    }
  });

  test("puts each login in one of RequestPort's groups, the worker's three as the worker's storages expect", () => {
    expect(INSTANCE_LOGIN_GROUPS).toEqual({
      application: "requestport_application",
      dispatcher: WORKER_GROUP_ROLES.dispatcher,
      processor: WORKER_GROUP_ROLES.processor,
      maintenance: WORKER_GROUP_ROLES.maintenance,
    });
    for (const group of Object.values(INSTANCE_LOGIN_GROUPS)) {
      expect(REQUESTPORT_GROUP_ROLES).toContain(group);
    }
    expect(new Set(Object.values(INSTANCE_LOGIN_GROUPS)).size).toBe(4);
  });

  test.each([
    "short",
    "UPPERCASE0",
    "with-dash00",
    "quote'00000",
    "a".repeat(33),
  ])("refuses the instance id %j", (instanceId) => {
    expect(() => instanceLoginNames(instanceId)).toThrow(/instance id/u);
    expect(() => instanceClaimComment(instanceId, "db")).toThrow(
      /instance id/u,
    );
  });

  test("reads back the claim its comment writes, whatever the database's name", () => {
    for (const database of ["requestport", "it's a \\ database"]) {
      expect(
        parseInstanceClaim(instanceClaimComment("0123456789abcdef", database)),
      ).toEqual({ instanceId: "0123456789abcdef", database });
    }
    expect(parseInstanceClaim(null)).toBeUndefined();
    expect(parseInstanceClaim("an acceptance login")).toBeUndefined();
  });

  test("writes a SCRAM-SHA-256 verifier into each statement, never the password", () => {
    const secret = password();
    const verifier = scramSha256Verifier(secret);

    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/u,
    );
    for (const statement of [
      createLoginStatement("rp_0123456789abcdef_application", verifier),
      alterLoginStatement("rp_0123456789abcdef_application", verifier),
    ]) {
      expect(statement).toContain(verifier);
      expect(statement).not.toContain(secret);
    }
    expect(
      alterLoginStatement("rp_0123456789abcdef_application", verifier),
    ).toBe(
      `alter role "rp_0123456789abcdef_application" with login nobypassrls nocreaterole password '${verifier}'`,
    );
    expect(() => scramSha256Verifier("short")).toThrow(/32 or more/u);
    expect(() => scramSha256Verifier(`${secret}'`)).toThrow(/32 or more/u);
  });

  test("quotes the claim's comment as a literal, whatever the database's name holds", () => {
    expect(
      commentLoginStatement(
        "rp_0123456789abcdef_application",
        instanceClaimComment("0123456789abcdef", "it's"),
      ),
    ).toBe(
      `comment on role "rp_0123456789abcdef_application" is 'requestport instance 0123456789abcdef database it''s'`,
    );
    expect(
      commentLoginStatement(
        "rp_0123456789abcdef_application",
        instanceClaimComment("0123456789abcdef", "a\\b"),
      ),
    ).toBe(
      `comment on role "rp_0123456789abcdef_application" is  E'requestport instance 0123456789abcdef database a\\\\b'`,
    );
    expect(() => createLoginStatement('x"; drop role y; --', "v")).toThrow(
      /identifier/u,
    );
  });

  test("composes each login's URL from the owner URL's server and database, keeping how it is reached, never the owner's credentials or options", () => {
    const passwords = passwordsFor();
    const urls = instanceLoginUrls(
      "postgres://owner:OWNER_SECRET@db.example.com:6543/requestport?sslmode=verify-full&sslrootcert=/etc/ca.pem&options=-c%20role%3Dx&application_name=owner",
      "0123456789abcdef",
      passwords,
    );
    const names = instanceLoginNames("0123456789abcdef");

    for (const kind of INSTANCE_LOGIN_KINDS) {
      const url = new URL(urls[kind]);
      expect(url.protocol).toBe("postgres:");
      expect(url.host).toBe("db.example.com:6543");
      expect(url.pathname).toBe("/requestport");
      expect(url.username).toBe(names[kind]);
      expect(url.password).toBe(passwords[kind]);
      expect([...url.searchParams.keys()].sort()).toEqual([
        "sslmode",
        "sslrootcert",
      ]);
      expect(url.searchParams.get("sslmode")).toBe("verify-full");
      expect(urls[kind]).not.toContain("OWNER_SECRET");
      expect(urls[kind]).not.toContain("owner");
    }
    expect(() =>
      instanceLoginUrls("not a url", "0123456789abcdef", passwords),
    ).toThrow("The owner URL is not a URL.");
    expect(() =>
      instanceLoginUrls("postgres://o:p@h/d", "0123456789abcdef", {
        ...passwords,
        dispatcher: "short",
      }),
    ).toThrow(/dispatcher login's password/u);
  });

  test("names the folder migrate() reads by default, which holds the journal", () => {
    expect(packagedMigrationsFolder()).toBe(migrationsFolder);
    expect(journalEntries).toBeGreaterThan(0);
  });

  test("opens nothing in a process that has not declared operator", async () => {
    const declared = declaredDatabaseSurface();
    try {
      for (const surface of [undefined, "application", "worker"] as const) {
        resetDatabaseSurfaceDeclaration(surface);
        await expect(
          openOperatorSession({
            ownerUrl: "postgres://owner:secret@127.0.0.1:1/never",
            env: {},
          }),
        ).rejects.toBeInstanceOf(DatabaseSurfaceError);
      }
    } finally {
      resetDatabaseSurfaceDeclaration(declared);
    }
  });

  test("imports the migrator's types only, so ./wiring's graph, which the web and the Trigger.dev worker load, gains no migrator", () => {
    const source = readFileSync(
      new URL("./operator-session.ts", import.meta.url),
      "utf8",
    );
    const fromMigrate = source.match(/^import[^;]*"\.\/migrate\.js";$/gmu);

    expect(fromMigrate).toEqual([expect.stringMatching(/^import type \{/u)]);
    expect(source).not.toMatch(/import\(\s*["'`]\.\/migrate/u);
  });

  test("takes a lock key of its own, not migrate()'s", () => {
    expect(INSTANCE_CLAIM_LOCK_KEY).not.toBe(MIGRATION_LOCK_KEY);
    expect(
      Buffer.from(
        BigInt.asUintN(64, BigInt(INSTANCE_CLAIM_LOCK_KEY))
          .toString(16)
          .padStart(16, "0"),
        "hex",
      ).toString(),
    ).toBe("RPCLAIMS");
  });
});

/*
 * What `openOperatorSession` makes of a role-guard refusal at its first
 * connection (`throw ownerRefusedByRoleGuard(error) ?? error`): only the
 * operator role check's lone `cannot_bypass_row_security`, for a role logged
 * in as itself, becomes `owner_attributes`; every other refusal is thrown as
 * it is (review of I.2 step 5: nothing pinned the narrowing).
 */
describe("which refusal at the owner's first connection is owner_attributes", () => {
  const mapped: RoleGuardFinding = {
    check: "role",
    status: "refused",
    surface: "operator",
    role: "owner_nobypass",
    objections: ["cannot_bypass_row_security"],
  };
  const refusal = (finding: RoleGuardFinding) =>
    new DatabaseRoleGuardError(
      "RequestPort database role is not permitted",
      finding,
    );

  test("the operator role check's lone cannot_bypass_row_security, for a role logged in as itself, is owner_attributes with the remedy", () => {
    const owner = ownerRefusedByRoleGuard(refusal(mapped));

    expect(owner).toBeInstanceOf(OperatorRefusalError);
    expect(owner?.reason).toBe("owner_attributes");
    expect(owner?.message).toContain(
      "As a superuser, run ALTER ROLE owner_nobypass BYPASSRLS, with CREATEROLE too if it lacks that;",
    );
  });

  test.each<[string, RoleGuardFinding]>([
    [
      "a declaration refusal",
      {
        check: "declaration",
        status: "refused",
        surface: undefined,
        objections: ["undeclared"],
      },
    ],
    [
      "the environment check's refusal",
      {
        check: "environment",
        status: "refused",
        surface: "operator",
        objections: ["DATABASE_URL"],
      },
    ],
    [
      "the role check's refusal of the application surface",
      { ...mapped, surface: "application" },
    ],
    [
      "the role check's refusal of the worker surface",
      { ...mapped, surface: "worker" },
    ],
    ["a role check finding naming no role", { ...mapped, role: undefined }],
    [
      "a finding whose session role is another login",
      { ...mapped, sessionRole: "owner_login" },
    ],
    [
      "another lone objection",
      { ...mapped, objections: ["member_of_bypassing_role"] },
    ],
    [
      "a second objection beside it",
      {
        ...mapped,
        objections: ["cannot_bypass_row_security", "superuser"],
      },
    ],
    ["no objection", { ...mapped, objections: [] }],
    [
      "the mapped finding from another check, every other field the same",
      { ...mapped, check: "environment" },
    ],
  ])(
    "%s is not owner_attributes, and is thrown as it is",
    (_label, finding) => {
      const error = refusal(finding);

      expect(ownerRefusedByRoleGuard(error)).toBeUndefined();
      expect(ownerRefusedByRoleGuard(error) ?? error).toBe(error);
    },
  );

  test("an error that is not the role guard's is not owner_attributes, whatever it carries", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      finding: mapped,
    });

    expect(ownerRefusedByRoleGuard(error)).toBeUndefined();
  });
});

/*
 * On the run's PostgreSQL, as its superuser (`DATABASE_URL`), in databases
 * and with roles this file creates, every name carrying the run's suffix or
 * an instance id it made, and drops in `afterAll`, checking none is left
 * (ruling 158, item 15). Roles are cluster-wide, so nothing here touches a
 * role or a database it did not create.
 */
describe("an operator session on PostgreSQL", () => {
  const run = `opsess_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const admin = createTestStorage({
    driver: "pg",
    pool: {
      max: 4,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 15_000,
    },
  });
  const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
  const databases: string[] = [];
  const roles: string[] = [];
  const instanceIds: string[] = [];
  const sessions: OperatorSession[] = [];
  const ownerPassword = password();
  const owners = {
    superuser: `${run}_super`,
    nobypass: `${run}_nobypass`,
    nocreaterole: `${run}_nocreaterole`,
    noadmin: `${run}_noadmin`,
    admin: `${run}_admin`,
  };

  const sql = (text: string, values?: unknown[]) =>
    rawQuery(admin, text, values);
  const urlFor = (user: string, secret: string, database: string) => {
    const url = new URL(base);
    url.username = user;
    url.password = secret;
    url.pathname = `/${database}`;
    url.search = "";
    return url.toString();
  };
  let counter = 0;
  const scratch = async (owner: string) => {
    counter += 1;
    const name = `${run}_${counter}`;
    await sql(`create database "${name}" owner "${owner}"`);
    databases.push(name);
    return name;
  };
  const newInstanceId = () => {
    const id = randomBytes(8).toString("hex");
    instanceIds.push(id);
    return id;
  };
  const open = async (owner: string, database: string) => {
    const session = await openOperatorSession({
      ownerUrl: urlFor(owner, ownerPassword, database),
      env: {},
    });
    sessions.push(session);
    return session;
  };
  const instanceRoles = async (instanceId: string) =>
    (
      await sql(
        `select r.rolname::text as login,
                pg_catalog.shobj_description(r.oid, 'pg_authid') as comment,
                (select count(*)::int from pg_catalog.pg_auth_members am where am.member = r.oid) as group_rows,
                (select string_agg(g.rolname::text, ',' order by g.rolname) from pg_catalog.pg_auth_members am
                   join pg_catalog.pg_roles g on g.oid = am.roleid where am.member = r.oid) as groups,
                r.rolsuper or r.rolcreatedb or r.rolreplication or r.rolbypassrls or r.rolcreaterole as privileged
           from pg_catalog.pg_roles r where r.rolname like $1 order by 1`,
        [`rp\\_${instanceId}\\_%`],
      )
    ).rows as {
      login: string;
      comment: string | null;
      group_rows: number;
      groups: string | null;
      privileged: boolean;
    }[];
  const journalTable = async (database: string) => {
    const probe = createTestStorage({
      driver: "pg",
      connectionString: urlFor(
        base.username,
        decodeURIComponent(base.password),
        database,
      ),
    });
    try {
      return (
        await rawQuery(
          probe,
          "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
        )
      ).rows[0]?.present as boolean;
    } finally {
      await probe.close();
    }
  };

  beforeAll(async () => {
    const self = (
      await sql(
        "select rolsuper from pg_catalog.pg_roles where rolname = current_user",
      )
    ).rows[0] as { rolsuper: boolean };
    expect(self.rolsuper, "DATABASE_URL must name a superuser here").toBe(true);
    const create = async (name: string, attributes: string) => {
      roles.push(name);
      await sql(
        `create role "${name}" login password '${ownerPassword}' ${attributes}`,
      );
    };
    await create(owners.superuser, "superuser");
    await create(owners.nobypass, "nosuperuser createrole nobypassrls");
    await create(owners.nocreaterole, "nosuperuser nocreaterole bypassrls");
    await create(owners.noadmin, "nosuperuser createrole bypassrls");
    await create(owners.admin, "nosuperuser createrole bypassrls");
    const present = (
      await sql(
        "select count(*)::int as n from pg_catalog.pg_roles where rolname = any($1::text[])",
        [[...REQUESTPORT_GROUP_ROLES]],
      )
    ).rows[0] as { n: number };
    expect(
      present.n,
      "the groups exist on this server, created by its superuser",
    ).toBe(REQUESTPORT_GROUP_ROLES.length);
    await sql(
      `grant ${REQUESTPORT_GROUP_ROLES.join(", ")} to "${owners.admin}" with admin option, inherit false, set false`,
    );
    // A password the server hashes itself, on the superuser owner's
    // sessions, gets one iteration; a verifier the session computes carries
    // its own 4096. So the stored verifiers show which the statement held.
    await sql(`alter role "${owners.superuser}" set scram_iterations = 1`);
  });

  afterAll(async () => {
    try {
      await Promise.all(sessions.map((session) => session.close()));
      for (const database of databases) {
        await sql(`drop database if exists "${database}" with (force)`);
      }
      const logins = (
        await sql(
          "select rolname::text as name from pg_catalog.pg_roles where rolname like any($1::text[]) order by 1",
          [instanceIds.map((id) => `rp\\_${id}\\_%`)],
        )
      ).rows as { name: string }[];
      for (const name of [...logins.map((row) => row.name), ...roles]) {
        await sql(`drop role if exists "${name}"`);
      }
      const left = (
        await sql(
          `select (select count(*)::int from pg_catalog.pg_roles
                    where rolname like $1 or rolname like any($2::text[])) as roles,
                  (select count(*)::int from pg_catalog.pg_database where datname like $1) as databases`,
          [`${run}%`, instanceIds.map((id) => `rp\\_${id}\\_%`)],
        )
      ).rows[0];
      expect(left).toEqual({ roles: 0, databases: 0 });
    } finally {
      await admin.close();
    }
  });

  test("a superuser owner: preflight, claim and provision sending SCRAM verifiers in place of the passwords, migrate, and a foundation repository the bootstrap runs on", async () => {
    const database = await scratch(owners.superuser);
    const instanceId = newInstanceId();
    const passwords = passwordsFor();
    const names = instanceLoginNames(instanceId);
    const session = await open(owners.superuser, database);

    await expect(session.claim({ instanceId, passwords })).rejects.toThrow(
      /needs a session that is preflighted/u,
    );
    expect(await session.preflight()).toEqual({
      role: owners.superuser,
      database,
      superuser: true,
      absentGroups: [],
    });
    expect(await session.claim({ instanceId, passwords })).toBe("claimed");

    const claimed = await instanceRoles(instanceId);
    expect(claimed.map((row) => row.login)).toEqual(
      Object.values(names).sort(),
    );
    for (const row of claimed) {
      expect(row).toMatchObject({
        comment: instanceClaimComment(instanceId, database),
        group_rows: 0,
        privileged: false,
      });
    }
    expect(await journalTable(database)).toBe(false);
    const storedVerifiers = async () =>
      (
        await sql(
          "select rolpassword from pg_catalog.pg_authid where rolname = any($1::text[])",
          [Object.values(names)],
        )
      ).rows.map((row) => String(row.rolpassword).split(":")[0]);
    expect(await storedVerifiers()).toEqual(
      Array(4).fill("SCRAM-SHA-256$4096"),
    );

    const report = await session.migrate({
      migrationsFolder,
      migrator: migrate,
    });
    expect(report.applied).toHaveLength(journalEntries);

    const provisioned = await session.provision({ instanceId, passwords });
    expect(provisioned).toEqual(
      INSTANCE_LOGIN_KINDS.map((kind) => ({
        kind,
        login: names[kind],
        group: INSTANCE_LOGIN_GROUPS[kind],
      })),
    );
    expect(await storedVerifiers()).toEqual(
      Array(4).fill("SCRAM-SHA-256$4096"),
    );
    // Run again, as a resume runs it: the same state.
    await session.provision({ instanceId, passwords });
    for (const row of await instanceRoles(instanceId)) {
      const kind = INSTANCE_LOGIN_KINDS.find(
        (each) => names[each] === row.login,
      ) as InstanceLoginKind;
      expect(row).toMatchObject({
        group_rows: 1,
        groups: INSTANCE_LOGIN_GROUPS[kind],
        privileged: false,
        comment: instanceClaimComment(instanceId, database),
      });
    }

    // Each login connects with the password secrets.json holds: the
    // verifier written in its place is the password's.
    for (const kind of INSTANCE_LOGIN_KINDS) {
      const login = createTestStorage({
        driver: "pg",
        connectionString: urlFor(names[kind], passwords[kind], database),
      });
      try {
        expect(
          (await rawQuery(login, "select current_user::text as role")).rows,
        ).toEqual([{ role: names[kind] }]);
      } finally {
        await login.close();
      }
    }

    const result = await bootstrapOwner(
      session.bootstrapRepository(),
      { actor: BOOTSTRAP_OWNER_ACTOR, correlationId: `test_${run}` },
      {
        email: "owner@example.com",
        organizationSlug: "acme",
        organizationName: "Acme",
        localCredential: "issue",
      },
    );
    expect(result).toMatchObject({
      status: "owner_active",
      localCredential: "issued",
    });
    await session.close();

    // A second start's session finds its own claim and goes on.
    const again = await open(owners.superuser, database);
    await again.preflight();
    expect(await again.claim({ instanceId, passwords })).toBe(
      "already-claimed",
    );
    expect(
      (await again.migrate({ migrationsFolder, migrator: migrate })).applied,
    ).toEqual([]);
    await again.close();
  });

  test("a second session on the database waits for the first's claim lock", async () => {
    const database = await scratch(owners.superuser);
    const first = await open(owners.superuser, database);
    let opened = false;
    const second = open(owners.superuser, database).then((session) => {
      opened = true;
      return session;
    });

    await new Promise((settle) => setTimeout(settle, 500));
    expect(opened).toBe(false);
    await first.close();
    await (await second).close();
    expect(opened).toBe(true);
  });

  test.each([
    ["nobypass", /lacks BYPASSRLS\./u],
    ["nocreaterole", /lacks CREATEROLE\./u],
  ] as const)(
    "refuses an owner that is %s, naming the attribute, before anything is created",
    async (shape, named) => {
      const database = await scratch(owners[shape]);
      const instanceId = newInstanceId();
      const session = await open(owners[shape], database);

      const refused = await session.preflight().catch((error) => error);
      expect(refused).toBeInstanceOf(OperatorRefusalError);
      expect(refused).toMatchObject({ reason: "owner_attributes" });
      expect((refused as Error).message).toMatch(named);
      await expect(
        session.claim({ instanceId, passwords: passwordsFor() }),
      ).rejects.toThrow(/needs a session that is preflighted/u);
      await session.close();
      expect(await instanceRoles(instanceId)).toEqual([]);
      expect(await journalTable(database)).toBe(false);
    },
  );

  test("refuses a non-superuser owner without ADMIN OPTION on groups another role created, with the remedy", async () => {
    const database = await scratch(owners.noadmin);
    const session = await open(owners.noadmin, database);

    const refused = await session.preflight().catch((error) => error);
    expect(refused).toMatchObject({ reason: "owner_admin_option" });
    expect((refused as Error).message).toContain(
      `GRANT ${REQUESTPORT_GROUP_ROLES.join(", ")} TO ${owners.noadmin} WITH ADMIN OPTION`,
    );
    await session.close();
    expect(await journalTable(database)).toBe(false);
  });

  test("refuses a database whose journal is not empty and holds no claim of this instance, before migrate", async () => {
    const database = await scratch(owners.superuser);
    const byHand = createTestStorage({
      driver: "pg",
      connectionString: urlFor(owners.superuser, ownerPassword, database),
    });
    try {
      await migrate(byHand, { migrationsFolder });
    } finally {
      await byHand.close();
    }
    const instanceId = newInstanceId();
    const session = await open(owners.superuser, database);
    await session.preflight();

    const refused = await session
      .claim({ instanceId, passwords: passwordsFor() })
      .catch((error) => error);
    expect(refused).toMatchObject({ reason: "journal_without_claim" });
    expect((refused as Error).message).toMatch(
      new RegExp(`holds ${journalEntries} applied migrations`, "u"),
    );
    await expect(
      session.migrate({ migrationsFolder, migrator: migrate }),
    ).rejects.toThrow(/needs a session that is claimed/u);
    await session.close();
    expect(await instanceRoles(instanceId)).toEqual([]);
  });

  test("refuses a database another instance has claimed, and leaves no login of this one", async () => {
    const database = await scratch(owners.superuser);
    const other = `${run}_other_claim`;
    roles.push(other);
    await sql(`create role "${other}" nologin`);
    await sql(
      `comment on role "${other}" is 'requestport instance otherinstance01 database ${database}'`,
    );
    const instanceId = newInstanceId();
    const session = await open(owners.superuser, database);
    await session.preflight();

    const refused = await session
      .claim({ instanceId, passwords: passwordsFor() })
      .catch((error) => error);
    expect(refused).toMatchObject({ reason: "claimed_by_another_instance" });
    expect((refused as Error).message).toContain("otherinstance01");
    await session.close();
    expect(await instanceRoles(instanceId)).toEqual([]);
  });

  test("refuses when some of this instance's logins exist but are not its claim on this database", async () => {
    const database = await scratch(owners.superuser);
    const instanceId = newInstanceId();
    await sql(
      `create role "${instanceLoginNames(instanceId).application}" nologin`,
    );
    const session = await open(owners.superuser, database);
    await session.preflight();

    await expect(
      session.claim({ instanceId, passwords: passwordsFor() }),
    ).rejects.toMatchObject({ reason: "instance_logins_exist" });
    await session.close();
    expect((await instanceRoles(instanceId)).map((row) => row.login)).toEqual([
      instanceLoginNames(instanceId).application,
    ]);
  });

  test("a non-superuser CREATEROLE BYPASSRLS owner with ADMIN OPTION, on a cluster holding other logins and another database's claim, initialises its database", async () => {
    const database = await scratch(owners.admin);
    const elsewhere = await scratch(owners.superuser);
    const gate = `${run}_gate_login`;
    const workerGate = `${run}_gate_worker`;
    const otherInstance = `${run}_other_database`;
    roles.push(gate, workerGate, otherInstance);
    await sql(`create role "${gate}" login in role requestport_application`);
    await sql(
      `create role "${workerGate}" login in role requestport_dispatcher`,
    );
    await sql(`create role "${otherInstance}" login`);
    await sql(
      `comment on role "${otherInstance}" is 'requestport instance otherinstance02 database ${elsewhere}'`,
    );
    const instanceId = newInstanceId();
    const passwords = passwordsFor();
    const session = await open(owners.admin, database);

    expect(await session.preflight()).toMatchObject({ superuser: false });
    expect(await session.claim({ instanceId, passwords })).toBe("claimed");
    expect(
      (await session.migrate({ migrationsFolder, migrator: migrate })).applied,
    ).toHaveLength(journalEntries);
    await session.provision({ instanceId, passwords });
    await session.close();
    const rows = await instanceRoles(instanceId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({ group_rows: 1, privileged: false });
    }
    const login = createTestStorage({
      driver: "pg",
      connectionString: urlFor(
        instanceLoginNames(instanceId).application,
        passwords.application,
        database,
      ),
    });
    try {
      expect(
        (await rawQuery(login, "select current_user::text as role")).rows,
      ).toEqual([{ role: instanceLoginNames(instanceId).application }]);
    } finally {
      await login.close();
    }
  });

  test("an owner whose createrole_self_grant includes inherit gets no inheriting membership in the instance's logins, so it cannot execute the worker's functions after provisioning (ruling 215)", async () => {
    const database = await scratch(owners.admin);
    // Only this owner's sessions in this database, and gone with it.
    await sql(
      `alter role "${owners.admin}" in database "${database}" set createrole_self_grant = 'set, inherit'`,
    );
    const instanceId = newInstanceId();
    const passwords = passwordsFor();
    const session = await open(owners.admin, database);

    await session.preflight();
    expect(await session.claim({ instanceId, passwords })).toBe("claimed");
    await session.migrate({ migrationsFolder, migrator: migrate });
    await session.provision({ instanceId, passwords });
    await session.close();
    const { rows } = await sql(
      `select l.rolname::text as login, am.inherit_option, am.set_option
         from pg_catalog.pg_auth_members am
         join pg_catalog.pg_roles l on l.oid = am.roleid
         join pg_catalog.pg_roles o on o.oid = am.member
        where o.rolname = $1 and l.rolname like $2
        order by 1`,
      [owners.admin, `rp\\_${instanceId}\\_%`],
    );
    expect(rows.filter((row) => row.inherit_option || row.set_option)).toEqual(
      [],
    );
    expect(
      (
        await sql(
          `select pg_catalog.has_function_privilege($1, 'requestport_private.claim_outbox_batch(integer, integer)', 'EXECUTE') as executes`,
          [owners.admin],
        )
      ).rows,
    ).toEqual([{ executes: false }]);
  });

  test("provisioning revokes a membership the login should not hold", async () => {
    const database = await scratch(owners.superuser);
    const instanceId = newInstanceId();
    const passwords = passwordsFor();
    const names = instanceLoginNames(instanceId);
    const session = await open(owners.superuser, database);
    await session.preflight();
    await session.claim({ instanceId, passwords });
    await sql(`grant requestport_maintenance to "${names.application}"`);
    await session.migrate({ migrationsFolder, migrator: migrate });
    await session.provision({ instanceId, passwords });
    await session.close();

    expect(
      (await instanceRoles(instanceId)).find(
        (row) => row.login === names.application,
      ),
    ).toMatchObject({ group_rows: 1, groups: "requestport_application" });
  });

  test("each transaction's beforeCommit runs inside it: a failure there leaves the claim, or provisioning, undone", async () => {
    const database = await scratch(owners.superuser);
    const instanceId = newInstanceId();
    const passwords = passwordsFor();
    const session = await open(owners.superuser, database);
    await session.preflight();
    const stop = () => {
      throw new Error("stopped before commit");
    };

    await expect(
      session.claim({ instanceId, passwords, beforeCommit: stop }),
    ).rejects.toThrow("stopped before commit");
    expect(await instanceRoles(instanceId)).toEqual([]);

    expect(await session.claim({ instanceId, passwords })).toBe("claimed");
    await session.migrate({ migrationsFolder, migrator: migrate });
    await expect(
      session.provision({ instanceId, passwords, beforeCommit: stop }),
    ).rejects.toThrow("stopped before commit");
    for (const row of await instanceRoles(instanceId)) {
      expect(row.group_rows).toBe(0);
    }
    await session.close();
  });

  /*
   * The check-only step (ruling 163, item 3): what `requestport owner
   * rotate-credential` runs in place of a start's steps.
   */
  describe("the check-only step", () => {
    /** A database a start's steps initialised for a new instance, as `owners.superuser`. */
    const initialised = async () => {
      const database = await scratch(owners.superuser);
      const instanceId = newInstanceId();
      const passwords = passwordsFor();
      const session = await open(owners.superuser, database);
      await session.preflight();
      await session.claim({ instanceId, passwords });
      await session.migrate({ migrationsFolder, migrator: migrate });
      await session.provision({ instanceId, passwords });
      await session.close();
      return { database, instanceId, passwords };
    };
    /** As the superuser: the instance's roles, with each stored verifier, and the database's journal and tables. */
    const state = async (database: string, instanceId: string) => {
      const verifiers = (
        await sql(
          `select rolname::text as login, rolpassword as verifier
             from pg_catalog.pg_authid where rolname like $1 order by 1`,
          [`rp\\_${instanceId}\\_%`],
        )
      ).rows;
      const probe = createTestStorage({
        driver: "pg",
        connectionString: urlFor(
          base.username,
          decodeURIComponent(base.password),
          database,
        ),
      });
      try {
        const journal = (await journalTable(database))
          ? (
              await rawQuery(
                probe,
                "select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id",
              )
            ).rows
          : null;
        const tables = (
          await rawQuery(
            probe,
            "select count(*)::int as n from pg_catalog.pg_tables where schemaname = 'public'",
          )
        ).rows[0];
        return {
          roles: await instanceRoles(instanceId),
          verifiers,
          journal,
          tables,
        };
      } finally {
        await probe.close();
      }
    };

    test("on a database a start initialised, it answers the preflight and the migrations the journal holds, and creates, changes and migrates nothing; the session then refuses to claim, migrate or provision, and gives the bootstrap's repository", async () => {
      const { database, instanceId, passwords } = await initialised();
      const before = await state(database, instanceId);
      expect(before.roles).toHaveLength(4);
      expect(before.journal).toHaveLength(journalEntries);

      const session = await open(owners.superuser, database);
      expect(await session.check({ instanceId, migrationsFolder })).toEqual({
        preflight: {
          role: owners.superuser,
          database,
          superuser: true,
          absentGroups: [],
        },
        migrations: journalEntries,
      });
      expect(await state(database, instanceId)).toEqual(before);

      for (const [step, attempt] of [
        ["claim", () => session.claim({ instanceId, passwords })],
        [
          "migrate",
          () => session.migrate({ migrationsFolder, migrator: migrate }),
        ],
        ["provision", () => session.provision({ instanceId, passwords })],
      ] as const) {
        await expect(attempt(), step).rejects.toThrow(
          `${step}: this session ran the check-only step, which creates, changes and migrates nothing.`,
        );
      }
      expect(typeof session.bootstrapRepository().transaction).toBe("function");
      await session.close();
      expect(await state(database, instanceId)).toEqual(before);
    });

    test("refuses, saying to run requestport start, when the journal lacks a migration the folder carries, and migrates nothing", async () => {
      const { database, instanceId } = await initialised();
      const before = await state(database, instanceId);
      // A folder carrying one migration more than the database holds, as a
      // newer requestport's bundle would; under this run's default temporary
      // directory (ruling 152).
      const newer = mkdtempSync(join(tmpdir(), "requestport-migrations "));
      try {
        cpSync(migrationsFolder, newer, { recursive: true });
        const journalFile = join(newer, "meta", "_journal.json");
        const journal = JSON.parse(readFileSync(journalFile, "utf8")) as {
          entries: { idx: number; when: number; tag: string }[];
        };
        const last = journal.entries.at(-1) as { idx: number; when: number };
        journal.entries.push({
          ...last,
          idx: last.idx + 1,
          when: last.when + 1_000,
          tag: "9999_check_only_marker",
        });
        writeFileSync(journalFile, JSON.stringify(journal));
        writeFileSync(
          join(newer, "9999_check_only_marker.sql"),
          "create table check_only_marker (id integer);",
        );

        const session = await open(owners.superuser, database);
        const refused = await session
          .check({ instanceId, migrationsFolder: newer })
          .catch((error) => error);
        await session.close();

        expect(refused).toBeInstanceOf(OperatorRefusalError);
        expect(refused).toMatchObject({ reason: "migrations_pending" });
        expect((refused as Error).message).toBe(
          `Database ${database}'s migration journal lacks 1 migration this requestport carries (9999_check_only_marker). A credential rotation never migrates: run requestport start first, which migrates.`,
        );
        expect(await state(database, instanceId)).toEqual(before);
      } finally {
        rmSync(newer, { recursive: true, force: true });
      }
    });

    test("refuses a database that holds no claim of this instance, and one another instance claims, creating nothing", async () => {
      const empty = await scratch(owners.superuser);
      const instanceId = newInstanceId();
      const session = await open(owners.superuser, empty);
      const unclaimed = await session
        .check({ instanceId, migrationsFolder })
        .catch((error) => error);
      await session.close();
      expect(unclaimed).toMatchObject({ reason: "not_claimed" });
      expect((unclaimed as Error).message).toBe(
        `Database ${empty} holds no claim of this instance (${instanceId}), and this check creates none: this instance did not initialise this database, or its logins were dropped. Run requestport start.`,
      );
      expect(await instanceRoles(instanceId)).toEqual([]);
      expect(await journalTable(empty)).toBe(false);

      // A refused check leaves the session check-only: claim creates nothing.
      const refusedThenClaim = await open(owners.superuser, empty);
      await refusedThenClaim
        .check({ instanceId, migrationsFolder })
        .catch(() => undefined);
      await expect(
        refusedThenClaim.claim({ instanceId, passwords: passwordsFor() }),
      ).rejects.toThrow(
        "claim: this session ran the check-only step, which creates, changes and migrates nothing.",
      );
      await refusedThenClaim.close();
      expect(await instanceRoles(instanceId)).toEqual([]);

      const other = await initialised();
      const again = await open(owners.superuser, other.database);
      await expect(
        again.check({ instanceId, migrationsFolder }),
      ).rejects.toMatchObject({ reason: "claimed_by_another_instance" });
      await again.close();
      expect(await instanceRoles(instanceId)).toEqual([]);
    });
  });
});
