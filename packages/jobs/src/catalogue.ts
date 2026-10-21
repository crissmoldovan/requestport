import type { ClaimSettlement } from "@requestport/db";

import { runEmailDelivery } from "./jobs/email-delivery.js";
import { runImportAnalyze } from "./jobs/import-analyze.js";
import { runImportApply } from "./jobs/import-apply.js";
import { repairNotificationDeliveries } from "./jobs/notification-repair.js";
import { recordOperationalMetrics } from "./jobs/operational-metrics.js";
import { deliverOutboxEvent } from "./jobs/outbox-delivery.js";
import { sendQuestionReminders } from "./jobs/question-reminders.js";
import { cleanUpRetention } from "./jobs/retention-cleanup.js";
import {
  repairSlackConnectionTests,
  runSlackConnectionTest,
} from "./jobs/slack-connection-test.js";
import {
  repairSlackMessageUpdates,
  runSlackMessageUpdate,
} from "./jobs/slack-message-update.js";
import { runSlackQuestionDelivery } from "./jobs/slack-question-delivery.js";
import { sweepStaleWorkSessions } from "./jobs/stale-sessions.js";
import {
  repairWebhookDeliveries,
  runWebhookDelivery,
} from "./jobs/webhook-delivery.js";
import { rotateWebhookSecrets } from "./jobs/webhook-secret-rotation.js";
import type { JobName, JobPayloads, JobRunner } from "./port.js";

/**
 * The three jobs that settle the row they were started for (manifest-i2.md
 * §5.1 "Settlement"): each is handed the claim it settles by whatever
 * started it — the poller's lease, or the Trigger.dev run's own id — never
 * by its payload. Only a claim starts one.
 */
export type SettledJobName =
  | "outbox-delivery"
  | "legacy-import-analyze"
  | "legacy-import-apply";

export const settledJobNames: readonly SettledJobName[] = Object.freeze([
  "outbox-delivery",
  "legacy-import-analyze",
  "legacy-import-apply",
]);

export function isSettledJobName(name: string): name is SettledJobName {
  return (settledJobNames as readonly string[]).includes(name);
}

export type JobHandlers = {
  [N in JobName]: N extends SettledJobName
    ? (payload: JobPayloads[N], settlement: ClaimSettlement) => Promise<unknown>
    : (payload: JobPayloads[N]) => Promise<unknown>;
};

/**
 * The body of every job, bound to the runner that will start its children.
 */
export function createJobHandlers(runner: JobRunner): JobHandlers {
  return {
    "outbox-delivery": ({ outboxId }, settlement) =>
      deliverOutboxEvent(outboxId, runner, settlement),
    "webhook-delivery": (payload) => runWebhookDelivery(payload, runner),
    "email-delivery": (payload) => runEmailDelivery(payload),
    "slack-question-delivery": (payload) =>
      runSlackQuestionDelivery(payload, runner),
    "slack-message-update": (payload) => runSlackMessageUpdate(payload, runner),
    "slack-connection-test": (payload) =>
      runSlackConnectionTest(payload, runner),
    "legacy-import-analyze": (payload, settlement) =>
      runImportAnalyze(payload, settlement),
    "legacy-import-apply": (payload, settlement) =>
      runImportApply(payload, runner, settlement),
  };
}

export type ScheduleDefinition = {
  id: string;
  cron: string;
  run: (runner: JobRunner) => Promise<unknown>;
};

/**
 * The schedules both runners run, with the crons Trigger.dev has always used
 * for them.
 *
 * Two Trigger.dev schedules are not here, because they exist only to hand
 * rows to Trigger.dev: `outbox-repair` and `legacy-import-dispatch-repair`
 * claim rows and start runs for them. The Postgres worker drains the same
 * rows itself with its pollers instead.
 */
export const scheduleDefinitions = [
  {
    id: "notification-delivery-repair",
    cron: "*/2 * * * *",
    run: (runner) => repairNotificationDeliveries(runner),
  },
  {
    id: "question-reminders",
    cron: "*/15 * * * *",
    run: (runner) => sendQuestionReminders(runner),
  },
  {
    id: "retention-cleanup",
    cron: "17 3 * * *",
    run: () => cleanUpRetention(),
  },
  {
    id: "stale-work-sessions",
    cron: "*/2 * * * *",
    run: () => sweepStaleWorkSessions(),
  },
  {
    id: "operational-metrics",
    cron: "*/2 * * * *",
    run: () => recordOperationalMetrics(),
  },
  {
    id: "webhook-secret-rotation",
    cron: "*/5 * * * *",
    run: () => rotateWebhookSecrets(),
  },
  {
    id: "webhook-delivery-repair",
    cron: "*/2 * * * *",
    run: (runner) => repairWebhookDeliveries(runner),
  },
  {
    id: "slack-message-update-repair",
    cron: "*/5 * * * *",
    run: (runner) => repairSlackMessageUpdates(runner),
  },
  {
    id: "slack-connection-test-repair",
    cron: "*/10 * * * *",
    run: (runner) => repairSlackConnectionTests(runner),
  },
] as const satisfies readonly ScheduleDefinition[];

export type ScheduleId = (typeof scheduleDefinitions)[number]["id"];

export function scheduleDefinition(id: ScheduleId): ScheduleDefinition {
  const found = scheduleDefinitions.find((definition) => definition.id === id);
  if (!found) throw new Error(`Unknown schedule ${JSON.stringify(id)}`);
  return found;
}
