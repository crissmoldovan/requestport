import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test, vi } from "vitest";

import {
  generateSecrets,
  writeConfiguration,
  writeSecrets,
} from "../configuration.js";
import { newInstanceId, writeInstanceMarker } from "../instance-marker.js";
import { SERVER_ACTION_KEY_FILE } from "../server-action-key.js";
import {
  loginPasswords,
  serveFromDataDirectory,
  workerNotReadyLine,
} from "./run.js";

/**
 * What the packed form's lookup of `@requestport/web` says where it does
 * not resolve (`web.ts`' `defaultSelfHostWebDirectory`), for a lookup with
 * no directory named: this file's `./web.js` throws it from
 * `defaultSelfHostWebDirectory` and from `locateSelfHostWeb` called without
 * a directory, as an install without `@requestport/web` does, and is
 * otherwise the module itself.
 */
const { UNRESOLVED } = vi.hoisted(() => ({
  UNRESOLVED:
    "requestport start serves the web UI from @requestport/web, and /planted/dist cannot resolve it (Cannot find module '@requestport/web/package.json'). requestport depends on @requestport/web, which carries it; install requestport again.",
}));
vi.mock("./web.js", async (importOriginal) => {
  const web = await importOriginal<typeof import("./web.js")>();
  const unresolved = (): never => {
    throw new web.SelfHostWebError(UNRESOLVED);
  };
  return {
    ...web,
    defaultSelfHostWebDirectory: unresolved,
    locateSelfHostWeb: (directory?: string) =>
      directory === undefined ? unresolved() : web.locateSelfHostWeb(directory),
  };
});

/*
 * The serving step's refusals (manifest-h.md §2.5, §2.7.1): it serves only an
 * instance whose first start completed, with, on PostgreSQL, the login URLs
 * the operator step wrote, and with the web UI's self-host build to serve
 * beside the host, and refuses before it changes its environment or imports
 * anything that reads it. Serving itself is the integration suites'
 * (`serving.integration.test.ts`, `first-start.integration.test.ts`,
 * `web-ui.integration.test.ts`).
 */

const scratch = mkdtempSync(join(tmpdir(), "requestport-serving-step-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const configuration = {
  version: 1 as const,
  storage: "pg" as const,
  publicUrl: "http://127.0.0.1:3200",
  port: 3200,
  host: "127.0.0.1",
};

async function serve(
  directory: string,
  webDirectory?: string,
  inherited: NodeJS.ProcessEnv = {},
) {
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://kept/here",
    ...inherited,
  };
  let stderr = "";
  const code = await serveFromDataDirectory({
    dataDirectory: directory,
    env,
    io: { stderr: { write: (text: string) => (stderr += text) } },
    signals: { on: () => process, off: () => process },
    exit: () => {
      throw new Error("no second signal here");
    },
    ...(webDirectory === undefined ? {} : { webDirectory }),
  });
  return { code, stderr, env };
}

/**
 * A self-host build `locateSelfHostWeb` accepts, which nothing here loads:
 * each case below refuses before the web UI is prepared.
 */
function webBuild(directory: string) {
  const web = join(directory, "web build");
  mkdirSync(join(web, ".next-self-host", "static"), { recursive: true });
  writeFileSync(join(web, "server.js"), "");
  writeFileSync(
    join(web, ".next-self-host", "required-server-files.json"),
    JSON.stringify({
      config: { output: "standalone", distDir: ".next-self-host" },
    }),
  );
  return web;
}

/** A PGlite data directory whose first start completed. */
function servableDirectory(prefix: string) {
  const directory = mkdtempSync(join(scratch, prefix));
  writeInstanceMarker(directory, {
    version: 1,
    instanceId: newInstanceId(),
    complete: true,
  });
  writeConfiguration(directory, { ...configuration, storage: "pglite" });
  writeSecrets(directory, generateSecrets("pglite"), "pglite");
  return directory;
}

describe("the serving step refuses, and changes nothing, when", () => {
  test("init.json is not complete", async () => {
    const directory = mkdtempSync(join(scratch, "incomplete-"));
    writeInstanceMarker(directory, { version: 1, instanceId: newInstanceId() });
    writeConfiguration(directory, configuration);
    writeSecrets(directory, generateSecrets("pg"), "pg");

    const { code, stderr, env } = await serve(directory);

    expect(code).toBe(1);
    expect(stderr).toBe(
      `requestport start: ${directory}'s init.json is not complete, so this instance has no owner yet; it serves nothing.\n`,
    );
    expect(env).toEqual({ DATABASE_URL: "postgres://kept/here" });
  });

  test("secrets.json holds no login URLs", async () => {
    const directory = mkdtempSync(join(scratch, "no-urls-"));
    writeInstanceMarker(directory, {
      version: 1,
      instanceId: newInstanceId(),
      complete: true,
    });
    writeConfiguration(directory, configuration);
    writeSecrets(directory, generateSecrets("pg"), "pg");

    const { code, stderr, env } = await serve(directory);

    expect(code).toBe(1);
    expect(stderr).toBe(
      `requestport start: ${directory}'s secrets.json holds no login URLs; the operator step writes them once it has provisioned the logins.\n`,
    );
    expect(env).toEqual({ DATABASE_URL: "postgres://kept/here" });
  });

  test("the web UI's self-host build is missing: refused by SelfHostWebError's name, naming where it looked", async () => {
    const directory = mkdtempSync(join(scratch, "no-web-"));
    const webDirectory = join(directory, "no build here");
    writeInstanceMarker(directory, {
      version: 1,
      instanceId: newInstanceId(),
      complete: true,
    });
    writeConfiguration(directory, { ...configuration, storage: "pglite" });
    writeSecrets(directory, generateSecrets("pglite"), "pglite");

    const { code, stderr, env } = await serve(directory, webDirectory);

    expect(code).toBe(1);
    expect(stderr).toBe(
      `requestport start: SelfHostWebError: requestport start serves the web UI from the self-host build, and there is none at ${webDirectory} (no server.js). Build it with apps/requestport/src/web/self-host-build.ts's buildSelfHostWeb (next build --webpack in apps/web with REQUESTPORT_SELF_HOST_BUILD=1).\n`,
    );
    expect(env).toEqual({ DATABASE_URL: "postgres://kept/here" });
  });

  test("it is named no web UI's directory, and the default lookup cannot resolve @requestport/web: refused by SelfHostWebError's name, through its own path, not thrown (H.7 round 5's review)", async () => {
    const directory = mkdtempSync(join(scratch, "unresolved-web-"));
    writeInstanceMarker(directory, {
      version: 1,
      instanceId: newInstanceId(),
      complete: true,
    });
    writeConfiguration(directory, { ...configuration, storage: "pglite" });
    writeSecrets(directory, generateSecrets("pglite"), "pglite");

    const { code, stderr, env } = await serve(directory);

    expect(code).toBe(1);
    expect(stderr).toBe(`requestport start: SelfHostWebError: ${UNRESOLVED}\n`);
    expect(env).toEqual({ DATABASE_URL: "postgres://kept/here" });
  });
});

describe("the serving step refuses, before it changes its environment, when the server-action key cannot be the data directory's (ruling 201 item 4)", () => {
  test("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is set in its environment: refused, naming the variable and never its value, and no key file is made", async () => {
    const directory = servableDirectory("inherited-key-");
    const files = readdirSync(directory).sort();
    const value = "S3NT1NEL_an+operator/key=";

    const { code, stderr, env } = await serve(directory, webBuild(scratch), {
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: value,
    });

    expect(code).toBe(1);
    expect(stderr).toBe(
      "requestport start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is set in requestport start's environment. requestport start makes the web UI's server-action key itself, once per data directory, and keeps it in the data directory's server-action-key file: unset the variable. To use a key of your own, write it to that file instead (base64 of 32 bytes, mode 0600).\n",
    );
    expect(env).toEqual({
      DATABASE_URL: "postgres://kept/here",
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: value,
    });
    expect(readdirSync(directory).sort()).toEqual(files);
    expect(existsSync(join(directory, SERVER_ACTION_KEY_FILE))).toBe(false);
  });

  test("the data directory's key file is open to group or others: refused, naming the file, never its contents, and left as it was", async () => {
    const directory = servableDirectory("open-key-");
    const path = join(directory, SERVER_ACTION_KEY_FILE);
    const key = Buffer.alloc(32, 3).toString("base64");
    writeFileSync(path, `${key}\n`);
    chmodSync(path, 0o640);

    const { code, stderr, env } = await serve(directory, webBuild(scratch));

    expect(code).toBe(1);
    expect(stderr).toBe(
      `requestport start: ${path} is open to group or others (mode 640), and it holds the web UI's server-action key. Run \`chmod 600 ${path}\`, then start again.\n`,
    );
    expect(env).toEqual({ DATABASE_URL: "postgres://kept/here" });
    expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
  });
});

/*
 * The line a serving start on pg writes once its worker has not been ready
 * for 30 s (ruling 163, item 2), from the worker storages' role reports.
 * That it is written, once, and the start goes on waiting, is
 * `serving.integration.test.ts`'s.
 */
describe("the passwords the not-ready line withholds", () => {
  test("are every login URL's password, as written and percent-decoded, and nothing else", () => {
    const encoded = "p%40ss%2Fw0rd";
    const passwords = loginPasswords({
      REQUESTPORT_APPLICATION_DATABASE_URL: `postgres://app:${encoded}@127.0.0.1:5432/db`,
      REQUESTPORT_DISPATCHER_DATABASE_URL:
        "postgres://d:plain-one@127.0.0.1:5432/db",
      REQUESTPORT_UNRELATED_URL: "postgres://x:not-a-login@127.0.0.1:5432/db",
    });
    expect(passwords).toContain(encoded);
    expect(passwords).toContain("p@ss/w0rd");
    expect(passwords).toContain("plain-one");
    expect(passwords).not.toContain("not-a-login");
  });
});

describe("the line that says why the worker is not ready", () => {
  const password = "pAssw0rd_0123456789abcdefghijklmnopqrstuvwxyz";

  test("names the error the role reports fail with, PostgreSQL's words, and says the start waits while the worker retries", () => {
    expect(
      workerNotReadyLine(
        30_000,
        {
          failure: new Error(
            'password authentication failed for user "rp_0123456789abcdef_dispatcher"',
          ),
        },
        [password],
      ),
    ).toBe(
      'the in-process worker is not ready after 30 s; a worker storage cannot run a query: password authentication failed for user "rp_0123456789abcdef_dispatcher". Still waiting while the worker retries.',
    );
  });

  test("names the driver's error inside the query error Drizzle wraps it in, on one line", () => {
    // As drizzle-orm 0.45.2's DrizzleQueryError: "Failed query: …\nparams: …",
    // with the driver's error as its cause.
    const wrapped = new Error("Failed query: select 1 as ready\nparams: ", {
      cause: new Error(
        'password authentication failed for user "rp_0123456789abcdef_maintenance"',
      ),
    });

    expect(workerNotReadyLine(30_000, { failure: wrapped }, [])).toBe(
      'the in-process worker is not ready after 30 s; a worker storage cannot run a query: password authentication failed for user "rp_0123456789abcdef_maintenance". Still waiting while the worker retries.',
    );
  });

  test("never carries a password it is given, wherever the error repeats one", () => {
    const line = workerNotReadyLine(
      30_000,
      {
        failure: new Error(
          `could not connect as postgres://rp_x:${password}@127.0.0.1/db (${password})`,
        ),
      },
      [password],
    );

    expect(line).not.toContain(password);
    expect(line).toContain(
      "could not connect as postgres://rp_x:[password]@127.0.0.1/db ([password])",
    );
  });

  test("when every storage runs a query, names each one's login and role check", () => {
    const role = (login: string) => ({
      surface: "worker" as const,
      findings: [
        {
          check: "role" as const,
          status: "passed" as const,
          surface: "worker" as const,
          role: login,
          objections: [],
        },
      ],
    });

    expect(
      workerNotReadyLine(
        30_000,
        {
          reports: {
            dispatcher: role("rp_x_dispatcher"),
            processor: role("rp_x_tenant_processor"),
            maintenance: { surface: "worker", findings: [] },
          },
        },
        [],
      ),
    ).toBe(
      "the in-process worker is not ready after 30 s; each worker storage runs a query (dispatcher: login rp_x_dispatcher, role check passed; processor: login rp_x_tenant_processor, role check passed; maintenance: login ?, role check not run). Still waiting.",
    );
  });
});
