import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { moduleLayout } from "../layout.js";
import { SERVER_ACTION_KEY_VARIABLE } from "../server-action-key.js";
import { SELF_HOST_DIST_DIR } from "../web/self-host-dist-dir.js";

/**
 * The web UI `requestport start` serves beside its host (Plan 13, H.5;
 * manifest-h.md §2.7.1): Next's request handler over the self-host build,
 * Next's standalone output in `apps/web/.next-self-host`
 * (`../web/self-host-build.ts`), in the start's own process. Packed, the
 * build's `apps/web`, without the `node_modules` Next traced into it, is the
 * package `@requestport/web`, which `requestport` depends on
 * (`scripts/pack-requestport.mjs`, H.7; ruling 193 item 4).
 *
 * - `locateSelfHostWeb` finds the build and reads the configuration it was
 *   built with, `required-server-files.json`'s `config`, and refuses, with
 *   `SelfHostWebError`, a build that is missing or is not a complete
 *   self-host build. It reads files only, so a start can refuse before it
 *   opens anything.
 * - `prepareWebUi` sets `__NEXT_PRIVATE_STANDALONE_CONFIG` to that
 *   configuration, as Next's generated `server.js` does (a private Next
 *   internal, pinned to 16.4.2 by `../web/standalone-config.test.ts`), and
 *   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` to the data directory's
 *   server-action key it is handed (`../server-action-key.ts`; ruling 201
 *   item 4), before it loads `next`. Next reads that variable, in place of
 *   the key its build wrote into `server/server-reference-manifest.json`,
 *   when it first encrypts or decrypts a server action's bound argument,
 *   and keeps the key it read for the life of the process (`next@16.4.2`
 *   `dist/server/app-render/encryption-utils.js:73-87`, which the build
 *   compiles into its server chunks). It loads `next` by
 *   resolving it from
 *   the build's directory, because this workspace has no `next` of its own:
 *   in the repository that finds the copy Next traced into the standalone
 *   tree, and packed, where `@requestport/web` holds no `node_modules` of its
 *   own, the `next` npm installed for it, which it declares and
 *   `requestport` does not; loads Next's
 *   configuration once, silently (below); and calls
 *   `next({ dev: false, dir, hostname, port })`, `getRequestHandler()` and
 *   `prepare()`, once each. Its caller has installed the host's handoff first
 *   (`serve.ts`), so what Next evaluates as it prepares already finds it.
 *
 * **On-demand revalidation (ruling 202 item 1).** The build's
 * `server/preview-props.json` holds Next's preview-mode id, the same in every
 * install of `@requestport/web` (`prerender-manifest.json` carries the same
 * props), and `next@16.4.2`'s node runtime reads it from that file and has no
 * override for it (`dist/server/next-server.js:1279-1285`, `getPreviewProps`,
 * which `dist/server/base-server.js:383` hands the render, and
 * `dist/server/route-modules/route-module.js:170`; 16.3.8 read
 * `prerender-manifest.json`'s). For a request whose `x-prerender-revalidate`
 * equals it, Next skips middleware (`dist/server/next-server.js:1144-1152`),
 * here `apps/web/src/proxy.ts`, and the answer carries none of the proxy's
 * headers. So the `handle` `prepareWebUi` answers removes
 * `x-prerender-revalidate` and `x-prerender-revalidate-if-generated` from
 * each request's `headers` before it hands the request to Next's handler,
 * which reads them from there (`checkIsOnDemandRevalidate`,
 * `dist/server/api-utils/index.js:99-118`, handed `req.headers`). That
 * `handle` is the one place every request Next sees passes: Next's handler is
 * held in its closure and nowhere else, and `serve.ts` hands it to `listen`
 * as the fallback for every path the host does not serve. No route of
 * `apps/web` asks for on-demand revalidation: there is no Pages Router, and
 * its actions call `revalidatePath`, which sends no request.
 *
 * **Standard output.** As it prepares, Next's router loads its
 * configuration with logging on and, unless that load is a cache hit, writes
 * "✓ Running next.config took …" to standard output
 * (`next@16.4.2` `dist/server/config.js:1190-1201` and
 * `dist/server/lib/router-server.js:133-138`, **read**), where
 * `requestport start` writes the owner's credential and its JSON log lines
 * and nothing else (`first-start.integration.test.ts`; measured: that line
 * was the one extra). Next caches a configuration per phase, directory and
 * process, so loading it here first, through the same module and with
 * logging off, makes the router's load a cache hit, and nothing is written.
 * `../web/standalone-config.test.ts` pins both behaviours of the installed
 * `next`.
 */

/** A missing, incomplete or foreign build: `requestport start` serves nothing without one. */
export class SelfHostWebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfHostWebError";
  }
}

/**
 * What a refusal tells the reader to do, for this module at `moduleUrl`: in
 * the repository, make the build; packed, `@requestport/web` carried it, so
 * `requestport`, which depends on it, is installed again. `moduleUrl` is
 * another URL only in tests.
 */
export function selfHostWebRemedy(moduleUrl: string = import.meta.url): string {
  return moduleLayout(moduleUrl) === "packed"
    ? "requestport depends on @requestport/web, which carries it; install requestport again."
    : "Build it with apps/requestport/src/web/self-host-build.ts's buildSelfHostWeb " +
        "(next build --webpack in apps/web with REQUESTPORT_SELF_HOST_BUILD=1).";
}

const REMEDY = selfHostWebRemedy();

/**
 * Where `requestport start` serves the web UI from unless it is told
 * another, for this module at `moduleUrl` (`../layout.ts`):
 *
 * - in the repository, the self-host build's standalone tree for `apps/web`;
 * - packed, the directory of `@requestport/web` (ruling 193 item 4), the
 *   package `requestport` depends on, into which the pack stages the
 *   build's `apps/web`: where its `package.json` resolves from the chunk in
 *   `dist/` that holds this module. Node resolves through symbolic links,
 *   so this is the package's real path. Where it does not resolve, this
 *   refuses with a `SelfHostWebError`.
 *
 * It is called as `locateSelfHostWeb`'s default: as `start` begins, after
 * its arguments are read and before it writes anything (`start.ts`, whose
 * refusal a `SelfHostWebError` is), and by the serving step when it is named
 * no directory (`run.ts`, inside its refusals); never as this module loads:
 * the chunk that holds this module also holds `start`'s argument parsing, so
 * a lookup at load made `requestport start --help` die on an install
 * without `@requestport/web` (ruling 197; H.7 round 4's finding 2).
 * `moduleUrl` is another URL only in tests, which ask for the packed form.
 */
export function defaultSelfHostWebDirectory(
  moduleUrl: string = import.meta.url,
): string {
  if (moduleLayout(moduleUrl) === "packed") {
    const requireFromDist = createRequire(moduleUrl);
    let manifest: string;
    try {
      manifest = requireFromDist.resolve("@requestport/web/package.json");
    } catch (error) {
      const [reason] = String(
        error instanceof Error ? error.message : error,
      ).split("\n");
      throw new SelfHostWebError(
        `requestport start serves the web UI from @requestport/web, and ${dirname(fileURLToPath(moduleUrl))} cannot resolve it (${reason}). ${selfHostWebRemedy(moduleUrl)}`,
      );
    }
    return dirname(manifest);
  }
  return resolve(
    dirname(fileURLToPath(moduleUrl)),
    "../../../web",
    SELF_HOST_DIST_DIR,
    "standalone",
    "apps",
    "web",
  );
}

/** Next's private variable, read by `next/dist/server/config.js` (above). */
const STANDALONE_CONFIG_VARIABLE = "__NEXT_PRIVATE_STANDALONE_CONFIG";

/** The two request headers that ask Next for on-demand revalidation (above; ruling 202 item 1). */
const ON_DEMAND_REVALIDATION_HEADERS: readonly string[] = Object.freeze([
  "x-prerender-revalidate",
  "x-prerender-revalidate-if-generated",
]);

/**
 * Removes `ON_DEMAND_REVALIDATION_HEADERS` from `incoming.headers`, the
 * object Next reads them from (above). Its `rawHeaders` are left as they
 * came, as `listen` leaves them (`packages/server/src/node.ts`): Node builds
 * `headers` and `headersDistinct` from them, each on its first read, over the
 * count of entries it recorded as it parsed, so removing entries there would
 * leave that count past their end.
 */
function removeOnDemandRevalidation(incoming: IncomingMessage): void {
  for (const name of ON_DEMAND_REVALIDATION_HEADERS) {
    delete incoming.headers[name];
  }
}

/** A self-host build, found: its `apps/web` (standalone, or packed as `@requestport/web`) and the configuration it was built with. */
export interface SelfHostWeb {
  readonly directory: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** Next's request handler, prepared, and how to stop it. */
export interface WebUi {
  handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

/** What `next(...)` answers, as far as this module uses it. */
interface NextApp {
  getRequestHandler(): (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ) => Promise<void>;
  prepare(): Promise<void>;
  close?(): Promise<void>;
}

type NextFactory = (options: {
  dev: false;
  dir: string;
  hostname: string;
  port: number;
}) => NextApp;

/**
 * The self-host build in `directory`, its `apps/web` (the standalone tree's,
 * or `@requestport/web`'s directory; `defaultSelfHostWebDirectory()`, looked
 * up as this is called, unless another is named), or a
 * `SelfHostWebError` naming what is missing: `server.js`, the
 * `required-server-files.json` of a standalone build whose distDir is
 * `.next-self-host`, or the static copy beside it.
 */
export function locateSelfHostWeb(
  directory: string = defaultSelfHostWebDirectory(),
): SelfHostWeb {
  const refuse = (what: string): never => {
    throw new SelfHostWebError(
      `requestport start serves the web UI from the self-host build, and ${what}. ${REMEDY}`,
    );
  };
  if (!existsSync(join(directory, "server.js"))) {
    refuse(`there is none at ${directory} (no server.js)`);
  }
  const serverFiles = join(
    directory,
    SELF_HOST_DIST_DIR,
    "required-server-files.json",
  );
  let config: unknown;
  try {
    config = (
      JSON.parse(readFileSync(serverFiles, "utf8")) as {
        config?: unknown;
      }
    ).config;
  } catch {
    refuse(`${serverFiles} is missing or does not parse`);
  }
  const named = config as Record<string, unknown> | undefined;
  if (
    typeof named !== "object" ||
    named === null ||
    named.output !== "standalone" ||
    named.distDir !== SELF_HOST_DIST_DIR
  ) {
    refuse(
      `${serverFiles} does not describe one: it says output ${JSON.stringify(named?.output)} and distDir ${JSON.stringify(named?.distDir)}, where a self-host build has "standalone" and "${SELF_HOST_DIST_DIR}"`,
    );
  }
  if (!existsSync(join(directory, SELF_HOST_DIST_DIR, "static"))) {
    refuse(
      `its static assets were not copied in beside it (${join(directory, SELF_HOST_DIST_DIR, "static")})`,
    );
  }
  return { directory, config: named as Record<string, unknown> };
}

/**
 * Loads Next from the build and prepares it (above). `serverActionKey` is
 * the data directory's server-action key (`../server-action-key.ts`). `env`
 * is where the two variables are written: the process's own environment,
 * which Next reads.
 */
export async function prepareWebUi(
  web: SelfHostWeb,
  {
    hostname,
    port,
    serverActionKey,
    env = process.env,
  }: {
    hostname: string;
    port: number;
    serverActionKey: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<WebUi> {
  env[STANDALONE_CONFIG_VARIABLE] = JSON.stringify(web.config);
  env[SERVER_ACTION_KEY_VARIABLE] = serverActionKey;
  const requireFromBuild = createRequire(join(web.directory, "package.json"));
  const loaded = requireFromBuild("next") as
    | NextFactory
    | { default: NextFactory };
  const next = typeof loaded === "function" ? loaded : loaded.default;
  const { default: loadConfig } = requireFromBuild(
    "next/dist/server/config.js",
  ) as {
    default: (
      phase: string,
      dir: string,
      options: { silent: boolean },
    ) => Promise<unknown>;
  };
  const { PHASE_PRODUCTION_SERVER } = requireFromBuild(
    "next/dist/shared/lib/constants.js",
  ) as { PHASE_PRODUCTION_SERVER: string };
  await loadConfig(PHASE_PRODUCTION_SERVER, web.directory, { silent: true });
  const app = next({ dev: false, dir: web.directory, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();
  return {
    handle: (incoming, outgoing) => {
      removeOnDemandRevalidation(incoming);
      return handle(incoming, outgoing);
    },
    close: async () => {
      await app.close?.();
    },
  };
}
