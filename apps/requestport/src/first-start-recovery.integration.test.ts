import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { declareDatabaseSurface } from "@requestport/db";
import { createTestStorage, rawQuery } from "@requestport/db/testing";
import {
  INSTANCE_LOGIN_GROUPS,
  INSTANCE_LOGIN_KINDS,
  instanceLoginNames,
  packagedMigrationsFolder,
} from "@requestport/db/wiring";
import { verifyLocalCredential } from "@requestport/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  generateSecrets,
  writeConfiguration,
  writeSecrets,
} from "./configuration.js";
import { newInstanceId, writeInstanceMarker } from "./instance-marker.js";
import { operatorChildCommand } from "./operator/command.js";
import { writeOwnerFile } from "./owner-url.js";
import { SERVER_ACTION_KEY_FILE } from "./server-action-key.js";

/*
 * The first start as a state machine, on the run's PostgreSQL
 * (manifest-h.md §2.3.1; Done when 6a, 7 and 8), as its superuser,
 * `DATABASE_URL`. Every database and role here carries the run's name, or is
 * a login of an instance this file started, and `afterAll` drops each and
 * checks that none is left (ruling 158, item 15).
 *
 * The cluster is not clean (§2.3.1's proof): before any case, it holds a
 * login in `requestport_application` and one in a worker group with no
 * claim, and another instance's claim on another database. The groups exist
 * already, created by the server's superuser, so the owner most cases use is
 * a non-superuser `CREATEROLE BYPASSRLS` login the superuser granted `ADMIN
 * OPTION` on each group; PostgreSQL 16 and later give it an implicit `ADMIN`
 * membership in each login it creates.
 *
 * Starts run as processes of their own: the shipped executable, or, to crash
 * at a boundary, `test-support/crashing-start.test-entry.ts`. This process
 * declares `operator`, as the operator step's entry does; it runs no step
 * itself.
 */
declareDatabaseSurface("operator");

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const crashingStartEntry = join(
  workspace,
  "src",
  "test-support",
  "crashing-start.test-entry.ts",
);
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx/esm"),
).href;

const journalTags = (
  JSON.parse(
    readFileSync(
      join(packagedMigrationsFolder(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: { tag: string }[] }
).entries.map((entry) => entry.tag);

const run = `h4d_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
/** The owners' password: in their URLs, and so in `owner.json`, and nowhere else. */
const SENTINEL = `S3NT1NEL${randomBytes(12).toString("hex")}`;
const owners = {
  superuser: `${run}_owner`,
  admin: `${run}_admin`,
  noadmin: `${run}_noadmin`,
  inheriting: `${run}_inheriting`,
};
/** The groups the migrations create, which exist on this cluster already. */
const GROUPS = [
  ...new Set([...Object.values(INSTANCE_LOGIN_GROUPS), "requestport_definer"]),
].sort();
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const admin = createTestStorage({
  driver: "pg",
  pool: { max: 3, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 15_000 },
});
const sql = (text: string, values?: unknown[]) => rawQuery(admin, text, values);

const databases: string[] = [];
const roles: string[] = [];
const instanceIds = new Set<string>();
const scratch = mkdtempSync(join(tmpdir(), "requestport-recovery-"));

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
};
const ownerUrlFor = (owner: string, database: string) =>
  urlFor(owner, SENTINEL, database);

let databaseCount = 0;
async function scratchDatabase(owner: string) {
  databaseCount += 1;
  const name = `${run}_${databaseCount}`;
  await sql(`create database "${name}" owner "${owner}"`);
  databases.push(name);
  return name;
}

let directoryCount = 0;
/** A data directory's path, with a space in it, as macOS's default has. */
function dataDirectoryPath() {
  directoryCount += 1;
  return join(scratch, `data ${directoryCount}`);
}

/** A `--owner-url-file` naming `owner` on `database`, mode 0600. */
function ownerUrlFile(owner: string, database: string) {
  const path = join(scratch, `owner-${owner}-${database}.url`);
  writeFileSync(path, `${ownerUrlFor(owner, database)}\n`, { mode: 0o600 });
  return path;
}

/** As the superuser, on `database`. */
async function onDatabase<T>(
  database: string,
  work: (query: typeof sql) => Promise<T>,
): Promise<T> {
  const storage = createTestStorage({
    driver: "pg",
    connectionString: urlFor(
      base.username,
      decodeURIComponent(base.password),
      database,
    ),
  });
  try {
    return await work((text, values) => rawQuery(storage, text, values));
  } finally {
    await storage.close();
  }
}

/** This instance's logins as the catalogue has them, with the count of `pg_auth_members` rows whose member each is. */
async function instanceLogins(instanceId: string) {
  instanceIds.add(instanceId);
  return (
    await sql(
      `select r.rolname::text as login,
              pg_catalog.shobj_description(r.oid, 'pg_authid') as comment,
              (select count(*)::int from pg_catalog.pg_auth_members am where am.member = r.oid) as group_rows,
              (select string_agg(g.rolname::text, ',' order by g.rolname)
                 from pg_catalog.pg_auth_members am join pg_catalog.pg_roles g on g.oid = am.roleid
                where am.member = r.oid) as groups,
              r.rolsuper or r.rolcreatedb or r.rolreplication or r.rolbypassrls or r.rolcreaterole as privileged
         from pg_catalog.pg_roles r where r.rolname = any($1::text[]) order by 1`,
      [Object.values(instanceLoginNames(instanceId))],
    )
  ).rows as {
    login: string;
    comment: string | null;
    group_rows: number;
    groups: string | null;
    privileged: boolean;
  }[];
}

const markerOf = (directory: string) =>
  JSON.parse(readFileSync(join(directory, "init.json"), "utf8")) as {
    instanceId: string;
    complete?: boolean;
  };

/** The journal's length, `null` before `migrate` has made it, and the active owners once there is a table to hold them. */
async function databaseState(database: string) {
  return onDatabase(database, async (query) => {
    const present = (
      await query(
        "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
      )
    ).rows[0]?.present as boolean;
    if (!present) return { journal: null, owners: 0 };
    const journal = (
      await query("select count(*)::int as n from drizzle.__drizzle_migrations")
    ).rows[0]?.n as number;
    const active = (
      await query(
        "select count(*)::int as n from organization_members where role = 'owner' and status = 'active'",
      )
    ).rows[0]?.n as number;
    return { journal, owners: active };
  });
}

/** The reasons of the owner's bootstrap audit records, oldest first. */
async function bootstrapAudit(database: string) {
  return onDatabase(database, async (query) =>
    (
      await query(
        `select reason from security_audit_records
          where action = 'organization.owner_bootstrapped' order by occurred_at, id`,
      )
    ).rows.map((row) => row.reason as string),
  );
}

interface Finished {
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  served: boolean;
}

/** What `requestport start` says once it serves (`serve/run.ts`). */
const SERVING = "requestport start: serving ";

/**
 * Runs a start to its end: `bin`, the shipped executable, or `crashing`, the
 * test entry that kills itself at the boundary `RP_H4_TEST_CRASH_AT` names.
 * Once it says it serves, `whileServing` runs, and then SIGTERM stops it, as
 * a self-hoster stops it.
 */
function runStart(
  command: "bin" | "crashing",
  args: readonly string[],
  {
    env = process.env,
    whileServing,
  }: {
    env?: NodeJS.ProcessEnv;
    whileServing?: (output: { stdout(): string }) => Promise<void>;
  } = {},
): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      command === "bin"
        ? [bin, "start", ...args]
        : ["--import", tsxLoader, crashingStartEntry, ...args],
      { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let served = false;
    let checked: Promise<unknown> = Promise.resolve();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!served && stderr.includes(SERVING)) {
        served = true;
        checked = (async () => {
          try {
            await whileServing?.({ stdout: () => stdout });
          } finally {
            child.kill("SIGTERM");
          }
        })().then(
          () => undefined,
          (error: unknown) => error,
        );
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      void checked.then((failure) => {
        if (failure !== undefined) reject(failure);
        else
          resolvePromise({
            pid: child.pid as number,
            code,
            signal,
            stdout,
            stderr,
            served,
          });
      });
    });
    child.stdin.end("");
  });
}

/** The shipped operator child, as `requestport start` starts it, over a data directory a test prepared. */
function operatorChild(
  directory: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { command, args } = operatorChildCommand(realpathSync(directory));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** A port nothing listens on now, which the system chose: never 3100. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

const EMAIL = "owner@example.com";
const bootstrapFlags = [
  "--email",
  EMAIL,
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];

/** The local credentials a start printed: the lines of its standard output that are one. */
const credentialsIn = (stdout: string) =>
  stdout
    .replaceAll("\r", "")
    .split("\n")
    .filter((line) => /^[A-Za-z0-9_-]{43}$/u.test(line));

/** The status a sign-in with the owner's local credential answers, through the host. */
async function signIn(publicUrl: string, credential: string) {
  const response = await fetch(`${publicUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicUrl },
    body: JSON.stringify({ email: EMAIL, password: credential }),
  });
  await response.arrayBuffer();
  return response.status;
}

/** The files a first start writes before it serves. */
const DATA_FILES = ["config.json", "init.json", "owner.json", "secrets.json"];

/**
 * What a converged first start leaves (Done when 6a): the data directory's
 * four files and, when a start has served from it (`served`), the web UI's
 * server-action key, which the serving step makes (ruling 201 item 4), each
 * 0600, no `*.tmp-*`, `init.json` complete; the journal complete; exactly
 * four instance logins, each claimed for this database, in exactly one
 * group, unprivileged, and connecting with the password in `secrets.json`;
 * one active owner, whose stored hash accepts `credential`.
 */
async function expectConverged(
  directory: string,
  database: string,
  credential: string,
  { served }: { served: boolean },
) {
  const files = readdirSync(directory).sort();
  expect(files).toEqual(
    served ? [...DATA_FILES, SERVER_ACTION_KEY_FILE].sort() : DATA_FILES,
  );
  expect(files.filter((file) => file.includes(".tmp-"))).toEqual([]);
  for (const file of files) {
    expect(statSync(join(directory, file)).mode & 0o777, file).toBe(0o600);
    expect(
      readFileSync(join(directory, file), "utf8").includes(SENTINEL),
      file,
    ).toBe(file === "owner.json");
  }
  const marker = markerOf(directory);
  expect(marker.complete).toBe(true);
  const names = instanceLoginNames(marker.instanceId);

  const logins = await instanceLogins(marker.instanceId);
  expect(logins.map((row) => row.login)).toEqual(Object.values(names).sort());
  for (const kind of INSTANCE_LOGIN_KINDS) {
    expect(
      logins.find((row) => row.login === names[kind]),
      kind,
    ).toEqual({
      login: names[kind],
      comment: `requestport instance ${marker.instanceId} database ${database}`,
      group_rows: 1,
      groups: INSTANCE_LOGIN_GROUPS[kind],
      privileged: false,
    });
  }
  const secrets = JSON.parse(
    readFileSync(join(directory, "secrets.json"), "utf8"),
  );
  for (const kind of INSTANCE_LOGIN_KINDS) {
    const url = secrets.loginUrls[kind] as string;
    expect(new URL(url).password).toBe(secrets.loginPasswords[kind]);
    const login = createTestStorage({ driver: "pg", connectionString: url });
    try {
      expect(
        (await rawQuery(login, "select current_user::text as role")).rows,
      ).toEqual([{ role: names[kind] }]);
    } finally {
      await login.close();
    }
  }

  expect(await databaseState(database)).toEqual({
    journal: journalTags.length,
    owners: 1,
  });
  const [owner] = await onDatabase(
    database,
    async (query) =>
      (
        await query(
          `select u.email, o.slug, a.password as hash
             from organization_members m
             join organizations o on o.id = m.organization_id
             join "user" u on u.id = m.user_id
             left join account a on a.user_id = u.id and a.provider_id = 'credential'
            where m.role = 'owner' and m.status = 'active'`,
        )
      ).rows as { email: string; slug: string; hash: string | null }[],
  );
  expect(owner).toMatchObject({ email: EMAIL, slug: "acme" });
  expect(
    await verifyLocalCredential({
      hash: owner?.hash as string,
      password: credential,
    }),
  ).toBe(true);
}

beforeAll(async () => {
  expect(
    ["127.0.0.1", "localhost", "[::1]"],
    "these suites create roles: DATABASE_URL must name a PostgreSQL on this machine",
  ).toContain(base.hostname);
  const self = (
    await sql(
      "select rolsuper from pg_catalog.pg_roles where rolname = current_user",
    )
  ).rows[0] as { rolsuper: boolean };
  expect(self.rolsuper, "DATABASE_URL must name a superuser").toBe(true);
  const present = (
    await sql(
      "select count(*)::int as n from pg_catalog.pg_roles where rolname = any($1::text[])",
      [GROUPS],
    )
  ).rows[0] as { n: number };
  expect(
    present.n,
    "the groups exist on this server already, created by its superuser",
  ).toBe(GROUPS.length);

  for (const [name, attributes] of [
    [owners.superuser, "superuser"],
    [owners.admin, "nosuperuser createrole bypassrls"],
    [owners.noadmin, "nosuperuser createrole bypassrls"],
    [owners.inheriting, "nosuperuser createrole bypassrls"],
  ] as const) {
    roles.push(name);
    await sql(
      `create role "${name}" login password '${SENTINEL}' ${attributes}`,
    );
  }
  await sql(
    `grant ${GROUPS.join(", ")} to "${owners.admin}" with admin option, inherit false, set false`,
  );
  // As admin, but inheriting requestport_dispatcher: the membership a server
  // whose createrole_self_grant includes inherit gives the role that creates
  // the group, which on this cluster its superuser created.
  await sql(
    `grant ${GROUPS.filter((group) => group !== "requestport_dispatcher").join(", ")} to "${owners.inheriting}" with admin option, inherit false, set false`,
  );
  await sql(
    `grant requestport_dispatcher to "${owners.inheriting}" with admin option, inherit true, set false`,
  );

  // The cluster is not clean: a login in requestport_application and one in
  // a worker group, neither claiming anything, as a gate's acceptance login
  // is left; and another instance's claim on another database.
  const gate = `${run}_gate_application`;
  const workerGate = `${run}_gate_dispatcher`;
  const elsewhereClaim = `${run}_elsewhere_claim`;
  roles.push(gate, workerGate, elsewhereClaim);
  await sql(`create role "${gate}" login in role requestport_application`);
  await sql(`create role "${workerGate}" login in role requestport_dispatcher`);
  const elsewhere = await scratchDatabase(owners.superuser);
  await sql(`create role "${elsewhereClaim}" nologin`);
  await sql(
    `comment on role "${elsewhereClaim}" is 'requestport instance 00000000000000ee database ${elsewhere}'`,
  );
});

afterAll(async () => {
  try {
    for (const database of databases) {
      await sql(`drop database if exists "${database}" with (force)`);
    }
    const claimed = (
      await sql(
        `select r.rolname::text as name, pg_catalog.shobj_description(r.oid, 'pg_authid') as comment
           from pg_catalog.pg_roles r
          where pg_catalog.shobj_description(r.oid, 'pg_authid') like 'requestport instance %'`,
      )
    ).rows as { name: string; comment: string }[];
    const logins = [
      ...new Set([
        ...claimed
          .filter((row) =>
            databases.some((database) =>
              row.comment.endsWith(` database ${database}`),
            ),
          )
          .map((row) => row.name),
        ...[...instanceIds].flatMap((id) =>
          Object.values(instanceLoginNames(id)),
        ),
      ]),
    ];
    for (const name of [...logins, ...roles]) {
      await sql(`drop role if exists "${name}"`);
    }
    const left = (
      await sql(
        `select (select count(*)::int from pg_catalog.pg_roles
                  where rolname like $1 or rolname = any($2::text[])) as roles,
                (select count(*)::int from pg_catalog.pg_database where datname like $1) as databases`,
        [`${run}%`, logins],
      )
    ).rows[0];
    expect(left).toEqual({ roles: 0, databases: 0 });
  } finally {
    await admin.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

const BOUNDARIES = [
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "B6",
  "B7",
  "B8",
  "B9",
  "B10",
  "B11",
] as const;
type Boundary = (typeof BOUNDARIES)[number];
const ordinal = (boundary: Boundary) => BOUNDARIES.indexOf(boundary) + 1;

/**
 * What a first start killed at each boundary leaves (§2.3.1's table): the
 * data directory's entries (the parent's lock stays when the parent itself
 * was killed), the count of `pg_auth_members` rows for each instance login,
 * the journal, and the active owners. Every boundary comes before the
 * serving step, so none leaves the server-action key.
 */
const LEFT: Record<
  Boundary,
  {
    files: string[];
    groupRows: number[];
    journal: number | null;
    owners: number;
  }
> = {
  B1: { files: ["init.json", "lock"], groupRows: [], journal: null, owners: 0 },
  B2: {
    files: ["config.json", "init.json", "lock"],
    groupRows: [],
    journal: null,
    owners: 0,
  },
  B3: {
    files: ["config.json", "init.json", "lock", "secrets.json"],
    groupRows: [],
    journal: null,
    owners: 0,
  },
  B4: {
    files: ["config.json", "init.json", "lock", "owner.json", "secrets.json"],
    groupRows: [],
    journal: null,
    owners: 0,
  },
  // Inside the claim's transaction: rolled back.
  B5: { files: DATA_FILES, groupRows: [], journal: null, owners: 0 },
  // The claim committed: four logins in no group; nothing migrated.
  B6: { files: DATA_FILES, groupRows: [0, 0, 0, 0], journal: null, owners: 0 },
  B7: {
    files: DATA_FILES,
    groupRows: [0, 0, 0, 0],
    journal: journalTags.length,
    owners: 0,
  },
  // Inside provisioning's transaction: rolled back, as B7.
  B8: {
    files: DATA_FILES,
    groupRows: [0, 0, 0, 0],
    journal: journalTags.length,
    owners: 0,
  },
  B9: {
    files: DATA_FILES,
    groupRows: [1, 1, 1, 1],
    journal: journalTags.length,
    owners: 0,
  },
  B10: {
    files: DATA_FILES,
    groupRows: [1, 1, 1, 1],
    journal: journalTags.length,
    owners: 1,
  },
  B11: {
    files: DATA_FILES,
    groupRows: [1, 1, 1, 1],
    journal: journalTags.length,
    owners: 1,
  },
};

const ROTATED =
  "already holds a local credential: an earlier start bootstrapped them and stopped before init.json was complete, so it may never have been shown. This start rotates it: a credential an earlier start printed no longer signs in, and their sessions end.";

describe("Done when 6a: a first start killed at each boundary, on a cluster that is not clean, then started again, converges", () => {
  test.each(BOUNDARIES)(
    "killed with SIGKILL at %s, then started normally",
    async (boundary) => {
      const database = await scratchDatabase(owners.admin);
      const directory = dataDirectoryPath();
      const ownerFile = ownerUrlFile(owners.admin, database);
      const port = await freePort();
      const publicUrl = `http://127.0.0.1:${port}`;

      const crashed = await runStart(
        "crashing",
        [
          "--data-dir",
          directory,
          "--owner-url-file",
          ownerFile,
          ...bootstrapFlags,
          "--port",
          String(port),
        ],
        { env: { ...process.env, RP_H4_TEST_CRASH_AT: boundary } },
      );

      expect(crashed.served, crashed.stderr).toBe(false);
      if (ordinal(boundary) <= 4) {
        // The parent killed itself.
        expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
      } else {
        // The operator child killed itself, and the parent says so and
        // answers non-zero.
        expect(crashed.code, crashed.stderr).toBe(1);
        expect(crashed.stderr).toContain(
          "requestport start: the operator step was stopped by SIGKILL.\n",
        );
      }
      const { instanceId } = markerOf(directory);
      instanceIds.add(instanceId);
      const logins = await instanceLogins(instanceId);
      for (const login of logins) {
        expect(login.comment, login.login).toBe(
          `requestport instance ${instanceId} database ${database}`,
        );
      }
      expect({
        files: readdirSync(directory).sort(),
        groupRows: logins.map((login) => login.group_rows),
        ...(await databaseState(database)),
      }).toEqual(LEFT[boundary]);
      expect(markerOf(directory).complete).toBeUndefined();
      // B11 is after the credential was printed; nothing before it prints one.
      const printedBefore = credentialsIn(crashed.stdout);
      expect(printedBefore).toHaveLength(boundary === "B11" ? 1 : 0);

      const resumed = await runStart(
        "bin",
        [
          "--data-dir",
          directory,
          // What the killed start had not yet recorded is given again: the
          // owner URL before B4, and the bootstrap's details (recorded after
          // B4) and the port (B2) before them.
          ...(ordinal(boundary) <= 3 ? ["--owner-url-file", ownerFile] : []),
          ...(ordinal(boundary) <= 4 ? bootstrapFlags : []),
          ...(boundary === "B1" ? ["--port", String(port)] : []),
        ],
        {
          whileServing: async ({ stdout }) => {
            const [credential] = credentialsIn(stdout());
            expect(await signIn(publicUrl, credential as string)).toBe(200);
            if (printedBefore[0] !== undefined) {
              expect(await signIn(publicUrl, printedBefore[0])).toBe(401);
            }
          },
        },
      );

      expect(resumed.stderr).not.toContain(SENTINEL);
      expect(resumed.stdout).not.toContain(SENTINEL);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.served).toBe(true);
      if (ordinal(boundary) <= 4) {
        expect(resumed.stderr).toContain(
          `requestport: taking over a stale lock on ${realpathSync(directory)}, left by requestport start (pid ${crashed.pid} is gone)`,
        );
      }
      const printed = credentialsIn(resumed.stdout);
      expect(printed).toHaveLength(1);
      await expectConverged(directory, database, printed[0] as string, {
        served: true,
      });
      expect(markerOf(directory).instanceId).toBe(instanceId);

      if (ordinal(boundary) >= 10) {
        // B10 and B11: `issue` answered `unchanged`, so the credential was
        // rotated, and the start said what that ends.
        expect(resumed.stderr).toContain(
          `requestport start: ${EMAIL} ${ROTATED}`,
        );
        expect(await bootstrapAudit(database)).toEqual([
          "First organization owner activated with a local credential",
          "Local owner credential rotated and sessions revoked",
        ]);
      } else {
        expect(resumed.stderr).not.toContain(ROTATED);
        expect(await bootstrapAudit(database)).toEqual([
          "First organization owner activated with a local credential",
        ]);
      }
    },
  );
});

describe("Done when 6a: two data directories, one database", () => {
  test("two first starts at once against one empty database: one initialises, the other refuses with the remedy, and no login of the second exists", async () => {
    const database = await scratchDatabase(owners.superuser);
    const ownerFile = ownerUrlFile(owners.superuser, database);
    const starts = await Promise.all(
      [dataDirectoryPath(), dataDirectoryPath()].map(async (directory) => {
        const port = await freePort();
        const finished = await runStart(
          "bin",
          [
            "--data-dir",
            directory,
            "--owner-url-file",
            ownerFile,
            ...bootstrapFlags,
            "--port",
            String(port),
          ],
          {
            whileServing: async ({ stdout }) => {
              const [credential] = credentialsIn(stdout());
              expect(
                await signIn(`http://127.0.0.1:${port}`, credential as string),
              ).toBe(200);
            },
          },
        );
        return { directory, finished };
      }),
    );

    const winners = starts.filter(({ finished }) => finished.served);
    const losers = starts.filter(({ finished }) => !finished.served);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const [winner] = winners as [(typeof starts)[number]];
    const [loser] = losers as [(typeof starts)[number]];
    expect(winner.finished.code, winner.finished.stderr).toBe(0);
    const winnerId = markerOf(winner.directory).instanceId;
    const loserId = markerOf(loser.directory).instanceId;
    instanceIds.add(winnerId);
    expect(loser.finished.code, loser.finished.stderr).toBe(1);
    expect(loser.finished.stderr).toContain(
      `Database ${database} is claimed by another RequestPort instance (${winnerId})`,
    );
    expect(loser.finished.stderr).toContain(
      "Start from the data directory that initialised it",
    );
    expect(loser.finished.stderr).not.toContain("applied migration ");
    expect(credentialsIn(loser.finished.stdout)).toEqual([]);
    expect(await instanceLogins(loserId)).toEqual([]);
    await expectConverged(
      winner.directory,
      database,
      credentialsIn(winner.finished.stdout)[0] as string,
      { served: true },
    );
  });

  test("a data directory killed at B4, while a second then initialises the database, refuses on its resume and leaves no login", async () => {
    const database = await scratchDatabase(owners.admin);
    const ownerFile = ownerUrlFile(owners.admin, database);
    const killed = dataDirectoryPath();
    const crashed = await runStart(
      "crashing",
      [
        "--data-dir",
        killed,
        "--owner-url-file",
        ownerFile,
        ...bootstrapFlags,
        "--port",
        String(await freePort()),
      ],
      { env: { ...process.env, RP_H4_TEST_CRASH_AT: "B4" } },
    );
    expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
    const killedId = markerOf(killed).instanceId;

    const other = dataDirectoryPath();
    const initialised = await runStart("bin", [
      "--data-dir",
      other,
      "--owner-url-file",
      ownerFile,
      ...bootstrapFlags,
      "--port",
      String(await freePort()),
    ]);
    expect(initialised.code, initialised.stderr).toBe(0);
    expect(initialised.served).toBe(true);
    const otherId = markerOf(other).instanceId;
    instanceIds.add(otherId);

    const resumed = await runStart("bin", [
      "--data-dir",
      killed,
      ...bootstrapFlags,
    ]);

    expect(resumed.code, resumed.stderr).toBe(1);
    expect(resumed.served).toBe(false);
    expect(resumed.stderr).toContain(
      `Database ${database} is claimed by another RequestPort instance (${otherId})`,
    );
    expect(resumed.stderr).toContain(
      "Start from the data directory that initialised it",
    );
    expect(credentialsIn(resumed.stdout)).toEqual([]);
    expect(await instanceLogins(killedId)).toEqual([]);
    expect(markerOf(killed).complete).toBeUndefined();
    await expectConverged(
      other,
      database,
      credentialsIn(initialised.stdout)[0] as string,
      { served: true },
    );
  });

  test("the converse: groups another role created, and a non-superuser owner without ADMIN OPTION on them, are refused by the preflight before anything is created, with the remedy", async () => {
    const database = await scratchDatabase(owners.noadmin);
    const directory = dataDirectoryPath();

    const refused = await runStart("bin", [
      "--data-dir",
      directory,
      "--owner-url-file",
      ownerUrlFile(owners.noadmin, database),
      ...bootstrapFlags,
      "--port",
      String(await freePort()),
    ]);

    expect(refused.code, refused.stderr).toBe(1);
    expect(refused.served).toBe(false);
    expect(refused.stderr).toContain(
      `holds no ADMIN OPTION on them, so it can neither run the migrations that grant them nor grant this instance's logins their groups`,
    );
    expect(refused.stderr).toContain(
      `GRANT ${GROUPS.join(", ")} TO ${owners.noadmin} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;`,
    );
    const { instanceId } = markerOf(directory);
    expect(await instanceLogins(instanceId)).toEqual([]);
    expect(await databaseState(database)).toEqual({ journal: null, owners: 0 });
  });
});

describe("an owner that inherits a worker group (ruling 215 item 10)", () => {
  test("is refused by 0023's closing check, which rolls every migration back, and start says why in PostgreSQL's words, naming createrole_self_grant", async () => {
    const database = await scratchDatabase(owners.inheriting);
    const directory = dataDirectoryPath();

    const refused = await runStart("bin", [
      "--data-dir",
      directory,
      "--owner-url-file",
      ownerUrlFile(owners.inheriting, database),
      ...bootstrapFlags,
      "--port",
      String(await freePort()),
    ]);

    expect(refused.code, refused.stderr).toBe(1);
    expect(refused.served).toBe(false);
    expect(refused.stderr).toContain(
      `requestport start: the migrations could not be applied: requestport: the migrating role ${owners.inheriting} can still execute requestport_private.claim_outbox_batch(integer,integer), through an inheriting membership in its group requestport_dispatcher. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.\n`,
    );
    expect(refused.stderr).not.toContain("Failed query");
    expect(refused.stderr).not.toContain("applied migration ");
    expect(refused.stdout).toBe("");
    // Drizzle applies every pending migration in one transaction: none of
    // them is left, and the journal, made before it, holds nothing.
    expect(
      await onDatabase(database, async (query) => {
        const row = (
          await query(
            `select to_regclass('drizzle.__drizzle_migrations') is not null as journal,
                    to_regclass('public.outbox') is not null as outbox,
                    to_regnamespace('requestport_private') is not null as private_schema`,
          )
        ).rows[0] as {
          journal: boolean;
          outbox: boolean;
          private_schema: boolean;
        };
        const entries = row.journal
          ? ((
              await query(
                "select count(*)::int as n from drizzle.__drizzle_migrations",
              )
            ).rows[0]?.n as number)
          : 0;
        return {
          entries,
          outbox: row.outbox,
          private_schema: row.private_schema,
        };
      }),
    ).toEqual({ entries: 0, outbox: false, private_schema: false });
    // The claim committed before the migrations: its four logins, in no group.
    const { instanceId } = markerOf(directory);
    expect(
      (await instanceLogins(instanceId)).map((login) => login.group_rows),
    ).toEqual([0, 0, 0, 0]);
  });
});

describe("Done when 7 and 8: later starts, and starts at once", () => {
  test("a second start applies no migration, creates no role and bootstraps no one; a start on a data directory in use is refused; a public URL change is refused without --public-url, and with it is recorded, keeping the old URL's OAuth resource rows", async () => {
    const database = await scratchDatabase(owners.admin);
    const directory = dataDirectoryPath();
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    let concurrent: Finished | undefined;

    const first = await runStart(
      "bin",
      [
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerUrlFile(owners.admin, database),
        ...bootstrapFlags,
        "--port",
        String(port),
      ],
      {
        whileServing: async ({ stdout }) => {
          // Done when 8: one data directory refuses a second start while
          // the first holds its lock.
          concurrent = await runStart("bin", ["--data-dir", directory]);
          const [credential] = credentialsIn(stdout());
          expect(await signIn(publicUrl, credential as string)).toBe(200);
        },
      },
    );
    expect(first.code, first.stderr).toBe(0);
    const [credential] = credentialsIn(first.stdout) as [string];
    instanceIds.add(markerOf(directory).instanceId);
    expect(concurrent?.code, concurrent?.stderr).toBe(1);
    expect(concurrent?.stderr).toContain(
      `requestport start: ${realpathSync(directory)} is in use by requestport start (pid ${first.pid}). One requestport runs per data directory`,
    );
    expect(concurrent?.stderr).not.toContain("requestport start: the owner,");

    // Done when 7: the second start.
    const allRoles = async () =>
      (
        await sql(
          "select oid::text || ' ' || rolname::text as role from pg_catalog.pg_roles order by oid",
        )
      ).rows.map((row) => row.role as string);
    const journal = () =>
      onDatabase(
        database,
        async (query) =>
          (
            await query(
              "select id, hash, created_at::text from drizzle.__drizzle_migrations order by id",
            )
          ).rows,
      );
    const credentialHash = () =>
      onDatabase(
        database,
        async (query) =>
          (
            await query(
              "select password from account where provider_id = 'credential'",
            )
          ).rows,
      );
    const rolesBefore = await allRoles();
    const journalBefore = await journal();
    const hashBefore = await credentialHash();
    expect(journalBefore).toHaveLength(journalTags.length);

    const second = await runStart("bin", ["--data-dir", directory], {
      whileServing: async () => {
        expect(await signIn(publicUrl, credential)).toBe(200);
      },
    });

    expect(second.code, second.stderr).toBe(0);
    expect(second.served).toBe(true);
    expect(second.stderr).toContain(
      `requestport start: database ${database} holds this instance's claim.\n`,
    );
    expect(second.stderr).toContain(
      "requestport start: no migration to apply.\n",
    );
    expect(second.stderr).not.toContain("applied migration ");
    expect(credentialsIn(second.stdout)).toEqual([]);
    expect(await allRoles()).toEqual(rolesBefore);
    expect(await journal()).toEqual(journalBefore);
    expect(await credentialHash()).toEqual(hashBefore);
    expect(await bootstrapAudit(database)).toEqual([
      "First organization owner activated with a local credential",
    ]);

    // A start whose --port alone would move the public URL is refused, and
    // changes nothing.
    const movedPort = await freePort();
    const movedUrl = `http://127.0.0.1:${movedPort}`;
    const recorded = readFileSync(join(directory, "config.json"), "utf8");
    const refused = await runStart("bin", [
      "--data-dir",
      directory,
      "--port",
      String(movedPort),
    ]);
    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain(
      `requestport start: --port differs from what this data directory's config.json records, and would move the public URL its first start pinned, ${publicUrl}, to ${movedUrl}. Agent grants are bound to the public URL: those bound to ${publicUrl} stop working once it changes. The OAuth resource rows for ${publicUrl} stay in the database`,
    );
    expect(refused.stderr).toContain(`--public-url ${movedUrl}.`);
    expect(refused.stderr).not.toContain("requestport start: the owner,");
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(recorded);

    // With --public-url naming the change, it is recorded, said, and
    // served; the first URL's resource rows stay beside the new URL's.
    const moved = await runStart(
      "bin",
      [
        "--data-dir",
        directory,
        "--port",
        String(movedPort),
        "--public-url",
        movedUrl,
      ],
      {
        whileServing: async () => {
          expect(await signIn(movedUrl, credential)).toBe(200);
        },
      },
    );
    expect(moved.code, moved.stderr).toBe(0);
    expect(moved.stderr).toContain(
      `requestport start: the public URL changes from ${publicUrl} to ${movedUrl}, as --public-url names, and config.json records it. Agent grants are bound to the public URL: those bound to ${publicUrl} stop working once it changes.`,
    );
    expect(moved.stderr).toContain(
      `requestport start: serving ${movedUrl}; the in-process worker is ready.\n`,
    );
    expect(
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    ).toMatchObject({ publicUrl: movedUrl, port: movedPort });
    expect(
      await onDatabase(database, async (query) =>
        (
          await query(
            "select identifier from oauth_resource order by identifier",
          )
        ).rows.map((row) => row.identifier as string),
      ),
    ).toEqual(
      [
        `${movedUrl}/api/v1`,
        `${movedUrl}/mcp`,
        `${publicUrl}/api/v1`,
        `${publicUrl}/mcp`,
      ].sort(),
    );
    expect(credentialsIn(moved.stdout)).toEqual([]);
  });

  test("Done when 8: two operator children at once, from one data directory's owner.json, apply the migrations once; the claim's lock serializes them, and the second finds them applied and bootstraps no one", async () => {
    const database = await scratchDatabase(owners.admin);
    const directory = mkdtempSync(join(scratch, "prepared-"));
    const instanceId = newInstanceId();
    instanceIds.add(instanceId);
    writeInstanceMarker(directory, {
      version: 1,
      instanceId,
      bootstrap: {
        email: EMAIL,
        organizationSlug: "acme",
        organizationName: "Acme",
      },
    });
    writeConfiguration(directory, {
      version: 1,
      storage: "pg",
      publicUrl: "http://127.0.0.1:3200",
      port: 3200,
      host: "127.0.0.1",
    });
    writeSecrets(directory, generateSecrets("pg"), "pg");
    writeOwnerFile(directory, ownerUrlFor(owners.admin, database));

    const children = await Promise.all([
      operatorChild(directory),
      operatorChild(directory),
    ]);

    for (const child of children) {
      expect(child.code, child.stderr).toBe(0);
      expect(child.stderr).not.toContain(SENTINEL);
      expect(child.stdout).not.toContain(SENTINEL);
    }
    const [first, second] = [...children].sort(
      (a, b) =>
        (b.stderr.match(/applied migration /gu)?.length ?? 0) -
        (a.stderr.match(/applied migration /gu)?.length ?? 0),
    ) as [(typeof children)[number], (typeof children)[number]];
    // The first through the claim's lock claimed, migrated and bootstrapped;
    // the second, let through once the first had closed its session, found
    // its claim, nothing to migrate, and init.json complete.
    expect(first.stderr.match(/applied migration /gu)).toHaveLength(
      journalTags.length,
    );
    expect(first.stderr).toContain(
      `requestport start: claimed database ${database} for instance ${instanceId}.\n`,
    );
    expect(credentialsIn(first.stdout)).toHaveLength(1);
    expect(second.stderr).toContain(
      `requestport start: database ${database} holds this instance's claim.\n`,
    );
    expect(second.stderr).toContain(
      "requestport start: no migration to apply.\n",
    );
    expect(second.stderr).not.toContain("applied migration ");
    expect(second.stdout).toBe("");
    expect(
      await onDatabase(
        database,
        async (query) =>
          (
            await query(
              "select count(*)::int as entries, count(distinct hash)::int as hashes from drizzle.__drizzle_migrations",
            )
          ).rows[0],
      ),
    ).toEqual({ entries: journalTags.length, hashes: journalTags.length });
    await expectConverged(
      directory,
      database,
      credentialsIn(first.stdout)[0] as string,
      // Operator children only: nothing served from this data directory.
      { served: false },
    );
    expect(await bootstrapAudit(database)).toEqual([
      "First organization owner activated with a local credential",
    ]);
  });
});
