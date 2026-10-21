import { createHash, createHmac } from "node:crypto";

import { DomainError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError("validation_failed", "Input must be JSON-safe");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new DomainError("validation_failed", "Input must be JSON-safe");
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function normalizedInputHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function keyedFingerprint(secret: string, value: string) {
  if (secret.length < 32) {
    throw new Error("RequestPort command fingerprint secret is invalid");
  }
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function validateCommandMeta(meta: unknown): asserts meta is {
  idempotencyKey: string;
  expectedVersion: number;
} {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new DomainError("validation_failed", "Command metadata is invalid");
  }
  const value = meta as Record<string, unknown>;
  if (
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length < 16 ||
    value.idempotencyKey.length > 200 ||
    value.idempotencyKey !== value.idempotencyKey.trim()
  ) {
    throw new DomainError("validation_failed", "Idempotency key is invalid");
  }
  if (
    typeof value.expectedVersion !== "number" ||
    !Number.isInteger(value.expectedVersion) ||
    value.expectedVersion < 0
  ) {
    throw new DomainError("validation_failed", "Expected version is invalid");
  }
}
