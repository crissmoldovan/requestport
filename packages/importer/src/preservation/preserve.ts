import { createHash } from "node:crypto";

import { DomainError } from "@requestport/domain";

import {
  MAX_LEGACY_ARTIFACT_BYTES,
  scanLegacySecrets,
  validateLegacyBytes,
} from "../discovery/file-policy.js";

export function validatePreservedArtifact(input: {
  relativePath: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  base64Bytes: string;
}) {
  if (
    !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/+ -]+$/u.test(
      input.relativePath,
    )
  ) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact path is invalid",
    );
  }
  if (!["text/markdown", "text/plain"].includes(input.mediaType)) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact media type is invalid",
    );
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      input.base64Bytes,
    )
  ) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact encoding is invalid",
    );
  }
  const bytes = Buffer.from(input.base64Bytes, "base64");
  if (bytes.toString("base64") !== input.base64Bytes) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact encoding is invalid",
    );
  }
  if (
    bytes.byteLength > MAX_LEGACY_ARTIFACT_BYTES ||
    bytes.byteLength !== input.byteSize
  ) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact size is invalid",
    );
  }
  const text = validateLegacyBytes(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.sha256) {
    throw new DomainError(
      "validation_failed",
      "Legacy artifact checksum is invalid",
    );
  }
  return { bytes, text, sha256, secretScanStatus: scanLegacySecrets(text) };
}
