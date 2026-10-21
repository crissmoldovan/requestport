import type { ParsedLegacyRecord } from "../parser/types.js";

export type ImportConflictProposal = {
  kind: string;
  severity: "warning" | "blocking";
  details: Record<string, unknown>;
};
export function analyzeLegacyRecord(input: {
  record: ParsedLegacyRecord;
  relativePath: string;
  sameBasenameCount?: number;
  sameKeyCount?: number;
  alreadyMapped?: boolean;
}) {
  const conflicts: ImportConflictProposal[] = [];
  if (input.alreadyMapped)
    conflicts.push({
      kind: "already_mapped",
      severity: "blocking",
      details: { relativePath: input.relativePath },
    });
  if ((input.sameBasenameCount ?? 0) > 1)
    conflicts.push({
      kind: "divergent_basename",
      severity: "blocking",
      details: { relativePath: input.relativePath },
    });
  if ((input.sameKeyCount ?? 0) > 1)
    conflicts.push({
      kind: "legacy_key_collision",
      severity: "blocking",
      details: { key: input.record.legacyKey?.normalizedKey ?? null },
    });
  if (input.record.warnings.includes("ambiguous_bundle"))
    conflicts.push({
      kind: "ambiguous_bundle",
      severity: "blocking",
      details: { relatedKeys: input.record.relatedLegacyKeys },
    });
  if (input.record.kind === "unknown" || !input.record.title)
    conflicts.push({
      kind: "low_confidence",
      severity: "blocking",
      details: { warnings: input.record.warnings },
    });
  // The parser infers no project from a record's text, so every record this
  // analyses carries this blocking conflict. Review resolves it, and a review
  // decision to create a request from the record must name its target project.
  conflicts.push({
    kind: "missing_project",
    severity: "blocking",
    details: { relativePath: input.relativePath },
  });
  if (
    input.record.bodyMarkdown.length > 100_000 ||
    new TextEncoder().encode(input.record.bodyMarkdown).byteLength > 262_144
  ) {
    conflicts.push({
      kind: "record_too_large",
      severity: "blocking",
      details: {
        characters: input.record.bodyMarkdown.length,
        bytes: new TextEncoder().encode(input.record.bodyMarkdown).byteLength,
      },
    });
  }
  if (input.record.statusClaim)
    conflicts.push({
      kind: "status_claim_requires_review",
      severity: "warning",
      details: { statusClaim: input.record.statusClaim },
    });
  return {
    proposedKind: input.record.kind,
    parsedJson: input.record,
    confidenceJson: input.record.confidence,
    conflicts,
  };
}
