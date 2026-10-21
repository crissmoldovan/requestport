import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, type TestContext, test } from "vitest";

import { kind as hostedDeploymentKind } from "../../../../scripts/hosted-deployment.mjs";

import {
  runEvidenceProblems,
  validateRunEvidence,
} from "./acceptance-run-evidence.js";
import {
  type Json,
  readJson,
  resolveRef,
  type Schema,
  validate,
} from "./json-schema.js";

/**
 * The run-evidence artifact, and the schema it answers to.
 *
 * The case table and this document are deliberate opposites, and the whole
 * point of this suite is to keep them that way. The table says what is to be
 * run and never what happened; this document says what happened and never what
 * a case is. Neither can be mistaken for the other, because neither contains a
 * single field the other declares — the table has `cases` with themes,
 * densities, viewports and owners; the evidence has `results`, which are case
 * *identifiers* and outcomes and nothing else.
 *
 * That is not tidiness. A table a run rewrites cannot be the thing a run is
 * checked against, and evidence that restates the catalogue can disagree with
 * it. So the evidence binds to the table by digest and then refers to it only
 * by identifier: read together they are the whole picture, and neither half
 * can be edited into the other.
 *
 * The document also has no vocabulary for a failure. Step 8 of the plan seals
 * "the immutable CI/Actions run-evidence artifact **for the accepted
 * application SHA**" — this artifact exists only for a run that passed, so CI
 * must not write it for a run that did not, and it cannot be used to launder a
 * red run into a green record. A reader who needs to know why a run failed
 * reads that run's logs, which `workflow.runId` addresses.
 */

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

/**
 * Skips the running case, naming `paths`, when the tree declares itself
 * public (manifest-j.md §2.4 item 6, Appendix A.3; ruling 92):
 * `scripts/hosted-deployment.mjs`'s `kind`, read through its declaration,
 * `hosted-deployment.d.mts`, is "public" there, as the seed's substitution
 * makes it, and the seed does not carry `paths`. In this private tree it skips
 * nothing, so a missing path still fails the case, and
 * `scripts/private-paths.test.mjs` fails if a path named here is gone.
 */
function skipInPublicTree(ctx: TestContext, ...paths: string[]) {
  ctx.skip(
    hostedDeploymentKind === "public",
    `the public tree does not carry ${paths.join(", ")} (scripts/hosted-deployment.mjs declares kind "public")`,
  );
}
const acceptanceRoot = resolve(
  repositoryRoot,
  "docs/implementation/acceptance",
);
const matrixPath = resolve(
  acceptanceRoot,
  "requestport-cue-reskin-matrix.json",
);
const schemaPath = resolve(
  acceptanceRoot,
  "requestport-cue-reskin-run-evidence.schema.json",
);
const matrixSchemaPath = resolve(
  acceptanceRoot,
  "requestport-cue-reskin-matrix.schema.json",
);

const schema = readJson(schemaPath) as Schema;
const schemaText = readFileSync(schemaPath, "utf8");
const matrixSchema = readJson(matrixSchemaPath) as Schema;

type MatrixCase = { engine: string; id: string };
const matrix = readJson(matrixPath) as unknown as { cases: MatrixCase[] };
const matrixDigest = createHash("sha256")
  .update(readFileSync(matrixPath))
  .digest("hex");

/** The bound table, as the checker takes it: the cases and the digest. */
function table() {
  return { cases: matrix.cases, sha256: matrixDigest };
}

/** The gate names the schema declares, which every accepted run must carry. */
function gates(): string[] {
  return resolveRef(schema, "#/$defs/gate").enum as string[];
}

/* ------------------------------------------------------------------ *
 * The document shape, and a conforming example.
 * ------------------------------------------------------------------ */

type RunEvidence = {
  $schema: string;
  acceptedApplicationSha: string;
  artifacts: { name: string; sha256: string; sizeBytes: number }[];
  gates: string[];
  kind: string;
  matrix: { path: string; sha256: string };
  results: { attempts: number; id: string; outcome: string }[];
  retentionDays: number;
  version: number;
  workflow: {
    headSha: string;
    path: string;
    repository: string;
    runAttempt: number;
    runId: string;
  };
};

const acceptedSha = "b6c1f0e3a48d2c7519fb0d4e8a3c6217de905f4b";

/**
 * A document CI could actually emit, built from the checked-in table.
 *
 * A result for every declared case cannot be hand-written without becoming a
 * second copy of the table, so the example is derived from the table exactly
 * the way a run's would be: one result per declared case, in the table's own
 * order. What the example proves is that the *shape* is satisfiable and admits
 * nothing else; the checks below then break it deliberately, one way at a time.
 */
function exampleEvidence(): RunEvidence {
  return {
    $schema: "./requestport-cue-reskin-run-evidence.schema.json",
    acceptedApplicationSha: acceptedSha,
    artifacts: [
      {
        name: "browser-failure-artifacts",
        sha256:
          "9f2c4b8a1d6e0357c9ab4f21d80e6b35a7c1904de2f6b83a05c7d1e94b6f20a8",
        sizeBytes: 41_237,
      },
    ],
    gates: [
      "browser-acceptance",
      "build",
      "lint",
      "migration-history",
      "migration-race",
      "typecheck",
      "unit-tests",
    ],
    kind: "run-evidence",
    matrix: {
      path: "docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
      sha256: matrixDigest,
    },
    results: matrix.cases.map((entry) => ({
      attempts: 1,
      id: entry.id,
      outcome: "passed",
    })),
    retentionDays: 14,
    version: 1,
    workflow: {
      headSha: acceptedSha,
      path: ".github/workflows/verify-reusable.yml",
      repository: "cueplusplus/requestport",
      runAttempt: 1,
      runId: "33190770436",
    },
  };
}

/* ------------------------------------------------------------------ *
 * Vocabularies the schema must and must not declare.
 * ------------------------------------------------------------------ */

function declaredPropertyNames(document: Json): Set<string> {
  const names = new Set<string>();
  const walk = (value: Json, insideProperties: boolean) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, false);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (insideProperties) names.add(key);
      walk(entry, key === "properties");
    }
  };
  walk(document, false);

  return names;
}

function stringsIn(value: Json, path = "$"): [string, string][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      stringsIn(entry, `${path}[${index}]`),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      stringsIn(entry, `${path}.${key}`),
    );
  }

  return typeof value === "string" ? [[path, value]] : [];
}

function enumOf(property: string): string[] {
  const properties = schema.properties as { [key: string]: Schema };
  const entry = properties[property] as Schema;
  const resolved =
    typeof entry.$ref === "string" ? resolveRef(schema, entry.$ref) : entry;

  return (resolved.enum as string[]) ?? [];
}

/** The gate names, and the command in the reusable workflow each one records. */

describe("acceptance run evidence", () => {
  test("is checked in beside the case table it answers about", () => {
    expect(existsSync(schemaPath)).toBe(true);
    expect(schema.$id).toBe(
      "https://requestport.com/schemas/requestport-cue-reskin-run-evidence.schema.json",
    );
  });

  test("bounds a number rather than merely typing it", () => {
    // `minimum`/`maximum` are new to the shared validator, so both directions
    // are planted: a validator that ignored them would report nothing here and
    // nothing on a correct document, and look identical.
    const bounded: Schema = { type: "integer", minimum: 1, maximum: 90 };

    expect(validate(bounded, 14)).toEqual([]);
    expect(validate(bounded, 0)).toEqual(["$: below the minimum 1"]);
    expect(validate(bounded, 91)).toEqual(["$: above the maximum 90"]);
  });

  test("reports a reference it cannot resolve instead of dying on it", () => {
    // A sub-schema validated without its root is the ordinary way to reach
    // this, and it used to surface as a `TypeError` naming the resolver rather
    // than the reference. A validator that stops partway has checked an
    // unknown fraction of the document, which is worse than one that says so.
    expect(validate({ $ref: "#/$defs/absent" }, 1)).toEqual([
      "$: unresolvable #/$defs/absent",
    ]);
    expect(
      validate(resolveRef(schema, "#/$defs/artifact"), {
        name: "browser-failure-artifacts",
        sha256: "0".repeat(64),
        sizeBytes: 1,
      }),
    ).toEqual(["$.name: unresolvable #/$defs/artifactName"]);
  });

  test("accepts a document CI could actually emit", () => {
    expect(validate(schema, exampleEvidence() as unknown as Json)).toEqual([]);
  });

  test("cannot be confused with the case table in either direction", () => {
    // The one-line discriminator, before any structural argument: the two
    // documents disagree about what they are.
    expect(schema.properties).toHaveProperty("kind");
    expect(matrixSchema.properties).not.toHaveProperty("kind");

    const evidence = exampleEvidence() as unknown as Json;
    const table = readJson(matrixPath);

    expect(validate(matrixSchema, evidence)).not.toEqual([]);
    expect(validate(schema, table)).not.toEqual([]);
  });

  test("declares no case attribute the table already owns", () => {
    const evidenceNames = declaredPropertyNames(schema);
    const tableNames = declaredPropertyNames(matrixSchema);
    const shared = [...evidenceNames].filter((name) => tableNames.has(name));

    // Exactly three names appear in both files, and each is deliberate.
    // `$schema` and `version` are how any checked-in document says what it is.
    // `id` is the join key — the one thing the evidence borrows from the table,
    // and borrowing *only* the identifier is precisely what stops the two from
    // becoming copies of each other. The evidence binds the table by `path` and
    // `sha256`; the table binds no document (ruling 175), so it declares
    // neither. A fourth shared name would mean a case attribute had leaked into
    // the evidence, or the table had been bound to a document again.
    expect(shared.sort()).toEqual(["$schema", "id", "version"]);
    for (const attribute of [
      "cases",
      "cleanupOwner",
      "density",
      "engine",
      "engines",
      "fixtureOwner",
      "lane",
      "lanes",
      "mode",
      "scheme",
      "state",
      "surface",
      "theme",
      "viewport",
      "viewports",
    ]) {
      expect({ attribute, declared: evidenceNames.has(attribute) }).toEqual({
        attribute,
        declared: false,
      });
    }
  });

  test("declares no field a rerun of the same commit would change", () => {
    const declared = declaredPropertyNames(schema);

    for (const name of [
      "actor",
      "branch",
      "completedAt",
      "date",
      "duration",
      "durationMs",
      "elapsed",
      "elapsedMs",
      "finishedAt",
      "hostname",
      "os",
      "ref",
      "recordedAt",
      "runner",
      "startedAt",
      "time",
      "timestamp",
      "triggeringActor",
    ]) {
      expect({ name, declared: declared.has(name) }).toEqual({
        name,
        declared: false,
      });
    }
  });

  test("declares no vocabulary for free-form text of any kind", () => {
    const declared = declaredPropertyNames(schema);

    for (const name of [
      "body",
      "detail",
      "error",
      "errors",
      "headers",
      "log",
      "logs",
      "message",
      "output",
      "payload",
      "reason",
      "request",
      "response",
      "stack",
      "stderr",
      "stdout",
      "title",
      "url",
    ]) {
      expect({ name, declared: declared.has(name) }).toEqual({
        name,
        declared: false,
      });
    }

    // The consequence, said once where a reader meets it: there is no outcome
    // that carries an explanation, because there is no failing outcome at all.
    expect(
      (resolveRef(schema, "#/$defs/result").properties as { outcome: Schema })
        .outcome.enum,
    ).toEqual(["passed", "skipped"]);
  });

  test("carries nothing that authenticates, addresses or locates anybody", () => {
    const exampleText = JSON.stringify(exampleEvidence(), null, 2);
    const documents: [string, string][] = [
      ["schema", schemaText],
      ["example", exampleText],
    ];

    // A conforming document carries no absolute address at all. The schema
    // carries exactly two, and both are schema identifiers rather than
    // anything a run reached: a third would be a provider endpoint that had
    // found its way in.
    expect(exampleText).not.toMatch(/https?:\/\//u);
    expect(schemaText.match(/https?:\/\/[^"]+/gu)).toEqual([
      "https://json-schema.org/draft/2020-12/schema",
      "https://requestport.com/schemas/requestport-cue-reskin-run-evidence.schema.json",
    ]);

    for (const [name, text] of documents) {
      expect({
        name,
        matched: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(text),
      }).toEqual({ name, matched: false });
      expect({
        name,
        matched:
          /(?:^|["\s])(?:\/(?:Users|home|private|var|tmp|opt)\/|[A-Z]:\\)/u.test(
            text,
          ),
      }).toEqual({ name, matched: false });
      expect({
        name,
        matched:
          /\b(?:secret|password|token|bearer|api[_-]?key|authorization|credential)\b/iu.test(
            text,
          ),
      }).toEqual({ name, matched: false });
    }
  });

  test("admits no free-form string anywhere in a conforming document", () => {
    const allowed = new Set<string>([
      "./requestport-cue-reskin-run-evidence.schema.json",
      "docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
    ]);
    for (const property of ["kind", "retentionDays"]) {
      for (const value of enumOf(property)) allowed.add(value);
    }
    for (const value of [
      ...enumOf("gates"),
      ...(resolveRef(schema, "#/$defs/gate").enum as string[]),
      ...(resolveRef(schema, "#/$defs/artifactName").enum as string[]),
    ]) {
      allowed.add(value);
    }
    allowed.add("run-evidence");
    allowed.add("cueplusplus/requestport");
    allowed.add(".github/workflows/verify-reusable.yml");
    allowed.add("passed");
    allowed.add("skipped");

    const unexplained = stringsIn(exampleEvidence() as unknown as Json)
      .filter(([, value]) => {
        if (allowed.has(value)) return false;
        if (/^(?:appearance|route-state)-[0-9]{4}$/u.test(value)) return false;
        if (/^[0-9a-f]{40}$/u.test(value)) return false;
        if (/^[0-9a-f]{64}$/u.test(value)) return false;
        if (/^[1-9][0-9]{0,19}$/u.test(value)) return false;

        return true;
      })
      .map(([path, value]) => `${path}: ${value}`);

    expect(unexplained.sort()).toEqual([]);
  });

  test("names no artifact it has not hashed", () => {
    const artifact = resolveRef(schema, "#/$defs/artifact");

    expect((artifact.required as string[]).sort()).toEqual([
      "name",
      "sha256",
      "sizeBytes",
    ]);
    expect(
      validate(
        artifact,
        { name: "browser-failure-artifacts", sizeBytes: 1 },
        schema,
      ),
    ).toEqual(["$: missing sha256"]);

    // Every other file-looking string in a conforming document is accounted
    // for: the schema reference is this document's own, the case table is
    // bound by digest, and the workflow file is pinned by the accepted
    // application SHA, which is the commit it was read from.
    const files = stringsIn(exampleEvidence() as unknown as Json)
      .filter(([, value]) => /\.[a-z0-9]{2,4}$/u.test(value))
      .map(([, value]) => value);

    expect([...new Set(files)].sort()).toEqual([
      "./requestport-cue-reskin-run-evidence.schema.json",
      ".github/workflows/verify-reusable.yml",
      "docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
    ]);
  });

  test("orders its keys so two writings of one run are one file", () => {
    const evidence = exampleEvidence() as unknown as Record<string, unknown>;
    const keys = Object.keys(evidence);

    expect(keys[0]).toBe("$schema");
    expect(keys.slice(1)).toEqual([...keys.slice(1)].sort());
    expect((schema.required as string[]).slice().sort()).toEqual(
      keys.slice().sort(),
    );
  });

  test("names every gate exactly once, in the vocabulary the document uses", () => {
    // This used to hold each gate name against a command in
    // `.github/workflows/verify-reusable.yml`, so the schema could not name a
    // gate CI did not run. There is no CI and no workflow, and nothing writes
    // this document any more — `scripts/write-run-evidence.mjs` went with the
    // workflows on 2026-09-18. The format is kept, dormant, because the local
    // gate could produce it later and the shared validator is exercised against
    // it below; what is gone is the binding, so this asserts what is still
    // checkable: the vocabulary is a set, sorted, with nothing repeated.
    const declared = resolveRef(schema, "#/$defs/gate").enum as string[];

    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.slice()).toEqual([...declared].sort());
  });

  test("bounds attempts by the retry policy the browser config sets", () => {
    const config = readFileSync(
      resolve(repositoryRoot, "apps/web/playwright.config.ts"),
      "utf8",
    );

    // A retry means an attempt more. The bound is read out of the policy the
    // config declares rather than restated beside it, because a bound larger
    // than the policy would let evidence claim a case the runner cannot have
    // run that many times — and a bound written down separately is the copy
    // that goes stale when the policy moves, which is exactly what it did.
    const policy = /export const laneRetries = [^;]*\?\s*(\d+)\s*:\s*(\d+);/u
      .exec(config)
      ?.slice(1)
      .map(Number);

    expect(policy).toBeDefined();
    expect(config).toMatch(/\n {2}retries: laneRetries,\n/u);
    expect(resolveRef(schema, "#/$defs/result").properties).toMatchObject({
      attempts: {
        maximum: Math.max(...(policy ?? [])) + 1,
        minimum: 1,
        type: "integer",
      },
    });
  });

  test("bounds artifact retention within what Actions can store", () => {
    const retention = (schema.properties as { retentionDays: Schema })
      .retentionDays;

    expect(retention).toMatchObject({ maximum: 90, minimum: 1 });
    expect(
      validate(schema, {
        ...exampleEvidence(),
        retentionDays: 91,
      } as unknown as Json),
    ).toEqual(["$.retentionDays: above the maximum 90"]);
  });

  test("agrees with the case table about which cases exist", () => {
    expect(runEvidenceProblems(exampleEvidence(), table(), gates())).toEqual(
      [],
    );
  });
});

/* ------------------------------------------------------------------ *
 * Hostile documents.
 * ------------------------------------------------------------------ */

/**
 * Every shape the evidence must refuse, fed to the checker as a document.
 *
 * The suite above proves the schema does not *declare* a forbidden property
 * name, and that is a weaker claim than it reads as: a deny-list of names says
 * nothing about the name nobody added to it, and nothing at all about a
 * forbidden *value* in a permitted field. So each entry here is a whole
 * document that a
 * run could plausibly produce, and the assertion is that
 * `validateRunEvidence` answers with the refusal named beside it — not that
 * some property is absent from some list.
 *
 * No entry carries a real value of anything. A credential is represented by a
 * property *name* holding an obvious placeholder, because what the schema
 * refuses is the field, and writing a credential-shaped string into a checked-in
 * test would be the leak the field exists to prevent.
 */
function hostileDocuments(): {
  document: Json;
  refusal: string;
  /** The stable name the runbook's attribution table keys on. */
  shape: string;
  why: string;
}[] {
  const base = exampleEvidence();
  const first = matrix.cases[0] as MatrixCase;
  const second = matrix.cases[1] as MatrixCase;
  const engines = new Map(
    matrix.cases.map((entry) => [entry.id, entry.engine]),
  );
  const as = (value: unknown) => value as Json;

  return [
    {
      document: as({ ...base, accessToken: "placeholder-not-a-value" }),
      refusal: "$: unexpected accessToken",
      shape: "credential",
      why: "a credential",
    },
    {
      document: as({
        ...base,
        workflow: { ...base.workflow, repository: "owner@example.invalid" },
      }),
      refusal: "$.workflow.repository: not the required constant",
      shape: "email-address",
      why: "an e-mail address in a field that already exists",
    },
    {
      document: as({
        ...base,
        workflow: {
          ...base.workflow,
          path: "https://github.com/example-org/requestport/actions/runs/1",
        },
      }),
      refusal: "$.workflow.path: not one of the enumerated values",
      shape: "absolute-url",
      why: "an absolute URL",
    },
    {
      document: as({
        ...base,
        matrix: {
          ...base.matrix,
          path: "/Users/someone/requestport/docs/implementation/acceptance/requestport-cue-reskin-matrix.json",
        },
      }),
      refusal: "$.matrix.path: not the required constant",
      shape: "filesystem-path",
      why: "a local filesystem path",
    },
    {
      document: as({
        ...base,
        error: "TypeError: cannot read properties of undefined",
      }),
      refusal: "$: unexpected error",
      shape: "free-form-error-text",
      why: "free-form error text",
    },
    {
      document: as({
        ...base,
        results: [
          { ...base.results[0], outcome: "failed" },
          ...base.results.slice(1),
        ],
      }),
      refusal: "$.results[0].outcome: not one of the enumerated values",
      shape: "failing-outcome",
      why: "a failing outcome, which this document has no vocabulary for",
    },
    {
      document: as({
        ...base,
        artifacts: [{ name: "browser-failure-artifacts", sizeBytes: 41_237 }],
      }),
      refusal: "$.artifacts[0]: missing sha256",
      shape: "unhashed-artifact",
      why: "an artifact nobody can prove they are looking at",
    },
    {
      document: as({
        ...base,
        results: [
          ...base.results,
          { attempts: 2, id: second.id, outcome: "passed" },
        ],
      }),
      refusal: `$.results: repeated ${second.id}`,
      shape: "duplicate-case",
      why: "a duplicated case the schema's own uniqueItems cannot see, because the two entries differ in their attempt count",
    },
    {
      document: as({ ...base, results: base.results.slice(1) }),
      refusal: `$.results: missing ${first.id}`,
      shape: "missing-case",
      why: "a case the bound table declares and this run answered nothing about",
    },
    {
      document: as({
        ...base,
        results: [
          ...base.results,
          { attempts: 1, id: "appearance-9999", outcome: "passed" },
        ],
      }),
      refusal: "$.results: undeclared appearance-9999",
      shape: "undeclared-case",
      why: "an outcome for a case no table declares",
    },
    {
      document: as({ ...base, startedAt: "2026-08-28T20:38:29Z" }),
      refusal: "$: unexpected startedAt",
      shape: "non-deterministic-field",
      why: "a field a rerun of the same commit would change",
    },
    {
      document: as({
        ...base,
        workflow: { ...base.workflow, headSha: "0".repeat(40) },
      }),
      refusal:
        "$.workflow.headSha: not the accepted application SHA this run sealed",
      shape: "head-sha-mismatch",
      why: "a run keyed to a commit other than the one it accepted",
    },
    {
      document: as({
        ...base,
        matrix: { ...base.matrix, sha256: "0".repeat(64) },
      }),
      refusal:
        "$.matrix.sha256: not the case table checked in beside this schema",
      shape: "matrix-digest-mismatch",
      why: "identifiers bound to a table that is not the one checked in",
    },
    {
      document: as({
        ...base,
        results: base.results.map((entry) => ({
          ...entry,
          outcome: engines.get(entry.id) === "webkit" ? "skipped" : "passed",
        })),
      }),
      refusal: "$.results: every webkit case was skipped",
      shape: "engine-entirely-skipped",
      why: "a green report from a host that could not drive one mandatory engine",
    },
    {
      document: as({
        ...base,
        gates: base.gates.filter((gate) => gate !== "build"),
      }),
      refusal: "$.gates: missing build",
      shape: "missing-gate",
      why: "a gate that did not run",
    },
  ];
}

describe("acceptance run evidence, fed a hostile document", () => {
  test("accepts the conforming example, so the refusals below mean something", () => {
    expect(
      validateRunEvidence(exampleEvidence() as unknown as Json, {
        gates: gates(),
        schema,
        table: table(),
      }),
    ).toEqual([]);
  });

  test.each(hostileDocuments())("refuses $why", ({ document, refusal }) => {
    expect(
      validateRunEvidence(document, {
        gates: gates(),
        schema,
        table: table(),
      }),
    ).toEqual([refusal]);
  });

  test("covers every shape the runbook says it refuses", () => {
    // The count is the other half of `test.each`: a table that lost an entry
    // would still report every remaining one as passing.
    expect(hostileDocuments().length).toBe(15);
  });

  test("is attributed in the runbook to the checker that actually refuses", (ctx) => {
    skipInPublicTree(
      ctx,
      "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
    );
    // The defect this closes. The runbook said "the run-evidence schema
    // refuses a document in which every case on one engine was skipped"; fed
    // exactly that document, `validate(schema, ...)` answers `[]`. The claim
    // was true of the check and false of the schema, and there was no way to
    // tell from the document which half owned any given refusal.
    //
    // So the runbook names one owner per shape and this reads the table back:
    // a shape attributed to the schema must be refused by the schema alone, and
    // a shape attributed to the relations must be one the schema accepts.
    const runbook = readFileSync(
      resolve(
        repositoryRoot,
        "docs/implementation/runbooks/requestport-cue-reskin-acceptance.md",
      ),
      "utf8",
    );
    const attributed = new Map(
      [
        ...runbook.matchAll(
          /^\| `([a-z-]+)` \| `(requestport-cue-reskin-run-evidence\.schema\.json|runEvidenceProblems)` \|/gmu,
        ),
      ].map(([, shape, checker]) => [shape, checker]),
    );
    const documents = hostileDocuments();

    expect([...attributed.keys()].sort()).toEqual(
      documents.map((entry) => entry.shape).sort(),
    );

    const owners = documents.map((entry) => ({
      owner:
        validate(schema, entry.document).length > 0
          ? "requestport-cue-reskin-run-evidence.schema.json"
          : "runEvidenceProblems",
      shape: entry.shape,
    }));

    expect(owners).toEqual(
      documents.map((entry) => ({
        owner: attributed.get(entry.shape),
        shape: entry.shape,
      })),
    );

    // Both owners have to appear, or the table would be a list of one name
    // that happened to be right.
    expect(new Set(owners.map((entry) => entry.owner)).size).toBe(2);
  });
});
