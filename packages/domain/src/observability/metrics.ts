export const requestPortMetricNames = [
  "command.duration_ms",
  "command.error_total",
  "command.conflict_total",
  "outbox.pending_total",
  "outbox.oldest_age_seconds",
  "task.result_total",
  "webhook.delivery_total",
  "notification.delivery_total",
  "mcp.tool_duration_ms",
  "mcp.tool_error_total",
  "work_session.stale_total",
  "import.conflict_total",
  "rate_limit.decision_total",
  "encryption.rewrap_total",
  "notification.repair_due",
  "import.dispatch_repair_claimed",
  "webhook.dead_letter_total",
  "notification.backlog_total",
  "slack.operation_backlog_total",
  "import.dispatch_dead_letter_total",
] as const;

export type RequestPortMetricName = (typeof requestPortMetricNames)[number];

export interface MetricSink {
  count(
    name: RequestPortMetricName,
    value: number,
    labels?: Record<string, string>,
  ): void;
  observe(
    name: RequestPortMetricName,
    value: number,
    labels?: Record<string, string>,
  ): void;
  gauge(
    name: RequestPortMetricName,
    value: number,
    labels?: Record<string, string>,
  ): void;
}

export const noopMetricSink: MetricSink = {
  count() {},
  observe() {},
  gauge() {},
};
