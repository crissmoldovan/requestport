import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { openOperatorSession } from "@requestport/db/wiring";
import { afterAll, describe, expect, test } from "vitest";

import { readDataFile } from "../atomic-file.js";
import {
  generateSecrets,
  writeConfiguration,
  writeSecrets,
} from "../configuration.js";
import { writeInstanceMarker } from "../instance-marker.js";
import { writeOwnerFile } from "../owner-url.js";
import { runOperatorStep } from "./operator-step.js";

/*
 * The operator step's composition, with spies in place of the database:
 * what it reads, what it checks before it connects, and in what order
 * (manifest-h.md Done when 6; ruling 155). The database itself is
 * `first-start.integration.test.ts`'s.
 */

const SENTINEL = "S3NT1NEL_0wner_secret";
const ownerUrl = `postgres://owner:${SENTINEL}@127.0.0.1:5432/requestport`;
const scratch = mkdtempSync(join(tmpdir(), "requestport-operator-step-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function dataDirectory({ bootstrap = true }: { bootstrap?: boolean } = {}) {
  const directory = mkdtempSync(join(scratch, "data-"));
  writeInstanceMarker(directory, {
    version: 1,
    instanceId: "0123456789abcdef",
    ...(bootstrap
      ? {
          bootstrap: {
            email: "owner@example.com",
            organizationSlug: "acme",
            organizationName: "Acme",
          },
        }
      : {}),
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
  return directory;
}

async function step(
  directory: string,
  overrides: {
    refuse?: (url: string, env: NodeJS.ProcessEnv) => void;
    migrationsFolder?: string;
  } = {},
) {
  const calls: unknown[][] = [];
  const read: string[] = [];
  const output = { stdout: "", stderr: "" };
  const env = { REQUESTPORT_PRODUCTION_DATABASE: "not approved" };
  const code = await runOperatorStep({
    dataDirectory: directory,
    env,
    output: {
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    },
    readFile: (from, name) => {
      read.push(name);
      return readDataFile(from, name);
    },
    refuseSharedDatabase: (url, given) => {
      calls.push(["refuseSharedDatabase", url, given]);
      overrides.refuse?.(url, given);
    },
    openSession: (async (options) => {
      calls.push(["openSession", options]);
      throw new Error("the spy opens no session");
    }) as typeof openOperatorSession,
    ...(overrides.migrationsFolder === undefined
      ? {}
      : { migrationsFolder: overrides.migrationsFolder }),
  });
  expect(output.stdout + output.stderr).not.toContain(SENTINEL);
  return { code, calls, read, output, env };
}

describe("the operator step's composition (manifest-h.md §2.4)", () => {
  test("refuses a shared database on the owner URL before it opens the owner's session, the first statement's", async () => {
    const { code, calls, env } = await step(dataDirectory());

    expect(calls).toEqual([
      ["refuseSharedDatabase", ownerUrl, env],
      ["openSession", { ownerUrl, env }],
    ]);
    expect(code).toBe(1);
  });

  test("a refused shared database stops it before the session opens", async () => {
    const { code, calls, output } = await step(dataDirectory(), {
      refuse: () => {
        throw new Error(
          "RequestPort would connect to the production database. Set REQUESTPORT_PRODUCTION_DATABASE=approved to do that deliberately, or point the connection string somewhere else.",
        );
      },
    });

    expect(code).toBe(1);
    expect(calls.map(([name]) => name)).toEqual(["refuseSharedDatabase"]);
    expect(output.stderr).toContain(
      "requestport start: the operator step failed: RequestPort would connect to the production database.",
    );
  });

  test("reads init.json and owner.json itself", async () => {
    const { read } = await step(dataDirectory());

    expect(read).toEqual(["init.json", "owner.json"]);
  });

  test("refuses a missing migrations folder, naming its path, before it refuses or connects (ruling 155)", async () => {
    const absent = join(scratch, "no-migrations-here");
    const empty = join(scratch, "migrations-without-a-journal");
    mkdirSync(empty, { recursive: true });

    for (const [folder, said] of [
      [absent, `the migrations folder ${absent} does not exist.`],
      [empty, `the migrations folder ${empty} holds no meta/_journal.json.`],
    ] as const) {
      const { code, calls, output } = await step(dataDirectory(), {
        migrationsFolder: folder,
      });

      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(output.stderr).toContain(`requestport start: ${said}`);
    }
  });

  test("decides the bootstrap from init.json as it reads once the session holds the claim's lock (Done when 8)", async () => {
    const directory = dataDirectory();
    const read: string[] = [];
    const calls: string[] = [];
    const output = { stdout: "", stderr: "" };
    type Session = Awaited<ReturnType<typeof openOperatorSession>>;
    const session: Session = {
      preflight: async () => {
        calls.push("preflight");
        return {
          role: "owner",
          database: "requestport",
          superuser: true,
          absentGroups: [],
        };
      },
      claim: async () => {
        calls.push("claim");
        return "already-claimed";
      },
      migrate: async () => {
        calls.push("migrate");
        return { applied: [] };
      },
      provision: async () => {
        calls.push("provision");
        return [];
      },
      // A credential rotation's step; a start never runs it.
      check: async () => {
        calls.push("check");
        throw new Error("the check-only step in a start");
      },
      bootstrapRepository: () => {
        calls.push("bootstrapRepository");
        throw new Error("a bootstrap after init.json was complete");
      },
      close: async () => {
        calls.push("close");
      },
    };

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
      readFile: (from, name) => {
        read.push(name);
        return readDataFile(from, name);
      },
      refuseSharedDatabase: () => undefined,
      // Another operator step on this data directory held the claim's lock
      // first, and completed the bootstrap while this one waited for it.
      openSession: (async () => {
        calls.push("openSession");
        const marker = JSON.parse(
          readDataFile(directory, "init.json") as string,
        );
        writeInstanceMarker(directory, { ...marker, complete: true });
        return session;
      }) as typeof openOperatorSession,
    });

    expect(output.stderr).not.toContain("the operator step failed");
    expect(code).toBe(0);
    expect(read).toEqual(["init.json", "owner.json", "init.json"]);
    expect(calls).toEqual([
      "openSession",
      "preflight",
      "claim",
      "migrate",
      "provision",
      "close",
    ]);
    expect(output.stdout).toBe("");
  });

  test("a migration PostgreSQL refuses is said in PostgreSQL's own words, not in the statement Drizzle wraps them in, and nothing after the migrations runs (ruling 215 item 10)", async () => {
    const directory = dataDirectory();
    const calls: string[] = [];
    const output = { stdout: "", stderr: "" };
    // As 0023's closing check refuses an owner that inherits a worker group,
    // wrapped as drizzle-orm 0.45.2's DrizzleQueryError wraps the driver's
    // error: "Failed query: <the statement>\nparams: ", the driver's error
    // its cause.
    const refusal = Object.assign(
      new Error(
        "requestport: the migrating role owner can still execute requestport_private.claim_outbox_batch(integer,integer), through an inheriting membership in its group requestport_dispatcher. A server whose createrole_self_grant includes inherit gives a role that is not a superuser such a membership in each role it creates: take the inherit option off it, or migrate as a role without one.",
      ),
      { code: "P0001" },
    );
    const wrapped = new Error(
      "Failed query: DO $$\nDECLARE\n\tworker record;\nBEGIN\n\tNULL;\nEND $$;\nparams: ",
      { cause: refusal },
    );
    type Session = Awaited<ReturnType<typeof openOperatorSession>>;
    const session = {
      preflight: async () => {
        calls.push("preflight");
        return {
          role: "owner",
          database: "requestport",
          superuser: false,
          absentGroups: [],
        };
      },
      claim: async () => {
        calls.push("claim");
        return "claimed";
      },
      migrate: async () => {
        calls.push("migrate");
        throw wrapped;
      },
      provision: async () => {
        calls.push("provision");
        return [];
      },
      close: async () => {
        calls.push("close");
      },
    } as unknown as Session;

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
      refuseSharedDatabase: () => undefined,
      openSession: (async () => session) as typeof openOperatorSession,
    });

    expect(code).toBe(1);
    expect(calls).toEqual(["preflight", "claim", "migrate", "close"]);
    expect(output.stderr).toContain(
      `requestport start: the migrations could not be applied: ${refusal.message}\n`,
    );
    expect(output.stderr).toContain("createrole_self_grant");
    expect(output.stderr).not.toContain("Failed query");
    expect(output.stderr).not.toContain("the operator step failed");
    expect(output.stdout).toBe("");
  });

  test("refuses an incomplete init.json with no bootstrap details before it connects", async () => {
    const { code, calls, output } = await step(
      dataDirectory({ bootstrap: false }),
    );

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(output.stderr).toContain(
      "init.json holds no email or organisation for the owner's bootstrap.",
    );
  });
});
