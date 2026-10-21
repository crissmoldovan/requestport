import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { capabilityRegistry, mcpOnlyTools } from "@requestport/domain";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { withoutComments } from "../source-text.js";

/**
 * The capability-coverage ledger (Plan 13, F.2.0): every action a file-level
 * `"use server"` module exports sits in exactly one row, and each row says
 * what reaches that capability from a machine — or why nothing should.
 *
 * The modules are discovered, not listed. F.0 took its inventory with
 * `grep -rl '^"use server";$' apps/web/src`, and this reads the same tree
 * (`capability-inventory.md`, "How the list was taken"), so a module written
 * after this ledger — F.3's `settings/operators` actions, for one — fails here
 * until its exports have rows. Only the file-level directive is read: an
 * action declared by a directive inside a function body is not an export of a
 * `"use server"` module, and `server-action-authorization.test.ts` is where
 * those are swept.
 *
 * The rows live in `rows/`, one file per class: `human-only.ts`, `covered.ts`,
 * and `f2-<n>.ts` for the actions F.2 group n ports. A group's rows start
 * `pending` and become `ported` when its registry entries exist. A `covered`
 * or `ported` row names what reaches it, and each name must resolve: a
 * `registry` name in `capabilityRegistry`, an `mcpOnly` name in
 * `mcpOnlyTools`. The row files are found by listing `rows/`, so a new one is
 * read without editing this file, and a file this test does not know the
 * class of fails rather than being skipped.
 */

const webSource = resolve(import.meta.dirname, "../..");
const rowsDirectory = resolve(import.meta.dirname, "rows");

/** Every `.ts` and `.tsx` file under `root`, as paths relative to it. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/u.test(entry.name))
        found.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * One statement of a directive prologue: a string literal alone, ended by a
 * semicolon, a line break or the end of the text. `"use server" + x` is an
 * expression, not a directive, and does not match.
 */
const prologueStatement = /^\s*(["'])([^"'\\\n]*)\1[ \t]*(?:;|(?=\n)|$)/u;

/** True when `source`'s directive prologue holds `"use server"`. */
function isFileLevelServerModule(source: string): boolean {
  let rest = withoutComments(source);
  for (
    let statement = prologueStatement.exec(rest);
    statement;
    statement = prologueStatement.exec(rest)
  ) {
    if (statement[2] === "use server") return true;
    rest = rest.slice(statement[0].length);
  }
  return false;
}

/** F.0's own test: a line that is exactly `"use server";`. */
const f0Directive = /^"use server";$/mu;

interface ServerModule {
  /** Relative to `apps/web/src`, with forward slashes. */
  module: string;
  /** The names of its `export async function`s, in source order. */
  actions: string[];
  /** Each `export` line that is not an `export async function`. */
  otherExports: string[];
}

/** Every file-level `"use server"` module under `root`, and what it exports. */
function discoverServerModules(root: string): ServerModule[] {
  return sourceFiles(root).flatMap((module) => {
    const source = readFileSync(join(root, module), "utf8");
    if (!isFileLevelServerModule(source)) return [];
    const actions: string[] = [];
    const otherExports: string[] = [];
    for (const line of withoutComments(source).split("\n")) {
      if (!/^export\b/u.test(line)) continue;
      const action = /^export async function ([A-Za-z_$][\w$]*)\s*\(/u.exec(
        line,
      );
      if (action?.[1]) actions.push(action[1]);
      else otherExports.push(line.trim());
    }
    return [{ module, actions, otherExports }];
  });
}

const rowIdentity = {
  module: z.string().min(1),
  action: z.string().min(1),
};
const registrySurface = z.object({ registry: z.string().min(1) }).strict();
const mcpOnlySurface = z.object({ mcpOnly: z.string().min(1) }).strict();

/** The shape every row must have; a row that does not parse fails the file. */
const coverageRow = z.discriminatedUnion("status", [
  z
    .object({
      ...rowIdentity,
      status: z.literal("human-only"),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...rowIdentity,
      status: z.literal("covered"),
      surfaces: z.array(z.union([registrySurface, mcpOnlySurface])).min(1),
    })
    .strict(),
  z.object({ ...rowIdentity, status: z.literal("pending") }).strict(),
  z
    .object({
      ...rowIdentity,
      status: z.literal("ported"),
      surfaces: z.array(registrySurface).min(1),
    })
    .strict(),
]);

type CoverageRow = z.infer<typeof coverageRow>;

/** The statuses each row file may hold. A file not named here fails. */
const statusesByRowFile: Readonly<
  Record<string, readonly CoverageRow["status"][]>
> = {
  "human-only.ts": ["human-only"],
  "covered.ts": ["covered"],
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((group) => [
      `f2-${group}.ts`,
      ["pending", "ported"] as const,
    ]),
  ),
};

/**
 * What is wrong with `rows` as a ledger of `modules`, as one line each. Empty
 * means every exported action has exactly one row, every row names an export
 * that exists, and every surface a row names resolves.
 */
function ledgerProblems(
  modules: readonly ServerModule[],
  rows: readonly CoverageRow[],
  resolvable: {
    registry: ReadonlySet<string>;
    mcpOnly: ReadonlySet<string>;
  },
): string[] {
  const problems: string[] = [];
  const key = (module: string, action: string) => `${module} › ${action}`;
  const exported = new Set(
    modules.flatMap(({ module, actions }) =>
      actions.map((action) => key(module, action)),
    ),
  );
  const rowCounts = new Map<string, number>();
  for (const row of rows) {
    const name = key(row.module, row.action);
    rowCounts.set(name, (rowCounts.get(name) ?? 0) + 1);
    if (!exported.has(name))
      problems.push(`${name}: has a row but is not an exported action`);
    if (row.status === "covered" || row.status === "ported")
      for (const surface of row.surfaces) {
        if ("registry" in surface && !resolvable.registry.has(surface.registry))
          problems.push(
            `${name}: names ${surface.registry}, which the capability registry does not hold`,
          );
        if ("mcpOnly" in surface && !resolvable.mcpOnly.has(surface.mcpOnly))
          problems.push(
            `${name}: names ${surface.mcpOnly}, which mcpOnlyTools does not list`,
          );
      }
  }
  for (const { module, actions, otherExports } of modules) {
    for (const line of otherExports)
      problems.push(
        `${module}: exports something other than an async function: ${line}`,
      );
    for (const action of actions) {
      const count = rowCounts.get(key(module, action)) ?? 0;
      if (count !== 1)
        problems.push(
          `${key(module, action)}: has ${count} rows, not exactly one`,
        );
    }
  }
  return problems;
}

/** Every entry in `rows/`, whatever its extension or kind. */
function rowDirectoryEntries(): string[] {
  return readdirSync(rowsDirectory).sort();
}

/** The row files whose class this ledger knows, loaded. */
async function readRowFiles() {
  const files = rowDirectoryEntries().filter((name) =>
    Object.hasOwn(statusesByRowFile, name),
  );
  return Promise.all(
    files.map(async (file) => {
      const loaded = (await import(
        pathToFileURL(join(rowsDirectory, file)).href
      )) as { rows?: unknown };
      return { file, rows: z.array(coverageRow).parse(loaded.rows) };
    }),
  );
}

const realResolvable = {
  registry: new Set(capabilityRegistry.map((capability) => capability.name)),
  mcpOnly: new Set<string>(mcpOnlyTools),
};

describe("the capability-coverage ledger", () => {
  const modules = discoverServerModules(webSource);

  test('finds the file-level "use server" modules F.0\'s method finds', () => {
    const byF0 = sourceFiles(webSource).filter((module) =>
      f0Directive.test(readFileSync(join(webSource, module), "utf8")),
    );
    expect(modules.map(({ module }) => module)).toEqual(byF0);
    expect(modules.length).toBeGreaterThan(0);
  });

  test("reads a row file for every class, and only files whose class it knows", async () => {
    // Every entry, not only `.ts` ones: a `rows/f2-8.tsx` or `rows/extra.js`
    // fails here instead of being skipped.
    expect(rowDirectoryEntries()).toEqual(
      Object.keys(statusesByRowFile).sort(),
    );
    const files = await readRowFiles();
    for (const { file, rows } of files)
      for (const row of rows)
        expect(statusesByRowFile[file], `${file}: ${row.action}`).toContain(
          row.status,
        );
  });

  test("gives every exported action exactly one row, and every row an action and surfaces that resolve", async () => {
    const rows = (await readRowFiles()).flatMap((file) => file.rows);
    expect(ledgerProblems(modules, rows, realResolvable)).toEqual([]);
  });
});

/*
  The ledger has to fail on the changes it exists for, and those cannot be made
  to the real tree from a test. So the reader runs over a tree written here,
  and the comparison over rows written here, each holding one such change.
*/
describe("the ledger fails when it should", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "capability-coverage-"));
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const write = (path: string, text: string) => {
    mkdirSync(join(fixtureRoot, path, ".."), { recursive: true });
    writeFileSync(join(fixtureRoot, path), text);
  };
  write(
    "app/known/actions.ts",
    '"use server";\n\nexport async function knownAction() {}\n',
  );
  write(
    "app/(app)/settings/new-area/actions.ts",
    '// A module written after the ledger.\n"use server";\n\nimport { x } from "y";\n\nexport async function firstAction(input: unknown) {}\nexport async function secondAction() {}\n',
  );
  write(
    "app/constant/actions.ts",
    '"use server";\nexport async function fine() {}\nexport const sneakyAction = async () => {};\n',
  );
  write(
    "lib/inline.ts",
    'export async function inline() {\n  "use server";\n}\n',
  );
  write(
    "lib/commented.ts",
    '// "use server";\nexport async function no() {}\n',
  );
  write(
    "lib/expression.ts",
    '"use server" + suffix;\nexport async function no() {}\n',
  );
  write(
    "lib/prologue.ts",
    "\"use strict\";\n'use server'\nexport async function late() {}\n",
  );
  const fixture = discoverServerModules(fixtureRoot);
  const known: CoverageRow = {
    module: "app/known/actions.ts",
    action: "knownAction",
    status: "pending",
  };
  const onlyKnown = fixture.filter(
    ({ module }) => module === "app/known/actions.ts",
  );

  test("the reader finds a module nobody listed, by its file-level directive alone", () => {
    expect(fixture.map(({ module }) => module)).toEqual([
      "app/(app)/settings/new-area/actions.ts",
      "app/constant/actions.ts",
      "app/known/actions.ts",
      "lib/prologue.ts",
    ]);
    expect(
      fixture.find(({ module }) => module.includes("new-area"))?.actions,
    ).toEqual(["firstAction", "secondAction"]);
  });

  test("an export with no row fails, in a module that did not exist when the rows were written", () => {
    expect(ledgerProblems(fixture, [known], realResolvable)).toEqual(
      expect.arrayContaining([
        "app/(app)/settings/new-area/actions.ts › firstAction: has 0 rows, not exactly one",
        "app/(app)/settings/new-area/actions.ts › secondAction: has 0 rows, not exactly one",
      ]),
    );
  });

  test("an export that is not an async function declaration fails by name", () => {
    expect(ledgerProblems(fixture, [], realResolvable)).toContain(
      "app/constant/actions.ts: exports something other than an async function: export const sneakyAction = async () => {};",
    );
  });

  test("two rows for one action fail, and so does a row for no action", () => {
    expect(
      ledgerProblems(
        onlyKnown,
        [known, { ...known, status: "human-only", reason: "twice" }],
        realResolvable,
      ),
    ).toEqual([
      "app/known/actions.ts › knownAction: has 2 rows, not exactly one",
    ]);
    expect(
      ledgerProblems(
        onlyKnown,
        [known, { ...known, action: "removedAction" }],
        realResolvable,
      ),
    ).toEqual([
      "app/known/actions.ts › removedAction: has a row but is not an exported action",
    ]);
  });

  test("a row naming an entry the registry lacks fails, and one naming an entry it holds passes", () => {
    expect(
      ledgerProblems(
        onlyKnown,
        [
          {
            ...known,
            status: "covered",
            surfaces: [
              { registry: "no_such_capability" },
              { mcpOnly: "no_such_tool" },
            ],
          },
        ],
        realResolvable,
      ),
    ).toEqual([
      "app/known/actions.ts › knownAction: names no_such_capability, which the capability registry does not hold",
      "app/known/actions.ts › knownAction: names no_such_tool, which mcpOnlyTools does not list",
    ]);
    expect(
      ledgerProblems(
        onlyKnown,
        [
          {
            ...known,
            status: "ported",
            surfaces: [{ registry: "no_such_capability" }],
          },
        ],
        realResolvable,
      ),
    ).toEqual([
      "app/known/actions.ts › knownAction: names no_such_capability, which the capability registry does not hold",
    ]);
    expect(
      ledgerProblems(
        onlyKnown,
        [
          {
            ...known,
            status: "covered",
            surfaces: [
              { registry: "post_message" },
              { mcpOnly: "create_project" },
            ],
          },
        ],
        realResolvable,
      ),
    ).toEqual([]);
  });

  test("a row of an unknown shape does not parse", () => {
    expect(coverageRow.safeParse({ ...known, status: "partial" }).success).toBe(
      false,
    );
    expect(
      coverageRow.safeParse({ ...known, status: "covered", surfaces: [] })
        .success,
    ).toBe(false);
    expect(
      coverageRow.safeParse({ ...known, status: "human-only" }).success,
    ).toBe(false);
    expect(
      coverageRow.safeParse({
        ...known,
        status: "ported",
        surfaces: [{ mcpOnly: "create_project" }],
      }).success,
    ).toBe(false);
  });
});
