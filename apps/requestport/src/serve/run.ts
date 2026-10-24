import type { RoleGuardReport } from "@requestport/db";

import {
  ConfigurationError,
  canonicalEnvironment,
  LOGIN_URL_VARIABLES,
  readConfiguration,
  readSecrets,
  writeCanonicalEnvironment,
} from "../configuration.js";
import { INIT_FILE, readInstanceMarker } from "../instance-marker.js";
import {
  refuseInheritedServerActionKey,
  ServerActionKeyError,
  serverActionKey,
} from "../server-action-key.js";
import {
  namedLoginUrls,
  pgliteHonestyLine,
  removeLoginUrlVariables,
  removeOwnerCapableVariables,
  removeSignInProviderVariables,
  servingApplicationName,
} from "./environment.js";
import { locateSelfHostWeb, prepareWebUi, SelfHostWebError } from "./web.js";

/**
 * `requestport start`'s serving step (manifest-h.md §2.3, §2.5, §2.6): what
 * the start process does once the operator child has exited 0. In order:
 * 1. it reads `init.json`, which must be complete, `config.json` and
 *    `secrets.json`, on pg with the four login URLs the operator child
 *    wrote; it never opens `owner.json` (§2.4); it finds the web UI's
 *    self-host build (`web.ts`), refusing, with `SelfHostWebError`'s words,
 *    a start that has none; and it reads the data directory's server-action
 *    key, making it the first time, after refusing an environment that
 *    already sets `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
 *    (`../server-action-key.ts`; ruling 201 item 4);
 * 2. it removes every `DATABASE_URL`, `DATABASE_URL_*`, `POSTGRES_*` and `PG*` name from its
 *    environment, one line each, never the value (ruling 158, item 11), on
 *    PGlite the four login URL variables too, which name a server, and the
 *    GitHub and Resend pairs, which the sign-in page Next serves reads and
 *    the host's Better Auth does not serve (`environment.ts`);
 * 3. it writes the canonical names into that environment, on pg each login
 *    URL naming this process (`application_name`, `environment.ts`), and on
 *    PGlite says what PGlite does not give (§2.6 item 5, `pgliteHonestyLine`);
 * 4. only then it imports what reads them: `@requestport/db`'s surface
 *    functions, through `database-surface.ts` (ruling 170), to declare the
 *    `application` surface on pg, `embedded` on PGlite (ruling 73),
 *    `@requestport/config/server`, which parses the configuration as it
 *    loads, and the composition, `serve.ts`;
 * 5. it serves (`serveInstance`), with the web UI beside the host, Next
 *    prepared from that build once the host's handoff is set, and handed
 *    the server-action key as `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` before
 *    it loads (`web.ts`), says where
 *    once the worker is ready, and names each storage's driver and login; on
 *    pg, if the worker is not ready `WORKER_NOT_READY_AFTER_MS` after the
 *    host listens, it says once why, from the worker storages' role reports,
 *    and goes on waiting (ruling 163, item 2);
 * 6. on SIGTERM or SIGINT it stops (`ServingInstance.close`) and answers 0;
 *    a second signal exits at once with 1. (`requestport worker` takes a
 *    repeat less than a second after the first as the same stop, ruling 246;
 *    whether this step should is X31.)
 * A start that cannot serve answers 1, having closed what it opened.
 */

export interface ServingIo {
  stderr: { write(text: string): unknown };
}

/** Test-only points in the serving step; the CLI passes none. */
export interface ServingHooks {
  /** Before the serving step reads anything. */
  beforeServing?: () => void;
  /**
   * Once the worker is ready and the start has said it serves: the URL, this
   * process's pid, and the surface `@requestport/db` holds as this process's
   * declaration.
   */
  afterServing?: (served: {
    url: string;
    pid: number;
    surface: string | undefined;
  }) => void;
  /** After every storage has closed, before the step answers. */
  afterClose?: () => void | Promise<void>;
}

export interface ServingOptions {
  dataDirectory: string;
  /** The serving process's own environment: `process.env`. */
  env: NodeJS.ProcessEnv;
  io: ServingIo;
  hooks?: ServingHooks;
  /** Where the signals come from: this process, unless a test sends its own. */
  signals?: Pick<NodeJS.Process, "on" | "off">;
  /** How a second signal ends the process: `process.exit`. */
  exit?: (code: number) => never;
  /**
   * The self-host build's `apps/web` (`web.ts`: the standalone tree's in
   * the repository, `@requestport/web`'s directory packed):
   * `web.ts`'s `defaultSelfHostWebDirectory()`, looked up when the serving
   * step locates the build, inside its refusals, unless a test names
   * another.
   */
  webDirectory?: string;
}

/** A refusal this step says in its own words. */
class ServingError extends Error {}

/**
 * How long a serving start on pg waits for its in-process worker, once the
 * host listens, before it says why the worker may not be ready (ruling 163,
 * item 2). It goes on waiting after it has said so.
 */
export const WORKER_NOT_READY_AFTER_MS = 30_000;

/** What the worker storages' role reports (`ServingInstance.roleReports`) came to. */
export type RoleReportsOutcome =
  | { reports: Record<string, RoleGuardReport> | null }
  | { failure: unknown };

/**
 * The line a serving start on pg writes once its worker has not been ready
 * for `afterMs` (ruling 163, item 2), from the worker storages' role
 * reports: when a storage cannot run a query, the error the reports failed
 * with, on one line, the innermost cause of it, since Drizzle wraps the
 * driver's error in its own ("Failed query: …", with the driver's as its
 * `cause`), and the driver's is the one PostgreSQL words with the login it
 * refused; otherwise each storage's login and role check. Each of
 * `passwords` is replaced wherever it appears, so the line carries none of
 * them.
 */
export function workerNotReadyLine(
  afterMs: number,
  outcome: RoleReportsOutcome,
  passwords: readonly string[],
): string {
  let cause: string;
  if ("failure" in outcome) {
    let failure = outcome.failure;
    while (failure instanceof Error && failure.cause instanceof Error) {
      failure = failure.cause;
    }
    const message = (
      failure instanceof Error ? failure.message : String(failure)
    )
      .replace(/\s+/gu, " ")
      .trim()
      .replace(/\.$/u, "");
    cause = `a worker storage cannot run a query: ${message}. Still waiting while the worker retries.`;
  } else {
    const storages = Object.entries(outcome.reports ?? {}).map(
      ([storage, report]) => {
        const role = report.findings.find(
          (finding) => finding.check === "role",
        );
        return `${storage}: login ${role?.role ?? "?"}, role check ${role?.status ?? "not run"}`;
      },
    );
    cause = `each worker storage runs a query (${storages.join("; ")}). Still waiting.`;
  }
  let line = `the in-process worker is not ready after ${Math.round(afterMs / 1000)} s; ${cause}`;
  for (const password of passwords) {
    if (password !== "") line = line.replaceAll(password, "[password]");
  }
  return line;
}

/** The passwords of the login URLs in `env`, as written and decoded. */
export function loginPasswords(env: NodeJS.ProcessEnv): string[] {
  return Object.values(LOGIN_URL_VARIABLES).flatMap((name) => {
    try {
      const { password } = new URL(env[name] ?? "");
      return [password, decodeURIComponent(password)];
    } catch {
      return [];
    }
  });
}

/** The user a login URL names, for the start log. */
function loginOf(url: string | undefined): string {
  try {
    return url === undefined ? "?" : decodeURIComponent(new URL(url).username);
  } catch {
    return "?";
  }
}

/**
 * The first SIGTERM or SIGINT, as `signal`; a second one, while the first is
 * being handled, exits at once with 1. `remove` takes both handlers off.
 */
function waitForSignal(
  signals: Pick<NodeJS.Process, "on" | "off">,
  say: (line: string) => void,
  exit: (code: number) => never,
) {
  let taken: NodeJS.Signals | undefined;
  let resolve: (signal: NodeJS.Signals) => void = () => undefined;
  const signal = new Promise<NodeJS.Signals>((settle) => {
    resolve = settle;
  });
  const onSignal = (received: NodeJS.Signals) => {
    if (taken !== undefined) {
      say(`${received} again while stopping: exiting at once.`);
      exit(1);
    }
    taken = received;
    resolve(received);
  };
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  return {
    signal,
    remove() {
      signals.off("SIGTERM", onSignal);
      signals.off("SIGINT", onSignal);
    },
  };
}

/** Runs the serving step, and answers the process's exit code. */
export async function serveFromDataDirectory({
  dataDirectory,
  env,
  io,
  hooks = {},
  signals = process,
  exit = (code) => process.exit(code),
  webDirectory,
}: ServingOptions): Promise<number> {
  const say = (line: string) => io.stderr.write(`requestport start: ${line}\n`);
  hooks.beforeServing?.();

  let stopped: ReturnType<typeof waitForSignal> | undefined;
  let instance: Awaited<
    ReturnType<typeof import("./serve.js").serveInstance>
  > | null = null;
  try {
    const marker = readInstanceMarker(dataDirectory);
    if (marker?.complete !== true) {
      throw new ServingError(
        `${dataDirectory}'s ${INIT_FILE} is not complete, so this instance has no owner yet; it serves nothing.`,
      );
    }
    const configuration = readConfiguration(dataDirectory);
    if (configuration === undefined) {
      throw new ServingError(`${dataDirectory} holds no config.json.`);
    }
    const pglite = configuration.storage === "pglite";
    const secrets = readSecrets(dataDirectory, configuration.storage);
    if (secrets === undefined) {
      throw new ServingError(`${dataDirectory} holds no secrets.json.`);
    }
    if (!pglite && secrets.loginUrls === undefined) {
      throw new ServingError(
        `${dataDirectory}'s secrets.json holds no login URLs; the operator step writes them once it has provisioned the logins.`,
      );
    }
    const web = locateSelfHostWeb(webDirectory);
    refuseInheritedServerActionKey(env);
    const actionKey = serverActionKey(dataDirectory);
    if (actionKey.made) {
      say(
        `made ${actionKey.path}, this instance's key for the web UI's server actions, which later starts keep.`,
      );
    }

    removeOwnerCapableVariables(env, say, configuration.storage);
    if (pglite) removeLoginUrlVariables(env, say);
    removeSignInProviderVariables(env, say);
    const canonical = canonicalEnvironment({
      dataDirectory,
      configuration,
      secrets,
      ...(pglite ? {} : { loginUrls: secrets.loginUrls }),
    });
    writeCanonicalEnvironment(
      env,
      pglite
        ? canonical
        : {
            ...canonical,
            ...namedLoginUrls(canonical, servingApplicationName(process.pid)),
          },
    );
    if (pglite) say(pgliteHonestyLine(configuration.host));

    stopped = waitForSignal(signals, say, exit);

    const { declareDatabaseSurface, declaredDatabaseSurface } = await import(
      "./database-surface.js"
    );
    declareDatabaseSurface(pglite ? "embedded" : "application");
    const { serverEnv } = await import("@requestport/config/server");
    const { createLogger } = await import("@requestport/config/logger");
    const { serveInstance } = await import("./serve.js");

    instance = await serveInstance({
      configuration,
      serverEnv,
      env,
      logger: createLogger({
        service: "requestport",
        environment: serverEnv.NODE_ENV,
      }),
      web: () =>
        prepareWebUi(web, {
          hostname: configuration.host,
          port: configuration.port,
          serverActionKey: actionKey.key,
        }),
    });
    say(`listening on ${instance.url} (pid ${process.pid}).`);

    // On pg, a worker whose storages cannot connect retries, and is never
    // ready while they cannot: past the bound, one line says why (ruling
    // 163, item 2). Not once the worker is ready, has failed, or is stopping.
    const serving = instance;
    let waiting = true;
    const notReady = pglite
      ? undefined
      : setTimeout(() => {
          serving
            .roleReports()
            .then(
              (reports): RoleReportsOutcome => ({ reports }),
              (failure: unknown): RoleReportsOutcome => ({ failure }),
            )
            .then((outcome) => {
              if (!waiting) return;
              say(
                workerNotReadyLine(
                  WORKER_NOT_READY_AFTER_MS,
                  outcome,
                  loginPasswords(env),
                ),
              );
            });
        }, WORKER_NOT_READY_AFTER_MS);
    let started: "ready" | NodeJS.Signals;
    try {
      started = await Promise.race([
        instance.ready.then(() => "ready" as const),
        stopped.signal,
      ]);
    } finally {
      waiting = false;
      clearTimeout(notReady);
    }
    if (started === "ready" && pglite) {
      say(
        `storage application: driver ${instance.driver}, surface embedded, PGlite's superuser (no role check), in ${env.REQUESTPORT_PGLITE_DATA_DIR}.`,
      );
      say(
        "storage worker: unbound, on the application storage, with the in-process exclusive runner.",
      );
      say(
        `serving ${configuration.publicUrl}; the in-process worker is ready.`,
      );
      hooks.afterServing?.({
        url: instance.url,
        pid: process.pid,
        surface: declaredDatabaseSurface(),
      });
    } else if (started === "ready") {
      say(
        `storage application: driver ${instance.driver}, login ${loginOf(env[LOGIN_URL_VARIABLES.application])}.`,
      );
      // The worker's storages are built from this environment, whose
      // REQUESTPORT_DATABASE_DRIVER chooses their driver as it chose the
      // application storage's; each login is the role its check resolved.
      const reports = await instance.roleReports();
      for (const [storage, report] of Object.entries(reports ?? {})) {
        const role = report.findings.find(
          (finding) => finding.check === "role",
        );
        say(
          `storage ${storage}: driver ${env.REQUESTPORT_DATABASE_DRIVER}, bound, login ${role?.role ?? "?"} (role check ${role?.status ?? "not run"}).`,
        );
      }
      say(
        `serving ${configuration.publicUrl}; the in-process worker is ready.`,
      );
      hooks.afterServing?.({
        url: instance.url,
        pid: process.pid,
        surface: declaredDatabaseSurface(),
      });
    }

    const signal = await stopped.signal;
    say(`${signal}: stopping.`);
    await instance.close();
    instance = null;
    await hooks.afterClose?.();
    say("stopped: the listener, the worker and every storage are closed.");
    return 0;
  } catch (error) {
    if (instance !== null) await instance.close().catch(() => undefined);
    if (
      error instanceof ServingError ||
      error instanceof ConfigurationError ||
      error instanceof ServerActionKeyError
    ) {
      say(error.message);
      return 1;
    }
    if (error instanceof SelfHostWebError) {
      say(`${error.name}: ${error.message}`);
      return 1;
    }
    say(
      `the instance could not serve: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    stopped?.remove();
  }
}
