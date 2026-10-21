import { types } from "node:util";

const MAX_STRING_LENGTH = 4 * 1024;
const MAX_DEPTH = 100;
const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const UNSERIALIZABLE = "[Unserializable]";
const TRUNCATED = "[Truncated]";
const SENSITIVE_KEY =
  /token|secret|password|cookie|authorization|magic|api.?key/i;

function isPlainObject(value: object): boolean {
  if (types.isProxy(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactArray(
  value: unknown[],
  seen: WeakSet<object>,
  depth: number,
): unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    result[index] =
      descriptor && "value" in descriptor
        ? redactLogValue(descriptor.value, seen, depth + 1)
        : UNSERIALIZABLE;
  }

  return result;
}

function redactObject(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable) {
      continue;
    }

    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED;
    } else if ("value" in descriptor) {
      result[key] = redactLogValue(descriptor.value, seen, depth + 1);
    } else {
      result[key] = UNSERIALIZABLE;
    }
  }

  return result;
}

export function redactLogValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return value.slice(0, MAX_STRING_LENGTH);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }

  if (seen.has(value)) {
    return CIRCULAR;
  }

  if (types.isProxy(value)) {
    return UNSERIALIZABLE;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return redactArray(value, seen, depth);
    }

    return isPlainObject(value)
      ? redactObject(value, seen, depth)
      : UNSERIALIZABLE;
  } catch {
    return UNSERIALIZABLE;
  }
}

export function safeLogFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactLogValue(input);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}
