export type LogLevel = "debug" | "info" | "warn" | "error";

export type SafeLogFields = {
  environment?: string;
  service?: string;
  correlationId?: string;
  causationId?: string;
  actorType?: string;
  actorId?: string;
  commandName?: string;
  eventId?: string;
  outboxId?: string;
  taskId?: string;
  runId?: string;
  deliveryId?: string;
  dispatchId?: string;
  credentialFingerprint?: string;
  taskKind?: string;
  status?: string;
  durationMs?: number;
  errorCode?: string;
  count?: number;
  metricName?: string;
  metricKind?: string;
  metricValue?: number;
  endpointClass?: string;
  provider?: string;
  providerEventId?: string;
};

const allowedFields = new Set<keyof SafeLogFields>([
  "environment",
  "service",
  "correlationId",
  "causationId",
  "actorType",
  "actorId",
  "commandName",
  "eventId",
  "outboxId",
  "taskId",
  "runId",
  "deliveryId",
  "dispatchId",
  "credentialFingerprint",
  "taskKind",
  "status",
  "durationMs",
  "errorCode",
  "count",
  "metricName",
  "metricKind",
  "metricValue",
  "endpointClass",
  "provider",
  "providerEventId",
]);

function safeEvent(event: string) {
  return /^[a-z0-9][a-z0-9_.-]{0,119}$/u.test(event)
    ? event
    : "invalid_log_event";
}

const tokenFieldNames = new Set<keyof SafeLogFields>([
  "actorType",
  "commandName",
  "endpointClass",
  "errorCode",
  "metricKind",
  "metricName",
  "service",
  "status",
  "taskKind",
  "taskId",
  "provider",
]);

const identifierFieldNames = new Set<keyof SafeLogFields>([
  "actorId",
  "causationId",
  "correlationId",
  "deliveryId",
  "dispatchId",
  "eventId",
  "outboxId",
  "providerEventId",
  "runId",
]);

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    );
  });
}

function safeStringField(key: keyof SafeLogFields, value: string) {
  if (
    value.length === 0 ||
    value.length > 255 ||
    hasControlCharacters(value) ||
    /(?:@|:\/\/|-----BEGIN|\bBearer\b)/iu.test(value) ||
    /^(?:eyJ|gh[opsu]_|github_pat_|sk[-_]|xox[abprs]-|rp[_-])/u.test(value)
  ) {
    return undefined;
  }
  if (key === "credentialFingerprint") {
    return /^[0-9a-f]{8,128}$/iu.test(value) ? value : undefined;
  }
  if (tokenFieldNames.has(key)) {
    return /^[a-z0-9][a-z0-9_.:-]{0,119}$/iu.test(value) ? value : undefined;
  }
  if (identifierFieldNames.has(key)) {
    return /^[a-z0-9][a-z0-9_.:-]{0,95}$/iu.test(value) ? value : undefined;
  }
  return /^[a-z0-9][a-z0-9_.:-]{0,119}$/iu.test(value) ? value : undefined;
}

export function safeLogRecord(
  level: LogLevel,
  event: string,
  fields: SafeLogFields,
) {
  const record: Record<string, string | number> = {
    level,
    event: safeEvent(event),
    timestamp: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key as keyof SafeLogFields) || value === undefined)
      continue;
    if (typeof value === "number" && Number.isFinite(value))
      record[key] = value;
    if (typeof value === "string") {
      const safe = safeStringField(key as keyof SafeLogFields, value);
      if (safe) record[key] = safe;
    }
  }
  return record;
}

export function createLogger(input: {
  service: string;
  environment: string;
  write?: (line: string) => void;
}) {
  const write = input.write ?? ((line: string) => console.log(line));
  function emit(level: LogLevel, event: string, fields: SafeLogFields = {}) {
    write(
      JSON.stringify(
        safeLogRecord(level, event, {
          service: input.service,
          environment: input.environment,
          ...fields,
        }),
      ),
    );
  }
  return {
    debug: (event: string, fields?: SafeLogFields) =>
      emit("debug", event, fields),
    info: (event: string, fields?: SafeLogFields) =>
      emit("info", event, fields),
    warn: (event: string, fields?: SafeLogFields) =>
      emit("warn", event, fields),
    error: (event: string, fields?: SafeLogFields) =>
      emit("error", event, fields),
  };
}

const metricLabelFields = new Set([
  "commandName",
  "endpointClass",
  "errorCode",
  "status",
  "taskId",
]);

function safeMetricToken(value: string) {
  return /^[a-z0-9][a-z0-9_.:-]{0,119}$/iu.test(value) ? value : undefined;
}

export function createMetricSink(input: {
  service: string;
  environment: string;
  write?: (line: string) => void;
}) {
  const logger = createLogger(input);
  function emit(
    kind: "count" | "gauge" | "observe",
    name: string,
    value: number,
    labels: Record<string, string> = {},
  ) {
    if (!Number.isFinite(value)) return;
    const fields: SafeLogFields = {
      metricName: safeMetricToken(name) ?? "invalid_metric",
      metricKind: kind,
      metricValue: value,
    };
    for (const [key, label] of Object.entries(labels)) {
      if (!metricLabelFields.has(key)) continue;
      const safe = safeMetricToken(label);
      if (safe) Object.assign(fields, { [key]: safe });
    }
    logger.info("metric.recorded", fields);
  }
  return {
    count: (name: string, value: number, labels?: Record<string, string>) =>
      emit("count", name, value, labels),
    gauge: (name: string, value: number, labels?: Record<string, string>) =>
      emit("gauge", name, value, labels),
    observe: (name: string, value: number, labels?: Record<string, string>) =>
      emit("observe", name, value, labels),
  };
}
