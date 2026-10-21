import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";

import { withoutComments } from "./source-text.js";

/**
 * The Playwright tree. A browser spec is the one suite that cannot be told it
 * is wrong: a locator matching nothing auto-waits to the timeout, so a
 * retired recipe reads as "the page never loaded" rather than as "this selector
 * no longer exists". These guards run in the node lane, where a retired recipe
 * fails at once instead of at the browser timeout.
 */
const webRoot = resolve(import.meta.dirname, "..", "..");
const testsRoot = resolve(webRoot, "tests");

/** The two source roots that decide what markup the application emits. */
const applicationRoots = ["src/components", "src/app"] as const;

/** The one module allowed to know how the organization switcher is built. */
const switcherFixture = "fixtures/shell.ts";

/**
 * The switcher's accessible name. Naming it inside a spec is how a spec ends up
 * owning the control's shape — which is exactly how `selectOption({ label })`
 * survived the control's migration off a native `<select>`.
 */
const switcherLabel = "Current organization";

/**
 * Classes a spec may select that the application does not write itself.
 *
 * Third-party or CUE++-owned markup is the only legitimate case: a class hook
 * the installed package emits belongs to the package's contract, not to this
 * application's, so it cannot be found by reading this application's sources.
 * Nothing qualifies today — the migrated surfaces are addressed through roles
 * and `data-slot`, which is what a published contract looks like — and an entry
 * added later has to name the package that owns the class.
 */
const foreignClasses: readonly string[] = [];

/**
 * The element names a compound selector may put in front of a class.
 *
 * `dialog.ui-dialog` and `select.ui-input` are class selectors. `record.oldValue`
 * and `scenario.projectName` are property reads spelled with the same character,
 * and inside a template literal they sit in the same string. The element name is
 * what separates the two, so the rule reads one rather than guessing.
 */
const selectorElements = new Set([
  "a",
  "button",
  "code",
  "details",
  "dialog",
  "div",
  "form",
  "h1",
  "h2",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "select",
  "span",
  "summary",
  "table",
  "tbody",
  "td",
  "textarea",
  "th",
  "tr",
  "ul",
]);

/**
 * A retired recipe class, assembled rather than spelled.
 *
 * This module is scanned by the native CUE++ audit, whose class rules read
 * every string literal rather than only the ones under a `className` — so a
 * suite about recipe classes that wrote one out would fail the contract it
 * exists to check. `native-cue-audit.test.ts` assembles the same way, for the
 * same reason.
 */
function recipeClass(...parts: readonly string[]): string {
  return ["ui", ...parts].join("-");
}

/** Every string and template literal a module writes. */
const stringLiteral =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

function literalsIn(source: string): string[] {
  return [...withoutComments(source).matchAll(stringLiteral)].map((match) =>
    match[0].slice(1, -1),
  );
}

/**
 * The class names one string selects, if it selects any.
 *
 * A class selector is written where a compound selector may begin — at the
 * start, after a combinator or a bracket — or straight after an element name.
 * Everywhere else a dot is punctuation in something that is not a selector at
 * all: a module path, an email domain, a file extension, a property read.
 */
export function selectedClasses(literal: string): string[] {
  const selected: string[] = [];

  for (const match of literal.matchAll(/\.([A-Za-z_][\w-]*)/gu)) {
    const before = literal.slice(0, match.index);
    const element = /([A-Za-z][\w-]*)$/u.exec(before)?.[1];

    if (element === undefined) {
      // A closing bracket is deliberately absent: `${rows[0].href}` and
      // `${locator.count()}` are the two commonest things a template literal
      // holds, and reading a class out of either would report a spec for
      // selecting one of its own method names.
      if (before !== "" && !/[\s>+~,(*]$/u.test(before)) continue;
    } else if (!selectorElements.has(element.toLowerCase())) {
      continue;
    }

    selected.push(match[1] ?? "");
  }

  return selected;
}

/**
 * The value of one `className` attribute, read from the character after `=`.
 *
 * Both spellings are read: a quoted string, and a braced expression whose
 * literals are the classes — `cn("a", condition && "b")` and a template with an
 * interpolation are both ordinary ways to write a class list, and a rule that
 * only understood the quoted form would report most of the application as
 * emitting nothing.
 */
function attributeValue(source: string, from: number): string {
  let index = from;
  while (/\s/u.test(source[index] ?? "")) index += 1;

  const opening = source[index] ?? "";
  if (opening === '"' || opening === "'") {
    const end = source.indexOf(opening, index + 1);
    return end < 0 ? "" : source.slice(index, end + 1);
  }
  if (opening !== "{") return "";

  let depth = 0;
  let quote = "";
  for (let scan = index; scan < source.length; scan += 1) {
    const character = source[scan] ?? "";
    if (quote) {
      if (character === "\\") scan += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(index, scan + 1);
    }
  }

  return "";
}

function applicationModules(): string[] {
  return applicationRoots.flatMap((root) =>
    readdirSync(resolve(webRoot, root), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .sort(),
  );
}

type EmittedClasses = {
  /** Class names written out in full. */
  readonly exact: ReadonlySet<string>;
  /**
   * The static head of an interpolated class — `route-preview-` from
   * `` `route-preview-${tone}` ``. Everything the application composes onto one
   * of these is a class it emits, so a prefix admits its whole family rather
   * than pretending the family does not exist.
   */
  readonly prefixes: readonly string[];
};

/**
 * Every class name the application writes, read from the sources that write it.
 *
 * This replaces a hand-written roster of retired recipes, which is a judgement
 * made once and never re-checked: the roster in this file had drifted in both
 * directions at the same time — it named one recipe four production modules
 * still emit, and named none of the recipes the native reskin actually retired,
 * so `pnpm test:e2e` could not pass while this suite reported everything fine.
 * A set derived from the application cannot drift from the application.
 */
function emittedClasses(): EmittedClasses {
  const exact = new Set<string>();
  const prefixes = new Set<string>();

  for (const file of applicationModules()) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/className\s*=/gu)) {
      const value = attributeValue(source, match.index + match[0].length);
      const written =
        value.startsWith('"') || value.startsWith("'")
          ? [value.slice(1, -1)]
          : literalsIn(value);

      for (const text of written) {
        for (const token of text.split(/\s+/u)) {
          if (token === "") continue;
          const interpolation = token.indexOf("${");
          if (interpolation < 0) {
            if (/^[A-Za-z][\w-]*$/u.test(token)) exact.add(token);
            continue;
          }
          const head = token.slice(0, interpolation);
          if (/^[A-Za-z][\w-]*-$/u.test(head)) prefixes.add(head);
        }
      }
    }
  }

  return { exact, prefixes: [...prefixes].sort() };
}

function browserFiles() {
  return readdirSync(testsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) =>
      relative(testsRoot, resolve(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
}

function read(file: string) {
  return readFileSync(resolve(testsRoot, file), "utf8");
}

/**
 * The names one `import { … } from "<specifier>"` clause binds.
 *
 * Type-only entries and renames are reduced to the imported name, because the
 * question this file asks is which module a spec takes `test` from.
 */
function namedImports(source: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const clause = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*"${escaped}"`,
    "gu",
  );
  const names: string[] = [];

  for (const match of source.matchAll(clause)) {
    for (const entry of (match[1] ?? "").split(",")) {
      const name = entry
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name) names.push(name);
    }
  }

  return names;
}

describe("browser spec contract", () => {
  test("finds the Playwright tree it is guarding", () => {
    const files = browserFiles();

    expect(files).toContain(switcherFixture);
    expect(
      files.filter((file) => file.endsWith(".spec.ts")).length,
    ).toBeGreaterThan(0);
  });

  test("keeps the organization switcher's shape in one shared fixture", () => {
    for (const file of browserFiles()) {
      expect({
        file,
        namesTheSwitcher: read(file).includes(switcherLabel),
      }).toEqual({ file, namesTheSwitcher: file === switcherFixture });
    }
  });

  test("drives the switcher through its role contract, never as a native select", () => {
    const source = read(switcherFixture);

    expect(source).toContain('getByRole("combobox"');
    expect(source).toContain('getByRole("listbox"');
    expect(source).toContain('getByRole("option"');
    expect(source).not.toContain("selectOption");
    expect(source).not.toContain('locator("option")');
  });

  test("reads the organization slug from the slots the page header emits", () => {
    // `page-layout.test.tsx` pins the other half: that a rendered `Page` really
    // does nest an eyebrow slot inside its header slot.
    expect(read(switcherFixture)).toContain(
      '[data-slot="page-shell-header"] [data-slot="eyebrow"]',
    );
  });

  test("reads a class selector, and only a class selector, out of a string", () => {
    expect(selectedClasses(".app-content")).toEqual(["app-content"]);
    expect(selectedClasses("nav:visible .navigation-icon")).toEqual([
      "navigation-icon",
    ]);
    expect(selectedClasses(`.${recipeClass("input")}:not(textarea)`)).toEqual([
      recipeClass("input"),
    ]);
    expect(selectedClasses(`dialog.${recipeClass("dialog")}`)).toEqual([
      recipeClass("dialog"),
    ]);
    expect(selectedClasses(`select.${recipeClass("input")}`)).toEqual([
      recipeClass("input"),
    ]);
    expect(selectedClasses('.a > .b, .c ~ [data-slot="d"]')).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Everything a dot is when it is not a selector. The interpolations are
    // written with escaped placeholders so each fixture is the text a template
    // literal holds rather than a second interpolation of this suite's own.
    expect(selectedClasses("../fixtures/auth.js")).toEqual([]);
    expect(selectedClasses("owner@example.invalid")).toEqual([]);
    expect(selectedClasses("requestport.e2e.outgoing-appearance")).toEqual([]);
    expect(selectedClasses(`\${scenario.projectName} duplicate`)).toEqual([]);
    expect(selectedClasses(`\${name}-\${width}.png`)).toEqual([]);
    expect(selectedClasses(`\${await rows.count()} rows`)).toEqual([]);
    expect(selectedClasses(`\${links[0].href}`)).toEqual([]);
  });

  test("reads the class names the application emits out of its sources", () => {
    const { exact, prefixes } = emittedClasses();

    // The two utilities the migrated console still writes by hand — a wrapping
    // rule and an ink — are what a working scan finds now that every recipe
    // class is gone.
    expect(exact.has("break-all")).toBe(true);
    expect(exact.has("text-fg-subtle")).toBe(true);
    // Nothing composes a class out of a value any longer: every tone the
    // console shows is a CUE++ variant. An empty family list is therefore the
    // honest reading, and asserting it keeps an empty scan from passing as one.
    expect(prefixes).toEqual([]);
    // The recipes the native reskin retired, and the reason the browser tree
    // could not be trusted to say so.
    for (const retired of [
      "app-content",
      "command-button",
      "content-section-inner",
      "desktop-rail",
      "mobile-navigation",
      "navigation-icon",
      "new-request-button",
      "organization-select",
      "rail-list",
      "top-bar",
      "user-popover",
    ]) {
      expect({ emitted: exact.has(retired), retired }).toEqual({
        emitted: false,
        retired,
      });
    }
  });

  test("selects no class the application stopped emitting", () => {
    const { exact, prefixes } = emittedClasses();
    const unemitted: string[] = [];

    for (const file of browserFiles()) {
      for (const literal of literalsIn(read(file))) {
        for (const selected of selectedClasses(literal)) {
          if (exact.has(selected) || foreignClasses.includes(selected)) {
            continue;
          }
          if (prefixes.some((prefix) => selected.startsWith(prefix))) continue;
          unemitted.push(`${file}:.${selected}`);
        }
      }
    }

    expect([...new Set(unemitted)].sort()).toEqual([]);
  });

  test("routes every spec's `test` through the shared engine guard", () => {
    // The guard that skips an engine its host cannot drive lives on one
    // extended `test`. A spec that imported `test` straight from the package
    // would step around it silently, and the run would go red on a limitation
    // the matrix has already accounted for — so the routing is a property of
    // the tree rather than of whoever wrote the newest spec.
    const specs = browserFiles().filter((file) => file.endsWith(".spec.ts"));
    const unguarded: string[] = [];

    expect(specs.length).toBeGreaterThan(0);
    for (const file of specs) {
      const source = withoutComments(read(file));
      if (namedImports(source, "@playwright/test").includes("test")) {
        unguarded.push(`${file}: takes test straight from @playwright/test`);
      }
      // The specifier carries its real extension because Node's own type
      // stripping resolves real paths only, and the Playwright configuration
      // is loaded that way by `scripts/playwright-config.test.mjs`.
      if (!namedImports(source, "../fixtures/engine.ts").includes("test")) {
        unguarded.push(`${file}: does not take test from the engine fixture`);
      }
    }

    expect(unguarded.sort()).toEqual([]);
  });

  test("grants no class an exemption without naming its owner", () => {
    // An empty allowlist is the honest state of a console addressed through
    // roles and `data-slot`. The assertion is here so that adding an entry is a
    // deliberate edit rather than a quiet widening.
    expect(foreignClasses).toEqual([]);
  });
});
