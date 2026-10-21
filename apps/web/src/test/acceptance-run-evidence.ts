import { type Json, type Schema, validate } from "./json-schema.js";

/**
 * The checker one accepted run's evidence has to answer to.
 *
 * There are two kinds of claim in that document and only one of them is a
 * schema's to make. `additionalProperties: false` with `const`, `enum` and
 * `pattern` is what refuses a credential, an address, a path, a message, an
 * artifact nobody hashed, a failing outcome, and a field a rerun of the same
 * commit would change: each is a property or a value, and each is decided by
 * looking at the document alone.
 *
 * The rest are relations between the document and the case table beside it, and
 * no JSON Schema in this subset can express one. A schema can require a
 * 40-character head SHA and a 40-character accepted SHA; it cannot require them
 * to be the *same* commit, which is the whole meaning of "keyed to
 * `github.sha`". It can require `results` to have unique entries; it cannot
 * notice that two of them name one case with different attempt counts, nor that
 * a declared case has no entry at all, nor that an entry names a case the table
 * never declared. And it cannot notice that every case on one engine was
 * skipped — the exact shape a run takes on a host that cannot drive WebKit, and
 * the reason a green report is not by itself evidence of two-engine coverage.
 *
 * `validateRunEvidence` is the whole check, so a caller cannot get half of it by
 * accident, and so a document can be pointed at one name. Two callers ask for
 * it: `acceptance-run-evidence.test.ts`, which `pnpm test` runs in CI and which
 * feeds it one hostile document per refusal, and
 * `scripts/write-run-evidence.mjs`, which hands it the document CI is about to
 * seal and refuses to write one it rejects. The second is what keeps the
 * producer answerable to the schema rather than to its own reading of it.
 */

/** The relational half of the check, as sorted `path: reason` lines. */
export function runEvidenceProblems(
  evidence: Readonly<{
    acceptedApplicationSha: string;
    gates: readonly string[];
    matrix: Readonly<{ sha256: string }>;
    results: readonly Readonly<{ id: string; outcome: string }>[];
    workflow: Readonly<{ headSha: string }>;
  }>,
  table: Readonly<{
    cases: readonly Readonly<{ engine: string; id: string }>[];
    sha256: string;
  }>,
  gateNames: readonly string[],
): string[] {
  const problems: string[] = [];

  if (evidence.workflow.headSha !== evidence.acceptedApplicationSha) {
    problems.push(
      "$.workflow.headSha: not the accepted application SHA this run sealed",
    );
  }
  if (evidence.matrix.sha256 !== table.sha256) {
    problems.push(
      "$.matrix.sha256: not the case table checked in beside this schema",
    );
  }

  const counted = new Map<string, number>();
  for (const entry of evidence.results) {
    counted.set(entry.id, (counted.get(entry.id) ?? 0) + 1);
  }
  const declared = new Map(table.cases.map((entry) => [entry.id, entry]));
  for (const [id, count] of counted) {
    if (!declared.has(id)) problems.push(`$.results: undeclared ${id}`);
    if (count > 1) problems.push(`$.results: repeated ${id}`);
  }
  for (const id of declared.keys()) {
    if (!counted.has(id)) problems.push(`$.results: missing ${id}`);
  }

  for (const name of gateNames) {
    if (!evidence.gates.includes(name)) {
      problems.push(`$.gates: missing ${name}`);
    }
  }

  // An engine whose every case was skipped ran nothing. That is precisely how
  // a host that cannot drive WebKit reports, and it is indistinguishable from
  // full coverage in any tally that only counts failures.
  const ran = new Map<string, boolean>();
  for (const entry of table.cases) {
    const outcome = evidence.results.find(
      (result) => result.id === entry.id,
    )?.outcome;
    ran.set(
      entry.engine,
      (ran.get(entry.engine) ?? false) || outcome === "passed",
    );
  }
  for (const [engine, any] of ran) {
    if (!any) problems.push(`$.results: every ${engine} case was skipped`);
  }

  return [...new Set(problems)].sort();
}

export type RunEvidenceExpectations = Readonly<{
  gates: readonly string[];
  schema: Schema;
  table: Readonly<{
    cases: readonly Readonly<{ engine: string; id: string }>[];
    sha256: string;
  }>;
}>;

/**
 * Every way one document fails to be evidence for an accepted run.
 *
 * Shape first, relations second, and the relations are not asked at all while
 * the shape is wrong: `runEvidenceProblems` reads `results`, `gates`,
 * `workflow.headSha` and `matrix.sha256` as the types it was given, and a
 * document that does not have them is not a document those questions have an
 * answer for. Reporting the structural refusal on its own is also the more
 * useful answer — a reader fixes the shape before the relations can mean
 * anything.
 */
export function validateRunEvidence(
  document: Json,
  { gates, schema, table }: RunEvidenceExpectations,
): string[] {
  const structural = validate(schema, document);
  if (structural.length > 0) return [...new Set(structural)].sort();

  return runEvidenceProblems(
    document as unknown as Parameters<typeof runEvidenceProblems>[0],
    table,
    gates,
  );
}
