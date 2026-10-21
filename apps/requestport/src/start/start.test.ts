import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { isBindableServer } from "@requestport/client/project";
import { afterAll, describe, expect, test } from "vitest";

import { OPERATOR_ENTRY } from "../operator/command.js";
import { OWNER_URL_FORMS } from "../owner-url.js";
import { type SelfHostWeb, SelfHostWebError } from "../serve/web.js";
import { runStart, type StartBoundary } from "./start.js";

const SENTINEL = "S3NT1NEL_0wner_secret";
const ownerUrl = `postgres://owner:${SENTINEL}@127.0.0.1:5432/requestport`;

const scratch = mkdtempSync(join(tmpdir(), "requestport-start-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const freshPath = (name: string) => {
  made += 1;
  return join(scratch, `${name}-${made}`);
};
const ownerUrlFile = () => {
  const path = freshPath("owner.url");
  writeFileSync(path, `${ownerUrl}\n`);
  chmodSync(path, 0o600);
  return path;
};

const bootstrapFlags = [
  "--email",
  "Owner@Example.com",
  "--organization",
  "acme",
  "--organization-name",
  "Acme",
];

interface Spawned {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  /** The data directory's `config.json` when the child was started. */
  configuration: unknown;
}

interface Served {
  dataDirectory: string;
  env: NodeJS.ProcessEnv;
  /** The data directory's entries while the serving step ran. */
  files: string[];
  /** The web UI's directory the serving step was handed. */
  webDirectory: string | undefined;
}

/** The web UI the stand-in lookup finds: no build is read in these cases. */
const WEB: SelfHostWeb = {
  directory: "/planted/@requestport/web",
  config: { output: "standalone", distDir: ".next-self-host" },
};

/**
 * `runStart` in this process, with a terminal-less stdin, a lookup of the
 * web UI that finds `WEB` (or does what `locateWeb` does), a spawn that
 * records and exits as told, and a serving step that records what it was
 * handed and answers `served`.
 */
async function start(
  argv: string[],
  {
    exit = { code: 0, signal: null },
    env = { PATH: process.env.PATH },
    served: servedCode = 0,
    locateWeb = () => WEB,
  }: {
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    env?: NodeJS.ProcessEnv;
    served?: number;
    locateWeb?: () => SelfHostWeb;
  } = {},
) {
  const output = { stdout: "", stderr: "" };
  const spawned: Spawned[] = [];
  const served: Served[] = [];
  const boundaries: { boundary: StartBoundary; files: string[] }[] = [];
  const directory = argv[argv.indexOf("--data-dir") + 1] as string;
  const code = await runStart(argv, env, {
    locateWeb,
    serve: async (context) => {
      served.push({
        dataDirectory: context.dataDirectory,
        env: context.env,
        files: readdirSync(context.dataDirectory).sort(),
        webDirectory: context.webDirectory,
      });
      return servedCode;
    },
    io: {
      stdin: new PassThrough(),
      stdout: { write: (text: string) => (output.stdout += text) },
      stderr: { write: (text: string) => (output.stderr += text) },
    },
    spawnOperator: (command, args, options) => {
      spawned.push({
        command,
        args,
        options,
        configuration: JSON.parse(
          readFileSync(join(directory, "config.json"), "utf8"),
        ),
      });
      const child = new EventEmitter() as ChildProcess;
      setImmediate(() => child.emit("exit", exit.code, exit.signal));
      return child;
    },
    afterBoundary: (boundary) => {
      boundaries.push({ boundary, files: readdirSync(directory).sort() });
    },
  });
  expect(output.stdout + output.stderr).not.toContain(SENTINEL);
  return { code, output, spawned, served, boundaries };
}

const dataFiles = (directory: string) =>
  existsSync(directory) ? readdirSync(directory).sort() : [];

describe("requestport start, around the operator step (manifest-h.md §2.3.1, §2.4, §2.5)", () => {
  test("refuses --owner-url with a value before it reads or writes anything", async () => {
    for (const given of [
      ["--owner-url", ownerUrl],
      [`--owner-url=${ownerUrl}`],
    ]) {
      const directory = freshPath("data");
      const { code, output, spawned } = await start([
        "--data-dir",
        directory,
        ...given,
        ...bootstrapFlags,
      ]);

      expect(code).toBe(2);
      expect(output.stderr).toBe(
        `requestport start: --owner-url takes no value on the command line. ${OWNER_URL_FORMS}\n`,
      );
      expect(existsSync(directory)).toBe(false);
      expect(spawned).toEqual([]);
    }
  });

  test("on a first start with no terminal, refuses before writing a file when the owner URL or a bootstrap flag is missing, or invalid", async () => {
    for (const [argv, said] of [
      [[...bootstrapFlags], "standard input is not a terminal to ask at"],
      [
        ["--owner-url-file", ownerUrlFile(), "--email", "owner@example.com"],
        "a first start needs --organization, --organization-name, and standard input is not a terminal to ask at.",
      ],
      [
        [
          "--owner-url-file",
          ownerUrlFile(),
          ...bootstrapFlags.slice(2),
          "--email",
          "not an address",
        ],
        "--email: Email is invalid.",
      ],
    ] as const) {
      const directory = freshPath("data");
      const { code, output, spawned } = await start([
        "--data-dir",
        directory,
        ...argv,
      ]);

      expect(code).toBe(2);
      expect(output.stderr).toContain(said);
      expect(dataFiles(directory)).toEqual([]);
      expect(spawned).toEqual([]);
    }
  });

  test("writes B1 to B4 in order, each 0600, then starts the operator child with the data directory as its one argument", async () => {
    const directory = freshPath("data");
    const env = { PATH: process.env.PATH, SOME_SETTING: "kept" };
    const { code, spawned, boundaries } = await start(
      [
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerUrlFile(),
        ...bootstrapFlags,
      ],
      { env },
    );

    expect(code).toBe(0);
    expect(boundaries).toEqual([
      { boundary: "B1", files: ["init.json", "lock"] },
      { boundary: "B2", files: ["config.json", "init.json", "lock"] },
      {
        boundary: "B3",
        files: ["config.json", "init.json", "lock", "secrets.json"],
      },
      {
        boundary: "B4",
        files: [
          "config.json",
          "init.json",
          "lock",
          "owner.json",
          "secrets.json",
        ],
      },
    ]);
    expect(dataFiles(directory)).toEqual([
      "config.json",
      "init.json",
      "owner.json",
      "secrets.json",
    ]);
    for (const file of dataFiles(directory)) {
      expect(statSync(join(directory, file)).mode & 0o777, file).toBe(0o600);
      expect(
        readFileSync(join(directory, file), "utf8").includes(SENTINEL),
        file,
      ).toBe(file === "owner.json");
    }
    const marker = JSON.parse(
      readFileSync(join(directory, "init.json"), "utf8"),
    );
    expect(marker).toEqual({
      version: 1,
      instanceId: expect.stringMatching(/^[0-9a-f]{16}$/u),
      bootstrap: {
        email: "owner@example.com",
        organizationSlug: "acme",
        organizationName: "Acme",
      },
    });
    expect(
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    ).toEqual({
      version: 1,
      storage: "pg",
      publicUrl: "http://127.0.0.1:3200",
      port: 3200,
      host: "127.0.0.1",
    });

    expect(spawned).toHaveLength(1);
    const [child] = spawned as [Spawned];
    expect(child.command).toBe(process.execPath);
    expect(child.args).toEqual([
      "--import",
      expect.stringMatching(
        /^file:\/\/.*\/apps\/requestport\/bin\/tsx-loader\.mjs$/u,
      ),
      OPERATOR_ENTRY,
      // The data directory's real path: under macOS's default TMPDIR,
      // /var is a symbolic link to /private/var (ruling 152).
      realpathSync(directory),
    ]);
    expect(JSON.stringify(child.args)).not.toContain(SENTINEL);
    expect(child.options.env).toBe(env);
    expect(child.options.stdio).toEqual(["ignore", "inherit", "inherit"]);
  });

  test("once the operator step has exited 0, serves in this process, holding the data directory's lock, the web UI it found before anything was written, and answers what serving answers", async () => {
    for (const answer of [0, 1]) {
      const directory = freshPath("data");
      const env = { PATH: process.env.PATH };
      const { code, served } = await start(
        [
          "--data-dir",
          directory,
          "--owner-url-file",
          ownerUrlFile(),
          ...bootstrapFlags,
        ],
        { env, served: answer },
      );

      expect(code).toBe(answer);
      expect(served).toEqual([
        {
          dataDirectory: realpathSync(directory),
          env,
          files: [
            "config.json",
            "init.json",
            "lock",
            "owner.json",
            "secrets.json",
          ],
          webDirectory: WEB.directory,
        },
      ]);
      expect(dataFiles(directory)).not.toContain("lock");
    }
  });

  test("refuses, before it makes the data directory or writes anything, when the web UI's self-host build cannot be found: SelfHostWebError's words, exit 1, no operator step and no serving step, so that a first start prints no one-time credential it then cannot serve (H.7 round 5's review)", async () => {
    const directory = freshPath("no-web");
    const unresolved =
      "requestport start serves the web UI from @requestport/web, and /planted/dist cannot resolve it (Cannot find module '@requestport/web/package.json'). requestport depends on @requestport/web, which carries it; install requestport again.";
    for (const storage of [
      ["--owner-url-file", ownerUrlFile()],
      ["--storage", "pglite"],
    ]) {
      const { code, output, spawned, served } = await start(
        ["--data-dir", directory, ...storage, ...bootstrapFlags],
        {
          locateWeb: () => {
            throw new SelfHostWebError(unresolved);
          },
        },
      );

      expect(code).toBe(1);
      expect(output).toEqual({
        stdout: "",
        stderr: `requestport start: SelfHostWebError: ${unresolved}\n`,
      });
      expect(spawned).toEqual([]);
      expect(served).toEqual([]);
      expect(existsSync(directory)).toBe(false);
    }
  });

  test("refuses, before it makes the data directory or writes anything, when NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is set in its environment: the data directory's key is the one Next uses, so a first start prints no one-time credential it then cannot serve; exit 1, naming the variable and never its value (ruling 201 item 4)", async () => {
    const directory = freshPath("inherited-key");
    const value = "S3NT1NEL_an+operator/key=";
    for (const storage of [
      ["--owner-url-file", ownerUrlFile()],
      ["--storage", "pglite"],
    ]) {
      const { code, output, spawned, served } = await start(
        ["--data-dir", directory, ...storage, ...bootstrapFlags],
        {
          env: {
            PATH: process.env.PATH,
            NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: value,
          },
        },
      );

      expect(code).toBe(1);
      expect(output).toEqual({
        stdout: "",
        stderr:
          "requestport start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is set in requestport start's environment. requestport start makes the web UI's server-action key itself, once per data directory, and keeps it in the data directory's server-action-key file: unset the variable. To use a key of your own, write it to that file instead (base64 of 32 bytes, mode 0600).\n",
      });
      expect(spawned).toEqual([]);
      expect(served).toEqual([]);
      expect(existsSync(directory)).toBe(false);
    }
  });

  test("answers 1, saying how, when the operator step fails or is killed", async () => {
    for (const [exit, said] of [
      [{ code: 1, signal: null }, "the operator step exited with code 1."],
      [
        { code: null, signal: "SIGKILL" },
        "the operator step was stopped by SIGKILL.",
      ],
    ] as const) {
      const directory = freshPath("data");
      const { code, output, served } = await start(
        [
          "--data-dir",
          directory,
          "--owner-url-file",
          ownerUrlFile(),
          ...bootstrapFlags,
        ],
        { exit },
      );

      expect(code).toBe(1);
      expect(output.stderr).toContain(`requestport start: ${said}`);
      expect(existsSync(join(directory, "lock"))).toBe(false);
      expect(served).toEqual([]);
    }
  });

  test("a later start writes nothing it already has, does not read an owner URL it was given again, and refuses a changed configuration", async () => {
    const directory = freshPath("data");
    await start([
      "--data-dir",
      directory,
      "--owner-url-file",
      ownerUrlFile(),
      ...bootstrapFlags,
    ]);
    const before = Object.fromEntries(
      dataFiles(directory).map((file) => [
        file,
        readFileSync(join(directory, file), "utf8"),
      ]),
    );

    const again = await start([
      "--data-dir",
      directory,
      "--owner-url-file",
      join(scratch, "no-such-file"),
    ]);
    expect(again.code).toBe(0);
    expect(again.boundaries).toEqual([]);
    expect(again.spawned).toHaveLength(1);
    expect(again.output.stderr).toContain(
      "owner.json already holds the owner URL; the --owner-url-file given was not read.",
    );
    for (const [file, contents] of Object.entries(before)) {
      expect(readFileSync(join(directory, file), "utf8"), file).toBe(contents);
    }

    const changed = await start(["--data-dir", directory, "--port", "3300"]);
    expect(changed.code).toBe(2);
    expect(changed.output.stderr).toContain(
      "--port differs from what this data directory's config.json records",
    );
    expect(changed.spawned).toEqual([]);
  });

  test("a later start refuses a --port or --host that would move the public URL a first start derived, naming the URL and --public-url, and changes nothing (manifest-h.md §2.3; ruling 158, item 18)", async () => {
    const directory = freshPath("data");
    await start([
      "--data-dir",
      directory,
      "--owner-url-file",
      ownerUrlFile(),
      ...bootstrapFlags,
    ]);
    const recorded = readFileSync(join(directory, "config.json"), "utf8");

    for (const [given, moved] of [
      [["--port", "3300"], "http://127.0.0.1:3300"],
      [["--host", "127.0.0.2"], "http://127.0.0.2:3200"],
    ] as const) {
      const refused = await start(["--data-dir", directory, ...given]);

      expect(refused.code).toBe(2);
      expect(refused.output.stderr).toContain(
        `requestport start: ${given[0]} differs from what this data directory's config.json records, and would move the public URL its first start pinned, http://127.0.0.1:3200, to ${moved}. Agent grants are bound to the public URL: those bound to http://127.0.0.1:3200 stop working once it changes. The OAuth resource rows for http://127.0.0.1:3200 stay in the database, since Better Auth inserts a row for each resource it does not hold and removes none. To change it, name the new URL with --public-url ${moved}.\n`,
      );
      expect(refused.spawned).toEqual([]);
      expect(refused.served).toEqual([]);
      expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(
        recorded,
      );
    }

    // A flag that moves no public URL is refused all the same.
    const proxy = await start([
      "--data-dir",
      directory,
      "--trusted-proxy",
      "10.0.0.1",
    ]);
    expect(proxy.code).toBe(2);
    expect(proxy.output.stderr).toContain(
      "requestport start: --trusted-proxy differs from what this data directory's config.json records. A later start changes config.json only when --public-url names the public URL beside it.\n",
    );
    expect(proxy.spawned).toEqual([]);
  });

  test("with --public-url, a later start records the flags given in config.json before the operator step runs, and says what a changed public URL ends", async () => {
    const directory = freshPath("data");
    await start([
      "--data-dir",
      directory,
      "--owner-url-file",
      ownerUrlFile(),
      ...bootstrapFlags,
    ]);

    const moved = await start([
      "--data-dir",
      directory,
      "--public-url",
      "http://127.0.0.1:3300/",
      "--port",
      "3300",
    ]);

    expect(moved.code).toBe(0);
    expect(moved.boundaries).toEqual([]);
    const expected = {
      version: 1,
      storage: "pg",
      publicUrl: "http://127.0.0.1:3300",
      port: 3300,
      host: "127.0.0.1",
    };
    expect(
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    ).toEqual(expected);
    expect(moved.spawned.map((child) => child.configuration)).toEqual([
      expected,
    ]);
    expect(moved.output.stderr).toContain(
      "requestport start: the public URL changes from http://127.0.0.1:3200 to http://127.0.0.1:3300, as --public-url names, and config.json records it. Agent grants are bound to the public URL: those bound to http://127.0.0.1:3200 stop working once it changes. The OAuth resource rows for http://127.0.0.1:3200 stay in the database, since Better Auth inserts a row for each resource it does not hold and removes none.\n",
    );

    // Naming the public URL it already records, with another port beside
    // it: the port is recorded and the public URL does not move.
    const repointed = await start([
      "--data-dir",
      directory,
      "--public-url",
      "http://127.0.0.1:3300",
      "--port",
      "3400",
    ]);
    expect(repointed.code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    ).toEqual({ ...expected, port: 3400 });
    expect(repointed.output.stderr).toContain(
      "requestport start: config.json records the configuration given, at the public URL http://127.0.0.1:3300.\n",
    );
    expect(repointed.output.stderr).not.toContain("Agent grants");

    // And naming it with nothing else changed writes nothing.
    const same = readFileSync(join(directory, "config.json"), "utf8");
    const again = await start([
      "--data-dir",
      directory,
      "--public-url",
      "http://127.0.0.1:3300",
    ]);
    expect(again.code).toBe(0);
    expect(again.output.stderr).not.toContain("config.json records");
    expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(same);
  });

  /**
   * The values `--public-url` refuses: every refusing row of the origin
   * rule's shared fixture but the empty one, which the argument parser
   * refuses first (`--public-url takes a value.`), and two with a path,
   * which the binding refuses and no row of the fixture holds.
   */
  const refusedPublicUrls = () => {
    const { cases } = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../../packages/client/src/origin-rule.cases.json",
        ),
        "utf8",
      ),
    ) as { cases: { url: string; accepted: boolean }[] };
    const refusing = [
      ...cases.filter((row) => !row.accepted).map((row) => row.url),
      "http://127.0.0.1:3200/some/path",
      "https://requestport.com/app",
    ].filter((url) => url !== "");
    expect(refusing.length).toBeGreaterThan(20);
    return refusing;
  };
  const publicUrlRefusal =
    "requestport start: --public-url must be https, or http on a loopback host, and an origin: no user name, password, path, query or fragment.\n";
  /** Whether `text` repeats `url`, or its user name or password. */
  const repeats = (text: string, url: string) => {
    let parts = [url];
    try {
      const parsed = new URL(url);
      parts = [url, parsed.username, parsed.password].filter(Boolean);
    } catch {
      // Not a URL: only the value itself.
    }
    return parts.some((part) => text.includes(part));
  };

  test("a first start refuses a --public-url that config.json may not record before it writes or runs anything, never repeating the value (Done when 4)", async () => {
    const outcomes = [];
    for (const url of refusedPublicUrls()) {
      const directory = freshPath("data");
      const first = await start([
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerUrlFile(),
        ...bootstrapFlags,
        "--public-url",
        url,
      ]);
      outcomes.push({
        url,
        code: first.code,
        said: first.output.stderr.startsWith(publicUrlRefusal),
        repeated: repeats(first.output.stderr, url),
        files: dataFiles(directory),
        spawned: first.spawned.length,
      });
    }

    expect(outcomes).toEqual(
      outcomes.map(({ url }) => ({
        url,
        code: 2,
        said: true,
        repeated: false,
        files: [],
        spawned: 0,
      })),
    );
  });

  test("a later start refuses a --public-url that config.json may not record, where the recorded public URL is the value's own origin, before it changes or runs anything, never repeating the value (Done when 4)", async () => {
    const outcomes = [];
    for (const url of refusedPublicUrls()) {
      // The recorded public URL is the value's own origin wherever
      // config.json may record that origin, so that only what the value
      // adds to it differs; otherwise the default.
      let origin: string | undefined;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = undefined;
      }
      const directory = freshPath("data");
      const initialised = await start([
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerUrlFile(),
        ...bootstrapFlags,
        ...(origin !== undefined && isBindableServer(origin)
          ? ["--public-url", origin]
          : []),
      ]);
      expect(initialised.code, url).toBe(0);
      const recorded = readFileSync(join(directory, "config.json"), "utf8");
      const later = await start(["--data-dir", directory, "--public-url", url]);
      outcomes.push({
        url,
        code: later.code,
        said: later.output.stderr.startsWith(publicUrlRefusal),
        repeated: repeats(later.output.stderr, url),
        configurationUnchanged:
          readFileSync(join(directory, "config.json"), "utf8") === recorded,
        spawned: later.spawned.length,
        served: later.served.length,
      });
    }

    expect(outcomes).toEqual(
      outcomes.map(({ url }) => ({
        url,
        code: 2,
        said: true,
        repeated: false,
        configurationUnchanged: true,
        spawned: 0,
        served: 0,
      })),
    );
  });

  test("a resumed first start refuses a bootstrap flag that differs from what init.json recorded, before the operator step, and changes nothing; the same details, normalised as recorded, resume", async () => {
    const directory = freshPath("data");
    // A first start whose operator step failed: init.json records the
    // bootstrap's details and is not complete.
    const first = await start(
      [
        "--data-dir",
        directory,
        "--owner-url-file",
        ownerUrlFile(),
        ...bootstrapFlags,
      ],
      { exit: { code: 1, signal: null } },
    );
    expect(first.code).toBe(1);
    const files = () =>
      Object.fromEntries(
        dataFiles(directory).map((file) => [
          file,
          readFileSync(join(directory, file), "utf8"),
        ]),
      );
    const before = files();
    expect(JSON.parse(before["init.json"] as string)).toEqual({
      version: 1,
      instanceId: expect.any(String),
      bootstrap: {
        email: "owner@example.com",
        organizationSlug: "acme",
        organizationName: "Acme",
      },
    });

    for (const given of [
      ["--email", "someone.else@example.com"],
      ["--organization", "other"],
      ["--organization-name", "Other"],
    ] as const) {
      const resumed = await start(["--data-dir", directory, ...given]);

      expect(resumed.code, given[0]).toBe(2);
      expect(resumed.output.stderr, given[0]).toContain(
        `requestport start: ${given[0]} differs from what init.json recorded for this first start's bootstrap.\n`,
      );
      expect(resumed.output.stderr, given[0]).not.toContain(given[1]);
      expect(resumed.spawned, given[0]).toEqual([]);
      expect(resumed.served, given[0]).toEqual([]);
      expect(files(), given[0]).toEqual(before);
    }

    const same = await start([
      "--data-dir",
      directory,
      "--email",
      "OWNER@example.com",
      "--organization",
      "acme",
    ]);
    expect(same.code).toBe(0);
    expect(same.spawned).toHaveLength(1);
    expect(files()).toEqual(before);
  });

  test("removes the temporary files a stopped write left, once it holds the lock", async () => {
    const directory = freshPath("data");
    await start([
      "--data-dir",
      directory,
      "--owner-url-file",
      ownerUrlFile(),
      ...bootstrapFlags,
    ]);
    writeFileSync(join(directory, "secrets.json.tmp-99999"), "half");

    const again = await start(["--data-dir", directory]);
    expect(again.code).toBe(0);
    expect(again.output.stderr).toContain(
      "removed secrets.json.tmp-99999, left by a start that stopped while writing.",
    );
    expect(dataFiles(directory)).not.toContain("secrets.json.tmp-99999");
  });
});

/*
 * PGlite (manifest-h.md §2.6; Done when 9): a first start writes B1 to B3,
 * never owner.json, and records the storage; the refusals PGlite adds come
 * before anything is written.
 */
describe("requestport start on PGlite (manifest-h.md §2.6)", () => {
  test("a first start writes B1 to B3 in order, no owner.json, records pglite, and starts the operator child", async () => {
    const directory = freshPath("data");
    const { code, spawned, served, boundaries } = await start([
      "--data-dir",
      directory,
      "--storage",
      "pglite",
      ...bootstrapFlags,
    ]);

    expect(code).toBe(0);
    expect(boundaries).toEqual([
      { boundary: "B1", files: ["init.json", "lock"] },
      { boundary: "B2", files: ["config.json", "init.json", "lock"] },
      {
        boundary: "B3",
        files: ["config.json", "init.json", "lock", "secrets.json"],
      },
    ]);
    expect(dataFiles(directory)).toEqual([
      "config.json",
      "init.json",
      "secrets.json",
    ]);
    expect(
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    ).toEqual({
      version: 1,
      storage: "pglite",
      publicUrl: "http://127.0.0.1:3200",
      port: 3200,
      host: "127.0.0.1",
    });
    const secrets = JSON.parse(
      readFileSync(join(directory, "secrets.json"), "utf8"),
    );
    expect(secrets.loginPasswords).toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args.at(-1)).toBe(realpathSync(directory));
    expect(served).toHaveLength(1);
  });

  test("refuses an owner URL form, a non-loopback --host, and a --storage that differs from config.json, before it writes anything", async () => {
    for (const [argv, said] of [
      [
        ["--owner-url-file", ownerUrlFile()],
        "requestport start: PGlite takes no owner URL: its database is inside the data directory. --owner-url-file and --owner-url-stdin are for PostgreSQL.\n",
      ],
      [
        ["--owner-url-stdin"],
        "requestport start: PGlite takes no owner URL: its database is inside the data directory. --owner-url-file and --owner-url-stdin are for PostgreSQL.\n",
      ],
      [
        ["--host", "0.0.0.0"],
        "requestport start: --host: PGlite serves one user on this machine, and row-level security does not apply to it, so it binds a loopback address only (localhost, 127.0.0.0/8 or ::1).\n",
      ],
      [
        ["--host", "192.168.1.20"],
        "requestport start: --host: PGlite serves one user on this machine",
      ],
    ] as const) {
      const directory = freshPath("data");
      const { code, output, spawned } = await start([
        "--data-dir",
        directory,
        "--storage",
        "pglite",
        ...argv,
        ...bootstrapFlags,
      ]);

      expect(code, output.stderr).toBe(2);
      expect(output.stderr.startsWith(said), output.stderr).toBe(true);
      expect(dataFiles(directory)).toEqual([]);
      expect(spawned).toEqual([]);
    }

    for (const [first, then] of [
      [["--owner-url-file", ownerUrlFile(), "--storage", "pg"], "pglite"],
      [["--storage", "pglite"], "pg"],
    ] as const) {
      const directory = freshPath("data");
      expect(
        (await start(["--data-dir", directory, ...first, ...bootstrapFlags]))
          .code,
      ).toBe(0);
      const before = readFileSync(join(directory, "config.json"), "utf8");
      const { code, output, spawned } = await start([
        "--data-dir",
        directory,
        "--storage",
        then,
      ]);

      expect(code).toBe(2);
      expect(output.stderr).toContain(
        `requestport start: --storage differs from what this data directory's config.json records, ${then === "pg" ? "pglite" : "pg"}. A data directory's storage never changes.\n`,
      );
      expect(readFileSync(join(directory, "config.json"), "utf8")).toBe(before);
      expect(spawned).toEqual([]);
    }
  });

  test("a later start without --storage serves what config.json records, loopback hosts included", async () => {
    const directory = freshPath("data");
    expect(
      (
        await start([
          "--data-dir",
          directory,
          "--storage",
          "pglite",
          "--host",
          "localhost",
          ...bootstrapFlags,
        ])
      ).code,
    ).toBe(0);
    const { code, spawned } = await start(["--data-dir", directory]);

    expect(code).toBe(0);
    expect(spawned[0]?.configuration).toMatchObject({
      storage: "pglite",
      host: "localhost",
    });
    expect(dataFiles(directory)).not.toContain("owner.json");
  });
});
