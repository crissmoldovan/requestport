import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { packageVersion, runRequestPortCli, USAGE } from "./cli.js";

const workspace = resolve(import.meta.dirname, "..");
const bin = join(workspace, "bin", "requestport.mjs");
const manifestVersion = (
  JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as {
    version: string;
  }
).version;

function captured() {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    sink: {
      stdout: (text: string) => {
        output.stdout += text;
      },
      stderr: (text: string) => {
        output.stderr += text;
      },
    },
  };
}

/** The executable, as a person runs it, with `node` options before it. */
function run(
  argv: string[],
  {
    env = process.env,
    nodeOptions = [],
  }: { env?: NodeJS.ProcessEnv; nodeOptions?: string[] } = {},
) {
  return spawnSync(process.execPath, [...nodeOptions, bin, ...argv], {
    cwd: workspace,
    env,
    encoding: "utf8",
  });
}

describe("requestport's commands, in this process", () => {
  test("--version prints the manifest's version (ruling 158, 19)", async () => {
    const { output, sink } = captured();

    expect(await runRequestPortCli(["--version"], {}, sink)).toBe(0);
    expect(output).toEqual({
      stdout: `requestport ${manifestVersion}\n`,
      stderr: "",
    });
    expect(packageVersion()).toBe(manifestVersion);
  });

  test("--help prints the usage", async () => {
    const { output, sink } = captured();

    expect(await runRequestPortCli(["--help"], {}, sink)).toBe(0);
    expect(output).toEqual({ stdout: `${USAGE}\n`, stderr: "" });
  });

  test("no command is a usage error", async () => {
    const { output, sink } = captured();

    expect(await runRequestPortCli([], {}, sink)).toBe(2);
    expect(output.stderr).toBe(
      `requestport: a command is required.\n\n${USAGE}\n`,
    );
  });

  test("an unknown command is a usage error that does not repeat what was typed", async () => {
    const { output, sink } = captured();

    expect(
      await runRequestPortCli(
        ["postgres://owner:SENTINEL_PASSWORD@db.example.com/requestport"],
        {},
        sink,
      ),
    ).toBe(2);
    expect(output.stderr).toBe(`requestport: unknown command.\n\n${USAGE}\n`);
    expect(output.stderr).not.toContain("SENTINEL_PASSWORD");
  });
});

/*
 * A `node` option that loads a resolve hook refusing every `@requestport/`
 * specifier and every module under `packages/`, so a command that loads a
 * workspace module fails. Hooks run last registered first, so tsx's, which
 * the executable registers after this one, runs before it; the control case
 * below shows a workspace specifier still reaches this one.
 */
let hooks: string;
let refuseWorkspace: string[];

beforeAll(() => {
  hooks = mkdtempSync(join(tmpdir(), "requestport-cli-hooks-"));
  const packages = pathToFileURL(resolve(workspace, "../../packages")).href;
  const hook = `
    const packages = ${JSON.stringify(`${packages}/`)};
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@requestport/")) {
        throw new Error("refused: a workspace module, " + specifier);
      }
      const resolved = await nextResolve(specifier, context);
      if (resolved.url.startsWith(packages)) {
        throw new Error("refused: a workspace module, " + resolved.url);
      }
      return resolved;
    }
  `;
  const register = join(hooks, "refuse-workspace.mjs");
  writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});\n`,
  );
  refuseWorkspace = ["--import", pathToFileURL(register).href];
});

afterAll(() => {
  rmSync(hooks, { recursive: true, force: true });
});

describe("the requestport executable", () => {
  test("--version and --help load no workspace module (K8)", () => {
    const version = run(["--version"], { nodeOptions: refuseWorkspace });
    const help = run(["--help"], { nodeOptions: refuseWorkspace });

    expect(version.stderr).toBe("");
    expect({ status: version.status, stdout: version.stdout }).toEqual({
      status: 0,
      stdout: `requestport ${manifestVersion}\n`,
    });
    expect(help.stderr).toBe("");
    expect({ status: help.status, stdout: help.stdout }).toEqual({
      status: 0,
      stdout: `${USAGE}\n`,
    });
  });

  test("the control: under the same hook, `worker` fails, because it loads @requestport/jobs", () => {
    const worker = run(["worker", "--help"], { nodeOptions: refuseWorkspace });

    expect(worker.status).not.toBe(0);
    expect(worker.stderr).toContain(
      "refused: a workspace module, @requestport/jobs",
    );
  });

  test("`worker` is requestport-jobs under this program's name", () => {
    const help = run(["worker", "--help"]);

    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(
      /^Usage: requestport worker \[--ready-file <path>\]\n/u,
    );
  });

  test("`worker` refuses unless the environment selects the Postgres runner, as requestport-jobs does, in its own name", () => {
    const env = { ...process.env };
    delete env.REQUESTPORT_JOB_RUNNER;

    const refused = run(["worker"], { env });

    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(
      /^requestport worker: this environment selects the trigger job runner, so this worker would compete with it for the same rows\. Set REQUESTPORT_JOB_RUNNER=postgres to run it\.\n$/u,
    );
  });
});

describe("requestport's commands: worker on PGlite", () => {
  test("the usage lists start and worker, each from its entry in the commands", () => {
    expect(USAGE).toContain("\n  start      ");
    expect(USAGE).toContain("\n  worker     ");
  });

  test("`worker` refuses an environment that selects PGlite before it opens anything: PGlite's worker runs in requestport start", () => {
    // Bounded: a worker that started on PGlite would not return by itself.
    const refused = spawnSync(process.execPath, [bin, "worker"], {
      cwd: workspace,
      env: {
        ...process.env,
        REQUESTPORT_JOB_RUNNER: "postgres",
        REQUESTPORT_DATABASE_DRIVER: "pglite",
        REQUESTPORT_PGLITE_DATA_DIR: "memory://",
      },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(
      "requestport worker: runs on PostgreSQL only. On PGlite, requestport start runs the worker in its own process, the one process that opens the database. Set REQUESTPORT_DATABASE_DRIVER to pg, or unset it.\n",
    );
  });
});

/*
 * Plan 13, I.2b's b5 (ruling 214 item 1): on PostgreSQL the worker connects
 * only as its three logins, and with none of them set it is refused. The
 * usage says so, and the second case shows the refusal it describes.
 */
describe("requestport's commands: worker on PostgreSQL, as its three logins", () => {
  const workerVariables = [
    "REQUESTPORT_DISPATCHER_DATABASE_URL",
    "REQUESTPORT_TENANT_PROCESSOR_DATABASE_URL",
    "REQUESTPORT_MAINTENANCE_DATABASE_URL",
  ];

  test("the usage's worker line says it connects as the worker's three database logins and refuses to start without them", () => {
    const start = USAGE.indexOf("\n  worker     ");
    const line = USAGE.slice(start, USAGE.indexOf("\n  login      ", start))
      .replace(/\s+/gu, " ")
      .trim();

    expect(line).toBe(
      "worker Runs the background jobs on PostgreSQL, as requestport-jobs does, connecting as the worker's three database logins that this process's environment names, and refuses to start without them. `requestport worker --help` says what it reads.",
    );
  });

  test("`worker` on PostgreSQL with none of the three set exits 2, naming them, before it starts", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REQUESTPORT_JOB_RUNNER: "postgres",
      REQUESTPORT_DATABASE_DRIVER: "pg",
    };
    delete env.VERCEL_ENV;
    for (const name of workerVariables) delete env[name];

    // Bounded: a worker that started would not return by itself.
    const refused = spawnSync(process.execPath, [bin, "worker"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(
      `requestport worker: RequestPort's worker connects as its three roles, and ${workerVariables[0]}, ${workerVariables[1]} and ${workerVariables[2]} are unset. Set all three, each to a login in its worker group.\n`,
    );
  });
});
