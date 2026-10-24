import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeAll, describe, expect, test, vi } from "vitest";

import {
  type ParseAst,
  rolldownParseAst,
  type SweepSource,
  sourcesUnder,
  sweepTransactionCallbacks,
} from "./transaction-callback-sweep.js";

/** This process's environment without git's own variables, as a hook sets them. */
const withoutGit = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );

/*
 * The source sweep over every transaction callback (Plan 13, X25's
 * remainder; ruling 232 item 7), on sources written here, and its choice of
 * sources on a git checkout made under the system's temporary directory and
 * removed after. Its run over this repository's packages/ and apps/ is in
 * ../one-query-at-a-time.integration.test.ts.
 */

let parseAst: ParseAst;

beforeAll(async () => {
  parseAst = await rolldownParseAst();
});

const sweep = (sources: readonly SweepSource[]) =>
  sweepTransactionCallbacks(sources, parseAst);

const sitesOf = (sources: readonly SweepSource[]) =>
  sweep(sources).sites.map(
    ({ path, line, call, callback }) =>
      `${path}:${line} ${call} in ${callback.via}@${callback.line}`,
  );

describe("the transaction-callback sweep", () => {
  test("finds Promise.all and its kin inside a callback handed to .transaction(), and in a function nested in one", () => {
    expect(
      sitesOf([
        {
          path: "a.ts",
          text: [
            "export async function read(storage) {",
            "  return storage.transaction(async (tx) => {",
            "    const [a, b] = await Promise.all([tx.select(), tx.select()]);",
            "    const later = async () => Promise.race([tx.execute(), tx.execute()]);",
            "    return [a, b, await later()];",
            "  });",
            "}",
          ].join("\n"),
        },
      ]),
    ).toEqual([
      "a.ts:3 Promise.all in transaction@2",
      "a.ts:4 Promise.race in transaction@2",
    ]);
  });

  test("finds one inside a callback handed to a helper that opens the transaction, defined in another file, and to a helper that forwards to it", () => {
    const sources = [
      {
        path: "helpers.ts",
        text: [
          "export function inTenant(database, organizationId, work) {",
          "  return database.transaction(async (tx) => {",
          "    await bind(tx, organizationId);",
          "    return work(tx);",
          "  });",
          "}",
          "export const forOrganization = (organizationId, work, readOnly = false) =>",
          "  inTenant(pool, organizationId, work);",
        ].join("\n"),
      },
      {
        path: "reads.ts",
        text: [
          "export const one = () => inTenant(pool, 'o', async (tx) =>",
          "  Promise.allSettled([tx.select(), tx.select()]));",
          "export const two = () => forOrganization('o', async (tx) => {",
          "  return Promise.any([tx.select(), tx.select()]);",
          "});",
        ].join("\n"),
      },
    ];
    const swept = sweep(sources);

    expect(sitesOf(sources)).toEqual([
      "reads.ts:2 Promise.allSettled in inTenant@1",
      "reads.ts:4 Promise.any in forOrganization@3",
    ]);
    expect(swept.helpers.get("inTenant")).toEqual([2]);
    expect(swept.helpers.get("forOrganization")).toEqual([1]);
  });

  test("finds one inside a callback handed to a method that hands a unit of the transaction to its argument", () => {
    expect(
      sitesOf([
        {
          path: "manager.ts",
          text: [
            "export function createManager(database) {",
            "  return {",
            "    run(work, binding) {",
            "      return database.transaction(async (tx) => {",
            "        return work(createUnit(tx), binding);",
            "      });",
            "    },",
            "  };",
            "}",
            "export const go = (manager) =>",
            "  manager.run(async (unit) => Promise.all([unit.a(), unit.b()]));",
          ].join("\n"),
        },
      ]),
    ).toEqual(["manager.ts:11 Promise.all in run@11"]);
  });

  test("finds nothing outside a transaction callback, nor in a callback handed to a function that only shares a parameter's name with one", () => {
    const swept = sweep([
      {
        path: "pool.ts",
        text: [
          "export function find(organizationId, id) {",
          "  return inTenant(pool, organizationId, async (tx) => tx.select());",
          "}",
          "export function inTenant(database, organizationId, work) {",
          "  return database.transaction(async (tx) => work(tx));",
          "}",
          "export const reads = (rows) => Promise.all([pool.query('a'), pool.query('b')]);",
          "export const found = (rows) => rows.find(async (row) => Promise.all([row.a(), row.b()]));",
        ].join("\n"),
      },
    ]);

    expect(swept.sites).toEqual([]);
    expect(swept.helpers.has("find")).toBe(false);
    expect(swept.callbacks).toEqual([
      { path: "pool.ts", line: 2, via: "inTenant" },
      { path: "pool.ts", line: 5, via: "transaction" },
    ]);
  });

  test("judges a callback handed by name as the function of that name written in the same file, once however often it is handed", () => {
    const sources = [
      {
        path: "by-name.ts",
        text: [
          "const read = async (tx) => Promise.all([tx.select(), tx.select()]);",
          "function write(tx) {",
          "  return Promise.race([tx.insert(), tx.update()]);",
          "}",
          "export const go = (storage) => storage.transaction(read);",
          "export const again = (storage) => storage.transaction(read);",
          "export const third = (storage) => inTenant(storage, 'o', write);",
          "export function inTenant(database, organizationId, work) {",
          "  return database.transaction(async (tx) => work(tx));",
          "}",
          "export const imported = (storage) => storage.transaction(elsewhere);",
        ].join("\n"),
      },
    ];

    expect(sitesOf(sources)).toEqual([
      "by-name.ts:1 Promise.all in transaction@1",
      "by-name.ts:3 Promise.race in inTenant@2",
    ]);
    expect(sweep(sources).callbacks).toEqual([
      { path: "by-name.ts", line: 1, via: "transaction" },
      { path: "by-name.ts", line: 2, via: "inTenant" },
      { path: "by-name.ts", line: 9, via: "transaction" },
    ]);
  });

  test("finds one inside a callback reached through a conditional, a logical expression, a call that wraps it, .bind, or an object's property written in the same file", () => {
    expect(
      sitesOf([
        {
          path: "shapes.ts",
          text: [
            "const handlers = { read: async (tx) => Promise.all([tx.a(), tx.b()]) };",
            "async function viaBind(tx) { return Promise.any([tx.a(), tx.b()]); }",
            "async function chosen(tx) { return Promise.allSettled([tx.a(), tx.b()]); }",
            "export const byMember = (s) => s.transaction(handlers.read);",
            "export const byBind = (s) => s.transaction(viaBind.bind(null));",
            "export const byConditional = (s, flag) =>",
            "  s.transaction(flag ? chosen : async (tx) => Promise.race([tx.a(), tx.b()]));",
            "export const byLogical = (s, given) =>",
            "  s.transaction(given ?? (async (tx) => Promise.all([tx.c(), tx.d()])));",
            "export const byWrapper = (s) =>",
            "  s.transaction(wrap(async (tx) => Promise.all([tx.e(), tx.f()])));",
          ].join("\n"),
        },
      ]),
    ).toEqual([
      "shapes.ts:1 Promise.all in transaction@1",
      "shapes.ts:2 Promise.any in transaction@2",
      "shapes.ts:3 Promise.allSettled in transaction@3",
      "shapes.ts:7 Promise.race in transaction@7",
      "shapes.ts:9 Promise.all in transaction@9",
      "shapes.ts:11 Promise.all in transaction@11",
    ]);
  });

  test("finds a helper that hands its parameter to a transaction through a conditional, a call that wraps it, or .bind", () => {
    const sources = [
      {
        path: "helpers.ts",
        text: [
          "export function inTenant(db, work, flag) {",
          "  return db.transaction(flag ? work : (tx) => tx);",
          "}",
          "export function inScope(db, work) {",
          "  return db.transaction(wrap(work));",
          "}",
          "export function inBound(db, work) {",
          "  return db.transaction(work.bind(null));",
          "}",
          "export const a = () => inTenant(pool, async (tx) => Promise.all([tx.a(), tx.b()]), true);",
          "export const b = () => inScope(pool, async (tx) => Promise.all([tx.a(), tx.b()]));",
          "export const c = () => inBound(pool, async (tx) => Promise.all([tx.a(), tx.b()]));",
        ].join("\n"),
      },
    ];
    const swept = sweep(sources);

    expect(sitesOf(sources)).toEqual([
      "helpers.ts:10 Promise.all in inTenant@10",
      "helpers.ts:11 Promise.all in inScope@11",
      "helpers.ts:12 Promise.all in inBound@12",
    ]);
    for (const helper of ["inTenant", "inScope", "inBound"]) {
      expect(swept.helpers.get(helper), helper).toEqual([1]);
    }
  });

  test("reads every source under packages/ and apps/ that git tracks or would track, a dot-directory's included, and leaves out what git ignores, tests and declarations, whatever repository the caller's GIT_DIR and GIT_WORK_TREE name", () => {
    const root = mkdtempSync(join(tmpdir(), "requestport-sweep-sources-"));
    const other = mkdtempSync(join(tmpdir(), "requestport-sweep-other-"));
    const write = (path: string, text = "export {};\n") => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };

    try {
      execFileSync("git", ["init", "--quiet", root], { env: withoutGit() });
      write(".gitignore", "build/\nnode_modules/\n");
      write("packages/a/src/.well-known/route.ts");
      write("packages/a/src/untracked.ts");
      write("packages/a/src/page.tsx");
      write("packages/a/src/module.mts");
      write("packages/a/src/a.test.ts");
      write("packages/a/src/types.d.ts");
      write("packages/a/build/output.ts");
      write("packages/a/node_modules/dependency/index.ts");
      write("apps/w/src/route.ts");
      write("scripts/outside.ts");
      execFileSync(
        "git",
        ["-C", root, "add", "packages/a/src/.well-known/route.ts"],
        { env: withoutGit() },
      );
      // Another repository, named by git's own variables, as a process a git
      // hook starts can inherit them: the sweep reads root's sources still.
      execFileSync("git", ["init", "--quiet", other], { env: withoutGit() });
      mkdirSync(join(other, "packages/b/src"), { recursive: true });
      writeFileSync(join(other, "packages/b/src/elsewhere.ts"), "export {};\n");
      execFileSync("git", ["-C", other, "add", "packages/b/src/elsewhere.ts"], {
        env: withoutGit(),
      });
      vi.stubEnv("GIT_DIR", join(other, ".git"));
      vi.stubEnv("GIT_WORK_TREE", other);

      expect(sourcesUnder(root).map(({ path }) => path)).toEqual([
        "apps/w/src/route.ts",
        "packages/a/src/.well-known/route.ts",
        "packages/a/src/module.mts",
        "packages/a/src/page.tsx",
        "packages/a/src/untracked.ts",
      ]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("parses TSX, its text holding apostrophes, and names a file it cannot parse rather than passing over it", () => {
    const swept = sweep([
      {
        path: "page.tsx",
        text: [
          "export default async function Page() {",
          "  const rows = await storage.transaction(async (tx) =>",
          "    Promise.all([read(tx), list(tx)]),",
          "  );",
          "  return <p>Don't {rows.length}</p>;",
          "}",
        ].join("\n"),
      },
      { path: "broken.ts", text: "export const = ;" },
    ]);

    expect(
      swept.sites.map(({ path, line, call }) => `${path}:${line} ${call}`),
    ).toEqual(["page.tsx:3 Promise.all"]);
    expect(swept.unparsed.map(({ path }) => path)).toEqual(["broken.ts"]);
  });
});
