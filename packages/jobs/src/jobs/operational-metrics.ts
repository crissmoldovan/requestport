import { createOperationalMetricsRepository } from "@requestport/db";

import { observeTaskResult, triggerMetrics } from "../observability.js";
import { workerStorages } from "../worker-storages.js";

export const recordOperationalMetrics = () =>
  observeTaskResult("operational-metrics", async () => {
    // Function 15, on the maintenance storage (track-i2.md, "I.2b design" §3).
    const snapshot = await createOperationalMetricsRepository(
      workerStorages().maintenance,
    ).snapshot();
    triggerMetrics.gauge("outbox.pending_total", snapshot.pendingOutbox, {
      status: "backlog",
      taskId: "operational-metrics",
    });
    triggerMetrics.gauge(
      "outbox.oldest_age_seconds",
      snapshot.oldestOutboxSeconds,
      { status: "backlog", taskId: "operational-metrics" },
    );
    triggerMetrics.gauge(
      "webhook.dead_letter_total",
      snapshot.deadLetterWebhooks,
      { status: "dead_letter", taskId: "operational-metrics" },
    );
    triggerMetrics.gauge(
      "notification.backlog_total",
      snapshot.notificationBacklog,
      { status: "backlog", taskId: "operational-metrics" },
    );
    triggerMetrics.gauge("work_session.stale_total", snapshot.staleSessions, {
      status: "backlog",
      taskId: "operational-metrics",
    });
    triggerMetrics.gauge(
      "import.conflict_total",
      snapshot.openImportConflicts,
      { status: "blocking", taskId: "operational-metrics" },
    );
    triggerMetrics.gauge(
      "slack.operation_backlog_total",
      snapshot.slackOperationBacklog,
      { status: "backlog", taskId: "operational-metrics" },
    );
    triggerMetrics.gauge(
      "import.dispatch_dead_letter_total",
      snapshot.deadLetterImportDispatches,
      { status: "dead_letter", taskId: "operational-metrics" },
    );
    return { status: "recorded", count: 8 };
  });
