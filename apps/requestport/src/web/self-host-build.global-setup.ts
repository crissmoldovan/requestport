import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { locateSelfHostWeb, SelfHostWebError } from "../serve/web.js";
import {
  buildSelfHostWeb,
  builtRouteProblems,
  builtSeamProblems,
  SelfHostBuildError,
} from "./self-host-build.js";
import { SELF_HOST_DIST_DIR } from "./self-host-dist-dir.js";
import { TEST_SEAMS } from "./test-seams.js";

/*
 * The integration project's global setup (manifest-h.md §2.7.1, Done when
 * 11; ruling 160, item 2): `requestport start` serves the web UI from the
 * self-host build and refuses to start without one (`../serve/web.ts`), so
 * every suite that starts an instance needs it. This builds it, through
 * `buildSelfHostWeb`, when it is missing or incomplete, when its routes are
 * not apps/web's without its test routes (`builtRouteProblems`, the check
 * `buildSelfHostWeb` makes of a build it has just made, so that a build made
 * before the test routes were left out, which holds them, is made again),
 * when it carries a test seam (`builtSeamProblems`, which `buildSelfHostWeb`
 * also makes of a build it has just made, so that a build made before ruling
 * 174, which carries them, is made again), or when it is older than any of
 * its inputs (`newestInput`, whose answer it names), and otherwise leaves it
 * as it is. It never lets a suite run against no build: a build that fails
 * fails the run. The build is made as `requestport`'s pack makes it, with
 * the inert test seams: no suite of this project relies on E2E mode against
 * it (measured in H.7, ruling 174's round).
 *
 * The inputs are the ones `--e2e` judges its own build by
 * (`scripts/start-e2e-server.mjs`'s `newestSourceMs`: apps/web's source,
 * `packages`, `trigger`, and the configuration and lock files), and this
 * workspace's own (`SELF_HOST_BUILD_INPUTS`), against the time of the
 * build's `BUILD_ID`. Turbo does not know this project's tests read
 * apps/web, so a cached turbo pass is no evidence here; the gate runs with
 * `--force`.
 */

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const webDirectory = join(repositoryRoot, "apps", "web");

/**
 * The self-host build's inputs outside `--e2e`'s, from the repository's
 * root: the build's modules (`self-host-build.ts`, and
 * `self-host-dist-dir.ts`, which it imports), the preload it hands `next
 * build`, the seams' module (`test-seams.ts`), the webpack loader the
 * preload's plugin puts in a seam's chain (`inert-seam-loader.cjs`), the
 * recorder the preload imports (`contained-modules.ts`, which records only
 * where the pack asks it to; ruling 197 item 4), and each seam's inert
 * module (ruling 174; ruling 190, minor 1). The seams'
 * list itself is `packages/core/bundle.mjs`'s (ruling 193 item 2), and the
 * fence's inert module is in `packages/server`: `--e2e`'s inputs, which walk
 * `packages` whole, hold both.
 */
export const SELF_HOST_BUILD_INPUTS: readonly string[] = Object.freeze([
  "apps/requestport/src/web/self-host-build.ts",
  "apps/requestport/src/web/self-host-dist-dir.ts",
  "apps/requestport/src/web/self-host-seams.ts",
  "apps/requestport/src/web/test-seams.ts",
  "apps/requestport/src/web/inert-seam-loader.cjs",
  "apps/requestport/src/web/contained-modules.ts",
  ...TEST_SEAMS.map(({ inert }) => inert),
]);

/** What `newestInput` names when the newest time is one of `--e2e`'s inputs, which it reads as one. */
export const E2E_INPUTS =
  "the newest of --e2e's inputs (apps/web/src, packages, trigger, and the configuration and lock files scripts/start-e2e-server.mjs lists)";

/** The newest of the build's inputs: what it is, and its time. */
export type NewestInput = Readonly<{ input: string; ms: number }>;

/** An input's modification time, in milliseconds, by its absolute path. */
export type InputTime = (path: string) => number;

const modifiedMs: InputTime = (path) => statSync(path).mtimeMs;

/**
 * The newest of the build's inputs in the checkout at `root`: `--e2e`'s
 * (`scripts/start-e2e-server.mjs`'s `newestSourceMs` over `root`, named
 * `E2E_INPUTS`), and each of `SELF_HOST_BUILD_INPUTS`, its time read through
 * `inputTime` (the file's own unless a test hands another), named by its
 * path from `root`. A tie goes to `--e2e`'s.
 */
export async function newestInput(
  root: string = repositoryRoot,
  inputTime: InputTime = modifiedMs,
): Promise<NewestInput> {
  const { newestSourceMs } = (await import(
    pathToFileURL(join(repositoryRoot, "scripts", "start-e2e-server.mjs")).href
  )) as { newestSourceMs: (root: string) => number };
  let newest: NewestInput = { input: E2E_INPUTS, ms: newestSourceMs(root) };
  for (const input of SELF_HOST_BUILD_INPUTS) {
    const ms = inputTime(join(root, input));
    if (ms > newest.ms) newest = { input, ms };
  }
  return newest;
}

/**
 * Why the self-host build in `web` must be made again, or undefined when it
 * is current. `newest` answers the newest of its inputs (`newestInput`); a
 * test hands its own.
 */
export async function staleness(
  web: string = webDirectory,
  newest: () => Promise<NewestInput> = () => newestInput(),
): Promise<string | undefined> {
  const buildId = join(web, SELF_HOST_DIST_DIR, "BUILD_ID");
  let built: number;
  try {
    built = statSync(buildId).mtimeMs;
  } catch {
    return `there is no ${buildId}`;
  }
  try {
    locateSelfHostWeb(
      join(web, SELF_HOST_DIST_DIR, "standalone", "apps", "web"),
    );
  } catch (error) {
    if (error instanceof SelfHostWebError) return error.message;
    throw error;
  }
  let routes: string[];
  try {
    routes = await builtRouteProblems(web);
  } catch (error) {
    if (error instanceof SelfHostBuildError) return error.message;
    throw error;
  }
  if (routes.length > 0) {
    return `its routes are not apps/web's without its test routes: ${routes.join("; ")}`;
  }
  const seams = await builtSeamProblems(web);
  if (seams.length > 0) {
    return `it carries a test seam: ${seams.join("; ")}`;
  }
  const { input, ms } = await newest();
  return ms > built
    ? `${input} is newer than it (${new Date(ms).toISOString()} > ${new Date(built).toISOString()})`
    : undefined;
}

export default async function selfHostBuildGlobalSetup(): Promise<void> {
  const reason = await staleness();
  if (reason === undefined) {
    console.log(
      `self-host build: ${join(webDirectory, SELF_HOST_DIST_DIR)} is current.`,
    );
    return;
  }
  console.log(`self-host build: building it, because ${reason}.`);
  const started = Date.now();
  await buildSelfHostWeb({ webDirectory });
  console.log(
    `self-host build: built in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
  );
}
