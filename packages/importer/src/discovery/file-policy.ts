import path from "node:path";

import { DomainError } from "@requestport/domain";

export const MAX_LEGACY_ARTIFACT_BYTES = 1_048_576;
const EXCLUDED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".vercel",
]);
const SECRET_FILE =
  /(?:^|[._-])(?:env|credentials?|secrets?|private[_-]?key|id_rsa)(?:$|[._-])/iu;

export function relativeLegacyPath(root: string, file: string) {
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("legacy_path_outside_root");
  const posix = relative.split(path.sep).join("/");
  if (posix.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment)))
    throw new Error("legacy_path_excluded");
  if (SECRET_FILE.test(path.basename(posix)))
    throw new Error("legacy_secret_file_rejected");
  if (!/\.(?:md|markdown|txt)$/iu.test(posix))
    throw new Error("legacy_media_type_rejected");
  return posix;
}

export function validateLegacyBytes(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_LEGACY_ARTIFACT_BYTES) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact exceeds the size limit",
    );
  }
  if (bytes.includes(0)) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact must contain text",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact must use UTF-8",
    );
  }
}

export function scanLegacySecrets(text: string) {
  const credentialAssignment =
    /\b(?:access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret|cookie|database[_-]?url|password|private[_-]?key|secret|session|signing[_-]?key|token)\s*[:=]\s*["']?[^\s"']{12,}/iu;
  const knownCredential =
    /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bgh[opsu]_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b|\bre_[A-Za-z0-9_-]{20,}\b|\brp_[A-Za-z0-9_-]{20,}\b)/u;
  const jwt =
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u;
  return credentialAssignment.test(text) ||
    knownCredential.test(text) ||
    jwt.test(text)
    ? ("blocked" as const)
    : ("clear" as const);
}
