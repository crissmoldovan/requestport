import { createHash } from "node:crypto";
import path from "node:path";

import { DomainError } from "@requestport/domain";
import { describe, expect, test } from "vitest";

import {
  analyzeLegacyRecord,
  freezeImportManifest,
  LEGACY_PARSER_VERSION,
  MAX_LEGACY_ARTIFACT_BYTES,
  parseLegacyArtifact,
  relativeLegacyPath,
  scanLegacySecrets,
  validateLegacyBytes,
  validatePreservedArtifact,
} from "./index.js";

describe("legacy file policy", () => {
  test("accepts only relative text artifacts outside excluded and secret paths", () => {
    const root = path.resolve("/tmp/requestport-import");
    expect(
      relativeLegacyPath(root, path.join(root, "handoffs", "FR-12.md")),
    ).toBe("handoffs/FR-12.md");
    expect(() =>
      relativeLegacyPath(root, path.join(root, "..", "FR-12.md")),
    ).toThrow("legacy_path_outside_root");
    expect(() =>
      relativeLegacyPath(root, path.join(root, ".git", "FR-12.md")),
    ).toThrow("legacy_path_excluded");
    expect(() =>
      relativeLegacyPath(root, path.join(root, "prod.credentials.txt")),
    ).toThrow("legacy_secret_file_rejected");
    expect(() =>
      relativeLegacyPath(root, path.join(root, "handoffs", "payload.json")),
    ).toThrow("legacy_media_type_rejected");
  });

  test("rejects binary, invalid UTF-8, oversized, and secret-bearing content", () => {
    expect(() => validateLegacyBytes(Uint8Array.from([65, 0, 66]))).toThrow(
      DomainError,
    );
    expect(() => validateLegacyBytes(Uint8Array.from([0xc3, 0x28]))).toThrow(
      DomainError,
    );
    // Text, and over the ceiling by one byte. A block of zeroes would be
    // refused by the NUL guard below whether or not a size ceiling existed, so
    // it could never tell the two apart — deleting the ceiling outright left
    // this case green. The message is asserted for the same reason: every
    // guard here raises `DomainError`, so the class alone names no guard.
    expect(() =>
      validateLegacyBytes(
        new TextEncoder().encode("a".repeat(MAX_LEGACY_ARTIFACT_BYTES + 1)),
      ),
    ).toThrow(/exceeds the size limit/iu);
    // And the byte that decides it: exactly at the ceiling is allowed through.
    expect(
      validateLegacyBytes(
        new TextEncoder().encode("a".repeat(MAX_LEGACY_ARTIFACT_BYTES)),
      ).length,
    ).toBe(MAX_LEGACY_ARTIFACT_BYTES);
    expect(
      scanLegacySecrets(
        "DATABASE_URL=postgres://user:password@example.invalid/db",
      ),
    ).toBe("blocked");
    expect(scanLegacySecrets("A normal handoff without credentials.")).toBe(
      "clear",
    );
  });
});

describe("legacy parsing and manifest review", () => {
  test("splits only explicit record headings and preserves handoff ambiguity", () => {
    const records = parseLegacyArtifact(
      `# FR-12 Feature request\n\nProject: lighthouse\n\n## Notes\nKeep together.\n\n# HANDOFF-13\n\nRelated FR-12. From lighthouse to harbour.\n`,
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "request",
      legacyKey: { normalizedKey: "FR-12" },
    });
    expect(records[1]).toMatchObject({
      kind: "handoff",
      legacyKey: { normalizedKey: "HANDOFF-13" },
    });
    expect(records[1]?.warnings).toContain("ambiguous_bundle");
  });

  test("requires human resolution for collisions, the record's project, and status claims; the parser infers no project from the text, so a handoff naming two projects gets missing_project, not ambiguous_direction, and carries no project hints", () => {
    const [record] = parseLegacyArtifact(
      "# FR-42 Handoff response\n\nStatus: done\n\nLighthouse and Harbour exchanged this request.",
    );
    expect(record).toBeDefined();
    if (!record) throw new Error("legacy_record_fixture_missing");
    expect(record.kind).toBe("handoff");
    const analyzed = analyzeLegacyRecord({
      record,
      relativePath: "handoffs/fr-42.md",
      sameBasenameCount: 2,
      sameKeyCount: 2,
    });
    const conflicts = analyzed.conflicts.map((item) => [
      item.kind,
      item.severity,
    ]);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        ["divergent_basename", "blocking"],
        ["legacy_key_collision", "blocking"],
        ["missing_project", "blocking"],
        ["status_claim_requires_review", "warning"],
      ]),
    );
    expect(conflicts).not.toContainEqual(["ambiguous_direction", "blocking"]);
    expect(record).not.toHaveProperty("sourceProjectHints");
    expect(record).not.toHaveProperty("targetProjectHints");
  });

  test("names its analysis requestport-legacy-markdown-v3, since v2 inferred project hints from the text, so a run's recorded parser version says which of the two analysed its entries", () => {
    // A run records this version (packages/core's legacy-import.ts, apps/web's
    // imports/actions.ts; a correction run its run's, with `:correction`
    // after it), and it enters the analyze command's receipt (packages/db's
    // import-repository.ts).
    expect(LEGACY_PARSER_VERSION).toBe("requestport-legacy-markdown-v3");
  });

  test("freezes equivalent object input into deterministic canonical evidence", () => {
    const left = freezeImportManifest({ b: 2, a: [1, { z: true }] });
    const right = freezeImportManifest({ a: [1, { z: true }], b: 2 });
    expect(left).toEqual(right);
    expect(left.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("preserved artifact boundary", () => {
  test("accepts exact canonical base64 bytes and reports their content hash", () => {
    const bytes = Buffer.from("# FR-1\n\nA safe request.\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = validatePreservedArtifact({
      relativePath: "feature-requests/FR-1.md",
      mediaType: "text/markdown",
      byteSize: bytes.byteLength,
      sha256,
      base64Bytes: bytes.toString("base64"),
    });
    expect(result).toMatchObject({ sha256, secretScanStatus: "clear" });
    expect(result.bytes).toEqual(bytes);
  });

  test("rejects traversal, noncanonical base64, size, and checksum mismatches", () => {
    const bytes = Buffer.from("safe", "utf8");
    const base = {
      relativePath: "safe.md",
      mediaType: "text/markdown",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      base64Bytes: bytes.toString("base64"),
    };
    expect(() =>
      validatePreservedArtifact({ ...base, relativePath: "../safe.md" }),
    ).toThrow(DomainError);
    expect(() =>
      validatePreservedArtifact({
        ...base,
        base64Bytes: `${base.base64Bytes}=`,
        byteSize: 5,
      }),
    ).toThrow(DomainError);
    expect(() => validatePreservedArtifact({ ...base, byteSize: 99 })).toThrow(
      DomainError,
    );
    expect(() =>
      validatePreservedArtifact({ ...base, sha256: "0".repeat(64) }),
    ).toThrow(DomainError);
  });
});
