import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestStorage, rawQuery } from "@requestport/db/testing";
import {
  instanceLoginNames,
  packagedMigrationsFolder,
} from "@requestport/db/wiring";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PGLITE_DATABASE_DIRECTORY } from "../configuration.js";
import {
  credentialsIn,
  freePort,
  runCommand,
  runStart,
  sessionLives,
  signIn,
} from "../test-support/start-process.js";

/*
 * `requestport owner rotate-credential` (manifest-h.md §2.4, Done when 7;
 * owner question 6, built on the proposal by ruling 156; ruling 158, item
 * 13), through the executable, on PGlite and on the run's PostgreSQL: it
 * prints a new local credential once, the one before it stops signing in,
 * and the owner's sessions end. On PGlite it needs the data directory to
 * itself; on pg it runs beside a serving start, and changes the credential
 * and nothing else: it checks the claim and the journal, and is refused,
 * migrating nothing, when the journal lacks a migration this requestport
 * carries (ruling 163, item 3).
 *
 * The pg case runs as the server's superuser, `DATABASE_URL`: its database
 * and its owner carry the run's name, the instance's logins are dropped with
 * them in `afterAll`, which checks that none is left (ruling 158, item 15).
 * Data directories are under this run's default temporary directory, with a
 * space in their names (ruling 152).
 */

const run = `h4e_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const PASSWORD = `pw${randomBytes(12).toString("hex")}`;
const owner = `${run}_owner`;
const database = `${run}_rotate`;
const base = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
const EMAIL = "owner@example.com";
const bootstrapFlags = [
  "--email",
  EMAIL,
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];

const scratch = mkdtempSync(join(tmpdir(), "requestport-owner "));
let admin: ReturnType<typeof createTestStorage> | undefined;
const instanceIds = new Set<string>();
const sql = (text: string, values?: unknown[]) =>
  rawQuery(admin as ReturnType<typeof createTestStorage>, text, values);

beforeAll(async () => {
  expect(
    ["127.0.0.1", "localhost", "[::1]"],
    "this suite creates roles: DATABASE_URL must name a PostgreSQL on this machine",
  ).toContain(base.hostname);
  admin = createTestStorage({
    driver: "pg",
    pool: { max: 2, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 15_000 },
  });
  await sql(`create role "${owner}" login password '${PASSWORD}' superuser`);
  await sql(`create database "${database}" owner "${owner}"`);
});

afterAll(async () => {
  try {
    if (admin !== undefined) {
      await sql(`drop database if exists "${database}" with (force)`);
      const logins = [...instanceIds].flatMap((id) =>
        Object.values(instanceLoginNames(id)),
      );
      for (const name of [...logins, owner]) {
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
    }
  } finally {
    await admin?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/** The reasons of the owner's bootstrap audit records, oldest first, through `query`. */
async function bootstrapAudit(
  query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>,
) {
  return (
    await query(
      `select reason from security_audit_records
        where action = 'organization.owner_bootstrapped' order by occurred_at, id`,
    )
  ).rows.map((row) => row.reason as string);
}

/** The migrations this requestport carries, oldest first. */
const bundle = (
  JSON.parse(
    readFileSync(
      join(packagedMigrationsFolder(), "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: { tag: string; when: number }[] }
).entries;

const ROTATED_LINE = `requestport owner rotate-credential: rotated the local credential of ${EMAIL}, owner of acme: the one before it no longer signs in, and their sessions and operator credentials are revoked. The new one follows on standard output, shown once.\n`;

describe("Done when 7: requestport owner rotate-credential", () => {
  test("on PGlite: refused while a start serves; then it prints a new credential, the old one stops signing in, and the owner's sessions end", async () => {
    const directory = join(scratch, "data pglite");
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    let cookie = "";
    let whileServed: { code: number | null; stderr: string } | undefined;

    const first = await runStart(
      "bin",
      [
        "--data-dir",
        directory,
        "--storage",
        "pglite",
        ...bootstrapFlags,
        "--port",
        String(port),
      ],
      {
        whileServing: async ({ stdout }) => {
          const [credential] = credentialsIn(stdout());
          const signedIn = await signIn(publicUrl, EMAIL, credential as string);
          expect(signedIn.status).toBe(200);
          cookie = signedIn.cookie;
          expect(await sessionLives(publicUrl, cookie)).toBe(true);
          whileServed = await runCommand([
            "owner",
            "rotate-credential",
            "--data-dir",
            directory,
          ]);
        },
      },
    );
    expect(first.code, first.stderr).toBe(0);
    const [old] = credentialsIn(first.stdout);
    // One engine per data directory: the start's lock refuses it.
    expect(whileServed?.code).toBe(1);
    expect(whileServed?.stderr).toContain(
      `requestport owner rotate-credential: ${realpathSync(directory)} is in use by requestport start (pid ${first.pid}).`,
    );

    const rotated = await runCommand([
      "owner",
      "rotate-credential",
      "--data-dir",
      directory,
    ]);
    expect(rotated.code, rotated.stderr).toBe(0);
    const printed = credentialsIn(rotated.stdout);
    expect(printed).toHaveLength(1);
    expect(rotated.stdout).toBe(`${printed[0]}\n`);
    expect(printed[0]).not.toBe(old);
    expect(rotated.stderr).toContain(ROTATED_LINE);

    const second = await runStart("bin", ["--data-dir", directory], {
      whileServing: async () => {
        expect((await signIn(publicUrl, EMAIL, old as string)).status).toBe(
          401,
        );
        expect(await sessionLives(publicUrl, cookie)).toBe(false);
        expect(
          (await signIn(publicUrl, EMAIL, printed[0] as string)).status,
        ).toBe(200);
      },
    });
    expect(second.code, second.stderr).toBe(0);
    expect(credentialsIn(second.stdout)).toEqual([]);

    const storage = createTestStorage({
      driver: "pglite",
      dataDir: join(directory, PGLITE_DATABASE_DIRECTORY),
    });
    try {
      expect(await bootstrapAudit((text) => rawQuery(storage, text))).toEqual([
        "First organization owner activated with a local credential",
        "Local owner credential rotated and sessions revoked",
      ]);
    } finally {
      await storage.close();
    }
  }, 400_000);

  test("on pg: beside a serving start, it prints a new credential, the old one stops signing in, and the owner's sessions end; it creates and migrates nothing, and is refused, saying to run requestport start, when the journal lacks a migration this requestport carries", async () => {
    const directory = join(scratch, "data pg");
    const ownerFile = join(scratch, "owner.url");
    const url = new URL(base);
    url.username = owner;
    url.password = PASSWORD;
    url.pathname = `/${database}`;
    url.search = "";
    writeFileSync(ownerFile, `${url}\n`, { mode: 0o600 });
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    let rotated: { code: number | null; stdout: string; stderr: string } = {
      code: null,
      stdout: "",
      stderr: "",
    };
    let old = "";

    const started = await runStart(
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
          instanceIds.add(
            (
              JSON.parse(
                readFileSync(join(directory, "init.json"), "utf8"),
              ) as { instanceId: string }
            ).instanceId,
          );
          [old = ""] = credentialsIn(stdout());
          const signedIn = await signIn(publicUrl, EMAIL, old);
          expect(signedIn.status).toBe(200);
          expect(await sessionLives(publicUrl, signedIn.cookie)).toBe(true);

          rotated = await runCommand([
            "owner",
            "rotate-credential",
            "--data-dir",
            directory,
          ]);
          expect(rotated.code, rotated.stderr).toBe(0);
          const [fresh] = credentialsIn(rotated.stdout);
          expect(fresh).toBeDefined();
          expect(fresh).not.toBe(old);
          expect((await signIn(publicUrl, EMAIL, old)).status).toBe(401);
          expect(await sessionLives(publicUrl, signedIn.cookie)).toBe(false);
          expect((await signIn(publicUrl, EMAIL, fresh as string)).status).toBe(
            200,
          );
        },
      },
    );
    expect(started.code, started.stderr).toBe(0);
    expect(started.served).toBe(true);
    expect(rotated.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/u);
    expect(rotated.stderr).toContain(ROTATED_LINE);
    expect(rotated.stderr).not.toContain(PASSWORD);

    const onDatabase = new URL(base);
    onDatabase.pathname = `/${database}`;
    const storage = createTestStorage({
      driver: "pg",
      connectionString: onDatabase.toString(),
    });
    try {
      // A journal that lacks the newest migration this requestport carries,
      // as a database a newer requestport's bundle meets: the rotation is
      // refused and migrates nothing.
      const journal = (text: string) =>
        rawQuery(storage, text).then((result) => result.rows);
      const newest = bundle.at(-1) as { tag: string; when: number };
      await journal(
        `delete from drizzle.__drizzle_migrations where created_at = ${newest.when}`,
      );
      const refused = await runCommand([
        "owner",
        "rotate-credential",
        "--data-dir",
        directory,
      ]);
      expect(refused.code, refused.stderr).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toBe(
        `requestport owner rotate-credential: Database ${database}'s migration journal lacks 1 migration this requestport carries (${newest.tag}). A credential rotation never migrates: run requestport start first, which migrates.\n`,
      );
      expect(
        await journal(
          "select count(*)::int as entries from drizzle.__drizzle_migrations",
        ),
      ).toEqual([{ entries: bundle.length - 1 }]);

      // The rotation beside the serving start ran the check-only step, and
      // none of a start's steps.
      expect(rotated.stderr).toContain(
        `requestport owner rotate-credential: database ${database} holds this instance's claim, and its journal holds each of the ${bundle.length} migrations this requestport carries; the check created and migrated nothing.\n`,
      );
      expect(rotated.stderr).not.toMatch(
        /claimed database|migration to apply|applied migration|provisioned/u,
      );
      expect(await bootstrapAudit((text) => rawQuery(storage, text))).toEqual([
        "First organization owner activated with a local credential",
        "Local owner credential rotated and sessions revoked",
      ]);
    } finally {
      await storage.close();
    }
  }, 300_000);
});
