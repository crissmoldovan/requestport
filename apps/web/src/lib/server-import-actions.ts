import type { RequestPort } from "@requestport/core";
import { DomainError, importRelationshipTypes } from "@requestport/domain";
import { z } from "zod";
import { webRequestPort } from "./server-web-request-port.js";

/*
  Import review's code that cannot live in `packages/domain` (Plan 13, F.2.6;
  `manifest-f2.md`, F.2.6 **Owns**): the split, and the text the two review
  forms submit. Reviewing an entry is the bus command
  `review_legacy_import_entry`; splitting one is `splitImportEntry` below,
  which the split form calls as the signed-in person, and which `/api/v1`
  reaches for an operator credential: the registry entry
  `split_legacy_import_entry` is dispatched to `import-split` and admits
  operators only (Plan 13, F.2.6's registry half; ruling 25).

  The split is core's, as the web's RequestPort composes it
  (`webRequestPort().handlers`; Plan 13, G.6, ruling 137):
  `packages/core/src/import-split.ts` writes down what it checks, in which
  order, and which receipt it keeps. The RequestPort opens the split's one
  transaction on the web root's storage, with every repository the split
  asks for opened on it — the re-check's under the deployment's
  REQUESTPORT_OPERATOR_CREDENTIALS, read from `serverEnv` as that repository
  opens, so it refuses every operator unless that is `enabled`. The receipt
  is keyed with `BETTER_AUTH_SECRET`, read from `serverEnv` when each split
  runs.
*/

/**
 * The preserved record cut into its segments, each parsed as one legacy
 * record: core's (`@requestport/core/adapters`), exported here for the web's
 * modules and suites that read it.
 */
export { legacySegments } from "@requestport/core/adapters";

/**
 * Split an import entry (core's `splitImportEntry`): its preserved record is
 * cut before each line the input names and each segment becomes an entry of
 * its own, for review, in one transaction on the web root's storage.
 */
export const splitImportEntry: RequestPort["handlers"]["splitImportEntry"] = (
  context,
  input,
  meta,
) => webRequestPort().handlers.splitImportEntry(context, input, meta);

/**
 * The split form's lines, as it has always read them: numbers separated by
 * spaces or commas, each 2 or more, kept once each and in order. A value
 * that is not such a number is a schema error; fewer than one or more than
 * nineteen distinct lines is refused.
 */
export function splitLinesFromText(text: string) {
  const splitLines = [
    ...new Set(
      text
        .split(/[\s,]+/u)
        .filter(Boolean)
        .map((value) => z.coerce.number().int().min(2).parse(value)),
    ),
  ].sort((left, right) => left - right);
  if (splitLines.length < 1 || splitLines.length > 19) {
    throw new DomainError(
      "validation_failed",
      "A manual split requires between one and nineteen split lines",
    );
  }
  return splitLines;
}

const relationshipLine = z.object({
  type: z.enum(importRelationshipTypes),
  targetRequestId: z.uuid(),
});

/**
 * The review form's relationships, as it has always read them: one
 * `type:request-id` per line, blank lines skipped, each kept once. A line
 * that is not one is a schema error; more than twenty is refused.
 */
export function relationshipsFromLines(text: string) {
  const parsed = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      return relationshipLine.parse(
        separator > 0
          ? {
              type: line.slice(0, separator),
              targetRequestId: line.slice(separator + 1),
            }
          : {},
      );
    });
  const relationships = [
    ...new Map(
      parsed.map((relationship) => [
        `${relationship.type}:${relationship.targetRequestId}`,
        relationship,
      ]),
    ).values(),
  ];
  if (relationships.length > 20) {
    throw new DomainError(
      "validation_failed",
      "An import entry may define at most 20 relationships",
    );
  }
  return relationships;
}
