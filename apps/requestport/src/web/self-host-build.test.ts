import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildSelfHostWeb,
  builtSeamProblems,
  type NextBuildInvocation,
  PLACEHOLDER_PUBLIC_URL,
  SELF_HOST_BUILD_VARIABLE,
  SelfHostBuildError,
  selfHostSeamsPreload,
} from "./self-host-build.js";
import { SELF_HOST_DIST_DIR } from "./self-host-dist-dir.js";

// The bytes apps/web/next-env.d.ts holds in the repository, and what a
// self-host `next build` rewrites it to (H.0b, K1a).
const COMMITTED_NEXT_ENV =
  '/// <reference types="next" />\nimport "./.next/dev/types/routes.d.ts";\n';
const REWRITTEN_NEXT_ENV =
  '/// <reference types="next" />\nimport "./.next-self-host/types/routes.d.ts";\n';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A stand-in for apps/web inside a repository root, under the default
// temporary directory (ruling 152).
function webDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-self-host-build-"));
  directories.push(root);
  const web = join(root, "apps", "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "next-env.d.ts"), COMMITTED_NEXT_ENV);
  return web;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type FakeBuild = {
  exitCode?: number;
  config?: Record<string, unknown>;
  writeServer?: boolean;
  /** server/app-paths-manifest.json's keys; `null` writes no manifest. */
  routes?: string[] | null;
  /** More files of the standalone tree, by their paths from it, and their text. */
  standaloneFiles?: Record<string, string>;
};

// Writes what Next writes for a standalone build in `.next-self-host`, as
// recorded at 16.3.1 (H.0b, K1a): required-server-files.json,
// server/app-paths-manifest.json (the routes it built), the standalone tree
// with its server.js, and static/, which Next does not copy into the
// standalone tree.
function fakeNextBuild(
  web: string,
  invocations: NextBuildInvocation[],
  {
    exitCode = 0,
    config = { distDir: SELF_HOST_DIST_DIR, output: "standalone" },
    writeServer = true,
    routes = [],
    standaloneFiles = {},
  }: FakeBuild = {},
) {
  return async (invocation: NextBuildInvocation): Promise<number> => {
    invocations.push(invocation);
    writeFileSync(join(web, "next-env.d.ts"), REWRITTEN_NEXT_ENV);
    if (exitCode !== 0) return exitCode;
    const dist = join(web, SELF_HOST_DIST_DIR);
    write(
      join(dist, "required-server-files.json"),
      JSON.stringify({
        version: 1,
        config,
        appDir: web,
        relativeAppDir: "apps/web",
        files: [],
      }),
    );
    if (routes !== null) {
      write(
        join(dist, "server", "app-paths-manifest.json"),
        JSON.stringify(
          Object.fromEntries(routes.map((route) => [route, `app${route}.js`])),
        ),
      );
    }
    write(join(dist, "static", "chunks", "main.js"), "main chunk");
    write(join(dist, "static", "css", "app.css"), "body{}");
    const server = join(dist, "standalone", "apps", "web");
    if (writeServer) write(join(server, "server.js"), "// server");
    write(join(server, SELF_HOST_DIST_DIR, "BUILD_ID"), "build-id");
    for (const [path, text] of Object.entries(standaloneFiles)) {
      write(join(dist, "standalone", path), text);
    }
    return 0;
  };
}

describe("buildSelfHostWeb", () => {
  test("runs next build --webpack in apps/web, every route of src/app but the test routes, with the variable, production and placeholders", async () => {
    const web = webDirectory();
    const invocations: NextBuildInvocation[] = [];

    await buildSelfHostWeb({
      webDirectory: web,
      environment: { PATH: "/usr/bin", DATABASE_URL: "postgres://x" },
      runNextBuild: fakeNextBuild(web, invocations),
    });

    expect(invocations).toHaveLength(1);
    const [invocation] = invocations;
    expect(invocation.cwd).toBe(web);
    // .well-known is named: Next's glob passes over a directory whose name
    // begins with a dot, so app/** alone leaves its four routes out
    // (measured with Next 16.3.1's own resolveBuildPaths; H.7, ruling 170).
    expect(invocation.args).toEqual([
      "build",
      "--webpack",
      "--debug-build-paths",
      "app/**,app/.well-known/**,!app/api/test/**",
    ]);
    expect(invocation.env).toMatchObject({
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://x",
      [SELF_HOST_BUILD_VARIABLE]: "1",
      NODE_ENV: "production",
      BETTER_AUTH_URL: PLACEHOLDER_PUBLIC_URL,
      NEXT_PUBLIC_APP_URL: PLACEHOLDER_PUBLIC_URL,
    });
    expect(invocation.env.BETTER_AUTH_SECRET?.length).toBeGreaterThanOrEqual(
      32,
    );
  });

  test("replaces an inherited public URL and secret, and drops an inherited standalone config", async () => {
    const web = webDirectory();
    const invocations: NextBuildInvocation[] = [];

    await buildSelfHostWeb({
      webDirectory: web,
      environment: {
        BETTER_AUTH_URL: "https://requestport.com",
        NEXT_PUBLIC_APP_URL: "https://requestport.com",
        BETTER_AUTH_SECRET: "a-developer's-own-secret-0123456789abcdef",
        NODE_ENV: "test",
        [SELF_HOST_BUILD_VARIABLE]: "0",
        __NEXT_PRIVATE_STANDALONE_CONFIG: '{"distDir":".next"}',
      },
      runNextBuild: fakeNextBuild(web, invocations),
    });

    const { env } = invocations[0];
    expect(env.BETTER_AUTH_URL).toBe(PLACEHOLDER_PUBLIC_URL);
    expect(env.NEXT_PUBLIC_APP_URL).toBe(PLACEHOLDER_PUBLIC_URL);
    expect(env.BETTER_AUTH_SECRET).not.toBe(
      "a-developer's-own-secret-0123456789abcdef",
    );
    expect(env.NODE_ENV).toBe("production");
    expect(env[SELF_HOST_BUILD_VARIABLE]).toBe("1");
    expect(env).not.toHaveProperty("__NEXT_PRIVATE_STANDALONE_CONFIG");
  });

  test("copies static/ into the standalone tree's own distDir and returns where it is", async () => {
    const web = webDirectory();

    const build = await buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, []),
    });

    const server = join(web, SELF_HOST_DIST_DIR, "standalone", "apps", "web");
    expect(build).toEqual({
      distDirectory: join(web, SELF_HOST_DIST_DIR),
      standaloneDirectory: join(web, SELF_HOST_DIST_DIR, "standalone"),
      serverDirectory: server,
      config: { distDir: SELF_HOST_DIST_DIR, output: "standalone" },
    });
    expect(
      readFileSync(
        join(server, SELF_HOST_DIST_DIR, "static", "chunks", "main.js"),
        "utf8",
      ),
    ).toBe("main chunk");
    expect(
      readFileSync(
        join(server, SELF_HOST_DIST_DIR, "static", "css", "app.css"),
        "utf8",
      ),
    ).toBe("body{}");
  });

  test("puts next-env.d.ts back to the bytes it held before the build", async () => {
    const web = webDirectory();

    await buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, []),
    });

    expect(readFileSync(join(web, "next-env.d.ts"), "utf8")).toBe(
      COMMITTED_NEXT_ENV,
    );
  });

  test("removes a next-env.d.ts the build wrote where there was none", async () => {
    const web = webDirectory();
    rmSync(join(web, "next-env.d.ts"));

    await buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, []),
    });

    expect(existsSync(join(web, "next-env.d.ts"))).toBe(false);
  });

  test("puts next-env.d.ts back when the build fails, and names the exit status", async () => {
    const web = webDirectory();

    const failure = buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, [], { exitCode: 1 }),
    });

    await expect(failure).rejects.toThrow(SelfHostBuildError);
    await expect(failure).rejects.toThrow("next build exited with 1");
    expect(readFileSync(join(web, "next-env.d.ts"), "utf8")).toBe(
      COMMITTED_NEXT_ENV,
    );
  });

  test("refuses before building when apps/web/public exists", async () => {
    const web = webDirectory();
    mkdirSync(join(web, "public"));
    const invocations: NextBuildInvocation[] = [];

    await expect(
      buildSelfHostWeb({
        webDirectory: web,
        environment: {},
        runNextBuild: fakeNextBuild(web, invocations),
      }),
    ).rejects.toThrow(/apps\/web\/public exists/);
    expect(invocations).toHaveLength(0);
    expect(existsSync(join(web, SELF_HOST_DIST_DIR))).toBe(false);
  });

  test.each([
    ["not standalone", { distDir: SELF_HOST_DIST_DIR }],
    ["in .next", { distDir: ".next", output: "standalone" }],
  ])("refuses a build whose configuration is %s", async (_label, config) => {
    const web = webDirectory();

    await expect(
      buildSelfHostWeb({
        webDirectory: web,
        environment: {},
        runNextBuild: fakeNextBuild(web, [], { config }),
      }),
    ).rejects.toThrow(/did not take the self-host configuration/);
  });

  test("refuses a standalone tree without server.js", async () => {
    const web = webDirectory();

    await expect(
      buildSelfHostWeb({
        webDirectory: web,
        environment: {},
        runNextBuild: fakeNextBuild(web, [], { writeServer: false }),
      }),
    ).rejects.toThrow(/server\.js/);
  });

  // apps/web's src/app, as the routes below need it: a page, a route under
  // .well-known, a test route with its own test file, and a component.
  function withRoutes(web: string): void {
    for (const path of [
      "src/app/(app)/page.tsx",
      "src/app/.well-known/oauth-authorization-server/route.ts",
      "src/app/api/test/scenarios/route.ts",
      "src/app/api/test/scenarios/route.test.ts",
      "src/app/layout.tsx",
    ]) {
      write(join(web, path), "export {};\n");
    }
  }

  test("accepts a build that holds every route of src/app but the test routes, and Next's own", async () => {
    const web = webDirectory();
    withRoutes(web);

    await expect(
      buildSelfHostWeb({
        webDirectory: web,
        environment: {},
        runNextBuild: fakeNextBuild(web, [], {
          routes: [
            "/(app)/page",
            "/.well-known/oauth-authorization-server/route",
            "/_not-found/page",
            "/_global-error/page",
          ],
        }),
      }),
    ).resolves.toMatchObject({ distDirectory: join(web, SELF_HOST_DIST_DIR) });
  });

  test("refuses a build that lacks a route of src/app, or holds a test route, naming each (ruling 170)", async () => {
    const web = webDirectory();
    withRoutes(web);

    const refused = buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, [], {
        routes: [
          "/(app)/page",
          "/api/test/scenarios/route",
          "/_not-found/page",
        ],
      }),
    });

    await expect(refused).rejects.toThrow(SelfHostBuildError);
    await expect(refused).rejects.toThrow(
      [
        "the self-host build's routes are not apps/web's without its test routes:",
        "- it lacks /.well-known/oauth-authorization-server/route, which src/app defines",
        "- it holds /api/test/scenarios/route, under api/test, which it leaves out",
      ].join("\n"),
    );
  });

  test("refuses a build with no server/app-paths-manifest.json, whose routes it cannot read", async () => {
    const web = webDirectory();

    await expect(
      buildSelfHostWeb({
        webDirectory: web,
        environment: {},
        runNextBuild: fakeNextBuild(web, [], { routes: null }),
      }),
    ).rejects.toThrow(/app-paths-manifest\.json/);
  });
});

describe("the test seams, left out of the self-host build (ruling 174)", () => {
  test("next build is preloaded with self-host-seams.ts beside this module, which gives apps/web's configuration the inert seams in that process alone", async () => {
    const web = webDirectory();
    const invocations: NextBuildInvocation[] = [];

    await buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, invocations),
    });

    expect(selfHostSeamsPreload()).toBe(
      pathToFileURL(join(import.meta.dirname, "self-host-seams.ts")).href,
    );
    expect(invocations[0].execArgv).toEqual([
      "--import",
      selfHostSeamsPreload(),
    ]);
  });

  test("refuses a build whose standalone tree holds a seam's marker, naming each file, seam and marker; node_modules is not read", async () => {
    const web = webDirectory();

    const built = buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, [], {
        standaloneFiles: {
          "apps/web/.next-self-host/server/chunks/1.js":
            'Symbol.for("requestport.e2e.scenario-runs")',
          "apps/web/.next-self-host/server/middleware.js":
            "a.REQUESTPORT_E2E_MODE",
          "node_modules/next/dist/x.js": "REQUESTPORT_E2E_TOKEN",
        },
      }),
    });

    await expect(built).rejects.toThrow(SelfHostBuildError);
    await expect(built).rejects.toThrow(
      "the self-host build carries a test seam (ruling 174):\n" +
        "- apps/web/.next-self-host/server/chunks/1.js holds apps/web's scenario-fault register (requestport.e2e.scenario-runs)\n" +
        "- apps/web/.next-self-host/server/middleware.js holds auth's E2E magic-link outbox (REQUESTPORT_E2E_MODE)",
    );
  });

  test("builtSeamProblems reads the standalone tree, static/ included, and answers nothing for a build without a marker", async () => {
    const web = webDirectory();
    await buildSelfHostWeb({
      webDirectory: web,
      environment: {},
      runNextBuild: fakeNextBuild(web, []),
    });
    expect(await builtSeamProblems(web)).toEqual([]);

    writeFileSync(
      join(
        web,
        SELF_HOST_DIST_DIR,
        "standalone/apps/web",
        SELF_HOST_DIST_DIR,
        "static/chunks/main.js",
      ),
      "packages/server/src/e2e-csp-fence.ts",
    );
    expect(await builtSeamProblems(web)).toEqual([
      "apps/web/.next-self-host/static/chunks/main.js holds the CSP's E2E fence (packages/server/src/e2e-csp-fence.ts)",
    ]);
  });
});
