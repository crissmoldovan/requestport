import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "@requestport/domain";

import {
  relativeLegacyPath,
  scanLegacySecrets,
  validateLegacyBytes,
} from "./file-policy.js";

export type DiscoveredLegacyFile = {
  relativePath: string;
  mediaType: "text/markdown" | "text/plain";
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
  secretScanStatus: "clear" | "blocked";
};

export const MAX_LEGACY_CAPTURE_FILES = 5_000;
export const MAX_LEGACY_CAPTURE_BYTES = 100 * 1_024 * 1_024;

export async function discoverLegacyFiles(
  explicitRoot: string,
): Promise<DiscoveredLegacyFile[]> {
  const root = await realpath(explicitRoot);
  const discovered: DiscoveredLegacyFile[] = [];
  let totalBytes = 0;
  async function walk(directory: string) {
    for await (const entry of await opendir(directory)) {
      const candidate = path.join(directory, entry.name);
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        try {
          relativeLegacyPath(root, path.join(candidate, "placeholder.md"));
        } catch {
          continue;
        }
        await walk(candidate);
        continue;
      }
      if (!stats.isFile()) continue;
      let relativePath: string;
      try {
        relativePath = relativeLegacyPath(root, candidate);
      } catch {
        continue;
      }
      const canonical = await realpath(candidate);
      relativeLegacyPath(root, canonical);
      const bytes = await readFile(canonical);
      const text = validateLegacyBytes(bytes);
      if (discovered.length >= MAX_LEGACY_CAPTURE_FILES) {
        throw new DomainError(
          "validation_failed",
          "Legacy capture exceeds the file-count limit",
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_LEGACY_CAPTURE_BYTES) {
        throw new DomainError(
          "validation_failed",
          "Legacy capture exceeds the total byte limit",
        );
      }
      discovered.push({
        relativePath,
        mediaType: /\.(?:md|markdown)$/iu.test(relativePath)
          ? "text/markdown"
          : "text/plain",
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
        secretScanStatus: scanLegacySecrets(text),
      });
    }
  }
  await walk(root);
  return discovered.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
}
