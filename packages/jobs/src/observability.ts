import { createLogger, createMetricSink } from "@requestport/config/logger";

import {
  type WorkerServiceNames,
  type WorkerSettings,
  workerSettings,
} from "./worker-storages.js";

/*
 * The job bodies' metric sink and loggers, built from this process's worker
 * settings (`worker-storages.ts`) the first time each is used, and again if
 * other settings are installed: a module that holds one reads nothing as it
 * loads, which the Trigger.dev indexer and core's import both need. Each
 * carries the installed settings' label, and the service the settings' names
 * give it (`serviceName`): with the worker root's settings, which name none,
 * the label and the service it always did.
 */

/** The metric sink's service under Trigger.dev's names. */
const TRIGGER_METRICS_SERVICE = "requestport-trigger";

/**
 * The service that `name`, a body's logger's or the metric sink's under
 * Trigger.dev's names, carries under `names` (`WorkerSettings.serviceNames`;
 * ruling 158, item 9). Absent or `"trigger"`, `name` itself. Under
 * `"self-host"`, the metric sink's `requestport-trigger` is
 * `requestport-worker`, and a body's `trigger-` prefix is `requestport-`, so
 * `trigger-retention` is `requestport-retention`.
 */
function serviceName(
  name: string,
  names: WorkerServiceNames | undefined,
): string {
  if (names !== "self-host") return name;
  if (name === TRIGGER_METRICS_SERVICE) return "requestport-worker";
  return name.replace(/^trigger-/u, "requestport-");
}

/** `build`'s value for the installed settings, built once for each settings object. */
function forInstalledSettings<T>(
  build: (settings: WorkerSettings) => T,
): () => T {
  let builtFor: WorkerSettings | undefined;
  let value: T | undefined;
  return () => {
    const settings = workerSettings();
    if (value === undefined || settings !== builtFor) {
      value = build(settings);
      builtFor = settings;
    }
    return value;
  };
}

type TriggerMetricSink = ReturnType<typeof createMetricSink>;

const metricSink = forInstalledSettings((settings) =>
  createMetricSink({
    service: serviceName(TRIGGER_METRICS_SERVICE, settings.serviceNames),
    environment: settings.environment ?? "development",
  }),
);

export const triggerMetrics: TriggerMetricSink = {
  count: (name, value, labels) => metricSink().count(name, value, labels),
  gauge: (name, value, labels) => metricSink().gauge(name, value, labels),
  observe: (name, value, labels) => metricSink().observe(name, value, labels),
};

/**
 * A job module's logger for `service`, its name under Trigger.dev's names,
 * carrying the installed settings' label, or `"unknown"` without one, as each
 * module's logger did when it was built from `VERCEL_ENV ?? NODE_ENV` as the
 * module loaded, and the service the settings' names give `service`
 * (`serviceName`).
 */
export function workerLogger(service: string) {
  const logger = forInstalledSettings((settings) =>
    createLogger({
      service: serviceName(service, settings.serviceNames),
      environment: settings.environment ?? "unknown",
    }),
  );
  type Logger = ReturnType<typeof logger>;
  return {
    debug: (...line: Parameters<Logger["debug"]>) => logger().debug(...line),
    info: (...line: Parameters<Logger["info"]>) => logger().info(...line),
    warn: (...line: Parameters<Logger["warn"]>) => logger().warn(...line),
    error: (...line: Parameters<Logger["error"]>) => logger().error(...line),
  };
}

function resultStatus(result: unknown) {
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    typeof result.status === "string" &&
    /^[a-z0-9_:-]{1,80}$/u.test(result.status)
  ) {
    return result.status;
  }
  return "completed";
}

export async function observeTaskResult<T>(
  taskId: string,
  run: () => Promise<T>,
) {
  try {
    const result = await run();
    triggerMetrics.count("task.result_total", 1, {
      taskId,
      status: resultStatus(result),
    });
    return result;
  } catch (error) {
    triggerMetrics.count("task.result_total", 1, {
      taskId,
      status: "failed",
      errorCode: "task_failed",
    });
    throw error;
  }
}
