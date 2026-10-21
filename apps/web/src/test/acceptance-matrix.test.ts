import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  appearanceDensities,
  appearanceFallback,
  appearanceModes,
  appearanceThemes,
} from "@requestport/domain/browser";
import { describe, expect, test } from "vitest";

import { acceptancePointers } from "../../tests/fixtures/acceptance-pointer.js";
import {
  e2eScenarioCleanupOwners,
  e2eScenarioIds,
  e2eScenarioLanes,
  e2eScenarios,
} from "./e2e-scenarios.js";
import {
  type Json,
  readJson,
  resolveRef,
  type Schema,
  validate,
} from "./json-schema.js";
import { routeStateInventory, routeStates } from "./route-state-inventory.js";

/**
 * The deterministic acceptance case table, and the schema it answers to.
 *
 * The table is *data*, and the point of this suite is to keep it data: a list
 * of what local acceptance runs, who seeds each case and who removes what it
 * created — and nothing about any run that has happened. A result, a workflow
 * identifier, an artifact link or an accepted commit in here would make the
 * table something a run rewrites, and a table a run rewrites cannot be the
 * thing a run is checked against. Those belong to the separate run-evidence
 * artifact.
 *
 * "Discovery" is the other half. A case table that merely lists cases is a
 * list; one that fails when a required row is missing is a contract, so every
 * axis the specification names — the pairwise cross-product, the fallback
 * submatrix, both OS schemes under system mode, and every row of the route and
 * state inventory — is checked for presence rather than assumed.
 */

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
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
  "requestport-cue-reskin-matrix.schema.json",
);

/* ------------------------------------------------------------------ *
 * The checked-in documents.
 * ------------------------------------------------------------------ */

type MatrixCase = {
  cleanupOwner: string;
  density: string;
  engine: string;
  fixtureOwner: string;
  id: string;
  lane: string;
  mode: string;
  pointer: string;
  scheme: string;
  state: string;
  surface: string;
  theme: string;
  viewport: { height: number; width: number };
};
type Matrix = {
  $schema: string;
  cases: MatrixCase[];
  engines: string[];
  lanes: string[];
  version: number;
  viewports: { height: number; width: number }[];
};

const schema = readJson(schemaPath) as Schema;
const matrix = readJson(matrixPath) as unknown as Matrix;
const matrixText = readFileSync(matrixPath, "utf8");
const caseProperties = (
  schema.$defs as { case: { properties: { [key: string]: Schema } } }
).case.properties;

function enumOf(property: string): string[] {
  const entry = caseProperties[property] as Schema;
  const resolved =
    typeof entry.$ref === "string" ? resolveRef(schema, entry.$ref) : entry;

  return (resolved.enum as string[]) ?? [];
}

/**
 * Every case that demands a state its surface cannot reach.
 *
 * The inventory relation used to be checked in one direction only — every
 * declared `(surface, state)` row had a case — while the schema enumerates the
 * two vocabularies independently, so all 40 x 12 combinations were legal
 * against the 164 the inventory declares. A case for one of the other 316
 * would demand a screenshot of a state that surface can never be in, and
 * nothing said so.
 */
export function unreachableCases(
  cases: readonly Pick<MatrixCase, "id" | "state" | "surface">[],
): string[] {
  const reachable = new Set(
    routeStateInventory.flatMap((entry) =>
      entry.states.map((state) => `${entry.id}|${state}`),
    ),
  );

  return cases
    .filter((entry) => !reachable.has(`${entry.surface}|${entry.state}`))
    .map(
      (entry) => `${entry.id}: ${entry.surface} never reaches ${entry.state}`,
    )
    .sort();
}

/**
 * Every way the declared viewports and the cases fail to describe each other.
 *
 * The header used to be decorative: a case could name any declared width
 * crossed with any declared height — the whole cross-product against the pairs
 * actually declared — and nothing compared the two lists in either direction.
 * The binding runs both ways here, and the schema closes the same gap
 * structurally
 * by enumerating the pairs rather than the axes.
 */
export function unboundViewports(
  table: Readonly<{
    cases: readonly Pick<MatrixCase, "id" | "viewport">[];
    viewports: readonly MatrixCase["viewport"][];
  }>,
): string[] {
  const size = (viewport: MatrixCase["viewport"]) =>
    `${viewport.width}x${viewport.height}`;
  const declared = new Set(table.viewports.map(size));
  const used = new Set(table.cases.map((entry) => size(entry.viewport)));
  const problems: string[] = [];

  for (const entry of table.cases) {
    if (!declared.has(size(entry.viewport))) {
      problems.push(`${entry.id}: ${size(entry.viewport)} is undeclared`);
    }
  }
  for (const declaredSize of declared) {
    if (!used.has(declaredSize)) {
      problems.push(`${declaredSize}: declared, never run`);
    }
  }

  return [...new Set(problems)].sort();
}

const widths = [390, 768, 1024, 1440] as const;
const schemes = ["dark", "light"] as const;

describe("acceptance case table", () => {
  test("has a validator that reports what a schema actually rejects", () => {
    const toy: Schema = {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^case-[0-9]+$" },
        engine: { enum: ["chromium", "webkit"] },
        viewport: { type: "integer" },
      },
    };

    expect(validate(toy, { id: "case-1" })).toEqual([]);
    expect(validate(toy, {})).toEqual(["$: missing id"]);
    expect(validate(toy, { id: "nope" })).toEqual([
      "$.id: does not match ^case-[0-9]+$",
    ]);
    expect(validate(toy, { id: "case-1", engine: "firefox" })).toEqual([
      "$.engine: not one of the enumerated values",
    ]);
    expect(validate(toy, { id: "case-1", result: "passed" })).toEqual([
      "$: unexpected result",
    ]);
    expect(validate(toy, { id: "case-1", viewport: 1.5 })).toEqual([
      "$.viewport: expected integer",
    ]);
    expect(validate({ never: true } as Schema, 1)).toEqual([
      "$: unsupported never",
    ]);
  });

  test("is checked in beside the schema it answers to", () => {
    expect(existsSync(matrixPath)).toBe(true);
    expect(existsSync(schemaPath)).toBe(true);
    expect(matrix.$schema).toBe("./requestport-cue-reskin-matrix.schema.json");
  });

  test("validates against its checked-in schema", () => {
    expect(validate(schema, matrix as unknown as Json)).toEqual([]);
  });

  test("closes every schema vocabulary on a vocabulary the code owns", () => {
    expect(enumOf("theme").sort()).toEqual([...appearanceThemes].sort());
    expect(enumOf("density").sort()).toEqual([...appearanceDensities].sort());
    expect(enumOf("mode").sort()).toEqual([...appearanceModes].sort());
    expect(enumOf("state").sort()).toEqual([...routeStates].sort());
    expect(enumOf("lane").sort()).toEqual([...e2eScenarioLanes].sort());
    expect(enumOf("fixtureOwner").sort()).toEqual([...e2eScenarioIds].sort());
    expect(enumOf("cleanupOwner").sort()).toEqual(
      [...e2eScenarioCleanupOwners].sort(),
    );
    expect(enumOf("surface").sort()).toEqual(
      routeStateInventory.map((entry) => entry.id).sort(),
    );
    expect(enumOf("pointer").sort()).toEqual([...acceptancePointers].sort());
    expect(enumOf("engine").sort()).toEqual(["chromium", "webkit"]);
    expect(matrix.engines).toEqual(["chromium", "webkit"]);
  });

  test("orders its keys and its cases so two writings are one file", () => {
    const keys = Object.keys(matrix);
    expect(keys[0]).toBe("$schema");
    expect(keys.slice(1)).toEqual([...keys.slice(1)].sort());

    for (const entry of matrix.cases) {
      expect({
        id: entry.id,
        keys: Object.keys(entry),
      }).toEqual({ id: entry.id, keys: [...Object.keys(entry)].sort() });
    }

    expect(matrix.cases.map((entry) => entry.id)).toEqual(
      [...matrix.cases.map((entry) => entry.id)].sort(),
    );
    expect(new Set(matrix.cases.map((entry) => entry.id)).size).toBe(
      matrix.cases.length,
    );
    expect(`${JSON.stringify(matrix, null, 2)}\n`).toBe(matrixText);
  });

  test("holds no two cases that say exactly the same thing", () => {
    const tuples = matrix.cases.map((entry) =>
      [
        entry.lane,
        entry.engine,
        entry.theme,
        entry.density,
        entry.mode,
        entry.scheme,
        entry.viewport.width,
        entry.surface,
        entry.state,
        entry.fixtureOwner,
      ].join("|"),
    );

    expect(new Set(tuples).size).toBe(tuples.length);
  });

  test("is bound to no specification or plan: the schema declares neither, and the table names no design document", () => {
    // Ruling 175 (J question 2c) dropped the table's binding to the reskin
    // specification and plan it was first derived from. The schema neither
    // requires nor declares either field, nor the document shape they took,
    // and the table holds neither field and no path under docs/specs or
    // docs/implementation/plans.
    const bindings = ["plan", "specification"];
    expect(
      (schema.required as string[]).filter((name) => bindings.includes(name)),
    ).toEqual([]);
    expect(
      Object.keys(schema.properties as Schema).filter((name) =>
        bindings.includes(name),
      ),
    ).toEqual([]);
    expect(Object.keys(schema.$defs as Schema)).not.toContain("document");
    expect(
      Object.keys(matrix).filter((name) => bindings.includes(name)),
    ).toEqual([]);
    expect(matrixText).not.toMatch(/docs\/(?:specs|implementation\/plans)\//u);
  });

  test("runs exactly the viewports it declares, and declares only those", () => {
    expect(unboundViewports(matrix)).toEqual([]);
    const ascending = (left: number, right: number) => left - right;
    expect(
      matrix.viewports.map((viewport) => viewport.width).sort(ascending),
    ).toEqual([...widths].sort(ascending));

    // Planted both ways, because a checker that reported nothing on a correct
    // table and nothing on a broken one would look identical above.
    const [first] = matrix.cases;
    expect(first).toBeDefined();
    expect(
      unboundViewports({
        cases: [
          { id: first?.id ?? "", viewport: { height: 768, width: 390 } },
          ...matrix.cases.slice(1),
        ],
        viewports: matrix.viewports,
      }),
    ).toContain(`${first?.id}: 390x768 is undeclared`);
    expect(
      unboundViewports({
        cases: matrix.cases,
        viewports: [...matrix.viewports, { height: 900, width: 390 }],
      }),
    ).toContain("390x900: declared, never run");
  });

  test("closes the schema's viewport on the declared pairs, not on two axes", () => {
    const viewport = resolveRef(schema, "#/$defs/viewport");

    expect(viewport.enum).toEqual(matrix.viewports);
    // The cross-product the two independent axes used to admit is gone: a
    // declared width with another declared height is now rejected.
    expect(validate(viewport, { height: 768, width: 390 })).toEqual([
      "$: not one of the enumerated values",
    ]);
    expect(validate(viewport, matrix.viewports[0] as unknown as Json)).toEqual(
      [],
    );
  });

  test("covers every pair of appearance, viewport, scheme and engine", () => {
    // The viewport factor is the declared *pair*. Reading only the width
    // discarded the height, so a case could claim a size the table never
    // declared and still count as covering the width it happened to share.
    const factors = {
      density: [...appearanceDensities],
      engine: ["chromium", "webkit"],
      mode: [...appearanceModes],
      scheme: [...schemes],
      theme: [...appearanceThemes],
      viewport: matrix.viewports.map(
        (viewport) => `${viewport.width}x${viewport.height}`,
      ),
    } as const;
    const names = Object.keys(factors).sort() as (keyof typeof factors)[];
    const read = (entry: MatrixCase, name: keyof typeof factors) =>
      name === "viewport"
        ? `${entry.viewport.width}x${entry.viewport.height}`
        : String(entry[name]);
    const missing: string[] = [];

    for (let left = 0; left < names.length; left += 1) {
      for (let right = left + 1; right < names.length; right += 1) {
        const first = names[left] as keyof typeof factors;
        const second = names[right] as keyof typeof factors;
        for (const firstValue of factors[first]) {
          for (const secondValue of factors[second]) {
            const covered = matrix.cases.some(
              (entry) =>
                read(entry, first) === firstValue &&
                read(entry, second) === secondValue,
            );
            if (!covered) {
              missing.push(
                `${first}=${firstValue} with ${second}=${secondValue}`,
              );
            }
          }
        }
      }
    }

    expect(missing.sort()).toEqual([]);
  });

  test("runs the fallback theme in both explicit modes at every density", () => {
    const missing: string[] = [];

    for (const mode of ["dark", "light"]) {
      for (const density of appearanceDensities) {
        const covered = matrix.cases.some(
          (entry) =>
            entry.theme === appearanceFallback.theme &&
            entry.mode === mode &&
            entry.density === density,
        );
        if (!covered) missing.push(`${mode} at ${density}`);
      }
    }

    expect(missing.sort()).toEqual([]);
  });

  test("runs the fallback theme in system mode under both OS schemes", () => {
    const missing: string[] = [];

    for (const density of appearanceDensities) {
      for (const scheme of schemes) {
        const covered = matrix.cases.some(
          (entry) =>
            entry.theme === appearanceFallback.theme &&
            entry.mode === "system" &&
            entry.density === density &&
            entry.scheme === scheme,
        );
        if (!covered) missing.push(`${density} under ${scheme}`);
      }
    }

    expect(missing.sort()).toEqual([]);
  });

  test("holds a case for every row of the route and state inventory", () => {
    const covered = new Set(
      matrix.cases.map((entry) => `${entry.surface}|${entry.state}`),
    );
    const missing: string[] = [];

    for (const entry of routeStateInventory) {
      for (const state of entry.states) {
        if (!covered.has(`${entry.id}|${state}`)) {
          missing.push(`${entry.id}|${state}`);
        }
      }
    }

    expect(missing.sort()).toEqual([]);
  });

  test("demands a case only for a state its surface can reach", () => {
    expect(unreachableCases(matrix.cases)).toEqual([]);

    // The partner of the row-coverage test above: together they make the
    // inventory and the table describe exactly each other. Planted, because a
    // one-directional check and a two-directional one report the same nothing
    // on a correct table.
    // The surface is one the inventory really declares, so what the plant
    // proves is that a *known* surface asked for a state it cannot reach is
    // reported — not merely that an unknown name is.
    expect(
      unreachableCases([
        {
          id: "planted-0001",
          state: "conflict",
          surface: "boundary:loading:(app)",
        },
        ...matrix.cases,
      ]),
    ).toEqual(["planted-0001: boundary:loading:(app) never reaches conflict"]);
  });

  test("gives every case a fixture owner that can actually produce it", () => {
    const mismatched: string[] = [];

    for (const entry of matrix.cases) {
      const owner =
        e2eScenarios[entry.fixtureOwner as keyof typeof e2eScenarios];
      if (owner === undefined) {
        mismatched.push(`${entry.id}: uncatalogued owner`);
        continue;
      }
      if (!(owner.states as readonly string[]).includes(entry.state)) {
        mismatched.push(`${entry.id}: owner does not reach ${entry.state}`);
      }
      if (owner.lane !== entry.lane) {
        mismatched.push(`${entry.id}: owner runs in the ${owner.lane} lane`);
      }
      if (owner.cleanupOwner !== entry.cleanupOwner) {
        mismatched.push(`${entry.id}: cleanup owner disagrees with the case`);
      }
    }

    expect(mismatched.sort()).toEqual([]);
  });

  test("exercises every catalogued scenario at least once", () => {
    const used = new Set(matrix.cases.map((entry) => entry.fixtureOwner));

    expect([...used].sort()).toEqual([...e2eScenarioIds].sort());
  });

  test("keeps the two lanes separately shardable", () => {
    const lanes = new Set(matrix.cases.map((entry) => entry.lane));

    expect([...lanes].sort()).toEqual([...e2eScenarioLanes].sort());
    for (const lane of e2eScenarioLanes) {
      expect({
        lane,
        cases: matrix.cases.filter((entry) => entry.lane === lane).length > 0,
      }).toEqual({ lane, cases: true });
    }
  });

  test("records no result, workflow, artifact or accepted commit", () => {
    const forbiddenKeys = new Set([
      "acceptedSha",
      "artifact",
      "artifacts",
      "attempt",
      "checksum",
      "commit",
      "completedAt",
      "duration",
      "evidence",
      "failed",
      "outcome",
      "passed",
      "recordedAt",
      "result",
      "results",
      "retention",
      "run",
      "runId",
      "runUrl",
      "sha",
      "startedAt",
      "status",
      "timestamp",
      "trace",
      "url",
      "workflow",
      "workflowId",
    ]);
    const seenKeys = new Set<string>();

    const walk = (value: Json) => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        seenKeys.add(key);
        walk(entry);
      }
    };
    walk(matrix as unknown as Json);

    expect(
      [...seenKeys].filter((key) => forbiddenKeys.has(key)).sort(),
    ).toEqual([]);
    // A 40-character hexadecimal word is a git object name; a 64-character
    // one is a content hash and has no word boundary inside it.
    expect(matrixText).not.toMatch(/\b[0-9a-f]{40}\b/u);
  });

  test("carries no credential, address, payload or local path", () => {
    expect(matrixText).not.toMatch(/https?:\/\//u);
    expect(matrixText).not.toMatch(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
    );
    expect(matrixText).not.toMatch(/\/(?:Users|home|private|var|tmp|opt)\//u);
    expect(matrixText).not.toMatch(
      /\b(?:secret|password|token|bearer|api[_-]?key|authorization)\b/iu,
    );
  });

  test("holds no free-form text anywhere in the table", () => {
    const allowed = new Set<string>([
      "./requestport-cue-reskin-matrix.schema.json",
    ]);
    for (const property of Object.keys(caseProperties)) {
      for (const value of enumOf(property)) allowed.add(value);
    }

    const unexplained: string[] = [];
    const walk = (value: Json, path: string) => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          walk(entry, `${path}[${index}]`);
        });
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          walk(entry, `${path}.${key}`);
        }
        return;
      }
      if (typeof value !== "string") return;
      if (allowed.has(value)) return;
      if (/^(?:appearance|route-state)-[0-9]{4}$/u.test(value)) return;
      unexplained.push(`${path}: ${value}`);
    };
    walk(matrix as unknown as Json, "$");

    expect(unexplained.sort()).toEqual([]);
  });

  test("references no file but the schema it answers to", () => {
    const referenced = new Set<string>();
    const walk = (value: Json) => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) walk(entry);
        return;
      }
      if (typeof value === "string" && /\.[a-z0-9]{2,4}$/u.test(value)) {
        referenced.add(value);
      }
    };
    walk(matrix as unknown as Json);

    expect([...referenced]).toEqual([
      "./requestport-cue-reskin-matrix.schema.json",
    ]);
  });
});
