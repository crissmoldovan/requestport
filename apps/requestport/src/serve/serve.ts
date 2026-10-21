import { createAuth } from "@requestport/auth/create-auth";
import type { ParsedServerEnv } from "@requestport/config/server";
import {
  createRequestPort,
  type RequestPortKeyRing,
  type RequestPortLogger,
  type RequestPortSecrets,
} from "@requestport/core";
import {
  createWorkerStorages,
  type RoleGuardOptions,
  type Storage,
  type WorkerStorages,
} from "@requestport/db";
import {
  hostConstructionToken,
  installHostHandoff,
  rootStorageFromEnv,
  withHostConstructionToken,
} from "@requestport/db/wiring";
import { POSTGRES_WORKER_POOL_SIZES } from "@requestport/jobs/worker";
import { createRequestPortHost, hostServes, listen } from "@requestport/server";

import type { InstanceConfiguration } from "../configuration.js";
import { createPgliteExclusiveRunner } from "../pglite-exclusive-runner.js";
import type { WebUi } from "./web.js";

/**
 * `requestport start`'s serving composition (manifest-h.md §2.2, §2.4, §2.5,
 * §2.6; ruling 141; ruling 158, items 2, 5 and 16). On pg, one process,
 * which has declared `application`, holding
 * - the application storage, `rootStorageFromEnv("application")`, which
 *   connects as the instance's application login through
 *   `REQUESTPORT_APPLICATION_DATABASE_URL`, with tenant binding on;
 * - the worker's three storages, `createWorkerStorages` over the same
 *   environment with the pg pools `requestport-jobs` uses, each judged by its
 *   guard as `worker` while the process declares `application` (ruling 72),
 *   each connecting as its own login;
 * - Better Auth (`createAuth`, `./create-auth`, which installs nothing as it
 *   is imported) over the application storage;
 * - core's RequestPort over the application storage, its background
 *   `postgres` over the worker storages, so that the worker runs in this
 *   process through core (ruling 141), started at once by `start()`; it
 *   admits private and loopback webhook receivers exactly when the
 *   configuration's `REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS` is `enabled`
 *   (Plan 13, H.10), which core applies at registration and hands the
 *   background's worker settings for every delivery;
 * - the host (`createRequestPortHost`) over the same storage, RequestPort and
 *   Better Auth, served by `listen` on the configured bind address and port,
 *   at the public URL;
 * - and, when it is handed one (`ServeOptions.web`, which `requestport start`
 *   always hands it, `run.ts`), the web UI: Next's request handler over the
 *   self-host build (`web.ts`), in this process, which `listen` hands every
 *   path the host does not serve (`hostServes`), and the host's handoff,
 *   through which Next's copies of the packages answer this storage, this
 *   Better Auth and this RequestPort and build none of their own (below).
 *
 * On PGlite (§2.6), one process, which has declared `embedded` (ruling 73),
 * holding one storage, PGlite's, `rootStorageFromEnv("embedded")`, over the
 * database in the data directory, its tenant binding off; the worker on its
 * unbound path, `createWorkerStorages({}, { unbound: "embedded", storage })`,
 * over that storage (§2.6 item 2; ruling 214 item 1(a), the exception only a
 * process declared `embedded` with a PGlite storage is given), with the
 * in-process exclusive runner in place of the
 * advisory one, which deadlocks on PGlite's one connection (§2.6 item 3,
 * `pglite-exclusive-runner.ts`); and Better Auth, core and the host over it,
 * as on pg.
 *
 * It reads the environment it is handed for the worker's storages on pg and
 * for `VERCEL_ENV`, the default application storage's builder reads
 * `process.env`, and everything else comes from the parsed configuration; it
 * neither declares a surface nor writes the environment, which its caller
 * does first (`run.ts`).
 */

export interface ServeOptions {
  configuration: InstanceConfiguration;
  /**
   * The server configuration, parsed from the canonical names its caller
   * wrote (`@requestport/config/server`'s `serverEnv` in the serving
   * process).
   */
  serverEnv: ParsedServerEnv;
  /**
   * The serving process's environment, the canonical names written in it:
   * the worker's three storages read their URLs, the driver and the guards'
   * environment from it (§2.5), as the application storage's builder reads
   * `process.env`.
   */
  env: NodeJS.ProcessEnv;
  /** Where core's dispatch, the worker and MCP write their lines. */
  logger: RequestPortLogger;
  /**
   * For tests: modes handed to the worker storages' guards, which can raise
   * a check to `enforce` and relax none (`@requestport/db`'s role guard):
   * Done when 5 hands every check at `warn` and is still refused. Unset, the
   * guards' default modes, in which the worker's declaration and role checks
   * enforce (I.2b's b5; ruling 214 item 2).
   */
  workerGuardModes?: RoleGuardOptions["modes"];
  /**
   * Prepares the web UI (`web.ts`'s `prepareWebUi` over the located build),
   * once, after the handoff is installed and before the host listens. Absent,
   * as in a test that composes the host alone, no handoff is installed and
   * every path the host does not serve is answered `404`.
   */
  web?: () => Promise<WebUi>;
}

export interface ServingInstance {
  /** Where the host listens: `http://<address>:<port>`. */
  readonly url: string;
  /** The application storage's driver. */
  readonly driver: string;
  /**
   * Settles when the in-process worker is ready (`RequestPort.start()`), and
   * rejects if it could not start.
   */
  readonly ready: Promise<void>;
  /**
   * The worker storages' role reports (`WorkerStorages.roleReports`): each
   * storage's guard's findings, once its role check has run, which this
   * runs first if it has not; `null` on PGlite, whose worker is unbound.
   */
  roleReports(): ReturnType<WorkerStorages["roleReports"]>;
  /**
   * Stops serving HTTP, then the web UI, then removes the host's handoff,
   * then stops the worker (`RequestPort.close()`, which waits for its drain),
   * then closes the worker storages and the application storage, in that
   * order (§2.5). Each step runs even if one before it failed; the first
   * failure is thrown once all have run.
   */
  close(): Promise<void>;
}

/**
 * A key ring from the variables that carry one, as the web's RequestPort and
 * the worker root build theirs: the current key under its version, and the
 * previous key only when it and its version are both set.
 */
function keyRing(
  current: { key: string; version: string },
  previousKey: string | undefined,
  previousVersion: string | undefined,
): RequestPortKeyRing {
  return {
    current,
    ...(previousKey && previousVersion
      ? { previous: { version: previousVersion, key: previousKey } }
      : {}),
  };
}

/**
 * Core's secrets from the parsed configuration, as the web's RequestPort
 * (`apps/web/src/lib/server-web-request-port.ts`) and the worker root
 * (`packages/jobs/src/worker-root.ts`) read them, with no Resend pair: the
 * self-host composes no e-mail sender (`authEnvironment`).
 */
export function requestPortSecrets(
  serverEnv: ParsedServerEnv,
): RequestPortSecrets {
  const webhookKey =
    serverEnv.REQUESTPORT_WEBHOOK_KEK ??
    serverEnv.REQUESTPORT_WEBHOOK_SIGNING_KEY;
  return {
    commandFingerprintKey: serverEnv.BETTER_AUTH_SECRET,
    operatorCredentials: serverEnv.REQUESTPORT_OPERATOR_CREDENTIALS,
    workspaceKeys: serverEnv.REQUESTPORT_WORKSPACE_KEK
      ? keyRing(
          {
            version: serverEnv.REQUESTPORT_WORKSPACE_KEK_VERSION,
            key: serverEnv.REQUESTPORT_WORKSPACE_KEK,
          },
          serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS,
          serverEnv.REQUESTPORT_WORKSPACE_KEK_PREVIOUS_VERSION,
        )
      : undefined,
    webhookKeys: webhookKey
      ? {
          ...keyRing(
            {
              version: serverEnv.REQUESTPORT_WEBHOOK_KEK_VERSION,
              key: webhookKey,
            },
            serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS,
            serverEnv.REQUESTPORT_WEBHOOK_KEK_PREVIOUS_VERSION,
          ),
          signingKey: serverEnv.REQUESTPORT_WEBHOOK_SIGNING_KEY,
        }
      : undefined,
    slackStateSecret: serverEnv.REQUESTPORT_SLACK_STATE_SECRET,
  };
}

/**
 * What Better Auth is composed from: the parsed configuration without the
 * GitHub and Resend pairs, which `requestport start` neither records nor
 * offers, so that the only way in is the owner's local credential, and the
 * sign-in methods Better Auth reports and its composition agree (no
 * magic-link sender is handed in); and `VERCEL_ENV` from the environment, as
 * the web's installer reads it (`packages/auth/src/server.ts`), since the
 * parsed configuration does not carry it. The serving step (`run.ts`) also
 * removes both pairs from the process's environment, which Next's sign-in
 * page reads (`removeSignInProviderVariables`); this composition leaves them
 * out whatever its caller's environment holds, as in a test that composes
 * the host alone.
 */
export function authEnvironment(
  serverEnv: ParsedServerEnv,
  env: NodeJS.ProcessEnv,
) {
  return {
    ...serverEnv,
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    RESEND_API_KEY: undefined,
    RESEND_FROM_EMAIL: undefined,
    VERCEL_ENV: env.VERCEL_ENV,
  };
}

/** Runs each of `steps`, all of them, and throws the first failure once they have. */
async function inTurn(steps: readonly (() => Promise<unknown>)[]) {
  let failure: unknown;
  let failed = false;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
}

/**
 * Composes and serves the instance (above). `buildApplicationStorage` is the
 * application storage's builder, `rootStorageFromEnv` unless a test builds
 * one whose guard's modes it forces (Done when 5; ruling 158, item 16); it
 * is asked for `application` on pg and `embedded` on PGlite.
 */
export async function serveInstance(
  options: ServeOptions,
  buildApplicationStorage: (
    surface: "application" | "embedded",
  ) => Storage = rootStorageFromEnv,
): Promise<ServingInstance> {
  const { configuration, serverEnv, env, logger } = options;
  const pglite = configuration.storage === "pglite";
  const token = hostConstructionToken();
  const storage = buildApplicationStorage(pglite ? "embedded" : "application");
  // On PGlite, an empty environment, whatever the process's environment
  // names, and the embedded exception asked for over PGlite's storage: the
  // unbound path, which `createWorkerStorages` refuses to any other caller
  // (§2.6 item 2; ruling 214 item 1(a)). It admits the exception only in a
  // process declared `embedded`, as `run.ts` declares it on PGlite, and only
  // over a PGlite storage, as this one is there. On pg, the instance's three
  // logins: bound, and neither the exception nor the storage is read.
  // The pools and guards below are the bound path's, and the unbound path
  // takes neither.
  const workerStorages = createWorkerStorages(pglite ? {} : env, {
    ...(pglite ? { unbound: "embedded" as const } : {}),
    storage,
    poolSizes: POSTGRES_WORKER_POOL_SIZES,
    // Each guard judges `worker` while this process declares `application`
    // (ruling 72): `createWorkerStorages` builds them so, and takes no
    // surface from its caller (ruling 215 item 4).
    guard: {
      ...(options.workerGuardModes === undefined
        ? {}
        : { modes: options.workerGuardModes }),
    },
    ...withHostConstructionToken({}, token),
  });
  const auth = createAuth({
    database: () => storage.db,
    env: authEnvironment(serverEnv, env),
    sendMagicLink: undefined,
    ...withHostConstructionToken({}, token),
  });
  const requestPort = createRequestPort({
    storage,
    secrets: requestPortSecrets(serverEnv),
    background: {
      kind: "postgres",
      workerStorages,
      ...(pglite ? { runExclusive: createPgliteExclusiveRunner() } : {}),
    },
    publicUrl: serverEnv.BETTER_AUTH_URL,
    environment: serverEnv.NODE_ENV,
    privateWebhookReceivers:
      serverEnv.REQUESTPORT_WEBHOOK_PRIVATE_RECEIVERS === "enabled",
    logger,
    betterAuth: { createAgentApiKey: auth.createAgentApiKey },
  });
  const handler = createRequestPortHost({
    requestPort,
    auth,
    publicUrl: serverEnv.BETTER_AUTH_URL,
    storage,
    secrets: { fingerprintKey: serverEnv.BETTER_AUTH_SECRET },
    mcp: {
      modernProtocol: serverEnv.REQUESTPORT_MCP_MODERN === "enabled",
      privateTelemetry: serverEnv.REQUESTPORT_WORKSPACE_KEK !== undefined,
    },
    environment: serverEnv.NODE_ENV,
    logger,
  });
  const closeStorages = () =>
    inTurn([
      () => requestPort.close(),
      () => workerStorages.close(),
      () => storage.close(),
    ]);

  /*
   * The host's handoff (manifest-h.md §2.7.1; rulings 141, 145 and 160, item 1):
   * `globalThis[Symbol.for("requestport.host")]`, set to `{ requestPort, auth,
   * storage, admitsConstruction }` once this process has composed them and
   * before Next prepares. Next's build carries copies of `@requestport/db`,
   * `@requestport/auth` and the web's RequestPort module of its own; with the
   * handoff set, the web's application root, Better Auth's installer and the
   * web's RequestPort answer these members (`@requestport/db/wiring`,
   * `@requestport/auth/server`, `apps/web/src/lib/server-web-request-port.ts`);
   * `createStorage`, `createWorkerStorages` and `createAuth`, in any copy,
   * refuse to build for a caller whose options carry no construction token the
   * handoff admits; and `workerStorages()` refuses in a copy where no worker
   * storages were installed (in this one, core's background installs them).
   * `auth` is the whole of what `createAuth` answered.
   *
   * The token (`hostConstructionToken`) is a fresh object only this closure
   * holds. The handoff carries `admitsConstruction`, which compares with it,
   * never the token itself, so nothing that reads `globalThis` can hold it
   * (slice b's record, For the driver 2). This composition builds the storage,
   * the worker storages and Better Auth before the handoff is set
   * (`installHostHandoff`), and hands the token to the two of those factories
   * that take options (`withHostConstructionToken`, spread into them), so a
   * construction of theirs made after the handoff is set would still be
   * admitted; none is made after it here.
   *
   * **The headers' order, ruling 149, as ruling 160 item 7 settles it.** The
   * self-host follows `next start`'s order, in which the proxy's headers are
   * merged over a route's (`proxy.ts` for Next's answers, `host.ts`'s
   * `withProxyHeaders` for the host's). For the two protected-resource
   * documents that order and Vercel's differ: Vercel serves the route's own
   * `cache-control: public, max-age=300`, and the self-host serves the proxy's
   * `private, no-store` (`docs/implementation/gotchas.md`, 2026-10-06;
   * `packages/server/test/route-goldens/route-goldens.test.ts`, "ruling 149").
   */
  // Set before anything of Next's is evaluated, and only when Next is served.
  const removeHandoff =
    options.web === undefined
      ? () => undefined
      : installHostHandoff({ requestPort, auth, storage }, token);
  // The worker next, so that it starts while Next prepares and the listener
  // binds; a caller that never awaits `ready` still hears of a failed start
  // from the logger.
  const ready = requestPort.start();
  ready.catch(() => undefined);
  let web: WebUi | undefined;
  let running: Awaited<ReturnType<typeof listen>>;
  try {
    web = await options.web?.();
    running = await listen(handler, {
      host: configuration.host,
      port: configuration.port,
      publicUrl: configuration.publicUrl,
      ...(configuration.trustedProxy === undefined
        ? {}
        : { trustedProxy: configuration.trustedProxy }),
      ...(web === undefined
        ? {}
        : {
            fallback: {
              serves: (pathname: string) => !hostServes(pathname),
              handle: web.handle,
            },
          }),
    });
  } catch (error) {
    await inTurn([
      async () => web?.close(),
      async () => removeHandoff(),
      closeStorages,
    ]).catch(() => undefined);
    throw error;
  }

  return {
    url: running.url,
    driver: storage.driver,
    ready,
    roleReports: () => workerStorages.roleReports(),
    close: () =>
      inTurn([
        () => running.close(),
        async () => web?.close(),
        async () => removeHandoff(),
        closeStorages,
      ]),
  };
}
