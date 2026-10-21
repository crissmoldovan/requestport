import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  OperatorRefusalError,
  type OperatorSession,
  packagedMigrationsFolder,
} from "@requestport/db/wiring";
import { afterAll, describe, expect, test } from "vitest";

import { USAGE } from "../cli.js";
import {
  generateSecrets,
  type StorageKind,
  writeConfiguration,
  writeSecrets,
} from "../configuration.js";
import { acquireInstanceLock } from "../instance-lock.js";
import {
  newInstanceId,
  readInstanceMarker,
  writeInstanceMarker,
} from "../instance-marker.js";
import { writeOwnerFile } from "../owner-url.js";
import { OWNER_USAGE, runOwnerCommand } from "./rotate-credential.js";

/*
 * `requestport owner rotate-credential`'s arguments and its refusals before
 * it connects (manifest-h.md §2.4; ruling 156; ruling 158, item 13), and on
 * pg which of the session's steps it runs (ruling 163, item 3). The rotation
 * itself, on pg and on PGlite, is this module's integration test. Nothing
 * here connects: the session, the declaration and the shared-database
 * refusal are watched, and every case that would reach them stops first, or
 * is handed a session that records each member it is asked for.
 */

const SENTINEL = "S3NT1NEL_0wner_secret";
const ownerUrl = `postgres://owner:${SENTINEL}@127.0.0.1:5432/requestport`;

const scratch = mkdtempSync(join(tmpdir(), "requestport-owner-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A data directory a start left: its files, the marker complete or not. */
function dataDirectory(storage: StorageKind, complete: boolean) {
  const directory = mkdtempSync(join(scratch, "data "));
  writeInstanceMarker(directory, {
    version: 1,
    instanceId: newInstanceId(),
    bootstrap: {
      email: "owner@example.com",
      organizationSlug: "acme",
      organizationName: "Acme",
    },
    ...(complete ? { complete: true } : {}),
  });
  writeConfiguration(directory, {
    version: 1,
    storage,
    publicUrl: "http://127.0.0.1:3200",
    port: 3200,
    host: "127.0.0.1",
  });
  writeSecrets(directory, generateSecrets(storage), storage);
  if (storage === "pg") writeOwnerFile(directory, ownerUrl);
  return directory;
}

async function owner(
  argv: string[],
  {
    refuse,
    session,
  }: {
    refuse?: () => void;
    /** The session `openSession` answers, given the calls so far; unset, opening throws. */
    session?: (calls: string[]) => OperatorSession;
  } = {},
) {
  const output = { stdout: "", stderr: "" };
  const calls: string[] = [];
  const code = await runOwnerCommand(
    argv,
    { PATH: process.env.PATH },
    {
      io: {
        stdout: { write: (text: string) => (output.stdout += text) },
        stderr: { write: (text: string) => (output.stderr += text) },
      },
      declareSurface: (surface) => {
        calls.push(`declare ${surface}`);
      },
      refuseSharedDatabase: (connectionString) => {
        calls.push(
          `refuse ${connectionString === ownerUrl ? "the owner URL" : "another"}`,
        );
        refuse?.();
      },
      openSession: async () => {
        calls.push("open");
        if (session === undefined) {
          throw new Error("the session is not opened in this test");
        }
        return session(calls);
      },
    },
  );
  expect(output.stdout + output.stderr).not.toContain(SENTINEL);
  return { code, output, calls };
}

describe("requestport owner rotate-credential, before it connects", () => {
  test("--help prints the usage, which says what the rotation ends and when it is refused", async () => {
    for (const argv of [
      ["--help"],
      ["rotate-credential", "--help"],
      ["rotate-credential", "-h"],
    ]) {
      const { code, output, calls } = await owner(argv);

      expect(code).toBe(0);
      expect(output).toEqual({ stdout: `${OWNER_USAGE}\n`, stderr: "" });
      expect(calls).toEqual([]);
    }
    expect(OWNER_USAGE).toContain(
      "The one before it no longer\nsigns in, and the owner's sessions and operator credentials are revoked.",
    );
    expect(OWNER_USAGE).toContain("stop requestport start first.");
    expect(OWNER_USAGE).toContain(
      "It is refused until the first start has completed.",
    );
    expect(OWNER_USAGE).toContain(
      "Beyond the rotation it changes nothing: it never migrates, and is\nrefused, saying to run requestport start, while the database lacks a\nmigration this requestport carries.",
    );
  });

  test.each([
    [[], "requestport owner: a subcommand is required."],
    [[`rotate-${SENTINEL}`], "requestport owner: unknown subcommand."],
    [
      ["rotate-credential", `--${SENTINEL}`],
      "requestport owner rotate-credential: an option it does not take.",
    ],
    [
      ["rotate-credential", SENTINEL],
      "requestport owner rotate-credential: an argument it does not take: it takes options only.",
    ],
    [
      ["rotate-credential", "--email"],
      "requestport owner rotate-credential: --email takes a value.",
    ],
    [
      ["rotate-credential", "--email=a@b.c", "--email", "x@y.z"],
      "requestport owner rotate-credential: --email is given twice.",
    ],
  ])(
    "refuses %j with a usage error that repeats nothing typed",
    async (argv, said) => {
      const { code, output, calls } = await owner(argv);

      expect(code).toBe(2);
      expect(output.stderr).toBe(`${said}\n\n${OWNER_USAGE}\n`);
      expect(calls).toEqual([]);
    },
  );

  test("refuses --owner-url with a value first, as start does, never repeating it", async () => {
    for (const argv of [
      ["rotate-credential", "--owner-url", ownerUrl],
      ["rotate-credential", `--owner-url=${ownerUrl}`],
    ]) {
      const { code, output, calls } = await owner(argv);

      expect(code).toBe(2);
      expect(output.stderr).toContain(
        "requestport owner rotate-credential: --owner-url takes no value on the command line.",
      );
      expect(calls).toEqual([]);
    }
  });

  test("refuses a data directory with no instance, and one whose first start has not completed, on either storage, before it declares or connects (ruling 158, item 13)", async () => {
    const empty = mkdtempSync(join(scratch, "empty "));
    const none = await owner(["rotate-credential", "--data-dir", empty]);
    expect(none.code).toBe(1);
    expect(none.output.stderr).toContain(
      "holds no init.json, so no instance: requestport start initialises one.",
    );
    expect(none.calls).toEqual([]);

    for (const storage of ["pg", "pglite"] as const) {
      const directory = dataDirectory(storage, false);
      const { code, output, calls } = await owner([
        "rotate-credential",
        "--data-dir",
        directory,
      ]);

      expect(code, storage).toBe(1);
      expect(output.stderr, storage).toContain(
        "'s first start has not completed (init.json is not complete). Run requestport start: it finishes the first start, and if an earlier one stopped after the owner's bootstrap, it rotates the credential and prints it itself.\n",
      );
      expect(calls, storage).toEqual([]);
    }
  });

  test("on PGlite, refuses while another process holds the data directory's lock, naming it, before it declares or opens the database (one engine; ruling 158, item 13)", async () => {
    const directory = dataDirectory("pglite", true);
    // A live process other than this one, as a serving start would be.
    const held = acquireInstanceLock(directory, {
      holder: "requestport start",
      pid: process.ppid,
    });
    try {
      const { code, output, calls } = await owner([
        "rotate-credential",
        "--data-dir",
        directory,
      ]);

      expect(code).toBe(1);
      expect(output.stderr).toContain(
        `is in use by requestport start (pid ${process.ppid}). One requestport runs per data directory`,
      );
      expect(calls).toEqual([]);
    } finally {
      held.release();
    }
  });

  test("on pg, declares operator, then refuses production's and staging's databases on the owner URL before its first statement", async () => {
    const directory = dataDirectory("pg", true);
    const { code, output, calls } = await owner(
      ["rotate-credential", "--data-dir", directory],
      {
        refuse: () => {
          // As `refuseUnapprovedSharedPgDatabase` throws.
          throw new Error("refused: a shared database.");
        },
      },
    );

    expect(code).toBe(1);
    expect(output.stderr).toBe(
      "requestport owner rotate-credential: failed: refused: a shared database.\n",
    );
    expect(calls).toEqual(["declare operator", "refuse the owner URL"]);
  });

  test("on pg, it runs the session's check-only step and none of a start's steps: a refusal there, saying to run requestport start, ends it with exit 1 and no credential (ruling 163, item 3)", async () => {
    const directory = dataDirectory("pg", true);
    const instanceId = readInstanceMarker(directory)?.instanceId;
    const refusal =
      "Database requestport's migration journal lacks 1 migration this requestport carries (9999_newer). A credential rotation never migrates: run requestport start first, which migrates.";
    const { code, output, calls } = await owner(
      ["rotate-credential", "--data-dir", directory],
      {
        // Records every member asked for. `check` refuses as the session's
        // does; `close` closes; anything else is a step a rotation does not
        // run, and fails. No `then`: the session is not a promise.
        session: (calls) =>
          new Proxy({} as OperatorSession, {
            get: (_target, member) => {
              if (member === "then") return undefined;
              if (member === "check") {
                return async (options: {
                  instanceId: string;
                  migrationsFolder: string;
                }) => {
                  calls.push(
                    `check ${options.instanceId === instanceId ? "this instance" : "another"} ${options.migrationsFolder === packagedMigrationsFolder() ? "the packaged migrations" : "another folder"}`,
                  );
                  throw new OperatorRefusalError("migrations_pending", refusal);
                };
              }
              if (member === "close") {
                return async () => {
                  calls.push("close");
                };
              }
              return () => {
                calls.push(String(member));
                throw new Error(`${String(member)}: not a rotation's step`);
              };
            },
          }),
      },
    );

    expect(code).toBe(1);
    expect(output).toEqual({
      stdout: "",
      stderr: `requestport owner rotate-credential: ${refusal}\n`,
    });
    expect(calls).toEqual([
      "declare operator",
      "refuse the owner URL",
      "open",
      "check this instance the packaged migrations",
      "close",
    ]);
  });
});

/*
 * The command's one entry in `cli.ts`'s commands (ruling 156): a "no" to
 * owner question 6 removes that entry and this directory, and this case
 * with them.
 */
describe("requestport owner, registered in the executable", () => {
  test("the usage lists owner rotate-credential, and the executable's `owner --help` prints this module's usage", () => {
    expect(USAGE).toContain("\n  owner rotate-credential\n");
    const workspace = resolve(import.meta.dirname, "../..");
    const help = spawnSync(
      process.execPath,
      [join(workspace, "bin", "requestport.mjs"), "owner", "--help"],
      { cwd: workspace, encoding: "utf8", timeout: 20_000 },
    );

    expect(help.status).toBe(0);
    expect(help.stdout).toBe(`${OWNER_USAGE}\n`);
  });
});
