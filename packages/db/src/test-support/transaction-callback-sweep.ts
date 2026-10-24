import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * The source sweep over every transaction callback (Plan 13, X25's
 * remainder; ruling 232 item 7).
 *
 * The overlap guard (`one-query-at-a-time.ts`, X24) sees only a site some
 * case runs. X24's own sweep sees `Promise.all` and its kin anywhere in
 * `packages/db/src`, whose repositories run on whatever they were built
 * over, a transaction among them. This one sees every source of `packages/`
 * and `apps/`, `packages/db`'s among them, but only inside transaction
 * callbacks: every function handed to something that runs it in a
 * transaction, and every `Promise.all`, `allSettled`, `any` or `race` inside
 * it, however deeply nested, which would hand that transaction's one client
 * several queries at once.
 *
 * A transaction callback is a function handed where a transaction is handed
 * to it, as far as the argument's own text shows (`reached`): a function
 * written there; a function written in the same file under the name it is
 * handed by (a declaration, a variable bound to a function, an object's
 * method or property), or under the property a member expression names
 * (`handlers.read`); either branch of a conditional and either side of a
 * logical expression; the function `.bind` is called on; and any of these
 * among the arguments of another call (`wrap(async (tx) => …)`), whose
 * result may run it. Parentheses, `as`, `!`, `satisfies` and `?.` are
 * looked through. Where a transaction is handed:
 *
 * - the first argument of any `.transaction(...)` call: Drizzle's, a
 *   storage's, Better Auth's adapter's, a unit of work's;
 * - the argument of a helper that opens one, at the position where the
 *   helper takes its callback. A helper is found, not listed: a named
 *   function (a declaration, a variable bound to a function, an object's
 *   method or property) that hands one of its parameters to a transaction,
 *   through any of the shapes above, at a callback position of
 *   `.transaction(...)` or of another helper, or calls it inside a callback
 *   it hands there. The search repeats until no new helper is found, so a
 *   helper that forwards to `inTenantTransaction`, which forwards to
 *   `.transaction`, is found.
 *
 * Helpers, and functions handed by name or by property, are matched by name,
 * because nothing here resolves an import, a scope or an object: a call of
 * another function with the same name at the same position counts too, and
 * so does another function of the handed name written in the same file, and
 * every argument of a call handed there counts as handed. That can only add
 * callbacks, so it can make a sweep fail where it should pass, never pass
 * where it should fail.
 *
 * What it does not see:
 * - a callback handed by a name or a property that is not written in the
 *   same file (an import, an object built elsewhere), or by a parameter the
 *   caller forwards (its callers are judged instead, as a helper's);
 * - a function reached any other way: through a computed member
 *   (`handlers[name]`), a spread argument, a variable assigned after it is
 *   declared (`let read; read = …`), `.call` or `.apply`, or returned by a
 *   call that is not handed it (`makeReader()`);
 * - a function that is handed a transaction as an ordinary parameter,
 *   outside any callback, as a repository is (X24's sweep covers
 *   `packages/db/src`'s);
 * - concurrency without those four calls, such as two queries started and
 *   then awaited in turn.
 */

export interface SweepSource {
  readonly path: string;
  readonly text: string;
}

export type ParseAst = (
  text: string,
  options: { lang: "ts" | "tsx" },
  filename: string,
) => unknown;

/**
 * A function handed where a transaction is handed to it, as far as the
 * argument's text shows it (the header).
 */
export interface TransactionCallback {
  readonly path: string;
  /** The line the function starts on, where it is written. */
  readonly line: number;
  /** The name of the call it is handed to: `transaction`, or a helper's. */
  readonly via: string;
}

/** A `Promise.all` or one of its kin inside a transaction callback. */
export interface TransactionCallbackSite {
  readonly path: string;
  readonly line: number;
  readonly call: string;
  /** The innermost transaction callback it is in. */
  readonly callback: { readonly line: number; readonly via: string };
}

export interface TransactionCallbackSweep {
  /** Each helper found, with the argument positions where it takes its callback. */
  readonly helpers: ReadonlyMap<string, readonly number[]>;
  readonly callbacks: readonly TransactionCallback[];
  readonly sites: readonly TransactionCallbackSite[];
  /** Each source the parser refused, which the sweep could not judge. */
  readonly unparsed: readonly {
    readonly path: string;
    readonly error: string;
  }[];
}

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const PROMISE_KIN = new Set(["all", "allSettled", "any", "race"]);
const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function children(node: Node): Node[] {
  const found: Node[] = [];

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

function isFunction(node: unknown): node is Node {
  return isNode(node) && FUNCTIONS.has(node.type);
}

/** The name a call is made by: `f(…)` and `x.f(…)` are both calls of `f`. */
function calleeName(call: Node): string | undefined {
  let callee = call.callee as Node | undefined;

  while (callee !== undefined && WRAPPERS.has(callee.type)) {
    callee = callee.expression as Node | undefined;
  }
  if (callee === undefined) return undefined;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && callee.computed !== true) {
    const property = callee.property as Node | undefined;

    if (property?.type === "Identifier") return property.name as string;
  }
  return undefined;
}

function argumentsOf(call: Node): Node[] {
  return (call.arguments as unknown[]).filter(isNode);
}

/** `node`, looked through parentheses, `as`, `!`, `satisfies` and `?.`. */
function unwrap(node: unknown): Node | undefined {
  let current = isNode(node) ? node : undefined;

  while (current !== undefined && WRAPPERS.has(current.type)) {
    current = isNode(current.expression) ? current.expression : undefined;
  }
  return current;
}

/** What an argument hands, as far as its own text shows (the header). */
interface Reached {
  /** Each name it hands a function by. */
  readonly names: readonly string[];
  /** Each property a member expression it hands names (`handlers.read`). */
  readonly properties: readonly string[];
  /** Each function written in it. */
  readonly functions: readonly Node[];
}

function reached(argument: unknown): Reached {
  const names: string[] = [];
  const properties: string[] = [];
  const functions: Node[] = [];
  const visit = (value: unknown): void => {
    const node = unwrap(value);

    if (node === undefined) return;
    if (FUNCTIONS.has(node.type)) {
      functions.push(node);
    } else if (node.type === "Identifier") {
      names.push(node.name as string);
    } else if (node.type === "MemberExpression") {
      const property = node.property as Node | undefined;

      if (node.computed !== true && property?.type === "Identifier") {
        properties.push(property.name as string);
      }
    } else if (node.type === "ConditionalExpression") {
      visit(node.consequent);
      visit(node.alternate);
    } else if (node.type === "LogicalExpression") {
      visit(node.left);
      visit(node.right);
    } else if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      const property = callee?.property as Node | undefined;

      if (
        callee?.type === "MemberExpression" &&
        callee.computed !== true &&
        property?.type === "Identifier" &&
        property.name === "bind"
      ) {
        visit(callee.object);
      }
      for (const inner of argumentsOf(node)) visit(inner);
    }
  };

  visit(argument);
  return { names, properties, functions };
}

/** Each parameter's name, by position, or undefined for a pattern. */
function parameterNames(fn: Node): (string | undefined)[] {
  return (fn.params as Node[]).map((parameter) => {
    let named: Node = parameter;

    if (named.type === "TSParameterProperty") named = named.parameter as Node;
    if (named.type === "AssignmentPattern") named = named.left as Node;
    return named.type === "Identifier" ? (named.name as string) : undefined;
  });
}

function namedFunctions(program: Node): { name: string; fn: Node }[] {
  const found: { name: string; fn: Node }[] = [];

  walk(program, (node) => {
    const id = node.id as Node | undefined;
    const key = node.key as Node | undefined;

    if (node.type === "FunctionDeclaration" && id?.type === "Identifier") {
      found.push({ name: id.name as string, fn: node });
    } else if (
      node.type === "VariableDeclarator" &&
      id?.type === "Identifier" &&
      isFunction(node.init)
    ) {
      found.push({ name: id.name as string, fn: node.init });
    } else if (
      (node.type === "Property" ||
        node.type === "MethodDefinition" ||
        node.type === "PropertyDefinition") &&
      key?.type === "Identifier" &&
      isFunction(node.value)
    ) {
      found.push({ name: key.name as string, fn: node.value });
    }
  });
  return found;
}

function calls(node: Node): Node[] {
  const found: Node[] = [];

  walk(node, (inner) => {
    if (inner.type === "CallExpression") found.push(inner);
  });
  return found;
}

function promiseKin(call: Node): string | undefined {
  const callee = call.callee as Node | undefined;

  if (callee?.type !== "MemberExpression" || callee.computed === true) {
    return undefined;
  }
  const object = callee.object as Node;
  const property = callee.property as Node;

  return object.type === "Identifier" &&
    object.name === "Promise" &&
    property.type === "Identifier" &&
    PROMISE_KIN.has(property.name as string)
    ? `Promise.${property.name as string}`
    : undefined;
}

function lineOf(text: string, offset: number): number {
  let line = 1;

  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * Sweeps `sources` (each a path and its text, `.tsx` parsed as TSX) with
 * `parseAst`, which answers an ESTree program with TypeScript's nodes and
 * each node's `start` and `end` offsets, as rolldown's does.
 */
export function sweepTransactionCallbacks(
  sources: readonly SweepSource[],
  parseAst: ParseAst,
): TransactionCallbackSweep {
  const parsed: { source: SweepSource; program: Node }[] = [];
  const unparsed: { path: string; error: string }[] = [];

  for (const source of sources) {
    try {
      const program = parseAst(
        source.text,
        { lang: source.path.endsWith("x") ? "tsx" : "ts" },
        source.path,
      );

      if (!isNode(program)) throw new Error("the parser answered no program");
      parsed.push({ source, program });
    } catch (error) {
      unparsed.push({
        path: source.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const helpers = new Map<string, Set<number>>([["transaction", new Set([0])]]);
  const definitions = parsed.flatMap(({ program }) => namedFunctions(program));

  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, fn } of definitions) {
      if (!isNode(fn.body)) continue;
      const parameters = parameterNames(fn);

      for (const call of calls(fn.body)) {
        const positions = helpers.get(calleeName(call) ?? "");

        if (positions === undefined) continue;
        const args = argumentsOf(call);

        for (const position of positions) {
          const handed = reached(args[position]);
          // A parameter handed there, or called inside a function written
          // there.
          const invoked = new Set([
            ...handed.names,
            ...handed.functions.flatMap((inner) =>
              isNode(inner.body)
                ? calls(inner.body)
                    .map((call) => call.callee as Node)
                    .filter((callee) => callee.type === "Identifier")
                    .map((callee) => callee.name as string)
                : [],
            ),
          ]);
          parameters.forEach((parameter, index) => {
            if (parameter === undefined || !invoked.has(parameter)) return;
            const known = helpers.get(name) ?? new Set<number>();

            if (known.has(index)) return;
            known.add(index);
            helpers.set(name, known);
            grew = true;
          });
        }
      }
    }
  }

  const callbacks: (TransactionCallback & { start: number; end: number })[] =
    [];
  const sites: TransactionCallbackSite[] = [];

  for (const { source, program } of parsed) {
    const inFile: (TransactionCallback & { start: number; end: number })[] = [];
    // The functions written in this file, by name, for a callback handed by
    // name or by property (the header).
    const written = new Map<string, Node[]>();

    for (const { name, fn } of namedFunctions(program)) {
      written.set(name, [...(written.get(name) ?? []), fn]);
    }
    walk(program, (node) => {
      if (node.type !== "CallExpression") return;
      const via = calleeName(node);
      const positions = helpers.get(via ?? "");

      if (via === undefined || positions === undefined) return;
      const args = argumentsOf(node);

      for (const position of [...positions].sort((a, b) => a - b)) {
        const handed = reached(args[position]);
        const functions = [
          ...handed.functions,
          ...[...handed.names, ...handed.properties].flatMap(
            (name) => written.get(name) ?? [],
          ),
        ];

        for (const fn of functions) {
          if (inFile.some(({ start }) => start === fn.start)) continue;
          inFile.push({
            path: source.path,
            line: lineOf(source.text, fn.start),
            via,
            start: fn.start,
            end: fn.end,
          });
        }
      }
    });
    callbacks.push(...inFile);
    walk(program, (node) => {
      if (node.type !== "CallExpression") return;
      const call = promiseKin(node);

      if (call === undefined) return;
      const around = inFile
        .filter(({ start, end }) => start <= node.start && node.end <= end)
        .sort((a, b) => b.start - a.start)[0];

      if (around === undefined) return;
      sites.push({
        path: source.path,
        line: lineOf(source.text, node.start),
        call,
        callback: { line: around.line, via: around.via },
      });
    });
  }

  return {
    helpers: new Map(
      [...helpers]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, positions]) => [
          name,
          [...positions].sort((a, b) => a - b),
        ]),
    ),
    callbacks: callbacks.map(({ path, line, via }) => ({ path, line, via })),
    sites,
    unparsed,
  };
}

/**
 * Rolldown's parser (`rolldown/parseAst`), as `packages/core` installs it for
 * its bundle: this package does not depend on rolldown, so it is resolved
 * from that package's directory.
 */
export async function rolldownParseAst(): Promise<ParseAst> {
  const requireFromCore = createRequire(
    new URL("../../../core/package.json", import.meta.url),
  );
  const parser = (await import(
    pathToFileURL(requireFromCore.resolve("rolldown/parseAst")).href
  )) as { parseAst: ParseAst };

  return parser.parseAst;
}

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/u;
const NOT_SOURCE = /\.(?:test|spec)\.[cm]?tsx?$|\.d\.[cm]?ts$/u;

/**
 * Every TypeScript source under `root`'s `packages/` and `apps/`, by its
 * path from `root`: each `.ts`, `.tsx`, `.mts` and `.cts` file git tracks
 * there, or would track (untracked and not ignored), but a test
 * (`*.test.*`, `*.spec.*`) or a declaration (`*.d.ts`). Git chooses, not a
 * list of directories here, so `node_modules` and the build outputs
 * (`.next`, `dist`, `coverage`, which `.gitignore` names) are left out and a
 * source in a dot-directory (`apps/web/src/app/.well-known`) is read. A file
 * git tracks that the working tree has deleted is not read. Git runs without
 * the caller's `GIT_*` variables, which a process a git hook starts can
 * inherit, naming the hook's repository rather than `root`'s; where `root`
 * is no git checkout it throws, so nothing passes unswept.
 */
export function sourcesUnder(root: string): SweepSource[] {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const listed = execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "packages",
      "apps",
    ],
    { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
  );
  const paths = [...new Set(listed.split("\0"))].filter(
    (path) =>
      SOURCE_FILE.test(path) &&
      !NOT_SOURCE.test(path) &&
      existsSync(join(root, path)),
  );

  return paths
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}
