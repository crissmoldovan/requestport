import { containsSensitiveContent } from "../security/sensitive-content.js";
import { DomainError } from "./errors.js";

const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "login",
  "mcp",
  "new",
  "settings",
  "signup",
  "www",
]);

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ValidationField =
  | "actor"
  | "context"
  | "correlationId"
  | "description"
  | "email"
  | "expiresInSeconds"
  | "input"
  | "keyPrefix"
  | "name"
  | "organizationId"
  | "repositoryUrl"
  | "role"
  | "slug"
  | "userId"
  | "value";

const VALIDATION_FIELDS = new Set<string>([
  "actor",
  "context",
  "correlationId",
  "description",
  "email",
  "expiresInSeconds",
  "input",
  "keyPrefix",
  "name",
  "organizationId",
  "repositoryUrl",
  "role",
  "slug",
  "userId",
  "value",
] satisfies ValidationField[]);

export function hasControlCharacters(
  value: unknown,
  allowTextWhitespace = false,
) {
  if (typeof value !== "string") {
    throw validationError("value", "Value must be a string");
  }
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return false;
    if (
      allowTextWhitespace &&
      (codePoint === 9 || codePoint === 10 || codePoint === 13)
    ) {
      return false;
    }
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

export function validationError(field: ValidationField, message: string) {
  const safeField = VALIDATION_FIELDS.has(field) ? field : "value";
  return new DomainError("validation_failed", message, { field: safeField });
}

export function normalizeEmail(email: unknown) {
  if (typeof email !== "string") {
    throw validationError("email", "Email is invalid");
  }
  const normalized = email.trim().normalize("NFC").toLowerCase();
  if (
    normalized.length > 320 ||
    hasControlCharacters(normalized) ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    throw validationError("email", "Email is invalid");
  }
  return normalized;
}

export function normalizeName(name: unknown, field: "name" = "name") {
  if (typeof name !== "string") {
    throw validationError(field, "Name must contain 1 to 120 characters");
  }
  const normalized = name.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    hasControlCharacters(normalized) ||
    containsSensitiveContent(normalized)
  ) {
    throw validationError(field, "Name must contain 1 to 120 characters");
  }
  return normalized;
}

export function normalizeSlug(slug: unknown) {
  if (typeof slug !== "string") {
    throw validationError("slug", "Slug is invalid or reserved");
  }
  const normalized = slug.trim().normalize("NFC").toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 63 ||
    !SLUG_PATTERN.test(normalized) ||
    RESERVED_SLUGS.has(normalized)
  ) {
    throw validationError("slug", "Slug is invalid or reserved");
  }
  return normalized;
}

export function normalizeDescription(description: unknown) {
  if (description === null || description === undefined) return null;
  if (typeof description !== "string") {
    throw validationError(
      "description",
      "Description must not exceed 2000 characters",
    );
  }
  const normalized = description.trim().normalize("NFC");
  if (
    normalized.length > 2_000 ||
    hasControlCharacters(normalized, true) ||
    containsSensitiveContent(normalized)
  ) {
    throw validationError(
      "description",
      "Description must not exceed 2000 characters",
    );
  }
  return normalized.length === 0 ? null : normalized;
}

export function normalizeKeyPrefix(keyPrefix: unknown) {
  if (typeof keyPrefix !== "string") {
    throw validationError(
      "keyPrefix",
      "Project key must be 2 to 10 uppercase letters or digits and start with a letter",
    );
  }
  const normalized = keyPrefix.trim();
  if (!/^[A-Z][A-Z0-9]{1,9}$/u.test(normalized)) {
    throw validationError(
      "keyPrefix",
      "Project key must be 2 to 10 uppercase letters or digits and start with a letter",
    );
  }
  return normalized;
}

export function validateOpaqueId(
  value: unknown,
  field: "correlationId" | "userId",
  maxLength = 255,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw validationError(field, "Identifier is invalid");
  }
  return value;
}

export function validateUuid(value: unknown, field: "organizationId") {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw validationError(field, "Identifier is invalid");
  }
  return value;
}

export function fitsUtf8ByteLimit(value: string, maxBytes: number) {
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}
