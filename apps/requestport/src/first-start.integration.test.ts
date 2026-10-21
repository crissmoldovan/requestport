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
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { declareDatabaseSurface } from "@requestport/db";
import { migrate } from "@requestport/db/migrate";
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
import { runOperatorStep } from "./operator/operator-step.js";
import { writeOwnerFile } from "./owner-url.js";
import { SERVER_ACTION_KEY_FILE } from "./server-action-key.js";

/*
 * The first start on pg, on the run's PostgreSQL (manifest-h.md Done when 5,
 * the operator's half, and Done when 6), as its superuser, `DATABASE_URL`.
 * Every database and role here carries the run's name, or is a login of an
 * instance this file started, and `afterAll` drops each and checks that none
 * is left (ruling 158, item 15). Roles are cluster-wide: nothing here touches
 * one this file did not make.
 *
 * This process declares `operator`, as the operator step's entry does, for
 * the cases that run the step here; the first starts run the executable, or
 * its test entries, as processes of their own.
 */
declareDatabaseSurface("operator");

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const startTestEntry = join(workspace, "src", "start", "start.test-entry.ts");
const operatorTestEntry = join(
  workspace,
  "src",
  "operator",
  "operator.test-entry.ts",
);
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx/esm"),
).href;
/**
 * The loader `requestport start` hands its operator child in the
 * repository (`operator/command.ts`): `bin/tsx-loader.mjs`, which registers
 * tsx's. The tests start the start entry with `tsxLoader` themselves.
 */
const operatorLoader = pathToFileURL(
  join(workspace, "bin", "tsx-loader.mjs"),
).href;

const journalTags = (
  JSON.parse(
    readFileSync(
      join(packagedMigrationsFolder(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: { tag: string }[] }
).entries.map((entry) => entry.tag);

const run = `h4s_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
/** The owners' password: in their URLs, and so in `owner.json`, and nowhere else. */
const SENTINEL = `S3NT1NEL${randomBytes(12).toString("hex")}`;
const owners = {
  superuser: `${run}_owner`,
  nobypass: `${run}_nobypass`,
  nocreaterole: `${run}_nocreaterole`,
};
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const admin = createTestStorage({
  driver: "pg",
  pool: { max: 3, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 15_000 },
});
const sql = (text: string, values?: unknown[]) => rawQuery(admin, text, values);

const databases: string[] = [];
const roles: string[] = [];
const instanceIds = new Set<string>();
const scratch = mkdtempSync(join(tmpdir(), "requestport-first-start-"));

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
function dataDirectoryPath() {
  directoryCount += 1;
  return join(scratch, `data ${directoryCount}`);
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

const journalPresent = (database: string) =>
  onDatabase(
    database,
    async (query) =>
      (
        await query(
          "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
        )
      ).rows[0]?.present as boolean,
  );

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

/** A data directory as `requestport start` leaves it for the operator step: B1 to B4, and the bootstrap's details. */
function preparedDataDirectory(ownerUrl: string) {
  const directory = mkdtempSync(join(scratch, "prepared-"));
  const instanceId = newInstanceId();
  instanceIds.add(instanceId);
  writeInstanceMarker(directory, {
    version: 1,
    instanceId,
    bootstrap: {
      email: "owner@example.com",
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
  writeOwnerFile(directory, ownerUrl);
  return { directory, instanceId };
}

async function operatorStep(directory: string) {
  const output = { stdout: "", stderr: "" };
  const code = await runOperatorStep({
    dataDirectory: directory,
    env: {},
    output: {
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    },
  });
  expect(output.stdout + output.stderr).not.toContain(SENTINEL);
  return { code, output };
}

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** What `requestport start` says once it serves (`serve/run.ts`). */
const SERVING = "requestport start: serving ";

/**
 * Runs `requestport start` (or a test entry around it) to completion: once
 * it says it serves, SIGTERM stops it, as a self-hoster stops it, since it
 * serves until it is stopped (slice c).
 */
function runProcess(
  command: string,
  args: readonly string[],
  { env, input }: { env: NodeJS.ProcessEnv; input?: string },
): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!stopped && stderr.includes(SERVING)) {
        stopped = true;
        child.kill("SIGTERM");
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolvePromise({ code, signal, stdout, stderr }),
    );
    child.stdin.end(input ?? "");
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

const bootstrapFlags = [
  "--email",
  "owner@example.com",
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];

/** A first start's `--port`, on a port the system chose. */
const portFlags = async () => ["--port", String(await freePort())];

/** The lines of a start's standard output that are not its JSON log lines. */
const plainLines = (stdout: string) =>
  stdout
    .replaceAll("\r", "")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("{"));

/**
 * What a converged first start leaves (Done when 5): checked in the database
 * and the data directory, which holds, once the start has served, the web
 * UI's server-action key beside the four files of a first start (ruling 201
 * item 4).
 */
async function expectInitialised(
  directory: string,
  database: string,
  credential: string,
) {
  const files = readdirSync(directory).sort();
  expect(files).toEqual([
    "config.json",
    "init.json",
    "owner.json",
    "secrets.json",
    SERVER_ACTION_KEY_FILE,
  ]);
  for (const file of files) {
    expect(statSync(join(directory, file)).mode & 0o777, file).toBe(0o600);
    expect(
      readFileSync(join(directory, file), "utf8").includes(SENTINEL),
      file,
    ).toBe(file === "owner.json");
  }
  const marker = JSON.parse(readFileSync(join(directory, "init.json"), "utf8"));
  expect(marker.complete).toBe(true);
  const instanceId = marker.instanceId as string;
  const names = instanceLoginNames(instanceId);

  const logins = await instanceLogins(instanceId);
  expect(logins.map((row) => row.login)).toEqual(Object.values(names).sort());
  for (const kind of INSTANCE_LOGIN_KINDS) {
    expect(
      logins.find((row) => row.login === names[kind]),
      kind,
    ).toEqual({
      login: names[kind],
      comment: `requestport instance ${instanceId} database ${database}`,
      group_rows: 1,
      groups: INSTANCE_LOGIN_GROUPS[kind],
      privileged: false,
    });
  }

  // Each login connects, as itself, through the URL secrets.json holds.
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

  const owner = await onDatabase(
    database,
    async (query) =>
      (
        await query(
          `select u.email, o.slug, m.role, m.status, a.password as hash
             from organization_members m
             join organizations o on o.id = m.organization_id
             join "user" u on u.id = m.user_id
             left join account a on a.user_id = u.id and a.provider_id = 'credential'`,
        )
      ).rows as {
        email: string;
        slug: string;
        role: string;
        status: string;
        hash: string | null;
      }[],
  );
  expect(owner).toEqual([
    {
      email: "owner@example.com",
      slug: "acme",
      role: "owner",
      status: "active",
      hash: expect.any(String),
    },
  ]);
  expect(
    await verifyLocalCredential({
      hash: owner[0]?.hash as string,
      password: credential,
    }),
  ).toBe(true);
  expect(
    await onDatabase(
      database,
      async (query) =>
        (
          await query(
            "select count(*)::int as entries from drizzle.__drizzle_migrations",
          )
        ).rows[0]?.entries,
    ),
  ).toBe(journalTags.length);
}

const CREDENTIAL_LINE = /^[A-Za-z0-9_-]{43}$/gmu;

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
  for (const [name, attributes] of [
    [owners.superuser, "superuser"],
    [owners.nobypass, "nosuperuser createrole nobypassrls"],
    [owners.nocreaterole, "nosuperuser nocreaterole bypassrls"],
  ] as const) {
    roles.push(name);
    await sql(
      `create role "${name}" login password '${SENTINEL}' ${attributes}`,
    );
  }
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
    const logins = new Set([
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
    ]);
    for (const name of [...logins, ...roles]) {
      await sql(`drop role if exists "${name}"`);
    }
    const left = (
      await sql(
        `select (select count(*)::int from pg_catalog.pg_roles
                  where rolname like $1 or rolname = any($2::text[])) as roles,
                (select count(*)::int from pg_catalog.pg_database where datname like $1) as databases`,
        [`${run}%`, [...logins]],
      )
    ).rows[0];
    expect(left).toEqual({ roles: 0, databases: 0 });
  } finally {
    await admin.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("Done when 6: refusals before any statement changes the database", () => {
  test.each([
    ["nobypass", "lacks BYPASSRLS."],
    ["nocreaterole", "lacks CREATEROLE."],
  ] as const)(
    "an owner that %s is refused, naming the attribute, and leaves no journal and no login",
    async (shape, said) => {
      const database = await scratchDatabase(owners[shape]);
      const { directory, instanceId } = preparedDataDirectory(
        ownerUrlFor(owners[shape], database),
      );

      const { code, output } = await operatorStep(directory);

      expect(code).toBe(1);
      expect(output.stderr).toContain(said);
      expect(output.stderr).toContain(
        "the owner must be a superuser, or have both BYPASSRLS and CREATEROLE",
      );
      expect(await journalPresent(database)).toBe(false);
      expect(await instanceLogins(instanceId)).toEqual([]);
    },
  );

  test("a database whose journal is not empty and holds no claim of this instance is refused before migrate, with the remedy", async () => {
    const database = await scratchDatabase(owners.superuser);
    const byHand = createTestStorage({
      driver: "pg",
      connectionString: ownerUrlFor(owners.superuser, database),
    });
    try {
      await migrate(byHand, { migrationsFolder: packagedMigrationsFolder() });
    } finally {
      await byHand.close();
    }
    const { directory, instanceId } = preparedDataDirectory(
      ownerUrlFor(owners.superuser, database),
    );

    const { code, output } = await operatorStep(directory);

    expect(code).toBe(1);
    expect(output.stderr).toContain(
      `Database ${database} already holds ${journalTags.length} applied migrations and no claim of this instance`,
    );
    expect(output.stderr).toContain(
      "Start from the data directory that initialised it",
    );
    expect(output.stderr).not.toContain("applied migration ");
    expect(await instanceLogins(instanceId)).toEqual([]);
  });

  test("a database another instance has claimed is refused before migrate, with the remedy", async () => {
    const database = await scratchDatabase(owners.superuser);
    const other = `${run}_other_claim`;
    roles.push(other);
    await sql(`create role "${other}" nologin`);
    await sql(
      `comment on role "${other}" is 'requestport instance 00000000000000aa database ${database}'`,
    );
    const { directory, instanceId } = preparedDataDirectory(
      ownerUrlFor(owners.superuser, database),
    );

    const { code, output } = await operatorStep(directory);

    expect(code).toBe(1);
    expect(output.stderr).toContain(
      `Database ${database} is claimed by another RequestPort instance (00000000000000aa)`,
    );
    expect(await journalPresent(database)).toBe(false);
    expect(await instanceLogins(instanceId)).toEqual([]);
  });
});

describe("Done when 5, the operator's half: a first start on pg with a superuser owner", () => {
  test("through the executable, with --owner-url-file: every migration reported, four claimed logins in one group each, the owner bootstrapped and the credential printed once", async () => {
    const database = await scratchDatabase(owners.superuser);
    const directory = dataDirectoryPath();
    const ownerFile = join(scratch, `owner-${database}.url`);
    writeFileSync(ownerFile, `${ownerUrlFor(owners.superuser, database)}\n`, {
      mode: 0o600,
    });

    const result = await runProcess(
      process.execPath,
      [
        bin,
        "start",
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerFile,
        ...bootstrapFlags,
        ...(await portFlags()),
      ],
      { env: process.env },
    );

    expect(result.stderr).not.toContain(SENTINEL);
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.code, result.stderr).toBe(0);
    const credentials = result.stdout.match(CREDENTIAL_LINE) ?? [];
    expect(credentials).toHaveLength(1);
    // Standard output carries the credential, once, and the serving
    // process's JSON log lines.
    expect(plainLines(result.stdout)).toEqual([credentials[0]]);
    expect(result.stderr).toContain(SERVING);
    for (const tag of journalTags) {
      expect(result.stderr).toContain(
        `requestport start: applied migration ${tag}.\n`,
      );
    }
    expect(result.stderr).toContain(
      `requestport start: the owner, ${owners.superuser}, may initialise database ${database} (a superuser).`,
    );
    await expectInitialised(directory, database, credentials[0] as string);
  });

  /*
   * The same first start through the test entries, which record the
   * parent's and the operator child's `process.argv` and `process.env` at
   * each boundary, and each argument the spawn wrapper is handed.
   */
  async function recordedFirstStart(
    database: string,
    start: (
      directory: string,
      env: NodeJS.ProcessEnv,
    ) => Promise<{ code: number | null; output: string }>,
  ) {
    const directory = dataDirectoryPath();
    const recordFile = join(scratch, `record-${database}.jsonl`);
    const env = { ...process.env, RP_H4_TEST_RECORD: recordFile };

    const { code, output } = await start(directory, env);

    expect(output).not.toContain(SENTINEL);
    expect(code, output).toBe(0);
    const records = readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      records.map(
        (record) =>
          `${record.process} ${record.boundary ?? record.event ?? ""}`,
      ),
    ).toEqual([
      "parent B1",
      "parent B2",
      "parent B3",
      "parent B4",
      "spawn ",
      "operator B5",
      "operator B6",
      "operator B7",
      "operator B8",
      "operator B9",
      "operator B10",
      "operator B11",
      "serve serving",
      "serve closed",
    ]);
    for (const record of records) {
      expect(JSON.stringify(record), String(record.process)).not.toContain(
        SENTINEL,
      );
    }
    const spawned = records.find((record) => record.process === "spawn") as {
      command: string;
      args: string[];
    };
    expect(spawned.command).toBe(process.execPath);
    expect(spawned.args).toEqual([
      "--import",
      operatorLoader,
      operatorTestEntry,
      realpathSync(directory),
    ]);
    // Done when 5's serving half: the serving process's environment holds
    // no owner-capable name, and from before it read anything until every
    // storage had closed, it opened config.json and secrets.json in the data
    // directory and never owner.json (the test entry's wrap of node:fs).
    const served = records.find((record) => record.event === "serving") as {
      env: Record<string, string>;
    };
    const closed = records.find((record) => record.event === "closed") as {
      opened: string[];
    };
    expect(
      Object.keys(served.env).filter(
        (name) =>
          name === "DATABASE_URL" ||
          name.startsWith("POSTGRES_") ||
          /^PG[A-Z0-9_]*$/u.test(name),
      ),
    ).toEqual([]);
    const inDirectory = closed.opened
      .filter((path) => dirname(path) === realpathSync(directory))
      .map((path) => basename(path));
    expect(inDirectory).toContain("config.json");
    expect(inDirectory).toContain("secrets.json");
    expect(
      closed.opened.filter((path) => basename(path) === "owner.json"),
    ).toEqual([]);
    const credentials =
      output.replaceAll("\r", "").match(CREDENTIAL_LINE) ?? [];
    expect(credentials).toHaveLength(1);
    await expectInitialised(directory, database, credentials[0] as string);
  }

  test("given by --owner-url-stdin, the URL is in no argument and no environment of either process, and in nothing they print", async () => {
    const database = await scratchDatabase(owners.superuser);
    await recordedFirstStart(database, async (directory, env) => {
      const result = await runProcess(
        process.execPath,
        [
          "--import",
          tsxLoader,
          startTestEntry,
          "--data-dir",
          directory,
          "--owner-url-stdin",
          ...bootstrapFlags,
          ...(await portFlags()),
        ],
        { env, input: `${ownerUrlFor(owners.superuser, database)}\n` },
      );
      return { code: result.code, output: result.stdout + result.stderr };
    });
  });

  test("given by --owner-url-file, the same", async () => {
    const database = await scratchDatabase(owners.superuser);
    const ownerFile = join(scratch, `owner-${database}.url`);
    writeFileSync(ownerFile, `${ownerUrlFor(owners.superuser, database)}\n`, {
      mode: 0o600,
    });
    await recordedFirstStart(database, async (directory, env) => {
      const result = await runProcess(
        process.execPath,
        [
          "--import",
          tsxLoader,
          startTestEntry,
          "--data-dir",
          directory,
          "--owner-url-file",
          ownerFile,
          ...bootstrapFlags,
          ...(await portFlags()),
        ],
        { env },
      );
      return { code: result.code, output: result.stdout + result.stderr };
    });
  });

  /*
   * A pseudo-terminal, from python3's `pty` module (the lockfile has no
   * node-pty): the script reads the URL from its own standard input, starts
   * the command on the terminal, types the URL once the prompt is shown,
   * stops it with SIGTERM once it says it serves, and copies everything the
   * terminal printed, echo included, to its standard output.
   */
  const PTY_DRIVER = `
import os, pty, select, signal, sys
url = sys.stdin.readline().strip().encode()
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out = b""
sent = False
stopped = False
while True:
    ready, _, _ = select.select([fd], [], [], 100)
    if not ready:
        break
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    out += data
    if not sent and b"Owner URL (not echoed): " in out:
        os.write(fd, url + b"\\r")
        sent = True
    if not stopped and b"requestport start: serving " in out:
        os.kill(pid, signal.SIGTERM)
        stopped = True
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.stdout.flush()
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

  test("typed at the prompt on a terminal, the URL is not echoed, and is in no argument and no environment of either process", async () => {
    const database = await scratchDatabase(owners.superuser);
    await recordedFirstStart(database, async (directory, env) => {
      const result = await runProcess(
        "python3",
        [
          "-c",
          PTY_DRIVER,
          process.execPath,
          "--import",
          tsxLoader,
          startTestEntry,
          "--data-dir",
          directory,
          ...bootstrapFlags,
          ...(await portFlags()),
        ],
        { env, input: `${ownerUrlFor(owners.superuser, database)}\n` },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Owner URL (not echoed): ");
      return { code: result.code, output: result.stdout };
    });
  });
});
