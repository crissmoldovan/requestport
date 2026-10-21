import {
  workerSettingsFromRoot,
  workerStoragesFromRoot,
} from "./worker-root.js";
import {
  registerWorkerRoot,
  useWorkerSettings,
  useWorkerStorages,
} from "./worker-storages.js";

export {
  createJobHandlers,
  isSettledJobName,
  type JobHandlers,
  type ScheduleDefinition,
  type ScheduleId,
  type SettledJobName,
  scheduleDefinition,
  scheduleDefinitions,
  settledJobNames,
} from "./catalogue.js";
export { runJobWorkerCli } from "./cli.js";
export { runEmailDelivery } from "./jobs/email-delivery.js";
export { runImportAnalyze } from "./jobs/import-analyze.js";
export { runImportApply } from "./jobs/import-apply.js";
export { deliverOutboxEvent } from "./jobs/outbox-delivery.js";
export { runSlackConnectionTest } from "./jobs/slack-connection-test.js";
export { runSlackMessageUpdate } from "./jobs/slack-message-update.js";
export { runSlackQuestionDelivery } from "./jobs/slack-question-delivery.js";
export { runWebhookDelivery } from "./jobs/webhook-delivery.js";
export { observeTaskResult, triggerMetrics } from "./observability.js";
export {
  type EnqueueOptions,
  type JobName,
  type JobPayloads,
  type JobRunner,
  jobNames,
} from "./port.js";
export {
  createPostgresJobRunner,
  type PostgresJobRunner,
} from "./postgres/runner.js";
export {
  createScheduler,
  type ExclusiveRunner,
  type ScheduledJob,
} from "./scheduler.js";
export {
  type JobRunnerKind,
  jobRunnerKinds,
  jobRunnerVariable,
  resolveJobRunnerKind,
} from "./selection.js";
export { SettlementPendingError } from "./settlement.js";
export {
  createSlackWebClient,
  withSlackRateLimit,
} from "./slack-rate-limit.js";
export {
  defaultWorkerTiming,
  timingViolations,
  type WorkerTiming,
} from "./timing.js";
export {
  type JobWorker,
  type JobWorkerDependencies,
  type JobWorkerOptions,
  POSTGRES_WORKER_POOL_SIZES,
  startJobWorker,
} from "./worker.js";
export {
  inUnit,
  useWorkerStorages,
  workerStorages,
} from "./worker-storages.js";

/*
 * The worker root, registered with the holder (`worker-storages.ts`) as this
 * module loads (Plan 13, G.7a; ruling 139, option (b)). With nothing
 * installed, a body's first ask builds its storages through
 * `workerStoragesFromRoot(process.env)` and its settings through
 * `workerSettingsFromRoot()`, and installs them, as the holder built them
 * before it stopped importing the root. The storages are bound, one pool
 * per worker role: the root refuses, naming them, unless the three worker
 * variables are set (I.2b's b5; ruling 214 item 1). Registering builds and
 * reads nothing. The Trigger.dev worker's task modules reach this package only
 * through this module, so its storages and settings are the root's.
 * `requestport-jobs` (its executable loads `cli.ts` directly) and core's
 * `postgres` background install their own, and load the holder without this
 * module. `requestport worker` (`apps/requestport`) loads this module for
 * `runJobWorkerCli`, so the root is registered there; that function installs
 * the storages and settings before its worker starts, as `requestport-jobs`
 * does, so the holder never asks the root.
 */
registerWorkerRoot({
  installStorages: () => useWorkerStorages(workerStoragesFromRoot(process.env)),
  installSettings: () => useWorkerSettings(workerSettingsFromRoot()),
});
