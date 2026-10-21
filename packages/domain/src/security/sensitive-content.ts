const secretContentPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bhttps?:\/\/[^\s/@:]+:[^@\s]+@|\b(?:api[_-]?key|authorization|cookie|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|signing[_-]?key|token)\s*[:=]\s*\S{8,}|\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b)/iu;

// Machine telemetry is valid only inside the encrypted workspace envelope. It
// must be removed when text is projected into events, notifications, webhooks,
// logs, or other distributable channels. Relative repository paths remain
// useful product content and are intentionally not matched here.
const privateMachineTelemetryPattern =
  /(?:\b(?:fqdn|host(?:name)?|os[_ -]?user|pwd|repository[_ -]?root|working[_ -]?directory)\s*[:=]\s*\S+|(?:^|[\s"'`(])(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s]+\\|\\\\[^\\\s]+\\[^\\\s]+))/imu;

const secretFieldNames = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "cookie",
  "environment",
  "environmentvalue",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "signingkey",
  "sshkey",
  "token",
]);

const privateTelemetryFieldNames = new Set([
  "fqdn",
  "hostname",
  "osuser",
  "pwd",
  "repositoryroot",
  "workingdirectory",
]);

function normalizedFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function containsUnsafeJson(
  value: unknown,
  options: { privateTelemetry: boolean },
  depth = 0,
): boolean {
  if (depth > 32) return true;
  if (typeof value === "string") {
    return options.privateTelemetry
      ? containsSensitiveContent(value)
      : containsSecretContent(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsUnsafeJson(entry, options, depth + 1));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalized = normalizedFieldName(key);
    return (
      secretFieldNames.has(normalized) ||
      (options.privateTelemetry &&
        privateTelemetryFieldNames.has(normalized)) ||
      containsUnsafeJson(entry, options, depth + 1)
    );
  });
}

export const sensitiveContentOmitted =
  "[Sensitive content omitted — open RequestPort]";

export function containsSecretContent(value: string) {
  return secretContentPattern.test(value);
}

export function containsSensitiveContent(value: string) {
  return (
    containsSecretContent(value) || privateMachineTelemetryPattern.test(value)
  );
}

export function containsSecretJson(value: unknown) {
  return containsUnsafeJson(value, { privateTelemetry: false });
}

export function containsSensitiveJson(value: unknown) {
  return containsUnsafeJson(value, { privateTelemetry: true });
}

export function redactSensitiveText(value: string) {
  return containsSensitiveContent(value) ? sensitiveContentOmitted : value;
}
