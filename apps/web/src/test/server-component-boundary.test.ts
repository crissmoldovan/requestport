import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

import { describe, expect, test } from "vitest";

import { withoutComments } from "./source-text.js";

/**
 * The React Server Component boundary, read out of the sources themselves.
 *
 * A Server Component that composes a client-only CUE++ module fails in exactly
 * one place — the browser — and it fails *silently* everywhere else. Neither
 * vitest lane can see it: the node lane never renders, and the jsdom lane is a
 * client environment by construction, so a `.dom.test.tsx` suite mounts the very
 * module the server cannot use and passes. The only witness is a Playwright
 * journey, which reports it as "the page never loaded" forty-five seconds later.
 *
 * Two shapes break, and they break for the same reason: what crosses the RSC
 * boundary is serialised data, not JavaScript.
 *
 * - **A client-only namespace.** `AppShell` is published from a module whose
 *   first line is `"use client"`, so on the server the import is a client
 *   *reference* rather than the compound object the package builds. Every
 *   member access — `AppShell.Root`, `AppShell.Body`, `AppShell.Sidebar` — is
 *   therefore `undefined`, and React throws on the first one. Rendering a
 *   client component as a plain element from a server module is not this: that
 *   is the boundary working as designed, and it stays allowed.
 * - **A function-valued prop.** A lucide icon is a component *function*.
 *   Handing one to a client component's prop asks the serialiser to send a
 *   function across the boundary, which it refuses. Handing the same function
 *   to a server-safe component such as `EmptyState` never crosses a boundary at
 *   all, so it stays allowed too.
 *
 * Both rules resolve their verdict from the installed package rather than from
 * a list: an import is followed through the published barrel to the dist module
 * that defines it, and that module's own first line decides whether it is a
 * client module. A CUE++ release that turns a server module into a client one
 * therefore fails this suite on the upgrade, which is the point.
 */

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "../..");
const cueDist = resolve(
  dirname(require.resolve("@cueplusplus/ui/package.json")),
  "dist",
);

/** The two source roots whose modules the App Router renders. */
const auditedRoots = ["src/app", "src/components"] as const;

/**
 * CUE++ dist modules a server module is known to reach into for a compound
 * namespace, and may.
 *
 * Each is a plain module — no client directive — so on the server it really is
 * the compound object the package builds, and `AppBar.Root` really is a
 * component. The list is explicit rather than derived so that the survey can be
 * checked against something: a resolver that silently stopped resolving would
 * report an empty offender set and look exactly like a clean tree. Naming the
 * modules the app genuinely reaches through means the survey has to still be
 * finding them.
 */
const serverSafeCueModules = [
  "chrome/app-bar",
  "chrome/page-shell",
  "layout/stack",
  "primitives/kbd",
] as const;

/**
 * Client-only namespaces a server module is nonetheless allowed to hold.
 *
 * There is no way to make one work — the member is `undefined` before any code
 * of ours runs — so an entry here could only ever record a module that never
 * dereferences the namespace it imported. The honest fix is the directive, or a
 * thin `"use client"` wrapper that owns the composition, which is why this list
 * is empty and expected to stay empty.
 */
const reviewedClientNamespaces: readonly string[] = [];

export type BoundaryRule = "client-function-prop" | "client-namespace";

export type BoundaryViolation = {
  readonly rule: BoundaryRule;
  /** Web-app-relative POSIX path. */
  readonly file: string;
  readonly detail: string;
};

/* ------------------------------------------------------------------ *
 * Reading a module.
 * ------------------------------------------------------------------ */

/** `"use client"` as the module's first statement. */
const clientDirective = /^\s*["']use client["']\s*;/u;

export function isClientModule(source: string): boolean {
  return clientDirective.test(withoutComments(source));
}

/** An import declaration, however many lines its specifier list spans. */
const importDeclaration =
  /^[ \t]*import\s[\s\S]*?from\s*["'][^"']*["']\s*;?[ \t]*$/gmu;

const cueImport =
  /import\s+(type\s+)?(\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\})\s*from\s*["']@cueplusplus\/ui(\/[^"']*)?["']/gu;

const lucideImport =
  /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/gu;

type NamedBinding = { readonly exported: string; readonly local: string };

/** `Button`, `AppShell as ConsoleFrame`, `type ButtonProps` — the last erased. */
function namedBindings(clause: string): NamedBinding[] {
  const bindings: NamedBinding[] = [];

  for (const piece of clause.replace(/[{}]/gu, "").split(",")) {
    const written = piece.trim();
    if (written === "" || /^type\s/u.test(written)) continue;
    const [exported = "", local = ""] = written.split(/\s+as\s+/u);
    bindings.push({ exported, local: local === "" ? exported : local });
  }

  return bindings;
}

/* ------------------------------------------------------------------ *
 * Following an import to the module that defines it.
 * ------------------------------------------------------------------ */

const barrels = new Map<string, ReadonlyMap<string, string>>();

function distSource(module: string): string {
  return readFileSync(resolve(cueDist, `${module}.js`), "utf8");
}

function moduleExists(module: string): boolean {
  try {
    distSource(module);
    return true;
  } catch {
    return false;
  }
}

/** Exported name to the sibling module a published barrel re-exports it from. */
function barrelBindings(subpath: string): ReadonlyMap<string, string> {
  const cached = barrels.get(subpath);
  if (cached) return cached;

  const barrel = subpath === "" ? "index" : `${subpath}/index`;
  const bindings = new Map<string, string>();

  for (const match of distSource(barrel).matchAll(
    /(?:import|export)\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+)\.js["']/gu,
  )) {
    for (const binding of namedBindings(match[1] ?? "")) {
      bindings.set(
        binding.local,
        subpath === "" ? (match[2] ?? "") : `${subpath}/${match[2] ?? ""}`,
      );
    }
  }

  barrels.set(subpath, bindings);

  return bindings;
}

/** Every name a published barrel puts its `export { … }` list. */
function barrelExports(subpath: string): ReadonlySet<string> {
  const barrel = subpath === "" ? "index" : `${subpath}/index`;
  const names = new Set<string>();

  for (const match of distSource(barrel).matchAll(
    /export\s*\{([^}]*)\}\s*;/gu,
  )) {
    for (const binding of namedBindings(match[1] ?? ""))
      names.add(binding.local);
  }

  return names;
}

/**
 * The dist module that defines one published name.
 *
 * A subpath is either a barrel — a directory whose `index.js` re-exports its
 * siblings — or a single published module such as `layout/resizable`, which
 * defines everything it exports. A name neither shape accounts for is an error
 * rather than an unknown: the whole value of the survey is that it resolves
 * every import, so an unresolved one has to be louder than a clean result.
 */
export function cueModuleFor(subpath: string, exported: string): string {
  const barrel = subpath === "" ? "index" : `${subpath}/index`;

  if (moduleExists(barrel)) {
    const defined = barrelBindings(subpath).get(exported);
    if (defined) return defined;
    // A barrel that exports a name it re-exports from nowhere defines it.
    if (barrelExports(subpath).has(exported)) return barrel;
    throw new Error(`cue-export-not-found:${subpath}:${exported}`);
  }
  if (moduleExists(subpath)) return subpath;

  throw new Error(`cue-subpath-has-no-dist-module:${subpath}`);
}

const clientModules = new Map<string, boolean>();

/** Whether the module CUE++ publishes that name from is a client module. */
export function isClientCueModule(module: string): boolean {
  const cached = clientModules.get(module);
  if (cached !== undefined) return cached;

  const client = isClientModule(distSource(module));
  clientModules.set(module, client);

  return client;
}

/* ------------------------------------------------------------------ *
 * Reading the JSX a module writes.
 * ------------------------------------------------------------------ */

type JsxHead = {
  readonly tag: string;
  readonly start: number;
  readonly end: number;
};

/**
 * Where a JSX opening tag's attribute list ends.
 *
 * Brackets are counted because an attribute value may hold a whole element of
 * its own — `render={<NextLink href="/" />}` carries two `>` characters that
 * close nothing — and quotes are honoured because `title="a > b"` carries a
 * third. Only a `>` written outside every bracket and every string closes the
 * tag it opened.
 */
function tagHeadEnd(source: string, from: number): number {
  let depth = 0;
  let quote = "";

  for (let index = from; index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") {
      depth -= 1;
    } else if (character === ">" && depth === 0) return index;
  }

  return -1;
}

/**
 * Every JSX opening tag in a module, with the span its attributes occupy.
 *
 * A `<` that continues an identifier or a call is a type argument or a
 * comparison — `Record<string, unknown>`, `useState<Mode>()`, `a < b` — and
 * opens no element, so the character before the bracket decides whether this is
 * JSX at all. Nested tags are collected in their own right, which is what makes
 * "the innermost span containing this attribute" the tag that owns it.
 */
export function jsxHeads(source: string): JsxHead[] {
  const heads: JsxHead[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "<") continue;
    if (/[\w$)\]]/u.test(source[index - 1] ?? " ")) continue;
    const opening = /^<([A-Za-z_$][\w$.]*)/u.exec(
      source.slice(index, index + 96),
    );
    if (!opening) continue;

    const end = tagHeadEnd(source, index + (opening[0]?.length ?? 0));
    if (end < 0) continue;
    heads.push({ end, start: index, tag: opening[1] ?? "" });
  }

  return heads;
}

/** `icon={Search}` — a prop whose value is one bare identifier. */
const identifierProp =
  /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/gu;

/* ------------------------------------------------------------------ *
 * The two rules.
 * ------------------------------------------------------------------ */

/**
 * Every RSC boundary violation one module commits, or none when the module
 * declares itself a client module — in which case there is no boundary inside
 * it to cross.
 */
export function auditModule(
  file: string,
  written: string,
): BoundaryViolation[] {
  if (isClientModule(written)) return [];

  const source = withoutComments(written);
  const body = source.replaceAll(importDeclaration, "");
  const violations: BoundaryViolation[] = [];
  const cueModules = new Map<string, string>();

  for (const match of source.matchAll(cueImport)) {
    if (match[1]) continue;
    const clause = match[2] ?? "";
    const subpath = (match[3] ?? "").replace(/^\//u, "");
    if (clause.startsWith("*")) {
      // A star import is the namespace shape with nothing left to resolve: the
      // module asks for every export at once, so no survey can say which of
      // them it will dereference.
      throw new Error(`cue-star-import-cannot-be-resolved:${file}`);
    }

    for (const binding of namedBindings(clause)) {
      const module = cueModuleFor(subpath, binding.exported);
      cueModules.set(binding.local, module);
      if (!isClientCueModule(module)) continue;

      const dereferenced = new RegExp(
        `(?<![\\w$.])${binding.local}\\s*\\.`,
        "u",
      ).test(body);
      const detail = `${binding.local}(${binding.exported})->${module}`;
      if (dereferenced && !reviewedClientNamespaces.includes(detail)) {
        violations.push({ detail, file, rule: "client-namespace" });
      }
    }
  }

  const icons = new Set<string>();
  for (const match of source.matchAll(lucideImport)) {
    if (match[1]) continue;
    for (const binding of namedBindings(match[2] ?? ""))
      icons.add(binding.local);
  }

  const heads = jsxHeads(source);
  for (const match of source.matchAll(identifierProp)) {
    const at = match.index;
    const value = match[2] ?? "";
    if (!icons.has(value)) continue;

    const owner = heads
      .filter((head) => head.start < at && at < head.end)
      .sort((left, right) => right.start - left.start)[0];
    if (!owner) continue;

    const module = cueModules.get(owner.tag.split(".")[0] ?? "");
    if (!module || !isClientCueModule(module)) continue;
    violations.push({
      detail: `${owner.tag}.${match[1] ?? ""}={${value}}`,
      file,
      rule: "client-function-prop",
    });
  }

  return violations;
}

/* ------------------------------------------------------------------ *
 * The survey.
 * ------------------------------------------------------------------ */

/**
 * Every module the App Router renders, minus the jsdom suites.
 *
 * A `.dom.test.tsx` file is a client environment by definition: it mounts the
 * verified provider and drives real portals, which is exactly what a client
 * module is for. It crosses no server boundary and is exempt for that reason
 * rather than by convenience.
 */
function auditedModules(): { file: string; source: string }[] {
  return auditedRoots
    .flatMap((root) =>
      readdirSync(resolve(webRoot, root), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
        .map((entry) => resolve(entry.parentPath, entry.name)),
    )
    .map((path) => relative(webRoot, path).split(sep).join("/"))
    .filter((file) => !file.endsWith(".dom.test.tsx"))
    .sort()
    .map((file) => ({
      file,
      source: readFileSync(resolve(webRoot, file), "utf8"),
    }));
}

function surveyViolations(): BoundaryViolation[] {
  return auditedModules().flatMap(({ file, source }) =>
    auditModule(file, source),
  );
}

/**
 * Every dist module the surveyed tree resolves a CUE++ import to.
 *
 * Both sides of the boundary are read. Which side a module is on is exactly
 * what the rules decide, so making the resolver's own coverage depend on that
 * verdict would let a fix on one module quietly narrow the survey.
 */
function resolvedCueImports(): ReadonlySet<string> {
  const reached = new Set<string>();

  for (const { source } of auditedModules()) {
    for (const match of withoutComments(source).matchAll(cueImport)) {
      if (match[1] || (match[2] ?? "").startsWith("*")) continue;
      for (const binding of namedBindings(match[2] ?? "")) {
        reached.add(
          cueModuleFor((match[3] ?? "").replace(/^\//u, ""), binding.exported),
        );
      }
    }
  }

  return reached;
}

describe("the CUE++ modules a server module resolves", () => {
  test("follows a published name to the dist module that defines it", () => {
    expect(cueModuleFor("chrome", "AppShell")).toBe("chrome/app-shell");
    expect(cueModuleFor("chrome", "AppBar")).toBe("chrome/app-bar");
    expect(cueModuleFor("layout", "Stack")).toBe("layout/stack");
    expect(cueModuleFor("primitives", "Kbd")).toBe("primitives/kbd");
    // A subpath published as a single module defines everything it exports.
    expect(cueModuleFor("layout/resizable", "Resizable")).toBe(
      "layout/resizable",
    );
    expect(() => cueModuleFor("chrome", "RequestPortFrame")).toThrow(
      "cue-export-not-found",
    );
  });

  test("reads the client directive off the installed package, not a list", () => {
    expect(isClientCueModule("chrome/app-shell")).toBe(true);
    expect(isClientCueModule("primitives/button")).toBe(true);

    for (const module of serverSafeCueModules) {
      expect({ client: isClientCueModule(module), module }).toEqual({
        client: false,
        module,
      });
    }
  });

  test("still reaches every server-safe module the console composes with", () => {
    // The survey's positive half. A resolver that quietly stopped resolving
    // would report no offenders and read exactly like a clean tree, so the
    // modules the app genuinely reaches through are named here and have to
    // keep turning up — and every import it meets has to resolve to one.
    const reached = resolvedCueImports();

    expect(reached.size).toBeGreaterThan(serverSafeCueModules.length);
    for (const module of serverSafeCueModules) {
      expect({ module, reached: reached.has(module) }).toEqual({
        module,
        reached: true,
      });
    }
  });
});

describe("the rules, against sources written to break them", () => {
  test("reports a client-only namespace held by a server module", () => {
    expect(
      auditModule(
        "x.tsx",
        [
          'import { AppShell as ConsoleFrame } from "@cueplusplus/ui/chrome";',
          "export function Frame() {",
          "  return <ConsoleFrame.Root />;",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      {
        detail: "ConsoleFrame(AppShell)->chrome/app-shell",
        file: "x.tsx",
        rule: "client-namespace",
      },
    ]);
  });

  test("reports a function-valued prop handed to a client component", () => {
    expect(
      auditModule(
        "x.tsx",
        [
          'import { Button } from "@cueplusplus/ui/primitives";',
          'import { Search } from "lucide-react";',
          "export function Find() {",
          "  return <Button icon={Search}>Search</Button>;",
          "}",
        ].join("\n"),
      ),
    ).toEqual([
      {
        detail: "Button.icon={Search}",
        file: "x.tsx",
        rule: "client-function-prop",
      },
    ]);
  });

  test("clears the same two shapes when the module is a client module", () => {
    expect(
      auditModule(
        "x.tsx",
        [
          '"use client";',
          'import { AppShell as ConsoleFrame } from "@cueplusplus/ui/chrome";',
          'import { Button } from "@cueplusplus/ui/primitives";',
          'import { Search } from "lucide-react";',
          "export function Frame() {",
          "  return (",
          "    <ConsoleFrame.Root>",
          "      <Button icon={Search}>Search</Button>",
          "    </ConsoleFrame.Root>",
          "  );",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("clears a client component rendered as a plain element from a server module", () => {
    // The RSC boundary working as designed. Only reaching *into* a client
    // module, or handing one a function, is the failure.
    expect(
      auditModule(
        "x.tsx",
        [
          'import { EmptyState } from "@cueplusplus/ui/chrome";',
          'import { Button } from "@cueplusplus/ui/primitives";',
          'import { Compass } from "lucide-react";',
          "export function Missing() {",
          "  return (",
          "    <EmptyState",
          '      action={<Button variant="primary">Go back</Button>}',
          "      icon={Compass}",
          '      title="Nothing here"',
          "    />",
          "  );",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("attributes a prop to the tag that owns it, not to a nested one", () => {
    const heads = jsxHeads(
      '<Button icon={Search} render={<NextLink href="/s" />} size="sm" />',
    );

    expect(heads.map((head) => head.tag)).toEqual(["Button", "NextLink"]);
    expect(heads[0]?.end).toBeGreaterThan(heads[1]?.end ?? 0);
  });

  test("never reads a type argument or a comparison as an element", () => {
    expect(
      jsxHeads("const seen = new Map<string, number>();\nif (a < b) run();"),
    ).toEqual([]);
  });

  test("never reads a directive, a namespace, or an icon out of prose", () => {
    expect(
      isClientModule(
        '/* a module with "use client" in its prose */\nexport {};',
      ),
    ).toBe(false);
    expect(
      auditModule(
        "x.tsx",
        [
          'import { AppShell as ConsoleFrame } from "@cueplusplus/ui/chrome";',
          "/** Never write ConsoleFrame.Root from a server module. */",
          "export const frame = ConsoleFrame;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("the authenticated console's server modules", () => {
  test("holds no client-only CUE++ namespace, and hands one no function", () => {
    expect(surveyViolations()).toEqual([]);
  });

  test("reviews no client namespace at all", () => {
    // Nothing can make one work, so an entry here would record a module that
    // imported a namespace and never dereferenced it. The directive, or a thin
    // client wrapper, is the fix in every other case.
    expect(reviewedClientNamespaces).toEqual([]);
  });

  test("surveys the whole App Router tree, minus the jsdom suites", () => {
    const files = auditedModules().map((module) => module.file);

    expect(files).toContain("src/components/app-shell.tsx");
    expect(files).toContain("src/app/(app)/layout.tsx");
    expect(files).not.toContain("src/components/app-shell.dom.test.tsx");
    expect(files.length).toBeGreaterThan(40);
  });
});
