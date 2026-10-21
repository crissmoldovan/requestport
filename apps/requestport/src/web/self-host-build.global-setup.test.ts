import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  E2E_INPUTS,
  newestInput,
  SELF_HOST_BUILD_INPUTS,
  staleness,
} from "./self-host-build.global-setup.js";
import { SELF_HOST_DIST_DIR } from "./self-host-dist-dir.js";
import { TEST_SEAMS } from "./test-seams.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A stand-in for apps/web, under the default temporary directory (ruling
 * 152), holding a self-host build as `staleness` reads one: `BUILD_ID`, the
 * standalone tree `locateSelfHostWeb` accepts, and, unless `routes` is
 * `null`, `server/app-paths-manifest.json` with `routes` as its keys. Its
 * `src/app` has a page, a route under `.well-known`, a test route with its
 * own test file, and a layout.
 */
function webWithBuild(routes: string[] | null): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-self-host-staleness-"));
  directories.push(root);
  const web = join(root, "apps", "web");
  for (const path of [
    "src/app/(app)/page.tsx",
    "src/app/.well-known/oauth-authorization-server/route.ts",
    "src/app/api/test/scenarios/route.ts",
    "src/app/api/test/scenarios/route.test.ts",
    "src/app/layout.tsx",
  ]) {
    write(join(web, path), "export {};\n");
  }
  const dist = join(web, SELF_HOST_DIST_DIR);
  write(join(dist, "BUILD_ID"), "build-id");
  if (routes !== null) {
    write(
      join(dist, "server", "app-paths-manifest.json"),
      JSON.stringify(
        Object.fromEntries(routes.map((route) => [route, `app${route}.js`])),
      ),
    );
  }
  const server = join(dist, "standalone", "apps", "web");
  write(join(server, "server.js"), "// server");
  write(
    join(server, SELF_HOST_DIST_DIR, "required-server-files.json"),
    JSON.stringify({
      config: { output: "standalone", distDir: SELF_HOST_DIST_DIR },
    }),
  );
  mkdirSync(join(server, SELF_HOST_DIST_DIR, "static"), { recursive: true });
  return web;
}

/** No input is newer than any build. */
const inputsOlder = async () => ({ input: E2E_INPUTS, ms: 0 });

/**
 * A checkout under the default temporary directory that holds none of
 * `--e2e`'s inputs, so their newest time is 0 and `newestInput` answers what
 * the reader it is handed says of `SELF_HOST_BUILD_INPUTS`.
 */
function emptyCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "requestport-self-host-inputs-"));
  directories.push(root);
  return root;
}

const CURRENT_ROUTES = [
  "/(app)/page",
  "/.well-known/oauth-authorization-server/route",
  "/_not-found/page",
];

describe("the integration project's global setup: staleness", () => {
  test("a build whose routes are src/app's without the test routes, with no input newer, is current", async () => {
    const web = webWithBuild(CURRENT_ROUTES);

    await expect(staleness(web, inputsOlder)).resolves.toBeUndefined();
  });

  test("a build older than an input is stale, naming the input", async () => {
    const web = webWithBuild(CURRENT_ROUTES);

    await expect(
      staleness(web, async () => ({
        input: "apps/web/src/app/layout.tsx",
        ms: Date.now() + 60_000,
      })),
    ).resolves.toMatch(
      /^apps\/web\/src\/app\/layout\.tsx is newer than it \(/u,
    );
  });

  test("a build older than one of requestport's own inputs is stale, naming it: newestInput reads each of SELF_HOST_BUILD_INPUTS' times through the reader it is handed (ruling 190, minor 1)", async () => {
    const web = webWithBuild(CURRENT_ROUTES);
    const root = emptyCheckout();
    const loader = "apps/requestport/src/web/inert-seam-loader.cjs";
    const read: string[] = [];
    const inputTime = (path: string) => {
      read.push(path);
      return path === join(root, loader) ? Date.now() + 60_000 : 0;
    };

    await expect(
      staleness(web, () => newestInput(root, inputTime)),
    ).resolves.toMatch(
      /^apps\/requestport\/src\/web\/inert-seam-loader\.cjs is newer than it \(/u,
    );
    expect(read).toEqual(
      SELF_HOST_BUILD_INPUTS.map((input) => join(root, input)),
    );
  });

  test("a build older than --e2e's newest input is stale, naming --e2e's inputs; with every input older, it is current", async () => {
    const web = webWithBuild(CURRENT_ROUTES);
    const root = emptyCheckout();
    const config = join(root, "apps", "web", "next.config.ts");
    write(config, "export default {};\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(config, future, future);

    await expect(
      staleness(web, () => newestInput(root, () => 0)),
    ).resolves.toMatch(
      /^the newest of --e2e's inputs \(.*\) is newer than it \(/u,
    );
    const past = new Date(Date.now() - 60_000);
    utimesSync(config, past, past);
    await expect(
      staleness(web, () => newestInput(root, () => 0)),
    ).resolves.toBeUndefined();
  });

  test("a build that holds a test route is stale, naming it, however new it is: one made before the self-host build left the test routes out is made again", async () => {
    const web = webWithBuild([...CURRENT_ROUTES, "/api/test/scenarios/route"]);

    await expect(staleness(web, inputsOlder)).resolves.toBe(
      "its routes are not apps/web's without its test routes: it holds /api/test/scenarios/route, under api/test, which it leaves out",
    );
  });

  test("a build that lacks a route of src/app is stale, naming it", async () => {
    const web = webWithBuild(["/(app)/page", "/_not-found/page"]);

    await expect(staleness(web, inputsOlder)).resolves.toBe(
      "its routes are not apps/web's without its test routes: it lacks /.well-known/oauth-authorization-server/route, which src/app defines",
    );
  });

  test("a build with no server/app-paths-manifest.json is stale, since its routes cannot be read", async () => {
    const web = webWithBuild(null);

    await expect(staleness(web, inputsOlder)).resolves.toMatch(
      /app-paths-manifest\.json, so its routes cannot be read$/u,
    );
  });

  test("a build that holds a test seam's marker is stale, naming it, however new it is: one made before requestport's builds left the seams out is made again (ruling 174)", async () => {
    const web = webWithBuild(CURRENT_ROUTES);
    write(
      join(
        web,
        SELF_HOST_DIST_DIR,
        "standalone/apps/web",
        SELF_HOST_DIST_DIR,
        "server/chunks/7770.js",
      ),
      'Symbol.for("requestport.e2e.magic-link-outbox")',
    );

    await expect(staleness(web, inputsOlder)).resolves.toBe(
      "it carries a test seam: apps/web/.next-self-host/server/chunks/7770.js holds auth's E2E magic-link outbox (requestport.e2e.magic-link-outbox)",
    );
  });

  test("the inputs it judges a build by include requestport's own: the build's modules, its preload, the seams' module, the loader the build runs, the recorder the preload imports, and each inert module (ruling 174; ruling 190, minor 1; ruling 197 item 4)", () => {
    expect(SELF_HOST_BUILD_INPUTS).toEqual([
      "apps/requestport/src/web/self-host-build.ts",
      "apps/requestport/src/web/self-host-dist-dir.ts",
      "apps/requestport/src/web/self-host-seams.ts",
      "apps/requestport/src/web/test-seams.ts",
      "apps/requestport/src/web/inert-seam-loader.cjs",
      "apps/requestport/src/web/contained-modules.ts",
      ...TEST_SEAMS.map(({ inert }) => inert),
    ]);
  });
});
