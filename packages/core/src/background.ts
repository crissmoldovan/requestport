import {
  createAdvisoryExclusiveRunner,
  createImportTaskDispatchRepository,
  createOutboxRepository,
  type WorkerStorages,
} from "@requestport/db";
import { DomainError } from "@requestport/domain";
import {
  createJobDispatch,
  type JobDispatchDependencies,
  type StartTriggerTask,
} from "@requestport/jobs/dispatch";
import type { WorkerSettings } from "@requestport/jobs/worker-storages";

import type {
  RequestPortBackground,
  RequestPortLogger,
  RequestPortOptions,
} from "./options.js";

/*
 * The background port (manifest-g.md §2.4): hands the rows a command
 * committed, and the jobs a caller starts directly, to the background the
 * caller chose. It is C's dispatch (`createJobDispatch`,
 * `@requestport/jobs/dispatch`), unchanged, with the runner chosen by the
 * caller rather than read from `REQUESTPORT_JOB_RUNNER`.
 */

/**
 * The repositories a committed row is read, claimed and accepted through,
 * each built for one organisation, so that its claim and its acceptance run
 * bound to the organisation the command committed in (manifest-i2.md §2.4;
 * track-i2.md D5).
 */
export interface CommittedRows {
  outbox(
    organizationId: string,
  ): JobDispatchDependencies["outboxRepository"] & {
    idsForEvents(eventIds: string[]): Promise<readonly { id: string }[]>;
    idsForCorrelation(
      correlationId: string,
    ): Promise<readonly { id: string }[]>;
  };
  importTaskDispatches(
    organizationId: string,
  ): JobDispatchDependencies["importTaskDispatchRepository"];
}

export interface BackgroundPortOptions {
  /**
   * The background, or a function asked once for each dispatch, so that a
   * caller whose choice follows its environment, as the web's does, can keep
   * reading it on every call.
   */
  background: RequestPortBackground | (() => RequestPortBackground);
  committedRows: CommittedRows;
  logger: JobDispatchDependencies["logger"];
}

/**
 * What a direct start is built with in place of the committed rows'
 * repositories: `createJobDispatch` asks for both, and its direct starts call
 * neither.
 */
const noCommittedRow = {
  claimOne: () =>
    Promise.reject(new Error("a direct start reads no committed row")),
  markAccepted: () =>
    Promise.reject(new Error("a direct start reads no committed row")),
};

export function createBackgroundPort(options: BackgroundPortOptions) {
  const { background: given, committedRows, logger } = options;
  const choose = typeof given === "function" ? given : () => given;

  /**
   * `createJobDispatch` over one choice of background, asked when the
   * dispatch first needs it and kept for that dispatch, as its `kind` is
   * asked once by each of its functions. `none` and `postgres` both give
   * the dispatch the web runs while the Postgres worker is selected: it
   * claims nothing, and refuses a direct start with
   * `JobDeferredToWorkerError`.
   */
  function dispatchOver(
    outboxRepository: JobDispatchDependencies["outboxRepository"],
    importTaskDispatchRepository: JobDispatchDependencies["importTaskDispatchRepository"],
  ) {
    let chosen: RequestPortBackground | undefined;
    const background = () => {
      chosen ??= choose();
      return chosen;
    };
    // Under `none` and `postgres`, `createJobDispatch` asks `kind` first and
    // returns before it would start anything, so the refusal below is never
    // reached.
    const startTriggerTask: StartTriggerTask = (taskId, payload, start) => {
      const current = background();
      return current.kind === "trigger"
        ? current.startTask(taskId, payload, start)
        : Promise.reject(
            new Error(
              `a background of kind ${current.kind} starts no Trigger.dev task`,
            ),
          );
    };

    return createJobDispatch({
      kind: () => (background().kind === "trigger" ? "trigger" : "postgres"),
      startTriggerTask,
      outboxRepository,
      importTaskDispatchRepository,
      logger,
    });
  }

  /** A dispatch whose claim and acceptance run bound to `organizationId`. */
  function committedDispatch(organizationId: string) {
    return dispatchOver(
      committedRows.outbox(organizationId),
      committedRows.importTaskDispatches(organizationId),
    );
  }

  function dispatchCommittedOutbox(outboxId: string, organizationId: string) {
    return committedDispatch(organizationId).dispatchCommittedOutbox(outboxId);
  }

  return {
    /** Hands a committed outbox row of `organizationId` to the background. */
    dispatchCommittedOutbox,

    /** Hands a committed import dispatch of `organizationId` to the background. */
    dispatchImportTask(dispatchId: string, organizationId: string) {
      return committedDispatch(organizationId).dispatchImportTask(dispatchId);
    },

    /**
     * Dispatches the outbox rows a command's events committed: each
     * organisation's events are read, and their rows dispatched, bound to
     * that organisation (D5). D5 says one command's events share one
     * organisation; this does not rely on it. No events: nothing is read. A
     * failed dispatch is swallowed — the rows are committed, and the repair
     * sweep is the durable fallback — but a failed read is not.
     */
    async dispatchCommittedEvents(
      events: readonly { id: string; organizationId: string }[],
    ) {
      const byOrganization = new Map<string, string[]>();

      for (const event of events) {
        const ids = byOrganization.get(event.organizationId) ?? [];
        ids.push(event.id);
        byOrganization.set(event.organizationId, ids);
      }
      for (const [organizationId, eventIds] of byOrganization) {
        const rows = await committedRows
          .outbox(organizationId)
          .idsForEvents(eventIds);
        await Promise.allSettled(
          rows.map((row) => dispatchCommittedOutbox(row.id, organizationId)),
        );
      }
    },

    /**
     * Dispatches the outbox rows committed under `correlationId`, read and
     * dispatched bound to `organizationId`, the organisation the command
     * committed in (D5). Failed dispatches are swallowed, as above.
     */
    async dispatchCommittedCorrelation(
      correlationId: string,
      organizationId: string,
    ) {
      const rows = await committedRows
        .outbox(organizationId)
        .idsForCorrelation(correlationId);
      await Promise.allSettled(
        rows.map((row) => dispatchCommittedOutbox(row.id, organizationId)),
      );
    },

    triggerNotificationDelivery(intentId: string, channel: "email" | "slack") {
      return dispatchOver(
        noCommittedRow,
        noCommittedRow,
      ).triggerNotificationDelivery(intentId, channel);
    },

    triggerSlackConnectionTest(operationId: string) {
      return dispatchOver(
        noCommittedRow,
        noCommittedRow,
      ).triggerSlackConnectionTest(operationId);
    },

    triggerSlackMessageUpdate(operationId: string) {
      return dispatchOver(
        noCommittedRow,
        noCommittedRow,
      ).triggerSlackMessageUpdate(operationId);
    },

    triggerWebhookDelivery(deliveryId: string) {
      return dispatchOver(
        noCommittedRow,
        noCommittedRow,
      ).triggerWebhookDelivery(deliveryId);
    },
  };
}

export type BackgroundPort = ReturnType<typeof createBackgroundPort>;

/**
 * What the job bodies read, from RequestPort's options in place of the
 * environment (`WorkerSettings`, `@requestport/jobs`): the label, defaulting
 * to `"unknown"` as `environment` does; the self-host's service names, since
 * a `postgres` background runs the worker in its caller's own process, and
 * the Trigger.dev worker composes no RequestPort, so no background (ruling
 * 158, item 9); the links' origin; the webhook delivery body's endpoint
 * policy, production exactly when `environment` is `"production"`, and
 * admitting private and loopback receivers exactly when
 * `privateWebhookReceivers` is `true`; the stale-session sweep's key,
 * derived from `commandFingerprintKey` with jobs' own
 * `workSweepFingerprintSecret`, exactly as the Trigger.dev worker derives it
 * from `BETTER_AUTH_SECRET`; and the key rings, the Slack secret and
 * Resend's pair as given.
 *
 * Asynchronous because that function is imported when this runs, from the
 * worker settings' holder (`@requestport/jobs/worker-storages`), through
 * `./worker-holder.js`, so importing core does not load the holder. The
 * holder imports no root (ruling 139, option (b)): neither it nor anything
 * core loads reaches the worker root, `worker-root.ts`, which reaches the
 * lazily parsed server configuration and db's wiring module
 * (`import.test.ts`).
 */
export async function postgresWorkerSettings(
  options: Pick<
    RequestPortOptions,
    "environment" | "publicUrl" | "secrets" | "privateWebhookReceivers"
  >,
): Promise<WorkerSettings> {
  const { workSweepFingerprintSecret } = await import("./worker-holder.js");
  const { secrets } = options;
  return {
    environment: options.environment ?? "unknown",
    serviceNames: "self-host",
    publicUrl: options.publicUrl,
    productionWebhookEndpoints: options.environment === "production",
    privateWebhookReceivers: options.privateWebhookReceivers === true,
    secrets: {
      workSweepFingerprintSecret: workSweepFingerprintSecret(
        secrets.commandFingerprintKey,
      ),
      workspaceKeys: secrets.workspaceKeys,
      slackStateSecret: secrets.slackStateSecret,
      webhookKeys: secrets.webhookKeys,
      email: secrets.email,
    },
  };
}

export interface PostgresBackgroundOptions {
  /** The three worker storages, built by the caller. Core never closes them. */
  workerStorages: WorkerStorages;
  /**
   * What the job bodies read (`postgresWorkerSettings`), or a promise of it,
   * installed once it settles.
   */
  settings: WorkerSettings | PromiseLike<WorkerSettings>;
  /** Where the worker writes its own lines. */
  logger: RequestPortLogger;
  /**
   * The worker's exclusive runner (`RequestPortBackground`'s `postgres`
   * kind). Absent, `createAdvisoryExclusiveRunner` over the dispatcher's
   * storage.
   */
  runExclusive?: Extract<
    RequestPortBackground,
    { kind: "postgres" }
  >["runExclusive"];
}

export interface PostgresBackground {
  /**
   * Settles once the worker has started and its first outbox tick has
   * reached the database; rejects if the worker could not start.
   */
  readonly ready: Promise<void>;
  /**
   * Stops the worker as `requestport-jobs` does on a signal (it stops
   * claiming, and waits for what is running up to its drain deadline). Once
   * it has drained, forgets the process's worker storages and settings, so
   * another background may start. If the deadline passes first, the worker
   * answers `drained: false` and what it was running keeps running, reading
   * them: so they stay installed, and this process refuses another
   * background from then on. Closes no storage. Asked again, answers the
   * first stop. A worker that never started has nothing running, and stops
   * at once, drained.
   */
  stop(): Promise<{ drained: boolean }>;
}

/**
 * The background this process runs, while one runs, and after an undrained
 * stop (`PostgresBackground.stop`).
 */
let running: PostgresBackground | undefined;

/** Where a background installed the storages and the settings. */
type WorkerHolders = typeof import("./worker-holder.js");

/**
 * Forgets what a background installed through `holders`, if it installed
 * anything, so another may start.
 */
function forget(holders: WorkerHolders | undefined) {
  holders?.forgetWorkerHolders();
  running = undefined;
}

/**
 * C's Postgres job worker, started in this process over the caller's worker
 * storages (manifest-g.md §2.4). Once the settings have settled, and then
 * the worker settings' holder, the worker and the catalogue have loaded
 * (`@requestport/jobs/worker-storages`, through `./worker-holder.js`, and
 * `@requestport/jobs/worker` and `/catalogue`), the storages and the settings
 * are installed where the job bodies reach them (`useWorkerStorages`,
 * `useWorkerSettings`), and then the worker is started as `requestport-jobs`
 * starts it — its outbox and import claims on the dispatcher's storage, its
 * ticks held by the caller's exclusive runner or, given none, by advisory
 * locks on that storage, as `requestport-jobs` holds them, and every job's
 * body from the shared catalogue. All three are imported here, when a
 * background starts, so that importing core loads none of them: neither the
 * bodies nor the holder. None of the three reaches the worker root, which
 * `@requestport/jobs`' own module registers with the holder and core never
 * loads (ruling 139, option (b)). Core builds no storage. Refuses while
 * another runs in this process, because what it installs is process-wide.
 *
 * If the worker cannot start, what was installed is forgotten, the logger is
 * told (`worker.start_failed`), and `ready` rejects.
 */
export function startPostgresBackground(
  options: PostgresBackgroundOptions,
): PostgresBackground {
  if (running) {
    throw new DomainError(
      "configuration_error",
      "a Postgres background already runs in this process, and its worker storages and settings are process-wide",
    );
  }
  const { workerStorages: storages, logger } = options;
  let installed: WorkerHolders | undefined;
  const worker = (async () => {
    const settings = await options.settings;
    const [holders, { startJobWorker }, catalogue] = await Promise.all([
      import("./worker-holder.js"),
      import("@requestport/jobs/worker"),
      import("@requestport/jobs/catalogue"),
    ]);
    holders.installWorkerHolders(storages, settings);
    installed = holders;
    return startJobWorker({
      outboxRepository: createOutboxRepository(storages.dispatcher),
      importTaskDispatchRepository: createImportTaskDispatchRepository(
        storages.dispatcher,
      ),
      createHandlers: catalogue.createJobHandlers,
      schedules: catalogue.scheduleDefinitions,
      runExclusive:
        options.runExclusive ??
        createAdvisoryExclusiveRunner(storages.dispatcher),
      logger,
    });
  })();
  const failed = worker.then(
    () => false,
    () => {
      logger.error("worker.start_failed", { errorCode: "worker_start_failed" });
      forget(installed);
      return true;
    },
  );
  const ready = worker.then((started) => started.ready);
  // A caller that never asks whether the worker became ready is told of a
  // failed start by the logger, not by an unhandled rejection.
  ready.catch(() => undefined);
  let stopped: Promise<{ drained: boolean }> | undefined;
  const background: PostgresBackground = {
    ready,
    stop() {
      stopped ??= failed.then(async (didFail) => {
        if (didFail) return { drained: true };
        const result = await (await worker).stop();
        // Undrained, the bodies still running read what was installed:
        // forgetting it would leave them a refusal, or, in a process that has
        // loaded `@requestport/jobs` itself, the worker root's, built from the
        // host's environment.
        if (result.drained) forget(installed);
        return result;
      });
      return stopped;
    },
  };
  running = background;
  return background;
}
