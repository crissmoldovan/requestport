import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import {
  defaultSelfHostWebDirectory,
  locateSelfHostWeb,
  prepareWebUi,
  SelfHostWebError,
  selfHostWebRemedy,
} from "./web.js";

/*
 * The web UI's loader (manifest-h.md §2.7.1; H.5's slice e): finding the
 * self-host build, and starting Next from it. Each build here is a fixture
 * in this run's default temporary directory (ruling 152), with a `next` of
 * its own that records how it was loaded and called. Next itself, from a
 * real build, is `web-ui.integration.test.ts`'s.
 */

const scratch = mkdtempSync(join(tmpdir(), "requestport-web-ui-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const VARIABLE = "__NEXT_PRIVATE_STANDALONE_CONFIG";
/** The variable Next reads its server-action key from (ruling 201 item 4). */
const KEY_VARIABLE = "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY";
/** A server-action key, as `../server-action-key.ts` makes one: base64 of 32 bytes. */
const KEY = Buffer.alloc(32, 5).toString("base64");
const RECORD = Symbol.for("requestport.test.fake-next");
const SELF_HOST_CONFIG = {
  distDir: ".next-self-host",
  output: "standalone",
  probe: "the build's own configuration",
};

type FakeNextRecord = {
  variableAtLoad: string | undefined;
  keyAtLoad: string | undefined;
  options: unknown[];
  calls: string[];
  handled: string[];
  /** The headers of each request the fake's handler was handed, as it saw them. */
  handledHeaders: Record<string, unknown>[];
};

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[RECORD];
});

let builds = 0;
/** A standalone `apps/web` fixture, with what `parts` names. */
function fixture(
  parts: {
    server?: boolean;
    serverFiles?: unknown;
    statics?: boolean;
    next?: "function" | "default";
  } = {},
) {
  builds += 1;
  const directory = join(scratch, `build ${builds}`, "apps", "web");
  mkdirSync(join(directory, ".next-self-host"), { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"name":"web"}');
  if (parts.server !== false) writeFileSync(join(directory, "server.js"), "");
  if (parts.serverFiles !== undefined) {
    writeFileSync(
      join(directory, ".next-self-host", "required-server-files.json"),
      typeof parts.serverFiles === "string"
        ? parts.serverFiles
        : JSON.stringify(parts.serverFiles),
    );
  }
  if (parts.statics !== false) {
    mkdirSync(join(directory, ".next-self-host", "static"));
  }
  if (parts.next !== undefined) {
    const next = join(directory, "node_modules", "next");
    mkdirSync(next, { recursive: true });
    writeFileSync(
      join(next, "package.json"),
      '{"name":"next","main":"index.js"}',
    );
    writeFileSync(
      join(next, "index.js"),
      `const record = globalThis[Symbol.for("requestport.test.fake-next")];
record.variableAtLoad = process.env.${VARIABLE};
record.keyAtLoad = process.env.${KEY_VARIABLE};
function next(options) {
  record.options.push(options);
  record.calls.push("next");
  return {
    getRequestHandler() {
      record.calls.push("getRequestHandler");
      return async (incoming, outgoing) => {
        record.handled.push(incoming.url);
        record.handledHeaders.push({ ...incoming.headers });
        outgoing.end("from the fake next");
      };
    },
    async prepare() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record.calls.push("prepare settled");
    },
    async close() {
      record.calls.push("close");
    },
  };
}
module.exports = ${parts.next === "default" ? "{ default: next }" : "next"};
`,
    );
    mkdirSync(join(next, "dist", "server"), { recursive: true });
    mkdirSync(join(next, "dist", "shared", "lib"), { recursive: true });
    writeFileSync(
      join(next, "dist", "server", "config.js"),
      `const record = globalThis[Symbol.for("requestport.test.fake-next")];
exports.default = async function loadConfig(phase, dir, options) {
  record.calls.push(
    \`loadConfig \${phase} \${dir} silent=\${options.silent} variable=\${process.env.${VARIABLE} !== undefined}\`,
  );
  return {};
};
`,
    );
    writeFileSync(
      join(next, "dist", "shared", "lib", "constants.js"),
      'exports.PHASE_PRODUCTION_SERVER = "phase-production-server";\n',
    );
  }
  return directory;
}

const complete = () =>
  fixture({ serverFiles: { config: SELF_HOST_CONFIG }, next: "function" });

describe("locateSelfHostWeb", () => {
  test("finds the build in apps/web's standalone tree in this repository unless it is told another", () => {
    expect(defaultSelfHostWebDirectory()).toBe(
      join(
        import.meta.dirname,
        "../../../web/.next-self-host/standalone/apps/web",
      ),
    );
  });

  test("from a module in the repository (.ts), the default is apps/web's standalone tree; packed (.js, in dist/), it is the directory of @requestport/web, which requestport depends on, as dist/ resolves its package.json (ruling 193 item 4)", () => {
    expect(
      defaultSelfHostWebDirectory(
        pathToFileURL(join(import.meta.dirname, "web.ts")).href,
      ),
    ).toBe(defaultSelfHostWebDirectory());
    // An install of the two packages, as npm lays them out: requestport's
    // dist/ (no file of it needs to exist to resolve from it) and
    // @requestport/web beside it. Node resolves through symbolic links, so
    // the answer is the real path (macOS's temporary directory is under one).
    const modules = join(scratch, "install", "node_modules");
    const web = join(modules, "@requestport", "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "package.json"), '{"name":"@requestport/web"}\n');
    const chunk = pathToFileURL(
      join(modules, "requestport", "dist", "chunk-ABC.js"),
    ).href;
    expect(defaultSelfHostWebDirectory(chunk)).toBe(realpathSync(web));
    expect(defaultSelfHostWebDirectory(chunk)).not.toBe(
      join(modules, "requestport", "web"),
    );
    expect(() =>
      defaultSelfHostWebDirectory("file:///opt/requestport/dist/web.mjs"),
    ).toThrow("neither the repository's TypeScript (.ts) nor the packed");
  });

  test("packed, where dist/ cannot resolve @requestport/web, it refuses with a SelfHostWebError that names the package and how to put it back", () => {
    const chunk = pathToFileURL(
      join(scratch, "bare", "node_modules", "requestport", "dist", "c.js"),
    ).href;
    // In a process of its own without NODE_PATH, as npm runs a package's
    // bin: this one runs under pnpm's shim for vitest, whose NODE_PATH holds
    // the workspace's hoisted packages, @requestport/web among them, where
    // Node looks when no node_modules above a module holds a package.
    const { NODE_PATH: _ignored, ...environment } = process.env;
    const script = [
      `import { defaultSelfHostWebDirectory, SelfHostWebError } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "web.ts")).href)};`,
      "try {",
      `  console.log(JSON.stringify({ answered: defaultSelfHostWebDirectory(${JSON.stringify(chunk)}) }));`,
      "} catch (error) {",
      "  console.log(JSON.stringify({ refused: error instanceof SelfHostWebError, message: error.message }));",
      "}",
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: join(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: environment,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const answer = JSON.parse(child.stdout) as {
      refused?: boolean;
      message?: string;
    };
    expect(answer.refused).toBe(true);
    expect(answer.message).toMatch(
      /^requestport start serves the web UI from @requestport\/web, and .+ cannot resolve it \(Cannot find module '@requestport\/web\/package\.json'.*\)\. requestport depends on @requestport\/web, which carries it; install requestport again\.$/u,
    );
  });

  test("names how to make the build in the repository, and that @requestport/web carries it when packed", () => {
    expect(
      selfHostWebRemedy(
        pathToFileURL(join(import.meta.dirname, "web.ts")).href,
      ),
    ).toBe(
      "Build it with apps/requestport/src/web/self-host-build.ts's buildSelfHostWeb (next build --webpack in apps/web with REQUESTPORT_SELF_HOST_BUILD=1).",
    );
    expect(
      selfHostWebRemedy(
        "file:///opt/npx/node_modules/requestport/dist/chunk-ABC.js",
      ),
    ).toBe(
      "requestport depends on @requestport/web, which carries it; install requestport again.",
    );
  });

  test("answers the directory and the configuration the build was made with", () => {
    const directory = complete();

    expect(locateSelfHostWeb(directory)).toEqual({
      directory,
      config: SELF_HOST_CONFIG,
    });
  });

  test("refuses a directory with no build in it, by its name, naming the directory and how to build one", () => {
    const directory = fixture({
      server: false,
      serverFiles: { config: SELF_HOST_CONFIG },
    });

    let refusal: unknown;
    try {
      locateSelfHostWeb(directory);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SelfHostWebError);
    expect((refusal as Error).name).toBe("SelfHostWebError");
    expect((refusal as Error).message).toBe(
      `requestport start serves the web UI from the self-host build, and there is none at ${directory} (no server.js). Build it with apps/requestport/src/web/self-host-build.ts's buildSelfHostWeb (next build --webpack in apps/web with REQUESTPORT_SELF_HOST_BUILD=1).`,
    );
  });

  test.each([
    ["absent", undefined, "is missing or does not parse"],
    ["unparsable", "{", "is missing or does not parse"],
    [
      "a .next build's",
      { config: { distDir: ".next" } },
      'it says output undefined and distDir ".next"',
    ],
    [
      "a standalone build in another distDir",
      { config: { output: "standalone", distDir: ".next" } },
      'it says output "standalone" and distDir ".next"',
    ],
    ["without a config", {}, "it says output undefined and distDir undefined"],
  ])(
    "refuses a build whose required-server-files.json is %s",
    (_label, serverFiles, said) => {
      const directory = fixture({
        ...(serverFiles === undefined ? {} : { serverFiles }),
      });

      expect(() => locateSelfHostWeb(directory)).toThrow(SelfHostWebError);
      expect(() => locateSelfHostWeb(directory)).toThrow(said);
    },
  );

  test("refuses a build whose static assets were not copied in", () => {
    const directory = fixture({
      serverFiles: { config: SELF_HOST_CONFIG },
      statics: false,
    });

    expect(() => locateSelfHostWeb(directory)).toThrow(
      `its static assets were not copied in beside it (${join(directory, ".next-self-host", "static")})`,
    );
  });
});

describe("prepareWebUi", () => {
  function record(): FakeNextRecord {
    const fresh: FakeNextRecord = {
      variableAtLoad: undefined,
      keyAtLoad: undefined,
      options: [],
      calls: [],
      handled: [],
      handledHeaders: [],
    };
    (globalThis as Record<symbol, unknown>)[RECORD] = fresh;
    return fresh;
  }

  test.each(["function", "default"] as const)(
    "sets the private variable to the build's configuration, and NEXT_SERVER_ACTIONS_ENCRYPTION_KEY to the server-action key it is handed, before it loads next from the build's tree (next exported as a %s), loads Next's configuration silently, then calls next, getRequestHandler and prepare once each, in that order",
    async (shape) => {
      vi.stubEnv(VARIABLE, undefined);
      vi.stubEnv(KEY_VARIABLE, undefined);
      const seen = record();
      const directory = fixture({
        serverFiles: { config: SELF_HOST_CONFIG },
        next: shape,
      });

      const web = await prepareWebUi(locateSelfHostWeb(directory), {
        hostname: "127.0.0.1",
        port: 4321,
        serverActionKey: KEY,
      });

      expect(seen.variableAtLoad).toBe(JSON.stringify(SELF_HOST_CONFIG));
      expect(process.env[VARIABLE]).toBe(JSON.stringify(SELF_HOST_CONFIG));
      expect(seen.keyAtLoad).toBe(KEY);
      expect(process.env[KEY_VARIABLE]).toBe(KEY);
      expect(seen.options).toEqual([
        { dev: false, dir: directory, hostname: "127.0.0.1", port: 4321 },
      ]);
      // Next's configuration loaded once, silently, before Next is made, so
      // the router's own load is a cache hit and writes nothing.
      expect(seen.calls).toEqual([
        `loadConfig phase-production-server ${directory} silent=true variable=true`,
        "next",
        "getRequestHandler",
        "prepare settled",
      ]);

      const answered: string[] = [];
      await web.handle(
        { url: "/sign-in", headers: {} } as never,
        { end: (text: string) => answered.push(text) } as never,
      );
      expect(seen.handled).toEqual(["/sign-in"]);
      expect(answered).toEqual(["from the fake next"]);

      await web.close();
      expect(seen.calls.at(-1)).toBe("close");
    },
  );

  test("writes both variables into the environment it is handed", async () => {
    vi.stubEnv(VARIABLE, undefined);
    vi.stubEnv(KEY_VARIABLE, undefined);
    record();
    const env: NodeJS.ProcessEnv = {};

    await prepareWebUi(locateSelfHostWeb(complete()), {
      hostname: "127.0.0.1",
      port: 1,
      serverActionKey: KEY,
      env,
    });

    expect(env[VARIABLE]).toBe(JSON.stringify(SELF_HOST_CONFIG));
    expect(env[KEY_VARIABLE]).toBe(KEY);
    expect(process.env[VARIABLE]).toBeUndefined();
    expect(process.env[KEY_VARIABLE]).toBeUndefined();
  });

  test("removes x-prerender-revalidate and x-prerender-revalidate-if-generated from each request before Next's handler is handed it, and leaves its other headers (ruling 202 item 1)", async () => {
    const seen = record();
    const web = await prepareWebUi(locateSelfHostWeb(complete()), {
      hostname: "127.0.0.1",
      port: 1,
      serverActionKey: KEY,
      env: {},
    });
    const kept = {
      host: "127.0.0.1:1",
      cookie: "a=b",
      "x-forwarded-for": "127.0.0.1",
    };

    for (const headers of [
      {
        ...kept,
        "x-prerender-revalidate": "0123456789abcdef0123456789abcdef",
        "x-prerender-revalidate-if-generated": "1",
      },
      { ...kept, "x-prerender-revalidate": "0123456789abcdef0123456789abcdef" },
      { ...kept },
    ]) {
      await web.handle(
        { url: "/sign-in", headers } as never,
        { end: () => undefined } as never,
      );
    }

    expect(seen.handledHeaders).toEqual([kept, kept, kept]);
  });
});
