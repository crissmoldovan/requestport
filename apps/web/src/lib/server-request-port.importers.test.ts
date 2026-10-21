import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AuthorizedCommandContext } from "@requestport/domain";
import type { McpServerDependencies } from "@requestport/mcp";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseAst } from "vitest/node";

/*
 * The web's importers of `db`, on the web root (Plan 13, G.2; manifest-g.md
 * §2.8, §5): every module that took `db` or `withTransaction` from
 * `@requestport/db` now reaches its database through the root,
 * `server-request-port.ts`: a call opens its transaction on `webStorage()`
 * and hands a factory that storage's `db`, and a transaction manager built
 * as its module loads holds `webDatabase`, which asks `webStorage()` when it
 * is used. Since G.5 that storage is the one the wiring builds for the web
 * process on its first ask, no longer the default storage, `db`'s (ruling
 * 118; `server-request-port.test.ts`), and `webStorage().transaction` and
 * `webDatabase` reach its `db.transaction`
 * (`server-request-port.handle.test.ts`). Since G.6 (ruling 137) the
 * modules that ran core's capabilities over the root's storage take them
 * from the web's RequestPort instead (`webRequestPort()`), composed over that
 * same storage in a module of its own, `server-web-request-port.ts` (ruling
 * 140): the REST route's dispatch, the MCP route's tools, the tenant command
 * bus, and the off-bus handlers. They take no transaction, handle or manager
 * from the root themselves.
 *
 * Two halves. The first reads each module's source: what it imports; that it
 * holds the root's storage only as a function's `const <name> =
 * webStorage()`, so no call of `webStorage()` sits at module scope; and where
 * every transaction, manager and handle it uses comes from. It also reads that no
 * module of the web takes `db` or `withTransaction` at all. Two planted
 * modules show that both readings fire: one holds the root's storage in
 * every other way the first recognises, and one takes `db` and
 * `withTransaction` in every way the second recognises, re-exports among
 * them. The second half runs the modules over a stand-in root, whose
 * storage records what reached it and refuses, so nothing below runs a
 * query: loading them, and every other module of the web that imports the
 * root (since G.3), must ask the root for nothing, and each call must stop at
 * that storage. Until G.5 each call also ran with `db`'s own methods spied
 * on and refusing, so that one going around the root would show. G.5 retired
 * `db` (Plan 13), so the first half's reading that no module takes it, and
 * the compiler, hold that now. The MCP
 * route's five import tools are run as the route hands them to its MCP
 * server, which is replaced here to capture them, and so are, since G.3, its
 * nine agent queries, its project registration and its webhook replay,
 * which take their repositories over the root's storage when they run. So is
 * every administration read, which since G.3 opens its transaction on the
 * root's handle, and since G.6 runs through the web's RequestPort. The root
 * itself runs here, over a stand-in storage the wiring answers it, and so
 * does the RequestPort's module, over the root.
 */

/** Where every transaction, manager and handle in a module comes from. */
interface RootUses {
  /** `storage.transaction(…)`, on a name bound to `webStorage()`. */
  transactions: number;
  /**
   * `storage.db`, read on a name bound to `webStorage()`: handed to a
   * repository factory, or as a function's `database` option.
   */
  handles: number;
  /** `createCommandTransactionManager(webDatabase, …)`. */
  managers: number;
  /**
   * `webRequestPort()`, imported from `server-web-request-port.ts`: the
   * RequestPort composed over the root's storage.
   */
  ports: number;
}

/**
 * The 13 modules of G.2's list (manifest-g.md §2.8, recounted at `1de8e512`
 * in track-g.md, G.2): the 11 that imported `db` and the 2 that called
 * `withTransaction`, with what each now takes from the root. These handles
 * are G.3's: the MCP route's four, for its agent queries, its project
 * registration and its webhook replay's two repositories; the agent
 * actions' second, for the credential read a key rotation makes; and the
 * import page's one, for its project read. A fourteenth module,
 * `server-administration-reads.ts`, whose 14 calls of
 * `withAdministrationReadTransaction` relied on its default database until
 * G.3 (§2.8's G.3 row: "every call that relies on a default"), handed each
 * the root's handle from G.3; since G.6 the reads are core's, which the
 * web's RequestPort runs on the root's storage, and the module re-exports
 * them and imports nothing from the root, so it is no longer listed. Since
 * G.6 (ruling 137) the MCP route, the tenant command bus's module and the
 * three off-bus handlers' modules take their capabilities from the web's
 * RequestPort, and nothing else from the root. Paths are from `apps/web`.
 */
const movedModules: Readonly<Record<string, RootUses>> = {
  "src/app/(app)/agents/actions.ts": {
    transactions: 0,
    handles: 2,
    managers: 0,
    ports: 0,
  },
  "src/app/(app)/imports/[runId]/page.tsx": {
    transactions: 1,
    handles: 1,
    managers: 0,
    ports: 0,
  },
  "src/app/(app)/imports/actions.ts": {
    transactions: 5,
    handles: 0,
    managers: 0,
    ports: 0,
  },
  "src/app/(app)/imports/page.tsx": {
    transactions: 1,
    handles: 0,
    managers: 0,
    ports: 0,
  },
  "src/app/api/v1/imports/artifacts/route.ts": {
    transactions: 1,
    handles: 0,
    managers: 0,
    ports: 0,
  },
  "src/app/mcp/route.ts": {
    transactions: 0,
    handles: 0,
    managers: 0,
    ports: 1,
  },
  "src/lib/server-agent-actions.ts": {
    transactions: 0,
    handles: 0,
    managers: 0,
    ports: 2,
  },
  "src/lib/server-core-commands.ts": {
    transactions: 0,
    handles: 0,
    managers: 0,
    ports: 1,
  },
  "src/lib/server-import-actions.ts": {
    transactions: 0,
    handles: 0,
    managers: 0,
    ports: 1,
  },
  "src/lib/server-routing-actions.ts": {
    transactions: 1,
    handles: 0,
    managers: 0,
    ports: 0,
  },
  "src/lib/server-slack-actions.ts": {
    transactions: 0,
    handles: 0,
    managers: 0,
    ports: 1,
  },
  "src/lib/server-slack.ts": {
    transactions: 3,
    handles: 2,
    managers: 1,
    ports: 0,
  },
  "src/lib/server-user-commands.ts": {
    transactions: 0,
    handles: 0,
    managers: 1,
    ports: 0,
  },
};

const webRoot = fileURLToPath(new URL("../../", import.meta.url));

// A loose view of the ESTree that `parseAst` returns.
type AstNode = { type: string; start: number; end: number } & Record<
  string,
  unknown
>;

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** A module's source, parsed. */
interface ParsedModule {
  /** Every node, in source order. */
  all: AstNode[];
  /** Each node's parent. */
  parents: Map<AstNode, AstNode>;
  /** The line a node starts on. */
  line: (node: AstNode) => number;
}

function parseSource(text: string, lang: "ts" | "tsx"): ParsedModule {
  const program = parseAst(text, { lang }) as unknown as AstNode;
  const all: AstNode[] = [];
  const parents = new Map<AstNode, AstNode>();
  const visit = (node: AstNode) => {
    all.push(node);
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value])
        if (isNode(child)) {
          parents.set(child, node);
          visit(child);
        }
  };
  visit(program);
  return {
    all,
    parents,
    line: (node) => text.slice(0, node.start).split("\n").length,
  };
}

/** A module under `apps/web`, parsed. */
function parse(path: string): ParsedModule {
  return parseSource(
    readFileSync(`${webRoot}${path}`, "utf8"),
    path.endsWith(".tsx") ? "tsx" : "ts",
  );
}

const nameOf = (node: unknown) =>
  isNode(node) && node.type === "Identifier"
    ? (node.name as string)
    : isNode(node) && node.type === "Literal"
      ? String(node.value)
      : undefined;

/** The value names a module imports from `source`, `import type` aside. */
function valueImports(all: AstNode[], source: (from: string) => boolean) {
  const names: string[] = [];
  for (const node of all) {
    if (
      node.type !== "ImportDeclaration" ||
      node.importKind === "type" ||
      !source(String((node.source as AstNode).value))
    )
      continue;
    for (const specifier of node.specifiers as AstNode[]) {
      if (specifier.importKind === "type") continue;
      names.push(
        specifier.type === "ImportSpecifier"
          ? (nameOf(specifier.imported) ?? "")
          : `* as ${nameOf(specifier.local)}`,
      );
    }
  }
  return names;
}

const fromDatabase = (from: string) => from === "@requestport/db";
const fromWebRoot = (from: string) =>
  /(^|\/)server-request-port\.js$/u.test(from);
/** The web's RequestPort's module (ruling 140). */
const fromWebRequestPort = (from: string) =>
  /(^|\/)server-web-request-port\.js$/u.test(from);

/** The nodes that open a function's scope. */
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/**
 * The names a binding pattern declares: `a`, `a = …`, `...a`, `{ a, b: c }`,
 * `[a]`, and a constructor's `private a`.
 */
function boundIdentifiers(pattern: unknown): AstNode[] {
  if (!isNode(pattern)) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern];
    case "AssignmentPattern":
      return boundIdentifiers(pattern.left);
    case "RestElement":
      return boundIdentifiers(pattern.argument);
    case "ArrayPattern":
      return (pattern.elements as unknown[]).flatMap(boundIdentifiers);
    case "ObjectPattern":
      return (pattern.properties as AstNode[]).flatMap((property) =>
        boundIdentifiers(
          property.type === "Property" ? property.value : property,
        ),
      );
    case "TSParameterProperty":
      return boundIdentifiers(pattern.parameter);
    default:
      return [];
  }
}

/**
 * Each name a module binds as a variable, a function's name or parameter, a
 * class's name, a caught error or an import, with the node that binds it.
 */
function bindingsOf(all: AstNode[]) {
  const bindings: Array<{ name: string; identifier: AstNode; site: AstNode }> =
    [];
  for (const node of all) {
    const declared =
      node.type === "VariableDeclarator"
        ? [node.id]
        : functionTypes.has(node.type)
          ? [node.id, ...(node.params as unknown[])]
          : node.type === "CatchClause"
            ? [node.param]
            : node.type === "ClassDeclaration" ||
                node.type === "ClassExpression"
              ? [node.id]
              : node.type === "ImportSpecifier" ||
                  node.type === "ImportDefaultSpecifier" ||
                  node.type === "ImportNamespaceSpecifier"
                ? [node.local]
                : [];
    for (const identifier of declared.flatMap(boundIdentifiers))
      bindings.push({
        name: nameOf(identifier) ?? "",
        identifier,
        site: node,
      });
  }
  return bindings;
}

/**
 * What a module takes from the root, and every use that does not come from
 * it. A module holds the root's storage only as `const <name> =
 * webStorage()` written inside a function, so that no call of `webStorage()`
 * sits at module scope: any other call of `webStorage()` is a stray. (A
 * function run at load, or a read of `webDatabase` at load, still asks the
 * root; the second half's load case counts everything loading asks for.) A
 * use is matched to that storage by name, so any other binding of the same
 * name in the module is a stray too: a parameter (with a default or without),
 * a pattern, a caught error, an import, a function or class, or a variable
 * bound to anything else.
 */
function rootUses({ all, parents, line }: ParsedModule) {
  const found: Array<{ at: number; what: string }> = [];
  const stray = (node: AstNode, what: string) =>
    found.push({ at: line(node), what });
  const insideFunction = (node: AstNode) => {
    for (let at = parents.get(node); at; at = parents.get(at))
      if (functionTypes.has(at.type)) return true;
    return false;
  };
  const isRootCall = (node: unknown) =>
    isNode(node) &&
    node.type === "CallExpression" &&
    nameOf(node.callee) === "webStorage";
  /** Each `const <name> = webStorage()` written inside a function. */
  const declarations = new Set<AstNode>();
  for (const node of all) {
    if (!isRootCall(node)) continue;
    const declarator = parents.get(node);
    const declaration = declarator && parents.get(declarator);
    if (
      declarator?.type === "VariableDeclarator" &&
      declarator.init === node &&
      isNode(declarator.id) &&
      declarator.id.type === "Identifier" &&
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const" &&
      insideFunction(declaration)
    )
      declarations.add(declarator);
    else
      stray(
        node,
        "`webStorage()`, not as a function's `const <name> = webStorage()`",
      );
  }
  const storages = new Set(
    [...declarations].map((node) => nameOf(node.id) ?? ""),
  );
  for (const { name, identifier, site } of bindingsOf(all))
    if (
      storages.has(name) &&
      !declarations.has(site) &&
      // A binding of `webStorage()` itself is judged above.
      !(site.type === "VariableDeclarator" && isRootCall(site.init))
    )
      stray(identifier, `\`${name}\`, bound some other way`);
  const onStorage = (node: unknown) => storages.has(nameOf(node) ?? "");
  const uses: RootUses = {
    transactions: 0,
    handles: 0,
    managers: 0,
    ports: 0,
  };
  for (const node of all) {
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode;
      const first = (node.arguments as AstNode[])[0];
      if (nameOf(callee) === "webRequestPort") {
        uses.ports += 1;
      } else if (
        callee.type === "MemberExpression" &&
        nameOf(callee.property) === "transaction"
      ) {
        if (onStorage(callee.object)) uses.transactions += 1;
        else stray(node, "a transaction");
      } else if (nameOf(callee) === "createCommandTransactionManager") {
        if (nameOf(first) === "webDatabase") uses.managers += 1;
        else stray(node, "a transaction manager");
      } else if (nameOf(callee) === "withTransaction") {
        stray(node, "withTransaction");
      }
    } else if (
      node.type === "MemberExpression" &&
      !node.computed &&
      nameOf(node.property) === "db"
    ) {
      if (onStorage(node.object)) uses.handles += 1;
      else stray(node, "a handle");
    }
  }
  return {
    fromDatabase: valueImports(all, fromDatabase).filter((name) =>
      ["db", "withTransaction"].includes(name),
    ),
    fromWebRoot: valueImports(all, fromWebRoot).sort(),
    fromWebRequestPort: valueImports(all, fromWebRequestPort).sort(),
    uses,
    strays: found
      .sort((left, right) => left.at - right.at)
      .map(({ at, what }) => `line ${at}: ${what}`),
  };
}

/** The modules of `apps/web/src`, its tests and the test harness (`src/test`) aside. */
function webModules(): string[] {
  const modules: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(`${webRoot}${directory}`, {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (path !== "src/test") walk(path);
      } else if (
        /\.tsx?$/u.test(entry.name) &&
        !/\.test\.tsx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        modules.push(path);
      }
    }
  };
  walk("src");
  return modules.sort();
}

/**
 * Where a module takes `db` or `withTransaction` from `@requestport/db`: by
 * an import declaration, by destructuring a dynamic import (alone or as an
 * element of `Promise.all([…])`), or as a member of a namespace bound to the
 * package; or where it hands either on, by re-exporting it, or the whole
 * package, from `@requestport/db`. A dynamic import bound any other way is
 * reported as such.
 */
function databaseTakes({ all, parents, line }: ParsedModule): string[] {
  const taken = new Set(["db", "withTransaction"]);
  const imported = valueImports(all, fromDatabase);
  const found = imported.filter((name) => taken.has(name));
  const namespaces = new Set(
    imported
      .filter((name) => name.startsWith("* as "))
      .map((name) => name.slice("* as ".length)),
  );
  for (const node of all) {
    if (
      node.type !== "ImportExpression" ||
      nameOf(node.source) !== "@requestport/db"
    )
      continue;
    const parent = parents.get(node);
    const awaited = parent?.type === "AwaitExpression" ? parent : node;
    const holder = parents.get(awaited);
    let pattern: unknown;
    if (holder?.type === "VariableDeclarator") pattern = holder.id;
    else if (holder?.type === "ArrayExpression") {
      const call = parents.get(holder);
      const outer =
        call && parents.get(call)?.type === "AwaitExpression"
          ? parents.get(call)
          : call;
      const declarator = outer && parents.get(outer);
      if (
        declarator?.type === "VariableDeclarator" &&
        isNode(declarator.id) &&
        declarator.id.type === "ArrayPattern"
      )
        pattern = (declarator.id.elements as unknown[])[
          (holder.elements as unknown[]).indexOf(awaited)
        ];
    }
    if (isNode(pattern) && pattern.type === "ObjectPattern") {
      for (const property of pattern.properties as AstNode[]) {
        const key = nameOf(property.key);
        if (key && taken.has(key)) found.push(key);
      }
    } else if (isNode(pattern) && pattern.type === "Identifier") {
      namespaces.add(nameOf(pattern) as string);
    } else {
      found.push(
        `a dynamic import at line ${line(node)}, bound some other way`,
      );
    }
  }
  for (const node of all)
    if (
      node.type === "MemberExpression" &&
      !node.computed &&
      namespaces.has(nameOf(node.object) ?? "") &&
      taken.has(nameOf(node.property) ?? "")
    )
      found.push(`${nameOf(node.object)}.${nameOf(node.property)}`);
  for (const node of all) {
    if (
      (node.type !== "ExportNamedDeclaration" &&
        node.type !== "ExportAllDeclaration") ||
      node.exportKind === "type" ||
      !fromDatabase(nameOf(node.source) ?? "")
    )
      continue;
    if (node.type === "ExportAllDeclaration")
      found.push(
        node.exported
          ? `the package, re-exported as ${nameOf(node.exported)} at line ${line(node)}`
          : `the package, re-exported at line ${line(node)}`,
      );
    else
      for (const specifier of node.specifiers as AstNode[]) {
        const local = nameOf(specifier.local) ?? "";
        if (specifier.exportKind !== "type" && taken.has(local))
          found.push(`${local}, re-exported at line ${line(node)}`);
      }
  }
  return found;
}

describe("the web's importers of db, read from their source", () => {
  test("no module of the web, outside its tests, takes db or withTransaction from @requestport/db", () => {
    const modules = webModules();
    const takers = modules.flatMap((path) =>
      databaseTakes(parse(path)).map((what) => `${path}: ${what}`),
    );

    expect(modules).toEqual(expect.arrayContaining(Object.keys(movedModules)));
    expect(takers).toEqual([]);
  });

  test.each(Object.entries(movedModules))(
    "%s takes its database from the web root, and from nowhere else",
    (path, expected) => {
      const found = rootUses(parse(path));

      expect(found.fromDatabase).toEqual([]);
      expect(found.fromWebRoot).toEqual(
        [
          ...(expected.transactions + expected.handles > 0
            ? ["webStorage"]
            : []),
          ...(expected.managers > 0 ? ["webDatabase"] : []),
        ].sort(),
      );
      expect(found.fromWebRequestPort).toEqual(
        expected.ports > 0 ? ["webRequestPort"] : [],
      );
      expect(found.strays).toEqual([]);
      expect(found.uses).toEqual(expected);
    },
  );

  test("the root-use reading reports, in a planted module, each other binding of the storage's name and each other call of webStorage()", () => {
    const planted = rootUses(
      parseSource(
        `import { createStorage, storageOptionsFromEnv } from "@requestport/db";
import { other as storage } from "./elsewhere.js";
import { webStorage } from "./server-request-port.js";
const hoisted = webStorage();
export async function lawful() {
  const storage = webStorage();
  await storage.transaction(async (tx) => tx);
  return storage.db;
}
export const tools = {
  list: async (storage = createStorage(storageOptionsFromEnv(process.env))) =>
    storage.transaction(async (tx) => tx),
};
export function plain(storage: { db: unknown }) {
  return storage.db;
}
export function rest(...storage: unknown[]) {
  return storage;
}
export function fromObject({ storage }: { storage: unknown }) {
  return storage;
}
export function objectPattern(holder: { held: unknown }) {
  const { held: storage } = holder;
  return storage;
}
export function arrayPattern(list: unknown[]) {
  const [storage] = list;
  return storage;
}
export function caught() {
  try {
    return lawful();
  } catch (storage) {
    return storage;
  }
}
export class Holder {
  constructor(private readonly storage: unknown) {}
}
export function declared() {
  function storage() {
    return hoisted;
  }
  return storage;
}
export function classed() {
  class storage {}
  return storage;
}
export function otherwise() {
  const storage = createStorage(storageOptionsFromEnv(process.env));
  return storage.db;
}
export function unlawful() {
  let storage = webStorage();
  storage = webStorage();
  const { db } = webStorage();
  return [storage, db, String(webStorage())];
}
`,
        "ts",
      ),
    );

    const elsewhere = "`storage`, bound some other way";
    const notConst =
      "`webStorage()`, not as a function's `const <name> = webStorage()`";
    expect(planted.strays).toEqual([
      `line 2: ${elsewhere}`,
      `line 4: ${notConst}`,
      `line 11: ${elsewhere}`,
      `line 14: ${elsewhere}`,
      `line 17: ${elsewhere}`,
      `line 20: ${elsewhere}`,
      `line 24: ${elsewhere}`,
      `line 28: ${elsewhere}`,
      `line 34: ${elsewhere}`,
      `line 39: ${elsewhere}`,
      `line 42: ${elsewhere}`,
      `line 48: ${elsewhere}`,
      `line 52: ${elsewhere}`,
      `line 56: ${notConst}`,
      `line 57: ${notConst}`,
      `line 58: ${notConst}`,
      `line 59: ${notConst}`,
    ]);
  });

  test("the db-taker reading reports, in a planted module, each import, dynamic import, namespace member and re-export of db or withTransaction", () => {
    const planted = databaseTakes(
      parseSource(
        `import { db, withTransaction as inTransaction } from "@requestport/db";
import * as database from "@requestport/db";
export async function dynamic() {
  const { db: handle } = await import("@requestport/db");
  const [{ withTransaction }] = await Promise.all([import("@requestport/db")]);
  const module = await import("@requestport/db");
  return [handle, withTransaction, module.db, database.withTransaction];
}
export async function unbound() {
  return [db, inTransaction, (await import("@requestport/db")).db];
}
export { db as handle, withTransaction } from "@requestport/db";
export * from "@requestport/db";
export * as everything from "@requestport/db";
export { createImportRepository, type Storage } from "@requestport/db";
export type { Database } from "@requestport/db";
`,
        "ts",
      ),
    );

    expect(planted).toEqual([
      "db",
      "withTransaction",
      "db",
      "withTransaction",
      "a dynamic import at line 10, bound some other way",
      "module.db",
      "database.withTransaction",
      "db, re-exported at line 12",
      "withTransaction, re-exported at line 12",
      "the package, re-exported at line 13",
      "the package, re-exported as everything at line 14",
    ]);
  });
});

/*
 * The second half: the modules, run over the web root, whose storage is a
 * stand-in the wiring answers it. The storage records each use and refuses
 * it, so a call stops at its first use of the database. The wiring also
 * counts each time the root is asked for its storage.
 */

const root = vi.hoisted(() => {
  const reached: string[] = [];
  const refusal = new Error("stopped at the web root's storage");
  /** Every member a function that records its name and throws the refusal. */
  const db = new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      return () => {
        reached.push(`db.${property}`);
        throw refusal;
      };
    },
  });
  return {
    reached,
    refusal,
    /**
     * How many times a module has asked the root for its storage: a call of
     * `webStorage()`, a member read or an `in` test of `webDatabase`, or the
     * first `webRequestPort()`, each of which asks the wiring.
     */
    asked: 0,
    storage: {
      db,
      transaction: async () => {
        reached.push("transaction");
        throw refusal;
      },
    },
  };
});

vi.mock("@requestport/db/wiring", () => ({
  applicationStorageFromEnv: () => {
    root.asked += 1;
    return root.storage;
  },
}));
/** What the MCP route hands its MCP server, which is replaced to capture it. */
const mcp = vi.hoisted(() => ({ handed: [] as McpServerDependencies[] }));
vi.mock("@requestport/mcp", () => ({
  handleMcpRequest: async (
    _request: Request,
    dependencies: McpServerDependencies,
  ) => {
    mcp.handed.push(dependencies);
    return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
  },
}));
vi.mock("@requestport/config/server", () => ({
  serverEnv: {
    BETTER_AUTH_SECRET: "server-request-port-importers-secret-0001",
    BETTER_AUTH_URL: "https://requestport.test",
    REQUESTPORT_OPERATOR_CREDENTIALS: "enabled",
    REQUESTPORT_SLACK_CLIENT_ID: "slack-client",
    REQUESTPORT_SLACK_CLIENT_SECRET: "slack-client-secret",
    REQUESTPORT_SLACK_STATE_SECRET: "slack-state-secret-0001",
    // A fixed 32-byte test key, so the Slack calls get past their
    // configuration check to the database. It encrypts nothing here.
    REQUESTPORT_WORKSPACE_KEK: Buffer.alloc(32, 7).toString("base64url"),
    REQUESTPORT_WORKSPACE_KEK_VERSION: "importers-test-v1",
    // A fixed 32-byte webhook key, so the web's RequestPort composes its
    // webhook management service, and the MCP route hands its server the
    // webhook tools, as wherever a key is configured (Plan 13, G.3, G.6). It
    // encrypts nothing here.
    REQUESTPORT_WEBHOOK_KEK: Buffer.alloc(32, 9).toString("base64url"),
    REQUESTPORT_WEBHOOK_KEK_VERSION: "importers-test-webhooks-v1",
  },
}));
vi.mock("./observability.js", () => ({
  webLogger: { debug() {}, info() {}, warn() {}, error() {} },
  webMetrics: { count() {}, gauge() {}, observe() {} },
}));
vi.mock("./trigger-client.js", () => ({
  dispatchCommittedEvents: vi.fn(),
  dispatchImportTask: vi.fn(),
  triggerSlackConnectionTest: vi.fn(),
  // Read as `server-administration-actions.ts` loads (the load case below),
  // and never called here.
  dispatchCommittedCorrelation: vi.fn(),
}));
/**
 * The signed-in person, and the agent credential the artifacts route and the
 * MCP route admit: `import:write`, bound to a project, with no lanes, so the
 * MCP route hands its server the import tools. It also holds
 * `agent:register`, which the project registration checks before it opens
 * its transaction, and `webhook:manage`, for which the MCP route hands its
 * server the webhook tools (Plan 13, G.3).
 */
const caller = vi.hoisted(() => ({
  organizationId: "00000000-0000-4000-8000-0000000000d1",
  userId: "00000000-0000-4000-8000-0000000000aa",
}));
vi.mock("./server-application-context.js", () => ({
  getApplicationContext: async () => ({
    currentOrganization: {
      id: caller.organizationId,
      name: "CUE++",
      role: "owner",
      slug: "example-org",
    },
    session: {
      user: { id: caller.userId },
      session: { id: "session-under-test" },
    },
  }),
}));
vi.mock("./security/rate-limit.js", () => ({
  enforceRateLimit: async () => undefined,
  rateLimitFingerprint: () => "fingerprint",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@requestport/auth/server", () => ({
  agentApiKeyService: {},
  authenticateAgentBearer: async () => ({
    actor: {
      type: "agent",
      id: "00000000-0000-4000-8000-0000000000a1",
      delegatedBy: null,
    },
    organizationId: caller.organizationId,
    projectId: "00000000-0000-4000-8000-0000000000b1",
    scopes: new Set(["import:write", "agent:register", "webhook:manage"]),
    laneIds: new Set(),
    authorizationId: "00000000-0000-4000-8000-0000000000e1",
    credentialId: "00000000-0000-4000-8000-0000000000e1",
    correlationId: "00000000-0000-4000-8000-0000000000cc",
  }),
  // Read as `settings/operators/actions.ts` loads (the load case below), and
  // never called here.
  operatorCredentialAvailability: vi.fn(),
  operatorCredentialService: {},
}));
const { revokeAgentCredential, revokeAgentOauthGrant } = await import(
  "./server-agent-actions.js"
);
const { coreCommandBus } = await import("./server-core-commands.js");
const { splitImportEntry } = await import("./server-import-actions.js");
const { evaluateRouteInTransaction } = await import(
  "./server-routing-actions.js"
);
const { queueSlackConnectionTest } = await import("./server-slack-actions.js");
const slack = await import("./server-slack.js");
const { userCommandBus } = await import("./server-user-commands.js");
const { revealWorkspaceTelemetryAction, rotateAgentKeyAction } = await import(
  "../app/(app)/agents/actions.js"
);
const { default: ImportDetailPage } = await import(
  "../app/(app)/imports/[runId]/page.js"
);
const importActions = await import("../app/(app)/imports/actions.js");
const { default: ImportsPage } = await import("../app/(app)/imports/page.js");
const artifactsRoute = await import("../app/api/v1/imports/artifacts/route.js");
const mcpRoute = await import("../app/mcp/route.js");
const { webRequestPort } = await import("./server-web-request-port.js");
const {
  capabilityRegistry,
  operatorActor,
  operatorScopes,
  privateTelemetryFields,
} = await import("@requestport/domain");
/**
 * Every module of the web, outside its tests and the harness, whose source
 * names the root's module or the web's RequestPort's, the root itself aside:
 * the 13 of `movedModules`, loaded above, the 33 other modules G.3 moved onto
 * the root that still name it (Plan 13, G.3; ruling 130: never at module
 * scope; `server-project-provisioning.ts`, the 34th, went in G.6, its
 * composition the web's RequestPort's), the readiness route, which G.5 moved
 * onto it (`app/api/health/ready/route.ts`), and the RequestPort's module,
 * `server-web-request-port.ts`, which composes over the root's storage
 * (ruling 140). Each is loaded by `vi.importActual`, so that the three this
 * file replaces above (`trigger-client.ts`, `server-application-context.ts`
 * and `security/rate-limit.ts`) load as themselves too. What each imports is
 * replaced as it is for every module here, the root's storage by its
 * stand-in.
 */
const rootImporters = webModules().filter((path) => {
  if (path === "src/lib/server-request-port.ts") return false;
  const text = readFileSync(`${webRoot}${path}`, "utf8");
  return (
    text.includes("server-request-port") ||
    text.includes("server-web-request-port")
  );
});
for (const path of rootImporters) await vi.importActual(`../../${path}`);
/** How many times loading every module above asked the root for its storage. */
const askedWhileLoading = root.asked;

const { organizationId } = caller;
const meta = { expectedVersion: 0, idempotencyKey: "0123456789abcdef0123" };
const runId = "00000000-0000-4000-8000-000000000101";
const requestId = "00000000-0000-4000-8000-000000000301";

/** A form as the browser submits it. */
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  return data;
}

function personContext(scope: string): AuthorizedCommandContext {
  return {
    actor: { type: "user", id: "00000000-0000-4000-8000-0000000000aa" },
    organizationId,
    scopes: new Set([scope]),
    credentialId: "session-under-test",
    correlationId: "00000000-0000-4000-8000-0000000000cc",
  };
}

/**
 * An operator credential's context (Plan 13, F.3), holding every operator
 * scope: the one context an administration read admits, and takes on to its
 * transaction, refusing any other before it asks the root. Some reads open
 * their transaction first, and re-check the credential inside it.
 */
function operatorContext(): AuthorizedCommandContext {
  return {
    actor: operatorActor({
      lineageId: "00000000-0000-4000-8000-0000000000f1",
      memberUserId: caller.userId,
    }),
    credentialKind: "operator",
    organizationId,
    projectId: null,
    scopes: new Set(operatorScopes),
    credentialId: "00000000-0000-4000-8000-0000000000f2",
    correlationId: "00000000-0000-4000-8000-0000000000cc",
  };
}

/** The transaction manager a bus was built with. */
function transactionsOf(bus: unknown) {
  return (
    bus as {
      dependencies: { transactions: { run(work: () => unknown): unknown } };
    }
  ).dependencies.transactions;
}

type McpImportTools = NonNullable<McpServerDependencies["imports"]>;

/**
 * What the MCP route hands its MCP server for one request, from the agent
 * credential above.
 */
async function mcpDependencies(): Promise<McpServerDependencies> {
  mcp.handed.length = 0;
  const response = await mcpRoute.POST(
    new Request("https://requestport.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer an-agent-credential",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  const handed = mcp.handed[0];
  expect(response.status).toBe(200);
  expect(mcp.handed).toHaveLength(1);
  if (!handed) throw new Error("the MCP route handed its server nothing");
  return handed;
}

/** The import tools the MCP route hands its MCP server for one request. */
async function mcpImportTools(): Promise<McpImportTools> {
  const tools = (await mcpDependencies()).imports;
  if (!tools)
    throw new Error("the MCP route handed its server no import tools");
  return tools;
}

beforeEach(() => {
  root.reached.length = 0;
});

describe("the web's importers of db, run over the web root", () => {
  test("loading every module of the web that imports the web root asks it for nothing", () => {
    expect(rootImporters).toHaveLength(48);
    expect(rootImporters).toEqual(
      expect.arrayContaining([
        ...Object.keys(movedModules),
        "src/lib/server-web-request-port.ts",
      ]),
    );
    expect(askedWhileLoading).toBe(0);
  });

  test.each([
    [
      "revokeAgentCredential",
      () =>
        revokeAgentCredential(
          personContext("agent:manage"),
          {
            organizationId,
            agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
            credentialId: "00000000-0000-4000-8000-0000000000c1",
          },
          { ...meta, expectedVersion: 2 },
        ),
    ],
    [
      "revokeAgentOauthGrant",
      () =>
        revokeAgentOauthGrant(
          personContext("agent:manage"),
          {
            organizationId,
            agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
            grantId: "00000000-0000-4000-8000-0000000000e1",
            reason: "The laptop holding it was lost",
          },
          { ...meta, expectedVersion: 2 },
        ),
    ],
    [
      "splitImportEntry",
      () =>
        splitImportEntry(
          personContext("import:write"),
          {
            organizationId,
            runId: "00000000-0000-4000-8000-000000000101",
            entryId: "00000000-0000-4000-8000-000000000102",
            splitLines: [2],
          },
          { ...meta, expectedVersion: 3 },
        ),
    ],
    [
      "evaluateRouteInTransaction",
      () =>
        evaluateRouteInTransaction(personContext("request:create"), {
          purpose: "preview",
          organizationId,
          targetProjectId: "00000000-0000-4000-8000-0000000000b1",
          requestType: "feature",
          priority: "normal",
        }),
    ],
    [
      "queueSlackConnectionTest",
      () =>
        queueSlackConnectionTest(
          personContext("slack:manage"),
          {
            organizationId,
            installationId: "00000000-0000-4000-8000-000000000201",
            channelId: "C012ABCDEF",
          },
          meta,
        ),
    ],
    [
      "completeSlackInstallation",
      () => slack.completeSlackInstallation({ code: "code", state: "state" }),
    ],
    [
      "prepareSlackAnswerModal",
      () =>
        slack.prepareSlackAnswerModal({
          rawToken: "launch-token",
          workspaceId: "T012ABCDEF",
          slackUserId: "U012ABCDEF",
        }),
    ],
  ])("%s opens its transaction on the web root's storage", async (_, call) => {
    await expect(call()).rejects.toBe(root.refusal);

    expect(root.reached).toEqual(["transaction"]);
  });

  test.each([
    [
      "startSlackInstallation",
      () => slack.startSlackInstallation(personContext("slack:manage")),
    ],
    [
      "issueSlackActionToken",
      () =>
        slack.issueSlackActionToken({
          organizationId,
          questionId: "00000000-0000-4000-8000-000000000401",
          installationId: "00000000-0000-4000-8000-000000000201",
          slackUserId: "U012ABCDEF",
          tokenType: "answer",
          actionPayload: {},
          expiresAt: new Date("2026-10-02T12:00:00.000Z"),
        }),
    ],
  ])("%s hands its repository the web root's handle", async (_, call) => {
    await expect(call()).rejects.toBe(root.refusal);

    expect(root.reached.length).toBeGreaterThan(0);
    for (const use of root.reached) expect(use).toMatch(/^db\./u);
  });

  test.each([
    ["the tenant command bus", () => transactionsOf(coreCommandBus)],
    ["the personal command bus", () => transactionsOf(userCommandBus)],
  ])("%s runs its unit of work on the web root's handle", (_, transactions) => {
    expect(() => transactions().run(async () => undefined)).toThrow(
      root.refusal,
    );

    expect(root.reached).toEqual(["db.transaction"]);
  });

  test("Slack's answer runs its unit of work on the web root's handle", async () => {
    await expect(
      slack.answerSlackQuestion({
        rawToken: "answer-token",
        tokenType: "answer",
        workspaceId: "T012ABCDEF",
        slackUserId: "U012ABCDEF",
      }),
    ).rejects.toBe(root.refusal);

    expect(root.reached).toEqual(["db.transaction"]);
  });

  test.each([
    ["the imports page", () => ImportsPage()],
    [
      "an import's page",
      () => ImportDetailPage({ params: Promise.resolve({ runId }) }),
    ],
  ])("%s opens its transaction on the web root's storage", async (_, page) => {
    await expect(page()).rejects.toBe(root.refusal);

    expect(root.reached).toEqual(["transaction"]);
  });

  test.each([
    [
      "analyzeImportAction",
      () =>
        importActions.analyzeImportAction(
          { status: "idle", message: "" },
          form({
            ...meta,
            expectedVersion: "0",
            sourceId: "00000000-0000-4000-8000-000000000501",
            snapshotId: "00000000-0000-4000-8000-000000000502",
          }),
        ),
    ],
    [
      "freezeImportAction",
      () =>
        importActions.freezeImportAction(
          { status: "idle", message: "" },
          form({ ...meta, expectedVersion: "1", runId }),
        ),
    ],
    [
      "applyImportAction",
      () =>
        importActions.applyImportAction(
          { status: "idle", message: "" },
          form({
            ...meta,
            expectedVersion: "2",
            runId,
            manifestConfirmation: "0123456789abcdef",
          }),
        ),
    ],
    [
      "correctImportAction",
      () =>
        importActions.correctImportAction(
          { status: "idle", message: "" },
          form({ ...meta, expectedVersion: "3", runId }),
        ),
    ],
  ])(
    "%s opens its transaction on the web root's storage, and answers the refusal as a failure",
    async (_, action) => {
      await expect(action()).resolves.toEqual({
        status: "error",
        message: "Import action failed.",
      });

      expect(root.reached).toEqual(["transaction"]);
    },
  );

  test("the artifacts route opens its transaction on the web root's storage, and answers the refusal as unexpected", async () => {
    const response = await artifactsRoute.POST(
      new Request("https://requestport.test/api/v1/imports/artifacts", {
        method: "POST",
        headers: {
          authorization: "Bearer an-agent-credential",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...meta,
          action: "finalize",
          sourceId: "00000000-0000-4000-8000-000000000501",
          snapshotId: "00000000-0000-4000-8000-000000000502",
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "unexpected_error",
    });
    expect(root.reached).toEqual(["transaction"]);
  });

  test("revealing an agent's workspace telemetry hands its repository the web root's handle", async () => {
    const state = await revealWorkspaceTelemetryAction(
      { status: "idle", message: "" },
      form({
        ...meta,
        // A reveal is always new: the repository refuses any other version
        // before it opens its transaction.
        expectedVersion: "0",
        workspaceId: "00000000-0000-4000-8000-000000000601",
        reason: "Investigating a stuck work session",
        fields: String(privateTelemetryFields[0]),
      }),
    );

    expect(state.status).toBe("error");
    expect(root.reached).toEqual(["db.transaction"]);
  });

  test("rotating an agent's key hands its credential read's repository the web root's handle", async () => {
    const state = await rotateAgentKeyAction(
      { status: "idle", message: "" },
      form({
        ...meta,
        expectedVersion: "2",
        agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
        credentialId: "00000000-0000-4000-8000-0000000000c1",
      }),
    );

    expect(state.status).toBe("error");
    expect(root.reached.length).toBeGreaterThan(0);
    for (const use of root.reached) expect(use).toMatch(/^db\./u);
  });

  test.each<[string, (tools: McpImportTools) => Promise<unknown>]>([
    ["list", (tools) => tools.list()],
    ["detail", (tools) => tools.detail(runId)],
    [
      "analyze",
      (tools) =>
        tools.analyze(
          "00000000-0000-4000-8000-000000000501",
          "00000000-0000-4000-8000-000000000502",
          meta,
        ),
    ],
    [
      "apply",
      (tools) =>
        tools.apply(runId, "0123456789abcdef", {
          ...meta,
          expectedVersion: 2,
        }),
    ],
    [
      "correct",
      (tools) => tools.correct(runId, { ...meta, expectedVersion: 3 }),
    ],
  ])(
    "the MCP route's %s import tool opens its transaction on the web root's storage",
    async (_, call) => {
      const tools = await mcpImportTools();

      await expect(call(tools)).rejects.toBe(root.refusal);
      expect(root.reached).toEqual(["transaction"]);
    },
  );

  test.each<
    [
      string,
      (
        queries: McpServerDependencies["queries"],
        agent: McpServerDependencies["context"],
      ) => Promise<unknown>,
    ]
  >([
    ["getAgentPolicy", (queries, agent) => queries.getAgentPolicy(agent)],
    ["listOrganizations", (queries, agent) => queries.listOrganizations(agent)],
    ["listProjects", (queries, agent) => queries.listProjects(agent)],
    [
      "getProject",
      (queries, agent) =>
        queries.getProject(agent, "00000000-0000-4000-8000-0000000000b1"),
    ],
    ["listRequests", (queries, agent) => queries.listRequests(agent, {})],
    ["getRequest", (queries, agent) => queries.getRequest(agent, requestId)],
    [
      "listTimeline",
      (queries, agent) => queries.listTimeline(agent, requestId),
    ],
    ["listOpenQuestions", (queries, agent) => queries.listOpenQuestions(agent)],
    ["listEvents", (queries, agent) => queries.listEvents(agent)],
  ])(
    "the MCP route's %s query hands its repository the web root's handle",
    async (_, call) => {
      const { context, queries } = await mcpDependencies();
      // Each query refuses a context lacking its query's scope before its
      // repository is built (ruling 230), as the MCP server registers a query
      // tool only for a key holding that scope; the agent here holds none of
      // the three, so they are added for the call.
      const reader = {
        ...context,
        scopes: new Set([
          ...context.scopes,
          "org:read",
          "project:read",
          "request:read",
        ]),
      };

      await expect(call(queries, reader)).rejects.toBe(root.refusal);
      expect(root.reached).toEqual(["db.transaction"]);
    },
  );

  test("the MCP route's project registration hands its repository the web root's handle", async () => {
    const { registerProject } = await mcpDependencies();
    if (!registerProject)
      throw new Error(
        "the MCP route handed its server no project registration",
      );

    await expect(
      registerProject({ alias: "importers-test" }, meta),
    ).rejects.toBe(root.refusal);
    expect(root.reached).toEqual(["db.transaction"]);
  });

  test("the MCP route's webhook replay hands its outbox repository the web root's handle", async () => {
    const { webhooks } = await mcpDependencies();
    if (!webhooks)
      throw new Error("the MCP route handed its server no webhook tools");

    await expect(
      webhooks.replay("00000000-0000-4000-8000-000000000701", meta),
    ).rejects.toBe(root.refusal);
    expect(root.reached.length).toBeGreaterThan(0);
    for (const use of root.reached) expect(use).toMatch(/^db\./u);
  });

  // `withAdministrationReadTransaction` opens its transaction on the handle
  // it is given (`tenant-context.ts`). Since G.3 each read hands it the
  // root's handle, and since G.6 the web's RequestPort runs each read, as the
  // REST route's GET does, handing it its storage's handle, which is the
  // root's. A read that returns the transaction's promise throws where the
  // stand-in refuses, so each runs in an async function, which answers that
  // throw as the rejection it is.
  test.each(
    capabilityRegistry
      .filter(
        (capability) =>
          capability.kind === "query" &&
          capability.dispatch.to === "administration-read",
      )
      .map((capability) => capability.name),
  )(
    "the administration read %s, run by the web's RequestPort, opens its transaction on the web root's handle",
    async (name) => {
      await expect(
        (async () =>
          webRequestPort().query(
            name,
            {},
            { context: operatorContext(), credentialKind: "operator" },
          ))(),
      ).rejects.toBe(root.refusal);
      expect(root.reached).toEqual(["db.transaction"]);
    },
  );
});
