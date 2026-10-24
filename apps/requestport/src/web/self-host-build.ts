import { spawn } from "node:child_process";
import { cp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize, relative } from "node:path";

import { SELF_HOST_DIST_DIR } from "./self-host-dist-dir.ts";
import { seamMarkersIn } from "./test-seams.ts";

/**
 * The self-host build of apps/web (Plan 13, H.5; manifest-h.md §2.7.1): Next's
 * standalone output, which `requestport start` serves beside the host.
 *
 * `apps/web/next.config.ts` adds `output: "standalone"` and its own distDir
 * only when this variable is exactly `1`; without it Vercel's build is
 * unchanged. The build lands in `apps/web/.next-self-host`
 * (`SELF_HOST_DIST_DIR`, `self-host-dist-dir.ts`), never in
 * `apps/web/.next`, which `--e2e` would otherwise serve.
 */
export const SELF_HOST_BUILD_VARIABLE = "REQUESTPORT_SELF_HOST_BUILD";

/**
 * The public URL the build is made with. Nothing built carries it (H.0b,
 * K1a): `requestport start` serves the build at whatever URL it is given.
 */
export const PLACEHOLDER_PUBLIC_URL = "https://placeholder.requestport.invalid";
const PLACEHOLDER_SECRET = "requestport-self-host-build-placeholder-secret";

/**
 * Next reads this before next.config.ts (`next/dist/server/config.js`, pinned
 * by `standalone-config.test.ts`), so an inherited value would build with that
 * configuration instead of the file's.
 */
const STANDALONE_CONFIG_VARIABLE = "__NEXT_PRIVATE_STANDALONE_CONFIG";

export type NextBuildInvocation = {
  /** Arguments to Next's CLI. */
  args: string[];
  /** Node's own options, before Next's CLI: the preload (`selfHostSeamsPreload`). */
  execArgv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Runs Next's CLI and answers its exit status. */
export type NextBuildRunner = (
  invocation: NextBuildInvocation,
) => Promise<number | null>;

export type SelfHostBuildOptions = {
  /** apps/web's directory. */
  webDirectory: string;
  /** What the build inherits, before the build's own variables. */
  environment?: NodeJS.ProcessEnv;
  runNextBuild?: NextBuildRunner;
};

export type SelfHostBuild = {
  /** `apps/web/.next-self-host`. */
  distDirectory: string;
  /** `apps/web/.next-self-host/standalone`. */
  standaloneDirectory: string;
  /**
   * Where `server.js` is in the standalone tree, beside the build's own
   * `.next-self-host` (with `static/` copied in).
   */
  serverDirectory: string;
  /**
   * `required-server-files.json`'s `config`: the object manifest-h.md §2.7.1
   * has the host set as `__NEXT_PRIVATE_STANDALONE_CONFIG` before it loads
   * `next`. `requestport start` reads the same object itself, from the build
   * on disk (`../serve/web.ts`: `locateSelfHostWeb` reads it, and
   * `prepareWebUi` sets it). This value is answered for a caller of the
   * build step that wants it: the integration project's global setup
   * discards it, and only this module's test reads it.
   */
  config: Record<string, unknown>;
};

/**
 * The routes of apps/web the self-host build leaves out, as directories of
 * `src/app`: its test routes, `api/test/scenarios` (the E2E scenario hook)
 * and `api/test/email-outbox` (the route that reads auth's fake e-mail
 * outbox). Ruling 170 refuses these two routes and the E2E owner storage in
 * `requestport`'s tarball, and `scripts/pack-requestport.mjs` refuses them in
 * `@requestport/web`'s, which carries this build (ruling 193 item 4). Left
 * out of Next's route discovery, their modules
 * are not compiled. In apps/web only the scenario hook imports the E2E owner
 * storage (through `src/lib/e2e-owner-storage.ts`), and a build without
 * these routes holds it in no file (measured on the real build, H.7, ruling
 * 170's round).
 *
 * Only these routes, and what only they import, are left out by this list.
 * Three other pieces of E2E code, each acting only in E2E mode, are left
 * out by `selfHostSeamsPreload` instead (ruling 174): auth's magic-link
 * outbox, apps/web's scenario-fault register and the CSP's E2E fence, each
 * built from an inert module (`test-seams.ts`).
 */
export const SELF_HOST_LEFT_OUT = Object.freeze(["api/test"]);

/**
 * `next build`'s `--debug-build-paths` (Next 16.4.2: `dist/bin/next:114`
 * names it, and `dist/lib/resolve-build-paths.js` differs from 16.3.8's, which
 * was 16.3.1's byte for byte, only in how its pattern error is thrown,
 * without Next's error code), which filters the route files (`page`,
 * `route`) Next discovers under `app/`; layouts and `default` files are not
 * filtered. The patterns: every route under `app/`, and
 * `app/.well-known/` named too, because Next's glob passes over a directory
 * whose name begins with a dot (with `app/**` alone its four routes are left
 * out, measured with Next's own `resolveBuildPaths`); then each of
 * `SELF_HOST_LEFT_OUT` excluded. Next type-checks the whole project either
 * way (its build says so). `buildSelfHostWeb` refuses a build whose routes
 * are not the source's but these, so a pattern that dropped a route would not
 * pass unseen.
 */
export const SELF_HOST_BUILD_PATHS = [
  "app/**",
  "app/.well-known/**",
  ...SELF_HOST_LEFT_OUT.map((directory) => `!app/${directory}/**`),
].join(",");

/**
 * The module `buildSelfHostWeb` preloads into `next build` (`node --import`;
 * ruling 174), as a URL: `self-host-seams.ts`, beside this module. In that
 * process alone it gives apps/web's configuration, as Next loads it, the
 * webpack plugin that builds each test seam's real module from its inert one,
 * and each of `db`'s private modules from its public variant (ruling 193 item 5;
 * `test-seams.ts`'s `selfHostReplacements`). apps/web/next.config.ts is not
 * changed. A function, not a constant, so that importing this module
 * computes nothing of it.
 */
export function selfHostSeamsPreload(): string {
  return new URL("./self-host-seams.ts", import.meta.url).href;
}

/** A route module of the app router: a `page` or a `route`, by Next's default page extensions. */
const ROUTE_FILE = /^(?:page|route)\.(?:tsx|ts|jsx|js)$/u;

/**
 * The routes `src/app` under `webDirectory` defines, as Next keys them in
 * `server/app-paths-manifest.json`: the module's path from `app/`, without
 * its extension (`/(app)/page`, `/.well-known/openid-configuration/route`).
 * Every directory is read, those whose names begin with a dot included; a
 * test file (`route.test.ts`) is not a route module.
 */
export async function sourceRoutes(webDirectory: string): Promise<string[]> {
  const app = join(webDirectory, "src", "app");
  if (!(await exists(app))) return [];
  const routes: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(app, relative), {
      withFileTypes: true,
    })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (ROUTE_FILE.test(entry.name)) {
        routes.push(path.replace(/\.(?:tsx|ts|jsx|js)$/u, ""));
      }
    }
  };
  await walk("");
  return routes.sort();
}

/**
 * What is wrong with the routes a self-host build holds (`built`, its
 * manifest's keys) against `source`'s: a route of the source outside
 * `SELF_HOST_LEFT_OUT` that the build lacks, and a route the build holds
 * under one of them. Next's own routes (`/_not-found/page`,
 * `/_global-error/page`) are not the source's, and are not judged.
 */
export function routeProblems(
  source: readonly string[],
  built: readonly string[],
): string[] {
  const leftOut = (route: string) =>
    SELF_HOST_LEFT_OUT.find((directory) => route.startsWith(`/${directory}/`));
  const problems: string[] = [];
  for (const route of source) {
    if (leftOut(route) === undefined && !built.includes(route)) {
      problems.push(`it lacks ${route}, which src/app defines`);
    }
  }
  for (const route of built) {
    const directory = leftOut(route);
    if (directory !== undefined) {
      problems.push(
        `it holds ${route}, under ${directory}, which it leaves out`,
      );
    }
  }
  return problems;
}

export class SelfHostBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfHostBuildError";
  }
}

/**
 * `routeProblems` for the self-host build on disk in `webDirectory`'s
 * `SELF_HOST_DIST_DIR`: the keys of its `server/app-paths-manifest.json`
 * against `src/app`'s routes. A build without that manifest is refused
 * (`SelfHostBuildError`), because its routes cannot be read. Both
 * `buildSelfHostWeb`, after it builds, and the integration project's global
 * setup, before it reuses a build, judge the build by it.
 */
export async function builtRouteProblems(
  webDirectory: string,
): Promise<string[]> {
  const routesManifest = join(
    webDirectory,
    SELF_HOST_DIST_DIR,
    "server",
    "app-paths-manifest.json",
  );
  const built = await readFile(routesManifest, "utf8").then(
    (text) => Object.keys(JSON.parse(text) as Record<string, unknown>),
    () => {
      throw new SelfHostBuildError(
        `the build wrote no ${routesManifest}, so its routes cannot be read`,
      );
    },
  );
  return routeProblems(await sourceRoutes(webDirectory), built);
}

/**
 * Each test seam's marker (`test-seams.ts`, `seamMarkersIn`) a file of the
 * self-host build's standalone tree holds, `static/` included and every
 * `node_modules` left out (`@requestport/web` carries the tree's
 * `apps/web`, without its `node_modules`). Each is
 * named by its path from the standalone tree. A tree that is not there holds
 * none. Both `buildSelfHostWeb`, after it builds, and the integration
 * project's global setup, before it reuses a build, judge the build by it.
 */
export async function builtSeamProblems(
  webDirectory: string,
): Promise<string[]> {
  const standalone = join(webDirectory, SELF_HOST_DIST_DIR, "standalone");
  if (!(await exists(standalone))) return [];
  const problems: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(path);
      } else if (entry.isFile()) {
        const text = (await readFile(path)).toString("latin1");
        for (const { seam, marker } of seamMarkersIn(text)) {
          problems.push(
            `${relative(standalone, path)} holds ${seam.name} (${marker})`,
          );
        }
      }
    }
  };
  await walk(standalone);
  return problems;
}

/**
 * `next build --webpack` in apps/web as the self-host build, every route of
 * `src/app` but `SELF_HOST_LEFT_OUT`'s (`SELF_HOST_BUILD_PATHS`), with
 * `selfHostSeamsPreload()` preloaded (the inert seams, and `db`'s private
 * module's public variant, whose absence `scripts/pack-requestport.mjs`
 * checks in `@requestport/web`'s tarball), then the static copy Next leaves
 * out of the standalone tree. It refuses a build whose routes
 * (`server/app-paths-manifest.json`) are not the source's without the test
 * routes (`routeProblems`), and then one that carries a test seam
 * (`builtSeamProblems`). apps/web/next-env.d.ts, which
 * the build rewrites to point at the distDir's types, is put back as it was
 * before (its bytes, or absent), whether the build passed or not (ruling 143),
 * so this works where no git checkout exists.
 */
export async function buildSelfHostWeb({
  webDirectory,
  environment = process.env,
  runNextBuild = runNextCli,
}: SelfHostBuildOptions): Promise<SelfHostBuild> {
  if (await exists(join(webDirectory, "public"))) {
    throw new SelfHostBuildError(
      `apps/web/public exists (${join(webDirectory, "public")}): the self-host build copies only ${SELF_HOST_DIST_DIR}/static into the standalone tree, so nothing would serve public/.`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...environment,
    [SELF_HOST_BUILD_VARIABLE]: "1",
    NODE_ENV: "production",
    BETTER_AUTH_URL: PLACEHOLDER_PUBLIC_URL,
    NEXT_PUBLIC_APP_URL: PLACEHOLDER_PUBLIC_URL,
    BETTER_AUTH_SECRET: PLACEHOLDER_SECRET,
  };
  delete env[STANDALONE_CONFIG_VARIABLE];

  const nextEnvPath = join(webDirectory, "next-env.d.ts");
  const nextEnv = await readFile(nextEnvPath).catch(() => null);
  let status: number | null;
  try {
    status = await runNextBuild({
      args: [
        "build",
        "--webpack",
        "--debug-build-paths",
        SELF_HOST_BUILD_PATHS,
      ],
      execArgv: ["--import", selfHostSeamsPreload()],
      cwd: webDirectory,
      env,
    });
  } finally {
    await restore(nextEnvPath, nextEnv);
  }
  if (status !== 0) {
    throw new SelfHostBuildError(
      `next build exited with ${status ?? "a signal"}`,
    );
  }

  const distDirectory = join(webDirectory, SELF_HOST_DIST_DIR);
  const serverFiles = JSON.parse(
    await readFile(join(distDirectory, "required-server-files.json"), "utf8"),
  ) as { config?: Record<string, unknown>; relativeAppDir?: unknown };
  const config = serverFiles.config ?? {};
  if (config.output !== "standalone" || config.distDir !== SELF_HOST_DIST_DIR) {
    throw new SelfHostBuildError(
      `the build did not take the self-host configuration: required-server-files.json says output ${JSON.stringify(config.output)} and distDir ${JSON.stringify(config.distDir)}; apps/web/next.config.ts must add output "standalone" and distDir "${SELF_HOST_DIST_DIR}" when ${SELF_HOST_BUILD_VARIABLE}=1.`,
    );
  }
  const relativeAppDir = serverFiles.relativeAppDir;
  if (
    typeof relativeAppDir !== "string" ||
    isAbsolute(relativeAppDir) ||
    normalize(relativeAppDir).split(/[\\/]/u).includes("..")
  ) {
    throw new SelfHostBuildError(
      `required-server-files.json's relativeAppDir is not a path inside the standalone tree: ${JSON.stringify(relativeAppDir)}`,
    );
  }

  const routes = await builtRouteProblems(webDirectory);
  if (routes.length > 0) {
    throw new SelfHostBuildError(
      `the self-host build's routes are not apps/web's without its test routes:\n- ${routes.join("\n- ")}`,
    );
  }

  const standaloneDirectory = join(distDirectory, "standalone");
  const serverDirectory = join(standaloneDirectory, relativeAppDir);
  if (!(await exists(join(serverDirectory, "server.js")))) {
    throw new SelfHostBuildError(
      `the standalone tree has no server.js at ${join(serverDirectory, "server.js")}`,
    );
  }
  await cp(
    join(distDirectory, "static"),
    join(serverDirectory, SELF_HOST_DIST_DIR, "static"),
    { recursive: true },
  );

  const seams = await builtSeamProblems(webDirectory);
  if (seams.length > 0) {
    throw new SelfHostBuildError(
      `the self-host build carries a test seam (ruling 174):\n- ${seams.join("\n- ")}`,
    );
  }

  return { distDirectory, standaloneDirectory, serverDirectory, config };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// Puts a file back as it was: its bytes, or absent. It writes only when the
// bytes differ.
async function restore(path: string, before: Buffer | null): Promise<void> {
  if (before === null) {
    await rm(path, { force: true });
    return;
  }
  const after = await readFile(path).catch(() => null);
  if (after === null || !after.equals(before)) await writeFile(path, before);
}

/** Next's own CLI, resolved from apps/web as its build script resolves it, after Node's own options. */
async function runNextCli({
  args,
  execArgv,
  cwd,
  env,
}: NextBuildInvocation): Promise<number | null> {
  const next = createRequire(join(cwd, "package.json")).resolve(
    "next/dist/bin/next",
  );
  const child = spawn(process.execPath, [...execArgv, next, ...args], {
    cwd,
    env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? null : code));
  });
}
