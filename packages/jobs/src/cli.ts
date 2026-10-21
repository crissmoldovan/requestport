import { rmSync, writeFileSync } from "node:fs";

import { createLogger } from "@requestport/config/logger";
import {
  createAdvisoryExclusiveRunner,
  createImportTaskDispatchRepository,
  createOutboxRepository,
  declareDatabaseSurface,
  ownerCapableVariableNames,
  WORKER_DATABASE_URL_VARIABLES,
  type WorkerStorages,
} from "@requestport/db";

import { createJobHandlers, scheduleDefinitions } from "./catalogue.js";
import { jobRunnerVariable, resolveJobRunnerKind } from "./selection.js";
import { POSTGRES_WORKER_POOL_SIZES, startJobWorker } from "./worker.js";
import {
  workerSettingsFromRoot,
  workerStoragesFromRoot,
} from "./worker-root.js";
import {
  useWorkerSettings,
  useWorkerStorages,
  type WorkerServiceNames,
} from "./worker-storages.js";

const usageOf = (program: string) => `Usage: ${program} [--ready-file <path>]

Runs RequestPort's background jobs against its PostgreSQL database: drains
the outbox, runs queued imports, and runs the schedules. Requires
${jobRunnerVariable}=postgres, no VERCEL_ENV, RequestPort's server
configuration, and the worker's three database logins, one in each worker
group:
  ${WORKER_DATABASE_URL_VARIABLES.dispatcher}
  ${WORKER_DATABASE_URL_VARIABLES.processor}
  ${WORKER_DATABASE_URL_VARIABLES.maintenance}
It refuses to start without all three, and refuses to start beside a
variable that can reach the database as its owner: DATABASE_URL, any
DATABASE_URL_* name, any PG* name or any POSTGRES_* name.

  --ready-file <path>  Written with this process's id once the worker has
                       reached the database; removed when it stops.

SIGTERM or SIGINT stops claiming work and waits for what is running; a second
signal exits at once.`;

type Arguments = { readyFile?: string };

function parseArguments(argv: readonly string[]): Arguments | "help" | string {
  const parsed: Arguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--ready-file") {
      const path = argv[index + 1];
      if (!path || path.startsWith("--")) return "--ready-file needs a path";
      parsed.readyFile = path;
      index += 1;
      continue;
    }
    return `unknown argument ${JSON.stringify(argument)}`;
  }
  return parsed;
}

/**
 * Runs the worker until a signal stops it, and answers the process's exit
 * code: 0 drained, 1 stopped with work still running, 2 refused to start.
 * `program` is the name its usage and messages give: `requestport-jobs`, this
 * package's executable, or `requestport worker`, the public program's
 * command (`apps/requestport`), which reaches this through the package's
 * index (ruling 158, 6). `serviceNames` is whose service names its log lines,
 * the job bodies' and the metrics carry (`WorkerServiceNames`; ruling 158,
 * 9): `"trigger"`, the names `requestport-jobs` has always logged under
 * (its own lines as `requestport-jobs`), or `"self-host"`, which
 * `requestport worker` passes (its own lines as `requestport-worker`).
 */
export async function runJobWorkerCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  program = "requestport-jobs",
  serviceNames: WorkerServiceNames = "trigger",
): Promise<number> {
  // The worker surface (manifest-i2.md §2.2, ruling 45), before anything
  // here can query.
  declareDatabaseSurface("worker");
  const usage = usageOf(program);
  const parsed = parseArguments(argv);
  if (parsed === "help") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (typeof parsed === "string") {
    process.stderr.write(`${program}: ${parsed}\n\n${usage}\n`);
    return 2;
  }

  let kind: string;
  try {
    kind = resolveJobRunnerKind(env);
  } catch (error) {
    process.stderr.write(`${program}: ${(error as Error).message}\n`);
    return 2;
  }
  if (kind !== "postgres") {
    process.stderr.write(
      `${program}: this environment selects the ${kind} job runner, so this worker would compete with it for the same rows. Set ${jobRunnerVariable}=postgres to run it.\n`,
    );
    return 2;
  }

  // The three storages (manifest-i2.md §5.1), from the worker root
  // (manifest-g.md §2.10): one pool per role, from the three variables. With
  // none of them set, or only some, the root refuses, naming them, and this
  // exits 2 (Plan 13, I.2b's b5; ruling 214 item 1).
  let storages: WorkerStorages;
  try {
    storages = workerStoragesFromRoot(env, {
      poolSizes: POSTGRES_WORKER_POOL_SIZES,
    });
  } catch (error) {
    process.stderr.write(`${program}: ${(error as Error).message}\n`);
    return 2;
  }

  // A variable that can reach the database as its owner would have every
  // storage refused at its first query by the environment check (I.2b's b6,
  // ruling 217), and the worker would start and never become ready. Refused
  // here instead, after the three's own refusal, naming the variables and
  // never a value; the storages, built but never used, are closed first.
  const ownerNames = ownerCapableVariableNames(env);
  if (ownerNames.length > 0) {
    await storages.close();
    process.stderr.write(
      `${program}: this environment names ${ownerNames.join(", ")}, which can reach the database as its owner. The worker connects only as its three logins and refuses to start beside ${ownerNames.length === 1 ? "it" : "them"}: remove ${ownerNames.length === 1 ? "it" : "them"} from the worker's environment.\n`,
    );
    return 2;
  }
  useWorkerStorages(storages);
  // The settings the bodies read, from the worker root too, installed beside
  // the storages before the worker starts, so no body's first ask fills the
  // holder (`worker-storages.ts`). `requestport-jobs`' process never loads
  // `@requestport/jobs`' own module, which registers the root the holder
  // fills from (`index.ts`), so there it could not fill itself;
  // `requestport worker` reaches this function through that module, so a
  // root is registered there, and the holder never asks it. Built here
  // rather than at a body's first ask, so the label (`VERCEL_ENV`, else
  // `NODE_ENV`) is read at start-up; every other member is still read when a
  // body reads it (`workerSettingsFromRoot`). `Object.assign` writes the
  // service names onto the object the root returns without reading any of
  // its other members, so those are still read only when a body reads them.
  useWorkerSettings(
    serviceNames === "trigger"
      ? workerSettingsFromRoot()
      : Object.assign(workerSettingsFromRoot(), { serviceNames }),
  );

  const logger = createLogger({
    service:
      serviceNames === "self-host" ? "requestport-worker" : "requestport-jobs",
    environment: env.NODE_ENV ?? "unknown",
  });
  const worker = startJobWorker({
    outboxRepository: createOutboxRepository(storages.dispatcher),
    importTaskDispatchRepository: createImportTaskDispatchRepository(
      storages.dispatcher,
    ),
    createHandlers: createJobHandlers,
    schedules: scheduleDefinitions,
    runExclusive: createAdvisoryExclusiveRunner(storages.dispatcher),
    logger,
  });

  const { readyFile } = parsed;
  void worker.ready.then(() => {
    if (readyFile)
      writeFileSync(readyFile, `${process.pid}\n`, { mode: 0o600 });
  });

  const stopped = new Promise<{ drained: boolean }>((resolveStopped) => {
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (stopping) {
        logger.warn("worker.forced_exit", { status: signal.toLowerCase() });
        process.exit(1);
      }
      stopping = true;
      logger.info("worker.stopping", { status: signal.toLowerCase() });
      void worker.stop().then(resolveStopped);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });

  const { drained } = await stopped;
  if (readyFile) rmSync(readyFile, { force: true });
  // The three are the only storages this process builds: the worker root
  // builds none of its own (`worker-root.ts`).
  await storages.close().catch(() => undefined);
  return drained ? 0 : 1;
}
