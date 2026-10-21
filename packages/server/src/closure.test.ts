/**
 * What the host loads (Plan 13, H.1; manifest-h.md §5, Done when 3): no
 * module in its closure imports `better-auth/next-js`, or anything of Next.
 * The host serves Better Auth through `auth.handler`, the member of the
 * object it is handed, where the web's route once wrapped it in
 * `toNextJsHandler`.
 *
 * The closure is read from the source: from this package's root, which
 * exports the host and the Node adapter, every module a value import, a
 * value re-export or a dynamic `import()` names, followed through relative
 * paths and through each `@requestport/*` package's `exports`, comments and
 * type-only imports aside (they compile to nothing). A third-party
 * specifier is recorded and not followed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";
import { parseAst } from "vitest/node";

const root = fileURLToPath(new URL("../../../", import.meta.url));

type AstNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Each `@requestport/*` package's directory and `exports`. */
const workspacePackages = new Map(
  readdirSync(`${root}packages`, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(`${root}packages/${entry.name}/package.json`),
    )
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(`${root}packages/${entry.name}/package.json`, "utf8"),
      ) as { name: string; exports?: unknown };
      return [
        manifest.name,
        { directory: `packages/${entry.name}/`, exports: manifest.exports },
      ] as const;
    }),
);

/** The value specifiers a module names, in source order. */
function valueSpecifiers(path: string): string[] {
  const program = parseAst(readFileSync(`${root}${path}`, "utf8"), {
    lang: path.endsWith(".tsx") ? "tsx" : "ts",
  }) as unknown as AstNode;
  const found: string[] = [];
  const visit = (node: AstNode) => {
    const source = node.source as AstNode | undefined;
    if (
      (node.type === "ImportDeclaration" && node.importKind !== "type") ||
      ((node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
        source &&
        node.exportKind !== "type") ||
      node.type === "ImportExpression"
    ) {
      if (source?.type === "Literal" && typeof source.value === "string")
        found.push(source.value);
    }
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value])
        if (isNode(child)) visit(child);
  };
  visit(program);
  return found;
}

/** The repository path a specifier names from `from`, or null when it is a third party's. */
function resolve(specifier: string, from: string): string | null {
  if (specifier.startsWith(".")) {
    const base = new URL(specifier, `file:///${from}`).pathname.slice(1);
    const candidates = [
      base.replace(/\.js$/u, ".ts"),
      base.replace(/\.js$/u, ".tsx"),
      base,
      `${base}.ts`,
      `${base}/index.ts`,
    ];
    const found = candidates.find((candidate) =>
      existsSync(`${root}${candidate}`),
    );
    if (!found) throw new Error(`${from}: cannot resolve ${specifier}`);
    return found;
  }
  const [, name, subpath] =
    /^(@requestport\/[^/]+)(\/.+)?$/u.exec(specifier) ?? [];
  if (!name) return null;
  const workspace = workspacePackages.get(name);
  if (!workspace) throw new Error(`${from}: no workspace package ${name}`);
  const exports = workspace.exports;
  const target =
    typeof exports === "string"
      ? subpath === undefined
        ? exports
        : undefined
      : (exports as Record<string, unknown> | undefined)?.[`.${subpath ?? ""}`];
  if (typeof target !== "string")
    throw new Error(`${from}: ${name} does not export ${subpath ?? "."}`);
  return `${workspace.directory}${target.replace(/^\.\//u, "")}`;
}

/** Every module the root loads, and every third-party specifier any of them names. */
function closure(start: string) {
  const modules = new Map<string, string[]>();
  const pending = [start];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (modules.has(path)) continue;
    const specifiers = valueSpecifiers(path);
    modules.set(path, specifiers);
    for (const specifier of specifiers) {
      const next = resolve(specifier, path);
      if (next && !modules.has(next)) pending.push(next);
    }
  }
  return modules;
}

const hostClosure = closure("packages/server/src/index.ts");

test("the walk reaches the host, the Node adapter, the auth and MCP handlers, and the auth wrapper in @requestport/auth", () => {
  expect([...hostClosure.keys()]).toEqual(
    expect.arrayContaining([
      "packages/server/src/host.ts",
      "packages/server/src/node.ts",
      "packages/server/src/auth.ts",
      "packages/server/src/mcp.ts",
      "packages/auth/src/auth-handler.ts",
      "packages/mcp/src/server.ts",
    ]),
  );
});

test("no module in the host's closure imports better-auth/next-js, or next", () => {
  const offending = [...hostClosure].flatMap(([path, specifiers]) =>
    specifiers
      .filter(
        (specifier) =>
          specifier === "better-auth/next-js" ||
          specifier === "next" ||
          specifier.startsWith("next/"),
      )
      .map((specifier) => `${path}: ${specifier}`),
  );

  expect(offending).toEqual([]);
});

test("the host's closure loads none of @requestport/auth's modules that install Better Auth: it is handed Better Auth's object", () => {
  expect([...hostClosure.keys()]).not.toEqual(
    expect.arrayContaining(["packages/auth/src/server.ts"]),
  );
  expect([...hostClosure.keys()]).not.toEqual(
    expect.arrayContaining(["packages/auth/src/index.ts"]),
  );
});
